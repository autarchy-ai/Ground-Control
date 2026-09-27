"""The locked allocation ledger the lifecycle helper reserves VM capacity in."""

from __future__ import annotations

import errno
import json
import os
import re
import stat
from pathlib import Path
from typing import TYPE_CHECKING

if __package__:
    from .durable import acquire_lock, release_lock, replace_file
else:
    from durable import acquire_lock, release_lock, replace_file

if TYPE_CHECKING:
    from .config import HostLimits

SANDBOX_NAME = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
_INVALID_ALLOCATION = "allocation state is invalid; run `grndctl sandbox reconcile`"
_FIELDS = ("cpu", "memory_mib", "disk_gib", "owner_uid")
_MAX_LEDGER_BYTES = 1024 * 1024
RUNNING, STOPPED, CLEANUP_PENDING = "running", "stopped", "cleanup_pending"
_STATES = {RUNNING, STOPPED, CLEANUP_PENDING}
# A VM that may still be running holds its CPU and memory; one awaiting cleanup
# may be running, because the create that launched it failed before it stopped.
_HOLDS_COMPUTE = {RUNNING, CLEANUP_PENDING}


class AdmissionError(RuntimeError):
    """Host capacity facts do not safely admit a VM operation."""


class CleanupPendingError(RuntimeError):
    """A create failed and so did removing the VM it may have launched; both are reported."""

    def __init__(self, action: str, name: str, primary_code: str, cleanup_code: str) -> None:
        """Name both failure codes and the recovery, never raw daemon output."""
        super().__init__(
            f"{action} failed ({primary_code}) and its cleanup also failed ({cleanup_code}); "
            f"{name} is recorded as cleanup-pending and keeps its capacity. "
            f"Retry the cleanup with: grndctl sandbox delete {name} --confirm {name}")
        self.primary_code = primary_code
        self.cleanup_code = cleanup_code


def _number(value: object) -> bool:
    """True for a positive integer that is not a boolean."""
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _record(value: object) -> dict[str, int | str]:
    """Accept one reservation, reading the pre-#1721 `active` shape as running or stopped."""
    if not isinstance(value, dict) or not all(_number(value.get(key)) for key in _FIELDS):
        raise AdmissionError(_INVALID_ALLOCATION)
    if set(value) == {*_FIELDS, "active"} and isinstance(value["active"], bool):
        state = RUNNING if value["active"] else STOPPED
    elif set(value) == {*_FIELDS, "state"} and value["state"] in _STATES:
        state = value["state"]
    else:
        raise AdmissionError(_INVALID_ALLOCATION)
    return {**{key: value[key] for key in _FIELDS}, "state": state}


def _validated(raw: bytes) -> dict[str, dict[str, int | str]]:
    """Parse the ledger; an empty file is an interrupted legacy write, never an empty ledger."""
    try:
        doc = json.loads(raw.decode("utf-8"))
    except ValueError as error:
        raise AdmissionError(_INVALID_ALLOCATION) from error
    if not isinstance(doc, dict) or not all(isinstance(name, str) and SANDBOX_NAME.fullmatch(name) for name in doc):
        raise AdmissionError(_INVALID_ALLOCATION)
    return {name: _record(value) for name, value in doc.items()}


def _read(path: Path) -> bytes:
    """Read the ledger bytes without following a link.

    Setup writes an empty ledger for the project it creates, so a missing one is lost state,
    not an empty ledger, and fails closed until reconciliation rebuilds it.
    """
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        if error.errno in {errno.ENOENT, errno.ELOOP}:
            raise AdmissionError(_INVALID_ALLOCATION) from error
        raise
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise AdmissionError(_INVALID_ALLOCATION)
        raw = os.read(descriptor, _MAX_LEDGER_BYTES + 1)
    finally:
        os.close(descriptor)
    if len(raw) > _MAX_LEDGER_BYTES:
        raise AdmissionError(_INVALID_ALLOCATION)
    return raw


class Ledger(object):
    """The allocation records, read and replaced under a stable lock until released.

    The lock is a separate file, so an atomic replacement of the records never swaps the
    inode a concurrent helper is waiting on.
    """

    def __init__(self, state_dir: Path, *, recover: bool = False) -> None:
        """Lock and read the ledger; `recover` admits a missing or invalid one for reconciliation only."""
        state_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
        self.path = state_dir / "allocations.json"
        self.rebuilt = False
        self._damaged: bytes | None = None
        self._descriptor: int | None = acquire_lock(state_dir / "allocations.lock")
        raw: bytes | None = None
        try:
            raw = _read(self.path)
            self.records = _validated(raw)
        except AdmissionError:
            if not recover:
                self.release()
                raise
            self.rebuilt, self._damaged, self.records = True, raw, {}
        except BaseException:
            self.release()
            raise

    def __enter__(self) -> Ledger:
        """Use the held ledger as a context manager."""
        return self

    def __exit__(self, *_: object) -> None:
        """Release the lock when the block ends."""
        self.release()

    def save(self) -> None:
        """Durably replace the records, keeping any invalid ledger they replace for inspection."""
        if self._damaged is not None:
            replace_file(self.path.with_name("allocations.json.invalid"), self._damaged, 0o600)
            self._damaged = None
        payload = json.dumps(self.records, separators=(",", ":"), sort_keys=True).encode("utf-8")
        replace_file(self.path, payload, 0o640)

    def release(self) -> None:
        """Release the lock; idempotent."""
        if self._descriptor is not None:
            release_lock(self._descriptor)
            self._descriptor = None


def headroom(records: dict[str, dict[str, int | str]], host: HostLimits,
             pool_total_gib: int | None) -> dict[str, int | None]:
    """The one capacity calculation shared by admission and status.

    CPU and memory count for every VM that may be running; disk counts for every VM that may
    still exist, stopped or awaiting cleanup, until its deletion is confirmed. The disk
    ceiling is the configured aggregate or the storage pool's size, whichever is smaller,
    and it is unknown while the pool is unobserved.
    """
    compute = [record for record in records.values() if record["state"] in _HOLDS_COMPUTE]
    disk_ceiling = None if pool_total_gib is None else min(host.max_disk_gib, pool_total_gib)
    return {
        "cpu": host.max_cpu - sum(int(record["cpu"]) for record in compute),
        "memory_mib": host.max_memory_mib - sum(int(record["memory_mib"]) for record in compute),
        "disk_gib": None if disk_ceiling is None else disk_ceiling - host.overhead_disk_gib - sum(
            int(record["disk_gib"]) for record in records.values()),
    }


def fits(records: dict[str, dict[str, int | str]], host: HostLimits, pool_total_gib: int) -> bool:
    """True when a prospective ledger stays within every aggregate bound."""
    return all(value is not None and value >= 0 for value in headroom(records, host, pool_total_gib).values())
