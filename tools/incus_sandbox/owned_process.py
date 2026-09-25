"""Deadline-bounded execution that owns and reaps each child's whole process tree.

The root-side Incus helpers hold the allocation flock or a per-sandbox state lock
while they run Incus. A hung daemon, transport, or guest command used to keep that
lock forever (issue #1720). Every fixed-argv call therefore goes through
`run_owned`: the child leads its own POSIX session, the call has a finite wall
deadline, and on timeout, interruption, or leader exit the whole group is
signalled TERM then KILL and confirmed empty before control returns, so a lock is
never released while a descendant of the call is still running.

`subprocess.run(timeout=...)` is not a substitute: it kills only the direct child
and then waits without a limit for any descendant still holding the pipes.
"""

from __future__ import annotations

import math
import os
import signal
import subprocess
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from types import FrameType

KILL_GRACE_SECONDS = 5.0
# SIGKILL cannot be ignored; this only bounds how long the kernel takes to reap.
_POST_KILL_CONFIRM_SECONDS = 2.0
_POLL_SECONDS = 0.02
# sudo relays these to the helper when its caller gives up, and a terminal sends
# SIGINT; each must reap the child group rather than orphan it.
_INTERRUPTS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
# (stdin, stdout and stderr, decode as text) for each closed stream mode. `inherit`
# keeps the operator's terminal, `discard` keeps child output off the host, and
# `capture` returns decoded output. Supplied input always arrives on a pipe.
_STREAMS = {
    "inherit": (None, None, False),
    "discard": (subprocess.DEVNULL, subprocess.DEVNULL, False),
    "capture": (subprocess.DEVNULL, subprocess.PIPE, True),
}


class OperationInterrupted(subprocess.SubprocessError):
    """The helper was signalled while a child ran; the child group was reaped first."""

    def __init__(self, signum: int) -> None:
        """Record which signal interrupted the call."""
        super().__init__(f"interrupted by {signal.Signals(signum).name}")
        self.signum = signum


def _require_deadline(deadline_seconds: object) -> float:
    """Accept only a finite positive number of seconds; nothing means unlimited."""
    if (isinstance(deadline_seconds, bool) or not isinstance(deadline_seconds, (int, float))
            or not math.isfinite(deadline_seconds) or deadline_seconds <= 0):
        raise ValueError("a finite positive deadline is required")
    return float(deadline_seconds)


def _group_alive(pgid: int) -> bool:
    """Report whether any process, a zombie included, is still in the group."""
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    return True


def _signal_group(pgid: int, signum: int) -> None:
    """Signal the group; an already-empty group needs nothing."""
    try:
        os.killpg(pgid, signum)
    except ProcessLookupError:
        pass


def _await_group_exit(process: subprocess.Popen[str], until: float) -> bool:
    """Poll until the group is empty; polling also reaps the leader's zombie."""
    while time.monotonic() < until:
        process.poll()
        if not _group_alive(process.pid):
            return True
        time.sleep(_POLL_SECONDS)
    process.poll()
    return not _group_alive(process.pid)


def reap_group(process: subprocess.Popen[str], grace_seconds: float = KILL_GRACE_SECONDS) -> None:
    """Terminate the child's group, escalating to SIGKILL, and confirm it is empty."""
    if not _group_alive(process.pid):
        process.poll()
        return
    _signal_group(process.pid, signal.SIGTERM)
    if _await_group_exit(process, time.monotonic() + grace_seconds):
        return
    _signal_group(process.pid, signal.SIGKILL)
    if not _await_group_exit(process, time.monotonic() + _POST_KILL_CONFIRM_SECONDS):
        raise OSError("a child process group survived SIGKILL")


def _reap_uninterrupted(process: subprocess.Popen[str], grace_seconds: float) -> None:
    """Hold termination signals until the group is gone; they are delivered afterwards."""
    blocked = signal.pthread_sigmask(signal.SIG_BLOCK, _INTERRUPTS)
    try:
        reap_group(process, grace_seconds)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, blocked)


@contextmanager
def _interrupts_raise() -> Iterator[None]:
    """Turn termination signals into an exception so cleanup runs before exit."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return

    def interrupt(signum: int, _frame: FrameType | None) -> None:
        """Unwind the wait so the caller reaps the group before exiting."""
        raise OperationInterrupted(signum)

    previous = {signum: signal.signal(signum, interrupt) for signum in _INTERRUPTS}
    try:
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def run_owned(argv: list[str], *, deadline_seconds: float, streams: str = "inherit",
              input: bytes | str | None = None, check: bool = True,
              grace_seconds: float = KILL_GRACE_SECONDS) -> subprocess.CompletedProcess[str]:
    """Run one fixed argv as the leader of its own process group, bounded by a deadline.

    A captured stream held open by a descendant after the leader exits keeps the
    call waiting until the deadline, which then reaps it; that is why callers that
    do not read output discard it.
    """
    deadline = _require_deadline(deadline_seconds)
    if os.name != "posix":
        raise OSError("owned process groups require POSIX; no tested equivalent exists")
    stdin, output_stream, text = _STREAMS[streams]
    with _interrupts_raise():
        process = subprocess.Popen(
            argv, stdin=subprocess.PIPE if input is not None else stdin, stdout=output_stream,
            stderr=output_stream, text=text, start_new_session=True,
        )
        try:
            output, errors = process.communicate(input, timeout=deadline)
        except subprocess.TimeoutExpired:
            _reap_uninterrupted(process, grace_seconds)
            # Name only the executable: argv can carry sandbox paths and guest commands.
            raise subprocess.TimeoutExpired(os.path.basename(argv[0]), deadline_seconds) from None
        except BaseException:
            _reap_uninterrupted(process, grace_seconds)
            raise
        # The leader exited; a descendant it left behind must not outlive the call.
        _reap_uninterrupted(process, grace_seconds)
    if check and process.returncode:
        raise subprocess.CalledProcessError(process.returncode, argv, output, errors)
    return subprocess.CompletedProcess(argv, process.returncode, output, errors)


# A deadline or a failed child; an interruption is neither and always propagates.
COMMAND_ERRORS = (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired)


def capture(argv: list[str], deadline_seconds: float) -> str:
    """Run one fixed query argv under its deadline and return its standard output."""
    return run_owned(argv, deadline_seconds=deadline_seconds, streams="capture").stdout
