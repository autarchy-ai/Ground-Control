"""Real stalled-process fixtures for the Incus deadline tests (issue #1720)."""

from __future__ import annotations

import os
import time
from pathlib import Path

# A stand-in for the Incus client. Each call is logged, and a mode file decides
# whether it succeeds, fails, or stalls while holding a descendant, the shape of a
# hung daemon call whose client never returns. `mode.<subcommand>.<last argument>`
# takes precedence over `mode.<subcommand>`.
_FAKE_INCUS = """#!/bin/sh
dir="$FAKE_INCUS_DIR"
printf '%s\\n' "$*" >> "$dir/calls.log"
for last; do :; done
mode=$(cat "$dir/mode.$1.$last" 2>/dev/null || cat "$dir/mode.$1" 2>/dev/null || echo ok)
case "$mode" in
  stall) sleep 300 & echo $! > "$dir/descendant.pid"; wait ;;
  fail) exit 1 ;;
  *) if [ -f "$dir/out.$1" ]; then cat "$dir/out.$1"; fi; exit 0 ;;
esac
"""


def write_fake_incus(directory: Path) -> Path:
    """Install the fake client in `directory` and return its path."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "incus"
    path.write_text(_FAKE_INCUS, encoding="utf-8")
    path.chmod(0o755)
    return path


def calls(directory: Path) -> list[str]:
    """Return the fake client's recorded argument lines."""
    log = directory / "calls.log"
    return log.read_text(encoding="utf-8").splitlines() if log.exists() else []


def process_alive(pid: int) -> bool:
    """Report whether `pid` still exists."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def wait_for_file(path: Path, timeout: float = 10.0) -> None:
    """Block until a fixture writes `path`."""
    deadline = time.monotonic() + timeout
    while not path.exists() or not path.read_text(encoding="utf-8").strip():
        if time.monotonic() > deadline:
            raise AssertionError(f"fixture never wrote {path.name}")
        time.sleep(0.02)


def descendant_pid(directory: Path) -> int:
    """Return the pid the stalled fixture recorded for its descendant."""
    path = directory / "descendant.pid"
    wait_for_file(path)
    return int(path.read_text(encoding="utf-8").strip())


def kill_quietly(pid: int) -> None:
    """Defensive cleanup so a failing test never leaves a stalled fixture behind."""
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
