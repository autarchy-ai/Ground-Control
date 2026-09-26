"""The owned-process primitive bounds and reaps every Incus helper child (issue #1720)."""

from __future__ import annotations

import os
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

from tools.incus_sandbox.owned_process import OperationInterrupted, run_owned
from tools.tests.incus_process_fixtures import kill_quietly, process_alive, wait_for_file


def _stalled_with_descendant(pid_file: Path) -> list[str]:
    """A leader that forks a long-lived descendant and then blocks on it."""
    return ["/bin/sh", "-c", f"sleep 300 & echo $! > {pid_file}; wait"]


def recorded_pid(pid_file: Path) -> int:
    """The descendant pid the stalled leader recorded."""
    wait_for_file(pid_file)
    return int(pid_file.read_text(encoding="utf-8"))


class OwnedProcessTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="gc-owned-process-")
        self.pid_file = Path(self.temporary.name) / "descendant.pid"

    def tearDown(self) -> None:
        if self.pid_file.exists() and self.pid_file.read_text(encoding="utf-8").strip():
            kill_quietly(int(self.pid_file.read_text(encoding="utf-8")))
        self.temporary.cleanup()

    def test_deadline_reaps_the_stalled_leader_and_its_descendant(self) -> None:
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired) as raised:
            run_owned(_stalled_with_descendant(self.pid_file), deadline_seconds=1)
        self.assertLess(time.monotonic() - started, 4)
        self.assertFalse(process_alive(recorded_pid(self.pid_file)))
        # The diagnostic names the executable and deadline, never argv content.
        self.assertEqual(raised.exception.cmd, "sh")
        self.assertEqual(raised.exception.timeout, 1)
        self.assertNotIn(str(self.pid_file), str(raised.exception))

    def test_a_descendant_left_behind_by_an_exited_leader_is_reaped(self) -> None:
        argv = ["/bin/sh", "-c", f"sleep 300 & echo $! > {self.pid_file}"]
        completed = run_owned(argv, deadline_seconds=30, streams="discard")
        self.assertEqual(completed.returncode, 0)
        self.assertFalse(process_alive(recorded_pid(self.pid_file)))

    def test_termination_while_waiting_reaps_the_group_and_interrupts(self) -> None:
        previous = signal.getsignal(signal.SIGTERM)
        timer = threading.Timer(0.5, lambda: os.kill(os.getpid(), signal.SIGTERM))
        timer.start()
        started = time.monotonic()
        try:
            with self.assertRaises(OperationInterrupted):
                run_owned(_stalled_with_descendant(self.pid_file), deadline_seconds=60)
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - started, 5)
        self.assertFalse(process_alive(recorded_pid(self.pid_file)))
        self.assertIs(signal.getsignal(signal.SIGTERM), previous)

    def test_a_tree_that_ignores_sigterm_is_killed_after_the_grace(self) -> None:
        argv = ["/bin/sh", "-c", f"trap '' TERM; sleep 300 & echo $! > {self.pid_file}; wait"]
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            run_owned(argv, deadline_seconds=0.5, grace_seconds=0.3)
        self.assertLess(time.monotonic() - started, 4)
        self.assertFalse(process_alive(recorded_pid(self.pid_file)))

    def test_a_call_from_a_worker_thread_is_still_bounded(self) -> None:
        raised: list[BaseException] = []

        def worker() -> None:
            try:
                run_owned(_stalled_with_descendant(self.pid_file), deadline_seconds=0.5)
            except subprocess.TimeoutExpired as error:
                raised.append(error)

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(10)
        self.assertEqual(len(raised), 1)
        self.assertFalse(process_alive(recorded_pid(self.pid_file)))

    def test_input_and_captured_output_round_trip(self) -> None:
        completed = run_owned(["/bin/cat"], deadline_seconds=10, input="frame", streams="capture")
        self.assertEqual(completed.stdout, "frame")

    def test_a_failed_command_raises_when_checked(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError):
            run_owned(["/bin/false"], deadline_seconds=10)
        self.assertEqual(run_owned(["/bin/false"], deadline_seconds=10, check=False).returncode, 1)

    def test_a_deadline_must_be_finite_and_positive(self) -> None:
        for invalid in (None, 0, -1, True, float("inf"), float("nan")):
            with self.subTest(deadline=invalid), self.assertRaises(ValueError):
                run_owned(["/bin/true"], deadline_seconds=invalid)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
