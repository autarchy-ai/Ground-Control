"""Stalled Incus calls end at their deadline and release the lock they hold (issue #1720)."""

from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from tools.incus_sandbox import build_image, helper as helper_module, probe
from tools.incus_sandbox import task_environment, transfer as incus_transfer
from tools.incus_sandbox.config import (
    DEFAULT_DEADLINES, MAX_DEADLINE_SECONDS, ConfigError, load_config, upgrade_config,
)
from tools.incus_sandbox.events import EventWriter
from tools.incus_sandbox.helper import LifecycleHelper
from tools.incus_sandbox.task_environment import (
    TaskEnvironmentService, TaskRuntime, guest_runner, record_source_binding, state_lock,
)
from tools.tests.incus_process_fixtures import (
    calls, descendant_pid, kill_quietly, process_alive, set_fake_mode, set_fake_output, write_fake_incus,
)
from tools.tests.test_incus_sandbox import config_doc
from tools.tests.test_incus_task_environment import declaration


def clone_packet() -> bytes:
    encoded = json.dumps({"schema": "gc.incus-sandbox.source/v1", "kind": "clone", "commit": "a" * 40,
                          "repository": "https://github.com/example/private.git"}).encode()
    return b"GCS1" + len(encoded).to_bytes(4, "big") + encoded


def v4_doc(root: Path, deadlines: dict[str, int]) -> dict[str, object]:
    """A v4 policy whose short deadlines keep the stalled fixtures fast."""
    return {
        **config_doc(root), "schema": "gc.incus-sandbox/v4",
        "migration": {"max_packet_bytes": 1024 * 1024, "max_file_count": 16,
                      "max_file_bytes": 1024, "max_handoff_bytes": 1024},
        "task_environment": {"max_value_bytes": 1024, "repositories": {}},
        "deadline_seconds": deadlines,
    }


def lifecycle_helper(case: "StalledIncusTestCase") -> LifecycleHelper:
    """A helper for the fixture's operator with fresh host observations."""
    return LifecycleHelper(
        case.config, event_writer=case.writer,
        observer=lambda: {"memory_mib": 16384, "disk_gib": 256, "fresh": True},
        network_checker=lambda config: True, caller_uid=os.getuid(),
    )


def recorded_events(config: object) -> list[dict[str, object]]:
    """The lifecycle events the fixture's helper wrote."""
    return [json.loads(line) for line in config.event_log.read_text(encoding="utf-8").splitlines()]


def recorded_allocations(config: object) -> dict[str, dict[str, object]]:
    """The durable allocation records."""
    return json.loads((config.state_dir / "allocations.json").read_text(encoding="utf-8") or "{}")


def contend_for_allocations(case: "StalledIncusTestCase", observed: dict[str, object]) -> threading.Thread:
    """A competing request that blocks on the allocation lock the stalled call holds."""
    def contender() -> None:
        stalled = descendant_pid(case.fake_dir)
        started = time.monotonic()
        lifecycle_helper(case)._headroom()
        observed["waited"] = time.monotonic() - started
        observed["descendant_alive"] = process_alive(stalled)
    thread = threading.Thread(target=contender)
    thread.start()
    return thread


def task_service(config: object) -> tuple[TaskEnvironmentService, bytes]:
    """A task service bound to a prepared source, and a matching start request."""
    raw = declaration("example/one", [])
    record_source_binding(config.state_dir, "dev", "example/one", raw)
    service = TaskEnvironmentService(
        project="gc-sandbox", state_dir=config.state_dir, operator_uid=os.getuid(),
        repositories={"example/one": {}},
        runtime=TaskRuntime(active_owner=lambda sandbox, uid: True,
                            runner=guest_runner(config.deadlines.task),
                            expected_provider_uid=os.getuid()),
    )
    request = json.dumps({"schema": "gc.incus-sandbox.task-start/v1", "repository": "example/one",
                          "declaration_b64": base64.b64encode(raw).decode()}).encode()
    return service, request


def load_policy(path: Path, doc: dict[str, object]) -> object:
    """Write a root-policy document with safe permissions and load it."""
    path.write_text(json.dumps(doc), encoding="utf-8")
    path.chmod(0o600)
    return load_config(path, expected_uid=os.getuid())


class StalledIncusTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="gc-incus-deadline-")
        self.root = Path(self.temporary.name)
        self.fake_dir = self.root / "fake"
        self.fake = str(write_fake_incus(self.fake_dir))
        environment = patch.dict(os.environ, {"FAKE_INCUS_DIR": str(self.fake_dir)})
        environment.start()
        self.addCleanup(environment.stop)
        path = self.root / "config.json"
        path.write_text(json.dumps(v4_doc(self.root, {"query": 1, "lifecycle": 1, "launch": 1,
                                                      "transfer": 1, "task": 1})), encoding="utf-8")
        path.chmod(0o600)
        self.config = load_config(path, expected_uid=os.getuid())
        self.writer = EventWriter(self.config.event_log, self.config.event_max_bytes,
                                  expected_uid=os.getuid())

    def tearDown(self) -> None:
        pid_file = self.fake_dir / "descendant.pid"
        if pid_file.exists() and pid_file.read_text(encoding="utf-8").strip():
            kill_quietly(int(pid_file.read_text(encoding="utf-8")))
        self.temporary.cleanup()

class LifecycleDeadlineTest(StalledIncusTestCase):
    def test_stalled_launch_times_out_reaps_its_tree_and_frees_the_lock(self) -> None:
        set_fake_mode(self.fake_dir, "launch", "stall")
        set_fake_output(self.fake_dir, "query", "[]")
        observed: dict[str, object] = {}
        with patch.object(helper_module, "_INCUS", self.fake):
            contender = contend_for_allocations(self, observed)
            with self.assertRaises(subprocess.TimeoutExpired):
                lifecycle_helper(self).create("dev")
            contender.join(10)
        # The contender waited for the stalled call, and got the lock only after its tree died.
        self.assertGreater(observed["waited"], 0.5)
        self.assertIs(observed["descendant_alive"], False)
        self.assertNotIn("dev", recorded_allocations(self.config))
        self.assertTrue(any(line.startswith("delete dev --force") for line in calls(self.fake_dir)))
        self.assertEqual(recorded_events(self.config)[-1]["error_code"], "command_timeout")

    def test_a_timed_out_launch_keeps_its_reservation_while_the_instance_may_exist(self) -> None:
        set_fake_mode(self.fake_dir, "launch", "stall")
        set_fake_mode(self.fake_dir, "delete", "fail")
        set_fake_output(self.fake_dir, "query", '["/1.0/instances/dev"]')
        with patch.object(helper_module, "_INCUS", self.fake):
            with self.assertRaises(subprocess.TimeoutExpired):
                lifecycle_helper(self).create("dev")
            self.assertTrue(recorded_allocations(self.config)["dev"]["active"])
            # Once the instance can be deleted, the owner's delete reconciles the reservation.
            set_fake_mode(self.fake_dir, "delete", "ok")
            lifecycle_helper(self).delete("dev", "dev")
        self.assertNotIn("dev", recorded_allocations(self.config))

    def test_delete_forgets_a_reservation_whose_instance_never_materialized(self) -> None:
        set_fake_mode(self.fake_dir, "launch", "stall")
        set_fake_mode(self.fake_dir, "delete", "fail")
        set_fake_output(self.fake_dir, "query", '["/1.0/instances/dev"]')
        with patch.object(helper_module, "_INCUS", self.fake):
            with self.assertRaises(subprocess.TimeoutExpired):
                lifecycle_helper(self).create("dev")
            set_fake_output(self.fake_dir, "query", '["/1.0/instances/other"]')
            lifecycle_helper(self).delete("dev", "dev")
        self.assertNotIn("dev", recorded_allocations(self.config))

    def test_a_stalled_stop_keeps_the_allocation_active(self) -> None:
        with patch.object(helper_module, "_INCUS", self.fake):
            lifecycle_helper(self).create("dev")
            set_fake_mode(self.fake_dir, "stop", "stall")
            with self.assertRaises(subprocess.TimeoutExpired):
                lifecycle_helper(self).stop("dev")
        self.assertTrue(recorded_allocations(self.config)["dev"]["active"])
        self.assertFalse(process_alive(descendant_pid(self.fake_dir)))
        self.assertEqual(recorded_events(self.config)[-1]["error_code"], "command_timeout")


class TransferAndTaskDeadlineTest(StalledIncusTestCase):
    def test_stalled_transfer_releases_the_sandbox_lock_without_a_binding(self) -> None:
        set_fake_mode(self.fake_dir, "exec", "stall")
        writer = types.SimpleNamespace(ensure_available=lambda: None, write=self.records.append)
        binding = self.config.state_dir / "source-bindings" / "dev.json"
        binding.parent.mkdir(parents=True)
        binding.write_text('{"obsolete":true}', encoding="utf-8")
        with patch.dict(sys.modules, {"events": types.SimpleNamespace(EventWriter=lambda *_: writer)}), \
             patch.object(incus_transfer, "_INCUS", self.fake):
            with self.assertRaises(subprocess.TimeoutExpired):
                incus_transfer.audited_transfer(self.config, "dev", io.BytesIO(clone_packet()), "clone")
        self.assertFalse(process_alive(descendant_pid(self.fake_dir)))
        self.assertFalse(binding.exists())
        self.assertEqual(self.records[-1]["error_code"], "command_timeout")
        with state_lock(self.config.state_dir, "dev"):
            pass

    def test_a_timed_out_start_is_forgotten_only_after_a_confirmed_stop(self) -> None:
        set_fake_mode(self.fake_dir, "exec.start", "stall")
        service, request = task_service(self.config)
        with patch.object(task_environment, "_INCUS", self.fake):
            with self.assertRaises(subprocess.TimeoutExpired):
                service.start("dev", request, os.getuid())
        self.assertTrue(calls(self.fake_dir)[-1].endswith("task-launcher.py stop"))
        self.assertFalse((self.config.state_dir / "tasks" / "dev.json").exists())

    def test_an_unconfirmed_stop_keeps_the_task_guard_against_source_replacement(self) -> None:
        set_fake_mode(self.fake_dir, "exec", "stall")
        service, request = task_service(self.config)
        with patch.object(task_environment, "_INCUS", self.fake):
            with self.assertRaises(subprocess.TimeoutExpired):
                service.start("dev", request, os.getuid())
        # The guest may still run the credentialed task, so its record stays and the
        # sandbox's source cannot be replaced underneath it.
        self.assertTrue((self.config.state_dir / "tasks" / "dev.json").exists())
        writer = types.SimpleNamespace(ensure_available=lambda: None, write=self.records.append)
        with patch.dict(sys.modules, {"events": types.SimpleNamespace(EventWriter=lambda *_: writer)}), \
             patch.object(incus_transfer, "_INCUS", self.fake):
            with self.assertRaisesRegex(incus_transfer.TransferError, "stop the active task"):
                incus_transfer.audited_transfer(self.config, "dev", io.BytesIO(clone_packet()), "clone")
        # A confirmed stop clears it.
        set_fake_mode(self.fake_dir, "exec", "ok")
        with patch.object(task_environment, "_INCUS", self.fake):
            service.stop("dev", os.getuid())
        self.assertFalse((self.config.state_dir / "tasks" / "dev.json").exists())

    def setUp(self) -> None:
        super().setUp()
        self.records: list[dict[str, object]] = []


class EntryPointTimeoutTest(unittest.TestCase):
    def test_transfer_reports_a_timeout_and_names_the_guest_log(self) -> None:
        config_module = types.SimpleNamespace(load_config=lambda _: types.SimpleNamespace(operator_uid=1000))
        timeout = subprocess.TimeoutExpired("incus", 1800)
        with patch.object(incus_transfer.os, "geteuid", return_value=0), \
             patch.dict(incus_transfer.os.environ, {"SUDO_UID": "1000"}), \
             patch.dict(sys.modules, {"config": config_module}), \
             patch.object(incus_transfer, "audited_transfer", side_effect=timeout):
            with self.assertRaisesRegex(incus_transfer.TransferError, "within 1800 seconds.*bootstrap.log"):
                incus_transfer.main(["dev", "clone"])

    def test_a_task_timeout_is_recorded_with_the_timeout_code(self) -> None:
        records: list[dict[str, object]] = []
        config = types.SimpleNamespace(
            project="gc-sandbox", state_dir=Path("/nonexistent"), operator_uid=os.getuid(),
            event_log=Path("/nonexistent/events"), event_max_bytes=1024, deadlines=DEFAULT_DEADLINES,
            task_environment=types.SimpleNamespace(repositories={}, max_value_bytes=16384),
        )
        service = types.SimpleNamespace(stop=lambda *_: (_ for _ in ()).throw(subprocess.TimeoutExpired("incus", 120)))
        with patch.object(task_environment.os, "geteuid", return_value=0), \
             patch.dict(task_environment.os.environ, {"SUDO_UID": str(os.getuid())}, clear=True), \
             patch("tools.incus_sandbox.config.load_config", return_value=config), \
             patch("tools.incus_sandbox.events.EventWriter",
                   return_value=types.SimpleNamespace(write=records.append)), \
             patch("tools.incus_sandbox.helper.LifecycleHelper"), \
             patch.object(task_environment, "TaskEnvironmentService", return_value=service):
            with self.assertRaises(subprocess.TimeoutExpired):
                task_environment.main(["stop", "dev"])
        self.assertEqual(records[-1]["error_code"], "command_timeout")

    def test_a_probe_that_does_not_finish_is_a_failed_boundary_check(self) -> None:
        listed = types.SimpleNamespace(returncode=0, stdout='"10.74.0.129 (enp5s0)"\n')
        policy = types.SimpleNamespace(deadlines=replace(DEFAULT_DEADLINES, query=7))
        with patch("tools.incus_sandbox.probe.load_config", return_value=policy), \
             patch("tools.incus_sandbox.probe.run_owned",
                   side_effect=[listed, subprocess.TimeoutExpired("incus", 7)]) as run:
            self.assertEqual(probe.main(["agent-1", "10.74.0.1", "agent-2"]), 1)
        # Both probe calls take the root-owned query deadline, never the built-in default.
        self.assertEqual([call.kwargs["deadline_seconds"] for call in run.call_args_list], [7, 7])


class TemplateBuildDeadlineTest(StalledIncusTestCase):
    def test_a_stalled_agent_probe_is_cut_at_the_outer_wait_deadline(self) -> None:
        set_fake_mode(self.fake_dir, "exec", "stall")
        # The per-probe query deadline alone would allow a minute; the outer wait allows one second.
        patient = replace(self.config, deadlines=replace(self.config.deadlines, query=60))
        started = time.monotonic()
        with patch.object(build_image, "_INCUS", self.fake), \
             patch.object(build_image, "_AGENT_TIMEOUT_SECONDS", 1):
            with self.assertRaises(build_image.BuildError):
                build_image._await_agent(patient, "gc-template-build-1")
        self.assertLess(time.monotonic() - started, 5)
        self.assertFalse(process_alive(descendant_pid(self.fake_dir)))


class DeadlinePolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="gc-incus-deadline-policy-")
        self.root = Path(self.temporary.name)
        self.path = self.root / "config.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_policies_before_v4_use_the_finite_defaults(self) -> None:
        self.assertEqual(load_policy(self.path, config_doc(self.root)).deadlines, DEFAULT_DEADLINES)

    def test_v4_overrides_individual_operations_and_keeps_the_rest(self) -> None:
        deadlines = load_policy(self.path, v4_doc(self.root, {"launch": 3600})).deadlines
        self.assertEqual(deadlines.launch, 3600)
        self.assertEqual(deadlines.query, DEFAULT_DEADLINES.query)

    def test_v4_rejects_anything_that_is_not_a_bounded_known_deadline(self) -> None:
        for invalid in ({"forever": 10}, {"query": 0}, {"query": -5}, {"query": True},
                        {"query": 1.5}, {"query": "60"}, {"query": MAX_DEADLINE_SECONDS + 1}, []):
            with self.subTest(deadlines=invalid), self.assertRaises(ConfigError):
                load_policy(self.path, v4_doc(self.root, invalid))  # type: ignore[arg-type]

    def test_upgrade_adds_an_empty_override_section(self) -> None:
        load_policy(self.path, config_doc(self.root))
        self.assertTrue(upgrade_config(self.path, expected_uid=os.getuid()))
        upgraded = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(upgraded["schema"], "gc.incus-sandbox/v4")
        self.assertEqual(upgraded["deadline_seconds"], {})
        self.assertEqual(load_config(self.path, expected_uid=os.getuid()).deadlines, DEFAULT_DEADLINES)
        self.assertFalse(upgrade_config(self.path, expected_uid=os.getuid()))


if __name__ == "__main__":
    unittest.main()
