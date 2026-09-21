"""Root-side authorization, resolution, delivery, and redacted task state."""

from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable, Iterator

if __package__:
    from .repository_environment import (
        DeclarationError, MAX_TASK_FRAME_BYTES, parse_repository_environment,
    )
else:
    from repository_environment import DeclarationError, MAX_TASK_FRAME_BYTES, parse_repository_environment


class ProviderError(RuntimeError):
    """A task environment cannot be authorized or completely resolved."""


_NAME = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
_TASK_ID = re.compile(r"^[0-9a-f]{32}$")
_MAX_REQUEST_BYTES = 96 * 1024
_LAUNCHER = "/usr/local/lib/gc-incus-sandbox/task-launcher.py"
_INCUS = "/usr/bin/incus"


def _atomic_json(path: Path, document: object) -> None:
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                         prefix=f"{path.name}-", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(document, handle, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def record_source_binding(state_dir: Path, sandbox: str, repository: str, declaration: bytes) -> str:
    """Persist only the identity and digest established by source preparation."""
    if not _NAME.fullmatch(sandbox):
        raise ProviderError("sandbox identity is invalid")
    digest = hashlib.sha256(declaration).hexdigest()
    record_source_digest(state_dir, sandbox, repository, digest)
    return digest


def record_source_digest(state_dir: Path, sandbox: str, repository: str, digest: str) -> None:
    """Record a packet-carried declaration digest without receiving declaration content."""
    if (not _NAME.fullmatch(sandbox) or not isinstance(repository, str)
            or not re.fullmatch(r"[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}", repository)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)):
        raise ProviderError("source environment binding is invalid")
    _atomic_json(state_dir / "source-bindings" / f"{sandbox}.json", {
        "schema": "gc.incus-sandbox.source-binding/v1",
        "repository": repository,
        "declaration_digest": digest,
    })


def clear_source_binding(state_dir: Path, sandbox: str) -> None:
    """Remove all authority derived from a replaced or deleted source."""
    if not _NAME.fullmatch(sandbox):
        raise ProviderError("sandbox identity is invalid")
    (state_dir / "source-bindings" / f"{sandbox}.json").unlink(missing_ok=True)
    (state_dir / "tasks" / f"{sandbox}.json").unlink(missing_ok=True)


@contextlib.contextmanager
def state_lock(state_dir: Path, sandbox: str) -> Iterator[None]:
    """Serialize source replacement and task lifecycle for one sandbox."""
    if not _NAME.fullmatch(sandbox):
        raise ProviderError("sandbox identity is invalid")
    lock_dir = state_dir / "task-locks"
    lock_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
    descriptor = os.open(lock_dir / f"{sandbox}.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


class TaskEnvironmentService(object):
    """Resolve a bound declaration and stream it once to the fixed guest launcher."""

    def __init__(self, *, project: str, state_dir: Path, operator_uid: int,
                 repositories: dict[str, dict[str, dict[str, object]]],
                 active_owner: Callable[[str, int], bool],
                 runner: Callable[..., object], expected_provider_uid: int = 0,
                 max_value_bytes: int = 16 * 1024,
                 task_id_factory: Callable[[], str] = lambda: secrets.token_hex(16)) -> None:
        self.project = project
        self.state_dir = state_dir
        self.operator_uid = operator_uid
        self.repositories = repositories
        self.active_owner = active_owner
        self.runner = runner
        self.expected_provider_uid = expected_provider_uid
        self.max_value_bytes = max_value_bytes
        self.task_id_factory = task_id_factory

    @staticmethod
    def _sandbox(sandbox: str) -> str:
        if not isinstance(sandbox, str) or not _NAME.fullmatch(sandbox):
            raise ProviderError("sandbox identity is invalid")
        return sandbox

    def _authorize(self, sandbox: str, caller_uid: int) -> None:
        if caller_uid != self.operator_uid or not self.active_owner(sandbox, caller_uid):
            raise ProviderError("task start is not authorized")

    def _request(self, raw: bytes) -> tuple[str, bytes]:
        if not isinstance(raw, bytes) or not raw or len(raw) > _MAX_REQUEST_BYTES:
            raise ProviderError("task start request is invalid")
        try:
            request = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProviderError("task start request is invalid") from exc
        expected = {"schema", "repository", "declaration_b64"}
        if not isinstance(request, dict) or set(request) != expected:
            raise ProviderError("task start request is invalid")
        if request.get("schema") != "gc.incus-sandbox.task-start/v1":
            raise ProviderError("task start request is invalid")
        repository = request.get("repository")
        encoded = request.get("declaration_b64")
        if not isinstance(repository, str) or not isinstance(encoded, str):
            raise ProviderError("task start request is invalid")
        try:
            declaration = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise ProviderError("task start request is invalid") from exc
        return repository, declaration

    def _binding(self, sandbox: str) -> dict[str, str]:
        try:
            binding = json.loads((self.state_dir / "source-bindings" / f"{sandbox}.json").read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise ProviderError("sandbox has no valid source binding") from exc
        expected = {"schema", "repository", "declaration_digest"}
        if not isinstance(binding, dict) or set(binding) != expected:
            raise ProviderError("sandbox has no valid source binding")
        return binding

    def _provider_value(self, repository: str, alias: str) -> bytes:
        try:
            locator = self.repositories[repository][alias]
        except KeyError as exc:
            raise ProviderError("a required task value is unavailable") from exc
        if isinstance(locator, dict):
            if set(locator) != {"path", "state"}:
                raise ProviderError("a required task value is unavailable")
            path, state = locator.get("path"), locator.get("state")
        else:
            path, state = getattr(locator, "path", None), getattr(locator, "state", None)
        if state != "available":
            raise ProviderError("a required task value is unavailable")
        if isinstance(path, str):
            path = Path(path)
        if not isinstance(path, Path) or not path.is_absolute():
            raise ProviderError("a required task value is unavailable")
        descriptor: int | None = None
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            details = os.fstat(descriptor)
            if (not stat.S_ISREG(details.st_mode) or details.st_uid != self.expected_provider_uid
                    or details.st_mode & 0o077):
                raise ProviderError("a required task value is unavailable")
            value = os.read(descriptor, self.max_value_bytes + 1)
        except OSError as exc:
            raise ProviderError("a required task value is unavailable") from exc
        finally:
            if descriptor is not None:
                os.close(descriptor)
        if not value or len(value) > self.max_value_bytes or b"\0" in value:
            raise ProviderError("a required task value is unavailable")
        try:
            value.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ProviderError("a required task value is unavailable") from exc
        return value

    def _resolve(self, parsed: object) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
        frame, redacted = [], []
        for item in parsed.variables:
            if item.literal is not None:
                value = item.literal.encode("utf-8")
                source = "literal"
            else:
                value = self._provider_value(parsed.repository, item.secret_ref)
                source = "secret"
            frame.append({"name": item.name, "value_b64": base64.b64encode(value).decode("ascii")})
            redacted.append({"name": item.name, "source": source, "state": "available"})
        return frame, redacted

    def _start_argv(self, sandbox: str) -> list[str]:
        return [_INCUS, "exec", sandbox, "--project", self.project, "--",
                "/usr/bin/python3", _LAUNCHER, "start"]

    def _stop_argv(self, sandbox: str) -> list[str]:
        return [_INCUS, "exec", sandbox, "--project", self.project, "--",
                "/usr/bin/python3", _LAUNCHER, "stop"]

    def start(self, sandbox: str, request: bytes, caller_uid: int) -> dict[str, object]:
        sandbox = self._sandbox(sandbox)
        with state_lock(self.state_dir, sandbox):
            return self._start_locked(sandbox, request, caller_uid)

    def _start_locked(self, sandbox: str, request: bytes, caller_uid: int) -> dict[str, object]:
        self._authorize(sandbox, caller_uid)
        repository, raw_declaration = self._request(request)
        binding = self._binding(sandbox)
        digest = hashlib.sha256(raw_declaration).hexdigest()
        if binding.get("repository") != repository or binding.get("declaration_digest") != digest:
            raise ProviderError("task declaration does not match the prepared source")
        try:
            parsed = parse_repository_environment(
                raw_declaration, repository, max_value_bytes=self.max_value_bytes,
            )
        except DeclarationError as exc:
            raise ProviderError("task environment declaration is invalid") from exc
        task_id = self.task_id_factory()
        if not _TASK_ID.fullmatch(task_id):
            raise ProviderError("task identity generation failed")
        variables, redacted = self._resolve(parsed)
        frame = json.dumps({
            "schema": "gc.incus-sandbox.task-frame/v1", "task_id": task_id,
            "variables": variables,
        }, separators=(",", ":")).encode()
        if len(frame) > MAX_TASK_FRAME_BYTES:
            raise ProviderError("resolved task environment exceeds the delivery limit")
        self.runner(self._start_argv(sandbox), input_bytes=frame)
        state = {
            "schema": "gc.incus-sandbox.task-state/v1", "task_id": task_id,
            "repository": repository, "declaration_digest": parsed.digest,
            "variables": redacted,
        }
        try:
            _atomic_json(self.state_dir / "tasks" / f"{sandbox}.json", state)
        except Exception:
            self.runner(self._stop_argv(sandbox), input_bytes=None)
            raise
        return state

    def stop(self, sandbox: str, caller_uid: int) -> None:
        sandbox = self._sandbox(sandbox)
        with state_lock(self.state_dir, sandbox):
            self._stop_locked(sandbox, caller_uid)

    def _stop_locked(self, sandbox: str, caller_uid: int) -> None:
        self._authorize(sandbox, caller_uid)
        self.runner(self._stop_argv(sandbox), input_bytes=None)
        (self.state_dir / "tasks" / f"{sandbox}.json").unlink(missing_ok=True)

    def restart(self, sandbox: str, request: bytes, caller_uid: int) -> dict[str, object]:
        sandbox = self._sandbox(sandbox)
        with state_lock(self.state_dir, sandbox):
            self._stop_locked(sandbox, caller_uid)
            return self._start_locked(sandbox, request, caller_uid)

    def status(self, sandbox: str) -> dict[str, object]:
        sandbox = self._sandbox(sandbox)
        try:
            state = json.loads((self.state_dir / "tasks" / f"{sandbox}.json").read_text())
        except (OSError, json.JSONDecodeError):
            return {"schema": "gc.incus-sandbox.task-status/v1", "state": "not_started", "variables": []}
        return {
            "schema": "gc.incus-sandbox.task-status/v1", "state": "running",
            "task_id": state["task_id"], "variables": state["variables"],
        }


def _run_guest(argv: list[str], input_bytes: bytes | None = None) -> None:
    """Run the fixed guest endpoint without returning child output or placing input in argv."""
    subprocess.run(argv, input=input_bytes, check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


def main(argv: list[str]) -> int:
    """Authenticate the operator and expose only the closed task lifecycle."""
    if os.geteuid() != 0 or len(argv) != 2 or argv[0] not in {"start", "restart", "stop"}:
        raise ProviderError("usage: task_environment.py {start|restart|stop} SANDBOX")
    sudo_uid = os.environ.get("SUDO_UID")
    if sudo_uid is None or not sudo_uid.isdecimal():
        raise ProviderError("task lifecycle requires the calling operator identity")
    if __package__:
        from .config import load_config
        from .events import EventWriter
        from .helper import LifecycleHelper
    else:
        from config import load_config
        from events import EventWriter
        from helper import LifecycleHelper
    config = load_config(Path("/etc/gc-incus-sandbox/config.json"))
    caller_uid = int(sudo_uid)
    events = EventWriter(config.event_log, config.event_max_bytes)
    lifecycle = LifecycleHelper(config, event_writer=events, caller_uid=caller_uid)

    def active_owner(sandbox: str, uid: int) -> bool:
        if uid != caller_uid:
            return False
        lifecycle.require_active_owner(sandbox)
        return True

    service = TaskEnvironmentService(
        project=config.project, state_dir=config.state_dir, operator_uid=config.operator_uid,
        repositories=config.task_environment.repositories, active_owner=active_owner,
        runner=_run_guest, max_value_bytes=config.task_environment.max_value_bytes,
    )
    action, sandbox = argv
    event_action = f"task_{action}"
    try:
        if action in {"start", "restart"}:
            request = sys.stdin.buffer.read(_MAX_REQUEST_BYTES + 1)
            getattr(service, action)(sandbox, request, caller_uid)
        elif action == "stop":
            service.stop(sandbox, caller_uid)
        events.write({"action": event_action, "outcome": "success", "sandbox_id": sandbox})
    except Exception:
        events.write({"action": event_action, "outcome": "failure", "sandbox_id": sandbox,
                      "error_code": "task_unavailable"})
        raise
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
        # Provider paths, aliases, values, child output, and raw errors never cross this boundary.
        print("task environment operation failed", file=sys.stderr)
        raise SystemExit(64) from exc
