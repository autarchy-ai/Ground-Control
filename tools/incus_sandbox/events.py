"""Bounded allowlisted lifecycle events owned by the host."""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any


_ACTIONS = {"create", "boot", "attach", "stop", "start", "delete", "status", "diagnose"}
_OUTCOMES = {"success", "failure", "denied"}
_ERRORS = {"none", "admission_observation_stale", "admission_insufficient", "command_failed",
           "invalid_input", "event_unavailable"}
_FIELDS = {"schema", "timestamp", "duration_ms", "event_id", "host_id", "operation_id",
           "sandbox_id", "action", "outcome", "error_code", "assigned", "observed"}


class EventWriter:
    """Writes one root-owned, rotation-bounded JSONL event stream."""

    def __init__(self, path: Path, max_bytes: int, *, expected_uid: int = 0) -> None:
        self.path = path
        self.max_bytes = max_bytes
        self.expected_uid = expected_uid

    def write(self, event: dict[str, Any]) -> None:
        if set(event) - {"action", "outcome", "sandbox_id", "error_code", "assigned", "observed", "duration_ms"}:
            raise ValueError("event contains an unallowlisted field")
        action = event.get("action")
        outcome = event.get("outcome")
        if action not in _ACTIONS or outcome not in _OUTCOMES:
            raise ValueError("event has an unsupported action or outcome")
        error_code = event.get("error_code", "none")
        if error_code not in _ERRORS:
            raise ValueError("event has an unsupported error code")
        sandbox_id = event.get("sandbox_id")
        if sandbox_id is not None and (not isinstance(sandbox_id, str) or len(sandbox_id) > 63):
            raise ValueError("event sandbox id is invalid")
        self.path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        if self.path.exists():
            current = self.path.lstat()
            if self.path.is_symlink() or not self.path.is_file() or current.st_uid != self.expected_uid:
                raise RuntimeError("event log path is unsafe")
        record = {
            "schema": "gc.incus-sandbox.event/v1",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "duration_ms": int(event.get("duration_ms", 0)),
            "event_id": str(uuid.uuid4()),
            "host_id": "local",
            "operation_id": str(uuid.uuid4()),
            "sandbox_id": sandbox_id,
            "action": action,
            "outcome": outcome,
            "error_code": error_code,
        }
        for field in ("assigned", "observed"):
            value = event.get(field)
            if value is not None:
                if not isinstance(value, dict) or set(value) - {"cpu", "memory_mib", "disk_gib", "fresh"}:
                    raise ValueError("event resource facts are invalid")
                record[field] = value
        rendered = json.dumps(record, separators=(",", ":")) + "\n"
        if len(rendered.encode("utf-8")) > self.max_bytes:
            raise RuntimeError("one event exceeds the configured log bound")
        previous = self.path.read_text(encoding="utf-8") if self.path.exists() else ""
        remaining = self.max_bytes - len(rendered.encode("utf-8"))
        while previous and len(previous.encode("utf-8")) > remaining:
            previous = previous.partition("\n")[2]
        self.path.write_text(previous + rendered, encoding="utf-8")
        os.chmod(self.path, 0o640)

    def ensure_available(self) -> None:
        """Prove the audit destination is safe before a lifecycle mutation."""
        self.path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        if self.path.exists():
            current = self.path.lstat()
            if self.path.is_symlink() or not self.path.is_file() or current.st_uid != self.expected_uid:
                raise RuntimeError("event log path is unsafe")
            if not os.access(self.path, os.W_OK):
                raise RuntimeError("event log is unavailable")
