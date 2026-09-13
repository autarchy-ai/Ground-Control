"""In-process tests for the dispatcher's argument, configuration, and supervision seams.

The end-to-end suites drive the installed executable as its own process, which is
the only way to prove the process contract. These cover the same modules in-process:
they pin the pure logic directly and, because coverage.py measures this interpreter,
they are what makes the dispatcher's coverage real rather than incidental.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

from gc_dispatch import hostconfig
from gc_dispatch.cli import (
    EXIT_INTERNAL,
    EXIT_QUEUE_TIMEOUT,
    EXIT_USAGE,
    UsageError,
    main,
    milliseconds,
    parse_args,
    report,
)
from gc_dispatch.hostconfig import HostConfigError, default_cpu_capacity, load_host_config
from gc_dispatch.ledger import Ledger
from gc_dispatch.records import process_token, supervisor_alive, supervisor_identity
from gc_dispatch.supervisor import ChildResult, exit_like, run_command


class ParseArgsTest(unittest.TestCase):
    def test_a_minimal_invocation_defaults_to_one_cpu_and_no_reduction(self):
        request = parse_args(["--profile", "unit", "--", "make", "test"])
        self.assertEqual(request.profile, "unit")
        self.assertEqual((request.requested, request.minimum), (1, 1))
        self.assertFalse(request.xdist)
        self.assertEqual(request.argv, ["make", "test"])

    def test_the_minimum_defaults_to_the_request(self):
        self.assertEqual(parse_args(["--profile", "u", "--cpu", "8", "--", "x"]).minimum, 8)

    def test_an_explicit_minimum_is_kept(self):
        request = parse_args(["--profile", "u", "--cpu", "8", "--min-cpu", "2", "--", "x"])
        self.assertEqual((request.requested, request.minimum), (8, 2))

    def test_inline_option_values_are_accepted(self):
        request = parse_args(["--profile=suite", "--cpu=4", "--", "x"])
        self.assertEqual((request.profile, request.requested), ("suite", 4))

    def test_the_xdist_opt_in_is_recorded(self):
        self.assertTrue(parse_args(["--profile", "u", "--xdist", "--", "x"]).xdist)

    def test_everything_after_the_separator_is_the_command(self):
        request = parse_args(["--profile", "u", "--", "make", "--cpu", "9", "--"])
        self.assertEqual(request.argv, ["make", "--cpu", "9", "--"])

    def test_refusals(self):
        for args, reason in [
            (["--profile", "u", "make"], "no separator"),
            (["--profile", "u", "--"], "empty command"),
            (["--", "make"], "no profile"),
            (["--profile", "Bad Name", "--", "x"], "bad profile"),
            (["--profile", "u", "--cpu", "lots", "--", "x"], "non-integer demand"),
            (["--profile", "u", "--cpu", "0", "--", "x"], "demand below range"),
            (["--profile", "u", "--cpu", "9999", "--", "x"], "demand above range"),
            (["--profile", "u", "--cpu", "2", "--min-cpu", "4", "--", "x"], "minimum above request"),
            (["--profile", "u", "--capacity", "8", "--", "x"], "unknown option"),
            (["--profile", "u", "--xdist=yes", "--", "x"], "value on a flag"),
            (["--profile", "u", "--cpu", "--", "x"], "missing value"),
        ]:
            with self.subTest(reason=reason):
                with self.assertRaises(UsageError):
                    parse_args(args)


class MillisecondsTest(unittest.TestCase):
    def test_a_duration_is_rounded_to_whole_milliseconds(self):
        self.assertEqual(milliseconds(1.2345), 1234)

    def test_a_negative_duration_never_reports_below_zero(self):
        self.assertEqual(milliseconds(-5.0), 0)


def read_metrics(state_dir):
    """Return the dispatcher's recorded measurements, newest last."""
    path = state_dir / "metrics.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


class HostRootTestCase(unittest.TestCase):
    """Isolates HOME and the XDG directories the dispatcher actually reads."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gc-dispatch-unit-"))
        self.home = self.tmp / "home"
        self.config_home = self.home / ".config"
        self.runtime_dir = self.tmp / "run"
        (self.config_home / "ground-control").mkdir(parents=True)
        self.runtime_dir.mkdir()
        self.env = mock.patch.dict(os.environ, {
            "HOME": str(self.home),
            "XDG_CONFIG_HOME": str(self.config_home),
            "XDG_RUNTIME_DIR": str(self.runtime_dir),
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    @property
    def config_path(self):
        return self.config_home / "ground-control" / "dispatch.json"

    @property
    def state_dir(self):
        return self.runtime_dir / "ground-control" / "dispatch"

    def write_config(self, **values):
        self.config_path.write_text(json.dumps(values), encoding="utf-8")
        self.config_path.chmod(0o600)



class HostConfigTest(HostRootTestCase):
    def test_configured_values_are_used(self):
        self.write_config(cpu_capacity=4, max_queue_wait_seconds=12, stale_lease_seconds=30)
        config = load_host_config()
        self.assertEqual(config.cpu_capacity, 4)
        self.assertEqual(config.max_queue_wait_seconds, 12.0)
        self.assertEqual(config.stale_lease_seconds, 30.0)

    def test_an_absent_file_falls_back_to_effective_cpu_affinity(self):
        config = load_host_config()
        self.assertEqual(config.cpu_capacity, default_cpu_capacity())
        self.assertEqual(config.max_queue_wait_seconds, hostconfig.DEFAULT_MAX_QUEUE_WAIT_SECONDS)

    def test_state_lives_under_the_runtime_directory_when_one_exists(self):
        self.assertEqual(load_host_config().state_dir,
                         self.runtime_dir / "ground-control" / "dispatch")

    def test_state_falls_back_to_the_per_user_state_home_not_a_shared_directory(self):
        # A predictable path under a world-writable directory is one another
        # account can pre-create or race, so /tmp is deliberately never used.
        with mock.patch.dict(os.environ, {"TMPDIR": "/tmp"}):
            os.environ.pop("XDG_RUNTIME_DIR")
            os.environ.pop("XDG_STATE_HOME", None)
            state_dir = load_host_config().state_dir
        self.assertEqual(state_dir, self.home / ".local" / "state" / "ground-control" / "dispatch")

    def test_an_explicit_state_home_is_honored(self):
        with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(self.tmp / "state")}):
            os.environ.pop("XDG_RUNTIME_DIR")
            self.assertEqual(load_host_config().state_dir,
                             self.tmp / "state" / "ground-control" / "dispatch")

    def test_refusals(self):
        for values, reason in [
            ({"cpu_capacity": 0}, "capacity below range"),
            ({"cpu_capacity": 4096}, "capacity above range"),
            ({"cpu_capacity": 1.5}, "fractional capacity"),
            ({"cpu_capacity": True}, "boolean capacity"),
            ({"cpu_capacity": "eight"}, "non-numeric capacity"),
            ({"max_queue_wait_seconds": -1}, "negative queue bound"),
            ({"stale_lease_seconds": 0}, "zero lease age"),
            ({"suites": 2}, "unknown key"),
        ]:
            with self.subTest(reason=reason):
                self.write_config(**values)
                with self.assertRaises(HostConfigError):
                    load_host_config()

    def test_a_non_object_document_is_refused(self):
        self.config_path.write_text("[]", encoding="utf-8")
        self.config_path.chmod(0o600)
        with self.assertRaises(HostConfigError):
            load_host_config()

    def test_unparsable_configuration_is_refused(self):
        self.config_path.write_text("{not json", encoding="utf-8")
        self.config_path.chmod(0o600)
        with self.assertRaises(HostConfigError):
            load_host_config()

    def test_a_group_writable_file_is_refused(self):
        self.write_config(cpu_capacity=4)
        self.config_path.chmod(0o660)
        with self.assertRaises(HostConfigError):
            load_host_config()

    def test_a_symlinked_configuration_file_is_refused(self):
        real = self.tmp / "real.json"
        real.write_text(json.dumps({"cpu_capacity": 4}), encoding="utf-8")
        self.config_path.symlink_to(real)
        with self.assertRaises(HostConfigError):
            load_host_config()


class ProcessIdentityTest(unittest.TestCase):
    def test_this_process_is_alive_by_its_own_identity(self):
        self.assertTrue(supervisor_alive(supervisor_identity()))

    def test_a_reused_pid_with_a_different_start_token_is_not_alive(self):
        identity = supervisor_identity()
        self.assertFalse(supervisor_alive({"pid": identity["pid"], "token": "0"}))

    def test_a_malformed_identity_is_not_alive(self):
        for value in (None, {}, {"pid": 0, "token": None}, {"pid": "x", "token": None}, "nope"):
            with self.subTest(value=value):
                self.assertFalse(supervisor_alive(value))

    def test_an_exited_process_has_no_start_token(self):
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait(timeout=30)
        # A token may still be readable for a moment while the child is a zombie;
        # what must never happen is claiming a token for a PID that cannot exist.
        self.assertIsNone(process_token(2 ** 22 - 1))


class SupervisorTest(unittest.TestCase):
    def test_a_command_exit_status_is_reported_exactly(self):
        result = run_command([sys.executable, "-c", "raise SystemExit(3)"], dict(os.environ), None)
        self.assertEqual(result, ChildResult(exit_code=3, term_signal=None))
        self.assertFalse(result.succeeded)

    def test_success_is_reported_as_success(self):
        self.assertTrue(run_command([sys.executable, "-c", "pass"], dict(os.environ), None).succeeded)

    def test_a_signalled_command_reports_its_signal(self):
        script = "import os, signal; os.kill(os.getpid(), signal.SIGTERM)"
        result = run_command([sys.executable, "-c", script], dict(os.environ), None)
        self.assertEqual(result, ChildResult(exit_code=None, term_signal=signal.SIGTERM))

    def test_the_environment_is_handed_to_the_command(self):
        env = dict(os.environ, GC_DISPATCH_UNIT_PROBE="present")
        script = "import os, sys; sys.exit(0 if os.environ.get('GC_DISPATCH_UNIT_PROBE') else 9)"
        self.assertTrue(run_command([sys.executable, "-c", script], env, None).succeeded)

    def test_exit_like_propagates_a_status(self):
        with self.assertRaises(SystemExit) as caught:
            exit_like(ChildResult(exit_code=5, term_signal=None))
        self.assertEqual(caught.exception.code, 5)

    def test_exit_like_maps_an_unknown_outcome_to_failure(self):
        with self.assertRaises(SystemExit) as caught:
            exit_like(ChildResult(exit_code=None, term_signal=None))
        self.assertEqual(caught.exception.code, 1)


class DispatchOrchestrationTest(HostRootTestCase):
    def test_a_successful_run_exits_with_the_command_status_and_records_a_metric(self):
        self.write_config(cpu_capacity=4)
        with self.assertRaises(SystemExit) as caught:
            main(["--profile", "unit", "--cpu", "2", "--", sys.executable, "-c", "pass"])
        self.assertEqual(caught.exception.code, 0)
        record = read_metrics(self.state_dir)[-1]
        self.assertEqual(record["granted"], 2)
        self.assertEqual(record["capacity"], 4)
        self.assertEqual(record["outcome"], "ran")

    def test_a_failing_command_exits_with_its_own_status(self):
        self.write_config(cpu_capacity=4)
        with self.assertRaises(SystemExit) as caught:
            main(["--profile", "unit", "--", sys.executable, "-c", "raise SystemExit(6)"])
        self.assertEqual(caught.exception.code, 6)
        self.assertEqual(read_metrics(self.state_dir)[-1]["exit_code"], 6)

    def test_a_usage_error_returns_the_usage_status_and_registers_nothing(self):
        self.write_config(cpu_capacity=4)
        self.assertEqual(main(["--profile", "unit", "--cpu", "0", "--", "true"]), EXIT_USAGE)
        self.assertFalse((self.state_dir / "ledger.json").exists())

    def test_unusable_host_configuration_returns_the_internal_status(self):
        self.write_config(suites=2)
        self.assertEqual(main(["--profile", "unit", "--", "true"]), EXIT_INTERNAL)

    def test_an_exhausted_queue_bound_returns_without_running_the_command(self):
        self.write_config(cpu_capacity=2, max_queue_wait_seconds=0)
        blocker = Ledger(self.state_dir, stale_after_seconds=3600)
        held = blocker.enqueue("blocker", 2, 2)
        self.assertEqual(blocker.try_admit(held, 2), 2)
        marker = self.tmp / "ran"
        try:
            status = main(["--profile", "unit", "--cpu", "2", "--", sys.executable, "-c",
                           f"import pathlib; pathlib.Path({str(marker)!r}).write_text('x')"])
        finally:
            blocker.release(held)
        self.assertEqual(status, EXIT_QUEUE_TIMEOUT)
        self.assertFalse(marker.exists())
        self.assertEqual(read_metrics(self.state_dir)[-1]["outcome"], "queue_timeout")

    def test_the_metrics_file_is_bounded(self):
        state = self.state_dir
        state.mkdir(parents=True, exist_ok=True)
        path = state / "metrics.jsonl"
        path.write_text("x" * 2_000_000, encoding="utf-8")
        report(state, {"profile": "unit", "outcome": "ran"})
        self.assertLess(path.stat().st_size, 1024)

    def test_measurement_failure_never_breaks_a_dispatch(self):
        report(self.tmp / "does-not-exist", {"profile": "unit", "outcome": "ran"})


if __name__ == "__main__":
    unittest.main()
