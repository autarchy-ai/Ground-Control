"""Ledger record shape, liveness identity, and lease primitives.

Split out of `ledger.py` so the store keeps only acquisition, sweeping, and
admission, and the rules that decide whether a record is *valid* and whether its
owner is *alive* have one home. Both questions are load-bearing: a record the
scheduler misreads becomes capacity issued twice, and so does an owner wrongly
called dead.
"""

from __future__ import annotations

import fcntl
import os
import re
from pathlib import Path
from .admission import LedgerEntry

LEDGER_VERSION = 1
LEASE_DIR_NAME = "leases"

ENTRY_FIELDS = (
    "ticket", "seq", "profile", "requested", "minimum", "granted",
    "state", "enqueued_at", "started_at", "supervisor", "orphaned_at",
)
ENTRY_STATES = ("queued", "running")
MAX_DEMAND = 1024
MAX_PROFILE_LENGTH = 64

_TICKET_RE = re.compile(r"^[0-9a-f]{16}$")
_PROFILE_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,%d}$" % MAX_PROFILE_LENGTH)
# `/proc/<pid>/stat` field 22 is the process start time. Paired with the PID it is
# a reuse-safe identity: a recycled PID belonging to a new process reports a
# different start time, so a dead supervisor can never look alive.
_HAS_PROC = Path("/proc/self/stat").exists()
_STAT_STARTTIME_OFFSET = 19


class LedgerError(RuntimeError):
    """Unusable host state. Callers fail closed rather than reset live leases."""


def process_token(pid: int) -> str | None:
    """Return the reuse-safe start-time token for ``pid``, or None when it is gone."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as handle:
            data = handle.read()
    except OSError:
        return None
    # The comm field can contain spaces and parentheses, so split after its close.
    tail = data.rsplit(b")", 1)[-1].split()
    if len(tail) <= _STAT_STARTTIME_OFFSET:
        return None
    return tail[_STAT_STARTTIME_OFFSET].decode("ascii", "replace")


def supervisor_identity() -> dict[str, object]:
    """Return this process's identity, for recording against a grant."""
    pid = os.getpid()
    return {"pid": pid, "token": process_token(pid) if _HAS_PROC else None}


def _is_pid(value: object) -> bool:
    """Whether the value can name a live process."""
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _pid_is_signalable(pid: int) -> bool:
    """Whether a signal probe finds the PID.

    Weaker than the start-time token against PID reuse, so it is the fallback for
    a host without `/proc`. It errs toward reporting a supervisor alive, which
    holds capacity rather than issuing it twice.
    """
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def supervisor_alive(supervisor: object) -> bool:
    """Whether the process that took a grant is still running."""
    pid = supervisor.get("pid") if isinstance(supervisor, dict) else None
    if not _is_pid(pid):
        return False
    if _HAS_PROC:
        return process_token(pid) == supervisor.get("token")
    return _pid_is_signalable(pid)


def lease_is_unheld(path: Path) -> bool:
    """Whether no live process holds the lease, so its capacity is reclaimable.

    The kernel drops an `flock` only once every process sharing the open file
    description is gone, so acquiring it here is proof the work behind the entry
    has ended, immune to PID reuse.
    """
    try:
        fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        unheld = True
    except OSError:
        unheld = False
    finally:
        os.close(fd)
    return unheld


def _require(condition: bool, detail: str) -> None:
    """Raise the bounded ledger error unless the invariant holds."""
    if not condition:
        raise LedgerError(
            f"host ledger is invalid and will not be reset or scheduled against: {detail}")


def _is_int(value: object) -> bool:
    """Whether the value is a real integer rather than a bool."""
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: object) -> bool:
    """Whether the value is a real number rather than a bool."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _validate_supervisor(entry: LedgerEntry) -> None:
    """Check the recorded supervisor identity, which may legitimately be absent."""
    supervisor = entry["supervisor"]
    if supervisor is None:
        return
    _require(isinstance(supervisor, dict), "an entry has a malformed supervisor record")
    _require(set(supervisor) == {"pid", "token"}, "a supervisor record has unexpected fields")
    _require(_is_int(supervisor["pid"]) and supervisor["pid"] > 0,
             "a supervisor PID is not positive")
    _require(supervisor["token"] is None or isinstance(supervisor["token"], str),
             "a supervisor token is not a string")


def _validate_demand(entry: LedgerEntry, ticket: str) -> None:
    """Check that the declared demand is a usable, bounded pair."""
    for field in ("requested", "minimum"):
        value = entry[field]
        _require(_is_int(value) and 1 <= value <= MAX_DEMAND,
                 f"ticket {ticket} has an out-of-range {field}")
    _require(entry["minimum"] <= entry["requested"],
             f"ticket {ticket} has minimum above requested")


def _validate_state(entry: LedgerEntry, ticket: str) -> None:
    """Check the fields whose meaning depends on whether the entry is running."""
    _require(entry["state"] in ENTRY_STATES, f"ticket {ticket} has an unknown state")
    if entry["state"] == "running":
        # A running entry with a zero or missing grant reads as free capacity, so
        # a corrupt record here would let the host be granted out twice over.
        _require(_is_int(entry["granted"]) and 1 <= entry["granted"] <= MAX_DEMAND,
                 f"ticket {ticket} is running without a valid grant")
        _require(_is_number(entry["started_at"]),
                 f"ticket {ticket} is running without a start time")
    else:
        _require(entry["granted"] is None, f"ticket {ticket} is queued but carries a grant")
        _require(entry["started_at"] is None,
                 f"ticket {ticket} is queued but carries a start time")


def _validate_entry(entry: object, seen: set[str]) -> None:
    """Reject any record the scheduler could misread as free or unlimited capacity."""
    _require(isinstance(entry, dict), "an entry is not an object")
    _require(set(entry) == set(ENTRY_FIELDS),
             f"entry fields {sorted(entry)} do not match the ledger schema")
    ticket = entry["ticket"]
    _require(isinstance(ticket, str) and bool(_TICKET_RE.match(ticket)),
             "an entry has a malformed ticket")
    _require(ticket not in seen, f"ticket {ticket} appears more than once")
    seen.add(ticket)
    _require(_is_int(entry["seq"]) and entry["seq"] >= 1,
             f"ticket {ticket} has a non-positive seq")
    _require(isinstance(entry["profile"], str) and bool(_PROFILE_RE.match(entry["profile"])),
             f"ticket {ticket} has a malformed profile")
    _validate_demand(entry, ticket)
    _validate_state(entry, ticket)
    _require(entry["orphaned_at"] is None or _is_number(entry["orphaned_at"]),
             f"ticket {ticket} has a malformed orphan time")
    _validate_supervisor(entry)


def validate_ledger(doc: object) -> dict[str, object]:
    """Return the document once every record is known-good, else fail closed."""
    _require(isinstance(doc, dict), "the ledger is not an object")
    _require(set(doc) == {"version", "next_seq", "entries"},
             "the ledger has unexpected top-level fields")
    _require(doc["version"] == LEDGER_VERSION,
             f"ledger version {doc['version']!r} is not supported by this dispatcher")
    _require(_is_int(doc["next_seq"]) and doc["next_seq"] >= 1,
             "next_seq is not a positive integer")
    _require(isinstance(doc["entries"], list), "entries is not a list")
    seen: set[str] = set()
    for entry in doc["entries"]:
        _validate_entry(entry, seen)
    return doc
