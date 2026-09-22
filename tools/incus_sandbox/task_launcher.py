#!/usr/bin/python3
"""Fixed guest launcher for one ephemeral environment-bearing task session."""

from __future__ import annotations

import base64
import json
import os
import re
import socket
import subprocess
import sys
import time

if __package__:
    from .repository_environment import DeclarationError, MAX_TASK_FRAME_BYTES, valid_environment_name
else:
    from repository_environment import DeclarationError, MAX_TASK_FRAME_BYTES, valid_environment_name


class FrameError(RuntimeError):
    """The host-to-guest task frame is outside the closed contract."""


_MAX_VALUE_BYTES = 16 * 1024
_TASK_ID = re.compile(r"^[0-9a-f]{32}$")
_TMUX = "/usr/bin/tmux"
_SYSTEMCTL = "/usr/bin/systemctl"
_SYSTEMD_RUN = "/usr/bin/systemd-run"
_SESSION = "gc-task"
_UNIT = "gc-sandbox-task.service"
_RUNTIME = "/run/gc-sandbox-task"
_INPUT_SOCKET = f"{_RUNTIME}/input.sock"
_CONTROL_SOCKET = f"{_RUNTIME}/control"
_READY = f"{_RUNTIME}/ready"
_WORKSPACE = "/home/sandbox/workspace"
_LAUNCHER = "/usr/local/lib/gc-incus-sandbox/task-launcher.py"
_INVALID_VARIABLE = "task frame variable is invalid"


def _valid_frame_shape(frame: object) -> bool:
    """Check the envelope fields without interpreting variable entries."""
    if not isinstance(frame, dict) or set(frame) != {"schema", "task_id", "variables"}:
        return False
    task_id, variables = frame.get("task_id"), frame.get("variables")
    return (
        frame.get("schema") == "gc.incus-sandbox.task-frame/v1"
        and isinstance(task_id, str) and bool(_TASK_ID.fullmatch(task_id))
        and isinstance(variables, list) and len(variables) <= 128
    )


def _frame(raw: bytes) -> dict[str, object]:
    """Decode and validate the closed task frame envelope."""
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_TASK_FRAME_BYTES:
        raise FrameError("task frame size is invalid")
    try:
        frame = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FrameError("task frame is invalid") from exc
    if not _valid_frame_shape(frame):
        raise FrameError("task frame is invalid")
    return frame


def _variable(item: object, names: set[str]) -> tuple[str, str]:
    """Decode one unique bounded environment entry."""
    if not isinstance(item, dict) or set(item) != {"name", "value_b64"}:
        raise FrameError(_INVALID_VARIABLE)
    try:
        name = valid_environment_name(item.get("name"))
    except DeclarationError as exc:
        raise FrameError(_INVALID_VARIABLE) from exc
    if name in names or not isinstance(item.get("value_b64"), str):
        raise FrameError(_INVALID_VARIABLE)
    try:
        value = base64.b64decode(item["value_b64"], validate=True)
        decoded = value.decode("utf-8")
    except ValueError as exc:
        raise FrameError(_INVALID_VARIABLE) from exc
    if len(value) > _MAX_VALUE_BYTES or b"\0" in value:
        raise FrameError(_INVALID_VARIABLE)
    return name, decoded


def environment_from_frame(raw: bytes, ambient: dict[str, str]) -> dict[str, str]:
    """Validate a bounded frame and build an environment without ambient inheritance."""
    frame = _frame(raw)
    environment = {
        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": _RUNTIME,
        "SHELL": "/bin/bash",
    }
    term = ambient.get("TERM")
    if isinstance(term, str) and 0 < len(term) <= 64 and "\0" not in term:
        environment["TERM"] = term
    names: set[str] = set()
    for item in frame["variables"]:
        name, decoded = _variable(item, names)
        environment[name] = decoded
        names.add(name)
    return environment


def systemd_run_command() -> list[str]:
    """Return the fixed transient-service boundary; no value or caller input enters argv."""
    properties = (
        "DynamicUser=yes", "SupplementaryGroups=sandbox",
        "RuntimeDirectory=gc-sandbox-task", "RuntimeDirectoryMode=0700",
        f"WorkingDirectory={_WORKSPACE}", f"ReadWritePaths={_WORKSPACE}",
        "PrivateTmp=yes", "PrivateDevices=yes", "ProtectProc=invisible", "ProcSubset=pid",
        "NoNewPrivileges=yes", "RestrictSUIDSGID=yes", "LockPersonality=yes",
        "KillMode=control-group", "LimitCORE=0",
    )
    command = [_SYSTEMD_RUN, "--quiet", f"--unit={_UNIT}"]
    command.extend(f"--property={item}" for item in properties)
    return command + ["--", "/usr/bin/python3", _LAUNCHER, "child"]


def _stop_unit() -> None:
    """Stop and collect the fixed transient task unit if it exists."""
    active = subprocess.run([_SYSTEMCTL, "is-active", "--quiet", _UNIT],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if active.returncode == 0:
        subprocess.run([_SYSTEMCTL, "stop", _UNIT], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([_SYSTEMCTL, "reset-failed", _UNIT], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _send_frame(raw: bytes, timeout_seconds: float = 5.0) -> None:
    """Send the validated frame once through the private task socket."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            client.connect(_INPUT_SOCKET)
            client.sendall(raw)
            client.shutdown(socket.SHUT_WR)
            client.close()
            return
        except (FileNotFoundError, ConnectionRefusedError):
            client.close()
            time.sleep(0.05)
        except Exception:
            client.close()
            raise
    raise FrameError("task service did not accept its input")


def start(raw: bytes) -> None:
    """Start a fresh dynamic-UID service, then deliver its one bounded frame by socket."""
    if os.geteuid() != 0:
        raise FrameError("task service control requires guest root")
    environment_from_frame(raw, {})
    try:
        subprocess.run(systemd_run_command(), check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        _send_frame(raw)
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if os.path.isfile(_READY):
                return
            time.sleep(0.05)
    except Exception:
        _stop_unit()
        raise
    _stop_unit()
    raise FrameError("task service did not become ready")


def _read_socket(connection: socket.socket) -> bytes:
    """Read one bounded frame until the root launcher closes its write side."""
    chunks, total = [], 0
    while True:
        chunk = connection.recv(min(65536, MAX_TASK_FRAME_BYTES - total + 1))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > MAX_TASK_FRAME_BYTES:
            raise FrameError("task frame size is invalid")
        chunks.append(chunk)


def child() -> None:
    """Receive one frame inside the dynamic identity and own the complete task scope."""
    if os.geteuid() == 0:
        raise FrameError("task child requires a dynamic service identity")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(_INPUT_SOCKET)
    os.chmod(_INPUT_SOCKET, 0o600)
    server.listen(1)
    with server, server.accept()[0] as connection:
        raw = _read_socket(connection)
    os.unlink(_INPUT_SOCKET)
    environment = environment_from_frame(raw, {})
    subprocess.run([_TMUX, "-S", _CONTROL_SOCKET, "new-session", "-d", "-s", _SESSION,
                    "-c", _WORKSPACE, "/bin/bash", "--noprofile", "--norc"],
                   check=True, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    descriptor = os.open(_READY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    os.execve(_TMUX, [_TMUX, "-S", _CONTROL_SOCKET, "wait-for", "gc-task-lifetime"], environment)


def stop() -> None:
    """Terminate every process in the transient task service's cgroup."""
    if os.geteuid() != 0:
        raise FrameError("task service control requires guest root")
    _stop_unit()


def main(argv: list[str]) -> int:
    """Dispatch the fixed internal guest task lifecycle."""
    if argv == ["start"]:
        start(sys.stdin.buffer.read(MAX_TASK_FRAME_BYTES + 1))
        return 0
    if argv == ["child"]:
        child()
        return 0
    if argv == ["stop"]:
        stop()
        return 0
    raise FrameError("usage: task-launcher.py {start|child|stop}")


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except FrameError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
