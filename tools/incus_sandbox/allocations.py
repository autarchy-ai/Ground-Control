"""The flock-guarded allocation record the lifecycle helper reserves VM capacity in."""

from __future__ import annotations

import fcntl
import json
import os
import re
from pathlib import Path

SANDBOX_NAME = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
_INVALID_ALLOCATION = "allocation state is invalid"
_FIELDS = ("cpu", "memory_mib", "disk_gib", "owner_uid")


class AdmissionError(RuntimeError):
    """Host capacity facts do not safely admit a VM operation."""


def _validated(doc: object) -> dict[str, dict[str, int]]:
    """Accept only the closed per-sandbox reservation shape."""
    if not isinstance(doc, dict):
        raise AdmissionError(_INVALID_ALLOCATION)
    records: dict[str, dict[str, int]] = {}
    for name, value in doc.items():
        if not SANDBOX_NAME.fullmatch(name) or not isinstance(value, dict):
            raise AdmissionError(_INVALID_ALLOCATION)
        if set(value) != {*_FIELDS, "active"}:
            raise AdmissionError(_INVALID_ALLOCATION)
        valid_numbers = all(isinstance(value[key], int) and value[key] > 0 for key in _FIELDS)
        if not valid_numbers or not isinstance(value["active"], bool):
            raise AdmissionError(_INVALID_ALLOCATION)
        records[name] = value
    return records


def locked_allocations(state_dir: Path) -> tuple[int, dict[str, dict[str, int]]]:
    """Take the exclusive allocation lock and return its descriptor with the records."""
    state_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
    fd = os.open(state_dir / "allocations.json", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o640)
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        raw = os.read(fd, 1024 * 1024).decode("utf-8")
        return fd, _validated(json.loads(raw) if raw else {})
    except Exception:
        unlock(fd)
        raise


def save_allocations(fd: int, records: dict[str, dict[str, int]]) -> None:
    """Durably replace the records behind an already-held lock."""
    payload = json.dumps(records, separators=(",", ":")).encode("utf-8")
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    os.write(fd, payload)
    os.fsync(fd)


def unlock(fd: int) -> None:
    """Release the allocation lock."""
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)
