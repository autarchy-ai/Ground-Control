"""Tests for bin/gc-test-dispatch - the host verification dispatcher entry point.

Every case runs the real executable as its own process, because the contract the
issue asks for is a process contract: the exact command runs, its streams are its
own, and its exit status or terminating signal reaches the caller unchanged.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS_ROOT = REPO_ROOT / "tools"
DISPATCH = REPO_ROOT / "bin" / "gc-test-dispatch"
sys.path.insert(0, str(TOOLS_ROOT))

EXIT_USAGE = 64
EXIT_INTERNAL = 70
EXIT_QUEUE_TIMEOUT = 75

def read_metrics(state_dir):
    """Return the dispatcher's recorded measurements, newest last."""
    path = state_dir / "metrics.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def worker_env_probe():
    """A command that prints the xdist worker count the dispatcher granted it."""
    return [sys.executable, "-c",
            "import os, sys; sys.stdout.write(os.environ.get('PYTEST_XDIST_AUTO_NUM_WORKERS', 'unset'))"]


HOLDER = r"""
import json, os, sys
sys.path.insert(0, os.environ["GC_DISPATCH_TOOLS"])
from gc_dispatch.ledger import Ledger
ledger = Ledger(os.environ["GC_DISPATCH_STATE"], stale_after_seconds=3600)
ticket = ledger.enqueue("holder", int(sys.argv[1]), int(sys.argv[2]))
print(json.dumps({"granted": ledger.try_admit(ticket, int(sys.argv[3]))}), flush=True)
sys.stdin.readline()
ledger.release(ticket)
"""


class DispatchTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gc-dispatch-cli-"))
        # Isolation uses the standard XDG locations the dispatcher already reads.
        # There is no dispatcher-specific override to point it somewhere else, and
        # test_no_environment_variable_can_redirect_host_state proves it.
        self.home = self.tmp / "home"
        self.config_home = self.home / ".config"
        self.runtime_dir = self.tmp / "run"
        (self.config_home / "ground-control").mkdir(parents=True)
        self.runtime_dir.mkdir()
        self.state = self.runtime_dir / "ground-control" / "dispatch"
        self.holders = []
        self.tracked = []
        self.write_host_config(cpu_capacity=8)

    def tearDown(self):
        for proc in self.tracked:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
        for proc in self.holders:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
            for stream in (proc.stdin, proc.stdout):
                if stream is not None and not stream.closed:
                    stream.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    @property
    def config_path(self):
        return self.config_home / "ground-control" / "dispatch.json"

    def write_host_config(self, **values):
        self.config_path.write_text(json.dumps(values), encoding="utf-8")
        self.config_path.chmod(0o600)

    def env(self):
        env = dict(os.environ)
        env["HOME"] = str(self.home)
        env["XDG_CONFIG_HOME"] = str(self.config_home)
        env["XDG_RUNTIME_DIR"] = str(self.runtime_dir)
        env.pop("PYTEST_XDIST_AUTO_NUM_WORKERS", None)
        return env

    def run_dispatch(self, *args, timeout=60, **kwargs):
        return subprocess.run(
            [sys.executable, str(DISPATCH), *args],
            env=self.env(), capture_output=True, text=True, timeout=timeout, **kwargs,
        )

    def start_holder(self, requested, minimum, capacity):
        env = self.env()
        env["GC_DISPATCH_TOOLS"] = str(TOOLS_ROOT)
        env["GC_DISPATCH_STATE"] = str(self.state)
        proc = subprocess.Popen(
            [sys.executable, "-c", HOLDER, str(requested), str(minimum), str(capacity)],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        self.holders.append(proc)
        report = json.loads(proc.stdout.readline())
        self.assertEqual(report["granted"], requested)
        return proc



class CommandFidelityTest(DispatchTestBase):
    def test_the_exact_command_runs_and_its_exit_status_is_returned(self):
        result = self.run_dispatch(
            "--profile", "unit", "--", sys.executable, "-c", "raise SystemExit(7)")
        self.assertEqual(result.returncode, 7)

    def test_success_is_reported_as_success(self):
        result = self.run_dispatch("--profile", "unit", "--", sys.executable, "-c", "pass")
        self.assertEqual(result.returncode, 0)

    def test_child_streams_reach_the_caller_unmodified(self):
        script = "import sys; sys.stdout.write('to-stdout'); sys.stderr.write('to-stderr')"
        result = self.run_dispatch("--profile", "unit", "--", sys.executable, "-c", script)
        self.assertEqual(result.stdout, "to-stdout")
        self.assertIn("to-stderr", result.stderr)

    def test_stdin_is_passed_through_to_the_command(self):
        script = "import sys; sys.stdout.write(sys.stdin.read().upper())"
        result = subprocess.run(
            [sys.executable, str(DISPATCH), "--profile", "unit", "--", sys.executable, "-c", script],
            env=self.env(), input="piped", capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.stdout, "PIPED")

    def test_a_command_killed_by_a_signal_terminates_the_dispatcher_the_same_way(self):
        script = "import os, signal; os.kill(os.getpid(), signal.SIGTERM)"
        result = self.run_dispatch("--profile", "unit", "--", sys.executable, "-c", script)
        self.assertEqual(result.returncode, -signal.SIGTERM)

    def test_a_signal_to_the_dispatcher_is_forwarded_to_the_command(self):
        pidfile = self.tmp / "child.pid"
        script = (
            f"import os, time, pathlib;"
            f"pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid()));"
            "time.sleep(120)"
        )
        proc = subprocess.Popen(
            [sys.executable, str(DISPATCH), "--profile", "unit", "--", sys.executable, "-c", script],
            env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.tracked.append(proc)
        deadline = time.monotonic() + 30
        while not pidfile.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(pidfile.exists(), "command never started")
        child_pid = int(pidfile.read_text())

        proc.send_signal(signal.SIGTERM)
        self.assertEqual(proc.wait(timeout=30), -signal.SIGTERM)

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except OSError:
                break
            time.sleep(0.02)
        else:
            self.fail("the command survived a signal sent to the dispatcher")

    def test_no_capacity_is_left_held_after_a_run(self):
        self.run_dispatch("--profile", "unit", "--", sys.executable, "-c", "pass")
        ledger = json.loads((self.state / "ledger.json").read_text(encoding="utf-8"))
        self.assertEqual(ledger["entries"], [])


class ParallelismTest(DispatchTestBase):
    def test_the_xdist_worker_count_is_the_granted_capacity(self):
        result = self.run_dispatch(
            "--profile", "suite", "--cpu", "3", "--xdist", "--", *worker_env_probe())
        self.assertEqual(result.stdout, "3")

    def test_a_command_that_did_not_opt_in_keeps_its_environment(self):
        result = self.run_dispatch(
            "--profile", "suite", "--cpu", "3", "--", *worker_env_probe())
        self.assertEqual(result.stdout, "unset")

    def test_an_elastic_request_runs_on_the_capacity_that_is_actually_free(self):
        self.start_holder(6, 6, 8)
        result = self.run_dispatch(
            "--profile", "suite", "--cpu", "8", "--min-cpu", "2", "--xdist",
            "--", *worker_env_probe())
        self.assertEqual(result.stdout, "2")

    def test_work_beyond_the_host_budget_waits_instead_of_oversubscribing(self):
        self.write_host_config(cpu_capacity=8, max_queue_wait_seconds=0)
        self.start_holder(8, 8, 8)
        marker = self.tmp / "ran"
        result = self.run_dispatch(
            "--profile", "suite", "--cpu", "4", "--",
            sys.executable, "-c", f"import pathlib; pathlib.Path({str(marker)!r}).write_text('x')")
        self.assertEqual(result.returncode, EXIT_QUEUE_TIMEOUT)
        self.assertFalse(marker.exists(), "the command ran despite never being admitted")

    def test_queued_work_runs_once_the_holder_releases_its_grant(self):
        holder = self.start_holder(8, 8, 8)
        proc = subprocess.Popen(
            [sys.executable, str(DISPATCH), "--profile", "suite", "--cpu", "8",
             "--", sys.executable, "-c", "pass"],
            env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.tracked.append(proc)
        holder.stdin.write("go\n")
        holder.stdin.flush()
        self.assertEqual(holder.wait(timeout=30), 0)
        self.assertEqual(proc.wait(timeout=60), 0)


class ArgumentValidationTest(DispatchTestBase):
    def _usage(self, *args):
        result = self.run_dispatch(*args)
        self.assertEqual(result.returncode, EXIT_USAGE, result.stderr)
        return result

    def test_an_unknown_option_is_refused(self):
        self._usage("--profile", "unit", "--capacity", "99", "--", "true")

    def test_a_missing_command_separator_is_refused(self):
        self._usage("--profile", "unit", "true")

    def test_an_empty_command_is_refused(self):
        self._usage("--profile", "unit", "--")

    def test_a_missing_profile_is_refused(self):
        self._usage("--", "true")

    def test_a_malformed_profile_name_is_refused(self):
        self._usage("--profile", "Bad Profile", "--", "true")

    def test_a_non_integer_demand_is_refused(self):
        self._usage("--profile", "unit", "--cpu", "many", "--", "true")

    def test_an_out_of_range_demand_is_refused(self):
        self._usage("--profile", "unit", "--cpu", "0", "--", "true")

    def test_a_minimum_above_the_request_is_refused(self):
        self._usage("--profile", "unit", "--cpu", "2", "--min-cpu", "4", "--", "true")

    def test_a_refused_invocation_registers_no_work(self):
        self._usage("--profile", "unit", "--cpu", "0", "--", "true")
        self.assertFalse((self.state / "ledger.json").exists())


class ReportingTest(DispatchTestBase):
    def test_a_run_reports_its_queue_time_execution_time_and_capacity(self):
        self.run_dispatch("--profile", "suite", "--cpu", "2", "--", sys.executable, "-c", "pass")
        records = read_metrics(self.state)
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["profile"], "suite")
        self.assertEqual(record["requested"], 2)
        self.assertEqual(record["granted"], 2)
        self.assertEqual(record["capacity"], 8)
        self.assertEqual(record["outcome"], "ran")
        self.assertEqual(record["exit_code"], 0)
        for field in ("queue_ms", "exec_ms"):
            self.assertIsInstance(record[field], int)
            self.assertGreaterEqual(record[field], 0)

    def test_the_summary_line_names_the_dispatcher_and_the_grant(self):
        result = self.run_dispatch("--profile", "suite", "--cpu", "2", "--", sys.executable, "-c", "pass")
        summary = [ln for ln in result.stderr.splitlines() if ln.startswith("gc-test-dispatch:")]
        self.assertEqual(len(summary), 1)
        self.assertIn("granted=2", summary[0])

    def test_a_queue_timeout_is_recorded_as_its_own_outcome(self):
        self.write_host_config(cpu_capacity=8, max_queue_wait_seconds=0)
        self.start_holder(8, 8, 8)
        self.run_dispatch("--profile", "suite", "--cpu", "4", "--", sys.executable, "-c", "pass")
        outcomes = [r["outcome"] for r in read_metrics(self.state)]
        self.assertIn("queue_timeout", outcomes)

    def test_no_command_text_is_persisted(self):
        secret = "s3cr3t-argument-value"
        self.run_dispatch("--profile", "suite", "--", sys.executable, "-c", f"x = {secret!r}")
        for path in self.state.rglob("*"):
            if path.is_file():
                self.assertNotIn(secret, path.read_text(encoding="utf-8", errors="replace"))


class TrustBoundaryTest(DispatchTestBase):
    def test_no_environment_variable_can_redirect_host_state(self):
        # A wrapped repository command must not be able to opt out of the owner's
        # capacity by pointing the dispatcher at a private root (findings F2/F4).
        self.write_host_config(cpu_capacity=2)
        elsewhere = self.tmp / "elsewhere"
        (elsewhere / "config").mkdir(parents=True)
        (elsewhere / "config" / "dispatch.json").write_text(
            json.dumps({"cpu_capacity": 64}), encoding="utf-8")
        env = self.env()
        env["GC_DISPATCH_TEST_ROOT"] = str(elsewhere)
        env["GC_DISPATCH_STATE_DIR"] = str(elsewhere / "state")
        env["GC_DISPATCH_CONFIG"] = str(elsewhere / "config" / "dispatch.json")

        result = subprocess.run(
            [sys.executable, str(DISPATCH), "--profile", "suite", "--cpu", "16",
             "--min-cpu", "1", "--xdist", "--", sys.executable, "-c",
             "import os, sys; sys.stdout.write(os.environ['PYTEST_XDIST_AUTO_NUM_WORKERS'])"],
            env=env, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.stdout, "2", result.stderr)
        self.assertTrue((self.state / "metrics.jsonl").exists())
        self.assertFalse((elsewhere / "state").exists())

    def test_no_environment_variable_can_redirect_the_dispatcher_package(self):
        # Importing dispatcher code from a caller-named directory would put
        # admission under the control of the command being admitted (finding F4).
        impostor = self.tmp / "impostor"
        (impostor / "gc_dispatch").mkdir(parents=True)
        (impostor / "gc_dispatch" / "__init__.py").write_text("", encoding="utf-8")
        (impostor / "gc_dispatch" / "cli.py").write_text(
            "def main(argv):\n    print('impostor')\n    return 0\n", encoding="utf-8")
        env = self.env()
        env["GC_DISPATCH_PACKAGE_ROOT"] = str(impostor)

        result = subprocess.run(
            [sys.executable, str(DISPATCH), "--profile", "unit", "--",
             sys.executable, "-c", "print('real')"],
            env=env, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.stdout.strip(), "real", result.stderr)


class HostConfigurationTest(DispatchTestBase):
    def test_host_capacity_bounds_the_grant_not_the_repository_request(self):
        self.write_host_config(cpu_capacity=2)
        result = self.run_dispatch(
            "--profile", "suite", "--cpu", "16", "--min-cpu", "1", "--xdist",
            "--", sys.executable, "-c",
            "import os, sys; sys.stdout.write(os.environ['PYTEST_XDIST_AUTO_NUM_WORKERS'])")
        self.assertEqual(result.stdout, "2")

    def test_capacity_defaults_to_the_effective_cpu_affinity(self):
        self.config_path.unlink()
        self.run_dispatch("--profile", "suite", "--", sys.executable, "-c", "pass")
        expected = len(os.sched_getaffinity(0))
        self.assertEqual(read_metrics(self.state)[0]["capacity"], expected)

    def test_a_world_writable_host_config_is_refused(self):
        self.config_path.chmod(0o666)
        result = self.run_dispatch("--profile", "unit", "--", sys.executable, "-c", "pass")
        self.assertEqual(result.returncode, EXIT_INTERNAL, result.stderr)
        self.assertIn("dispatch.json", result.stderr)

    def test_an_unknown_host_config_key_is_refused(self):
        self.write_host_config(cpu_capacity=8, suites=2)
        result = self.run_dispatch("--profile", "unit", "--", sys.executable, "-c", "pass")
        self.assertEqual(result.returncode, EXIT_INTERNAL, result.stderr)
        self.assertIn("suites", result.stderr)


if __name__ == "__main__":
    unittest.main()
