"""Bounded allowlisted lifecycle events owned by the host."""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import TypedDict


_ACTIONS = {"create", "boot", "attach", "stop", "start", "delete", "status", "diagnose", "transfer"}
_OUTCOMES = {"success", "failure", "denied"}
_ERRORS = {
    "none", "admission_observation_stale", "admission_insufficient", "command_failed",
    "invalid_input", "event_unavailable",
}
_INPUT_FIELDS = {"action", "outcome", "sandbox_id", "error_code", "assigned", "observed", "duration_ms"}


class EventInput(TypedDict, total=False):
    """Facts accepted from the closed lifecycle helper."""

    action: str
    outcome: str
    sandbox_id: str | None
    error_code: str
    assigned: dict[str, int | bool]
    observed: dict[str, int | bool]
    duration_ms: int


class EventWriter(object):
    """Write a root-owned, rotation-bounded JSONL event stream."""

    def __init__(self, path: Path, max_bytes: int, *, expected_uid: int = 0) -> None:
        self.path = path
        self.max_bytes = max_bytes
        self.expected_uid = expected_uid

    def _validate_path(self) -> None:
        """Create the controlled parent and reject unsafe existing log files."""
        self.path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        if not os.path.lexists(self.path):
            return
        current = self.path.lstat()
        if self.path.is_symlink() or not self.path.is_file() or current.st_uid != self.expected_uid:
            raise RuntimeError("event log path is unsafe")

    @staticmethod
    def _resource_facts(value: object) -> dict[str, int | bool]:
        """Validate the small resource fact vocabulary retained in an event."""
        if not isinstance(value, dict) or set(value) - {"cpu", "memory_mib", "disk_gib", "fresh"}:
            raise ValueError("event resource facts are invalid")
        if not all(isinstance(key, str) and isinstance(item, (int, bool)) for key, item in value.items()):
            raise ValueError("event resource facts are invalid")
        return value

    @staticmethod
    def _identity(event: EventInput) -> tuple[str, str, str, str | None]:
        """Validate and return the lifecycle identity fields for one record."""
        if set(event) - _INPUT_FIELDS:
            raise ValueError("event contains an unallowlisted field")
        action, outcome = event.get("action"), event.get("outcome")
        if action not in _ACTIONS or outcome not in _OUTCOMES:
            raise ValueError("event has an unsupported action or outcome")
        error_code = event.get("error_code", "none")
        if error_code not in _ERRORS:
            raise ValueError("event has an unsupported error code")
        sandbox_id = event.get("sandbox_id")
        if sandbox_id is not None and (not isinstance(sandbox_id, str) or len(sandbox_id) > 63):
            raise ValueError("event sandbox id is invalid")
        return action, outcome, error_code, sandbox_id

    def _record(self, event: EventInput) -> str:
        """Build one schema-constrained JSONL record from approved facts."""
        action, outcome, error_code, sandbox_id = self._identity(event)
        record: dict[str, object] = {
            "schema": "gc.incus-sandbox.event/v1",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "duration_ms": int(event.get("duration_ms", 0)), "event_id": str(uuid.uuid4()),
            "host_id": "local", "operation_id": str(uuid.uuid4()),
            "sandbox_id": sandbox_id, "action": action, "outcome": outcome,
            "error_code": error_code,
        }
        self._add_resource_facts(record, event)
        rendered = json.dumps(record, separators=(",", ":")) + "\n"
        if len(rendered.encode("utf-8")) > self.max_bytes:
            raise RuntimeError("one event exceeds the configured log bound")
        return rendered

    def _add_resource_facts(self, record: dict[str, object], event: EventInput) -> None:
        """Copy the two optional resource-fact groups after schema validation."""
        for field in ("assigned", "observed"):
            value = event.get(field)
            if value is not None:
                record[field] = self._resource_facts(value)

    def _read_retained(self, remaining: int) -> str:
        """Keep only complete newest events that fit beside the next record."""
        if not self.path.exists():
            return ""
        previous = self.path.read_text(encoding="utf-8")
        while previous and len(previous.encode("utf-8")) > remaining:
            previous = previous.partition("\n")[2]
        return previous

    def _replace_log(self, content: str) -> None:
        """Write through a no-follow descriptor after path validation."""
        descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o640)
        try:
            os.write(descriptor, content.encode("utf-8"))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.chmod(self.path, 0o640)

    @contextlib.contextmanager
    def _exclusive(self) -> Iterator[None]:
        """Serialize the read-retain-replace sequence across lifecycle processes."""
        self.path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        descriptor = os.open(self.path.with_suffix(".lock"), os.O_WRONLY | os.O_CREAT, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    def write(self, event: EventInput) -> None:
        """Append an approved event while enforcing the configured byte bound."""
        rendered = self._record(event)
        with self._exclusive():
            self._validate_path()
            retained = self._read_retained(self.max_bytes - len(rendered.encode("utf-8")))
            self._replace_log(retained + rendered)

    def ensure_available(self) -> None:
        """Prove the audit destination is safe before a lifecycle mutation."""
        self._validate_path()
        if self.path.exists() and not os.access(self.path, os.W_OK):
            raise RuntimeError("event log is unavailable")
