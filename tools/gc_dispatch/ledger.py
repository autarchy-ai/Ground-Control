"""The per-user capacity ledger shared by every dispatcher process on a host.

Coordination has to survive across repositories, checkouts, agent drivers, and MCP
server processes, so the shared state is a small file protected by an OS advisory
lock rather than anything held inside one process. The lock is held only while the
ledger is read, swept, scheduled against, and replaced; never while a command runs.

Liveness is not a PID check. Every entry owns a lease file the owner holds under
`flock` for its whole life, and the descriptor is inherited by the command it
launched, so a grant stays held while real work continues. The record shape,
identity, and lease primitives live in `records.py`.
"""

from __future__ import annotations

import fcntl
import json
import os
import secrets
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, NamedTuple

from .admission import LedgerEntry, plan_admission
from .records import (
    LEASE_DIR_NAME,
    LEDGER_VERSION,
    LedgerError,
    lease_is_unheld,
    supervisor_alive,
    supervisor_identity,
    validate_ledger,
)

LEDGER_NAME = "ledger.json"
LOCK_NAME = "ledger.lock"

__all__ = ["Ledger", "LedgerError", "Ticket", "prepare_state_dir"]


class Ticket(NamedTuple):
    """A claim on the ledger plus the open lease that proves the claimant is alive."""

    id: str
    seq: int
    lease_path: Path
    lease_fd: int


def _tighten(path: Path) -> None:
    """Restrict a dispatcher directory to its owner."""
    if path.stat().st_mode & 0o077:
        path.chmod(0o700)


def prepare_state_dir(path: Path | str) -> Path:
    """Create or validate the private per-user runtime directory."""
    path = Path(path)
    if path.is_symlink():
        raise LedgerError(f"dispatcher state path must not be a symlink: {path}")
    if path.exists() and not path.is_dir():
        raise LedgerError(f"dispatcher state path is not a directory: {path}")
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise LedgerError(f"cannot create dispatcher state directory {path}: {exc}") from exc
    if path.stat().st_uid != os.getuid():
        raise LedgerError(f"dispatcher state directory is not owned by this user: {path}")
    _tighten(path)
    leases = path / LEASE_DIR_NAME
    leases.mkdir(exist_ok=True)
    _tighten(leases)
    return path


# The explicit `object` base is this repository's Python class convention, enforced
# by the shared strict Sonar profile (python:S1722) rather than left to taste.
class Ledger(object):
    """The shared admission state, and the only writer of it in this process."""

    def __init__(self, state_dir: Path | str, stale_after_seconds: float) -> None:
        """Bind to a validated per-user state directory and its stale-lease bound."""
        self.state_dir = prepare_state_dir(state_dir)
        self.lease_dir = self.state_dir / LEASE_DIR_NAME
        self.stale_after_seconds = float(stale_after_seconds)
        self._ledger_path = self.state_dir / LEDGER_NAME
        self._lock_path = self.state_dir / LOCK_NAME
        self._released: set[str] = set()

    # -- persistence -----------------------------------------------------

    @contextmanager
    def _locked(self) -> Iterator[None]:
        """Hold the ledger's advisory lock for one read-modify-write."""
        fd = os.open(self._lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def _read(self) -> dict[str, Any]:
        """Return the validated ledger, or a fresh one when none exists yet."""
        try:
            raw = self._ledger_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {"version": LEDGER_VERSION, "next_seq": 1, "entries": []}
        except OSError as exc:
            raise LedgerError(f"cannot read {self._ledger_path}: {exc}") from exc
        try:
            doc = json.loads(raw)
        except ValueError as exc:
            raise LedgerError(
                f"{self._ledger_path} is not valid JSON; refusing to reset live host state ({exc})"
            ) from exc
        return validate_ledger(doc)

    def _write(self, doc: dict[str, Any]) -> None:
        """Replace the ledger atomically, so no reader sees a partial document."""
        tmp = self._ledger_path.with_suffix(f".tmp.{os.getpid()}")
        fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(doc, handle)
            os.replace(tmp, self._ledger_path)
        except OSError as exc:
            tmp.unlink(missing_ok=True)
            raise LedgerError(f"cannot write {self._ledger_path}: {exc}") from exc

    # -- sweeping --------------------------------------------------------

    def _lease_path(self, ticket_id: str) -> Path:
        """Return the lease file backing one ticket."""
        return self.lease_dir / f"{ticket_id}.lease"

    def _is_reclaimable(self, entry: LedgerEntry, now: float) -> bool:
        """Decide whether an entry's capacity can be issued to somebody else.

        The order is the whole safety argument. An unheld lease proves nothing is
        running behind the entry. A live supervisor proves the opposite, and holds
        its grant however long the work takes. Only when neither is true (a
        descendant inherited the lease and no supervisor remains) does the age
        bound apply, so a long but healthy suite is never evicted mid-run.
        """
        if lease_is_unheld(self._lease_path(entry["ticket"])):
            return True
        if supervisor_alive(entry["supervisor"]):
            return False
        base = entry["orphaned_at"] or entry["started_at"] or entry["enqueued_at"]
        return (now - float(base)) >= self.stale_after_seconds

    def _sweep(self, doc: dict[str, Any], protect: str | None = None) -> bool:
        """Drop every reclaimable entry, returning whether anything changed."""
        now = time.time()
        kept: list[LedgerEntry] = []
        dropped: list[LedgerEntry] = []
        for entry in doc["entries"]:
            if entry["ticket"] == protect or not self._is_reclaimable(entry, now):
                kept.append(entry)
            else:
                dropped.append(entry)
        for entry in dropped:
            self._lease_path(entry["ticket"]).unlink(missing_ok=True)
        doc["entries"] = kept
        return bool(dropped)

    # -- public operations ----------------------------------------------

    @staticmethod
    def _open_lease(lease_path: Path) -> int:
        """Create and hold the lease that will back a new entry.

        The command this dispatcher launches must inherit the descriptor, so the
        two processes share one open file description and the lock outlives a
        supervisor killed mid-run. Python marks new descriptors non-inheritable by
        default (PEP 446), which would silently defeat that.
        """
        fd = os.open(lease_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.set_inheritable(fd, True)
        except BaseException:
            os.close(fd)
            raise
        return fd

    def enqueue(self, profile: str, requested: int, minimum: int) -> Ticket:
        """Claim a lease, then register the queued entry it backs.

        The lease is acquired first on purpose: a ledger entry must never exist
        without a live holder behind it, or a crash between the two steps would
        strand capacity that no sweep can attribute.
        """
        ticket_id = secrets.token_hex(8)
        lease_path = self._lease_path(ticket_id)
        fd = self._open_lease(lease_path)
        entry: LedgerEntry = {
            "ticket": ticket_id,
            "seq": 0,
            "profile": profile,
            "requested": int(requested),
            "minimum": int(minimum),
            "granted": None,
            "state": "queued",
            "enqueued_at": time.time(),
            "started_at": None,
            "supervisor": supervisor_identity(),
            "orphaned_at": None,
        }
        try:
            with self._locked():
                doc = self._read()
                self._sweep(doc)
                entry["seq"] = int(doc["next_seq"])
                doc["next_seq"] = entry["seq"] + 1
                doc["entries"].append(entry)
                self._write(doc)
        except BaseException:
            os.close(fd)
            lease_path.unlink(missing_ok=True)
            raise
        return Ticket(id=ticket_id, seq=entry["seq"], lease_path=lease_path, lease_fd=fd)

    def try_admit(self, ticket: Ticket, capacity: int) -> int | None:
        """Return this ticket's grant, or None while it must keep waiting."""
        with self._locked():
            doc = self._read()
            changed = self._sweep(doc, protect=ticket.id)
            mine = next((e for e in doc["entries"] if e["ticket"] == ticket.id), None)
            if mine is None:
                raise LedgerError(
                    f"ticket {ticket.id} is no longer registered in the host ledger")
            granted = plan_admission(capacity, doc["entries"], ticket.id)
            if granted is not None:
                mine["state"] = "running"
                mine["granted"] = int(granted)
                mine["started_at"] = time.time()
                changed = True
            if changed:
                self._write(doc)
        return granted

    def _close_lease(self, ticket: Ticket) -> None:
        """Drop this process's reference to the lease, at most once."""
        if ticket.id in self._released:
            return
        self._released.add(ticket.id)
        try:
            os.close(ticket.lease_fd)
        except OSError:
            pass

    def _settle_entry(self, doc: dict[str, Any], ticket: Ticket) -> None:
        """Remove the entry, or keep it accounted while a descendant still runs."""
        entry = next((e for e in doc["entries"] if e["ticket"] == ticket.id), None)
        if entry is None:
            return
        if lease_is_unheld(ticket.lease_path):
            doc["entries"] = [e for e in doc["entries"] if e["ticket"] != ticket.id]
            ticket.lease_path.unlink(missing_ok=True)
        else:
            entry["supervisor"] = None
            entry["orphaned_at"] = time.time()
        self._write(doc)

    def release(self, ticket: Ticket) -> None:
        """Give the grant back, but only once nothing is still spending it.

        Waiting on the direct child is not proof that the work is over: a
        descendant can inherit the lease and keep running. Dropping our own
        descriptor first makes the lease answer that question. If somebody still
        holds it, the entry stays and keeps its capacity accounted, with the
        supervisor identity cleared so the stale bound can eventually reclaim it.

        Idempotent, and safe to call from `finally`: a failure here can only ever
        leave capacity looking busy, so it must not mask the command's exit status.
        """
        self._close_lease(ticket)
        try:
            with self._locked():
                self._settle_entry(self._read(), ticket)
        except (LedgerError, OSError):
            pass

    def snapshot(self) -> list[LedgerEntry]:
        """Return the live entries, sweeping anything nothing holds any more."""
        with self._locked():
            doc = self._read()
            if self._sweep(doc):
                self._write(doc)
            return [dict(entry) for entry in doc["entries"]]
