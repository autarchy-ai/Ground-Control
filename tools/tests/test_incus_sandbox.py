"""Behavioral tests for the local Incus coding sandbox boundary."""

from __future__ import annotations

import json
import multiprocessing
import os
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.incus_sandbox.config import ConfigError, load_config
from tools.incus_sandbox.events import EventWriter
from tools.incus_sandbox.helper import AdmissionError, LifecycleHelper, UsageError
from tools.incus_sandbox.observations import observation
from tools.incus_sandbox.probe import (
    IPV6_CANARY,
    boundary_probe_commands,
    main as probe_main,
    sibling_address,
)


def config_doc(tmp: Path) -> dict[str, object]:
    return {
        "schema": "gc.incus-sandbox/v1",
        "project": "gc-sandbox",
        "profile": "gc-sandbox-default",
        "pool": "gc-sandbox-pool",
        "bridge": "gcbr0",
        "image": "images:" + "a" * 64,
        "state_dir": str(tmp / "state"),
        "event_log": str(tmp / "events" / "lifecycle.jsonl"),
        "event_max_bytes": 1024,
        "observation_max_age_seconds": 60,
        "operator_uid": os.getuid(),
        "vm": {"cpu": 2, "memory_mib": 4096, "disk_gib": 16},
        "host": {
            "reserve_memory_mib": 2048,
            "reserve_disk_gib": 32,
            "max_cpu": 8,
            "max_memory_mib": 32768,
            "max_disk_gib": 512,
            "overhead_disk_gib": 16,
        },
    }


class SandboxTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="gc-incus-sandbox-")
        self.root = Path(self.tmp.name)
        self.config_path = self.root / "config.json"
        self.config_path.write_text(json.dumps(config_doc(self.root)), encoding="utf-8")
        self.config_path.chmod(0o600)
        self.config = load_config(self.config_path, expected_uid=os.getuid())
        self.commands: list[list[str]] = []
        self.writer = EventWriter(self.config.event_log, self.config.event_max_bytes,
                                  expected_uid=os.getuid())
        self.helper = LifecycleHelper(
            self.config,
            runner=lambda argv: self.commands.append(argv) or {"returncode": 0},
            event_writer=self.writer,
            observer=lambda: {"memory_mib": 16384, "disk_gib": 256, "fresh": True},
            network_checker=lambda config: True,
            caller_uid=os.getuid(),
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()


class ConfigBoundaryTest(SandboxTestCase):
    def test_rejects_unknown_configuration_and_group_writable_config(self) -> None:
        doc = config_doc(self.root)
        doc["raw.qemu"] = "-device evil"
        self.config_path.write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(self.config_path, expected_uid=os.getuid())
        self.config_path.write_text(json.dumps(config_doc(self.root)), encoding="utf-8")
        self.config_path.chmod(0o620)
        with self.assertRaises(ConfigError):
            load_config(self.config_path, expected_uid=os.getuid())

    def test_rejects_a_symlinked_root_configuration(self) -> None:
        target = self.root / "target.json"
        target.write_text(json.dumps(config_doc(self.root)), encoding="utf-8")
        self.config_path.unlink()
        self.config_path.symlink_to(target)
        with self.assertRaises(ConfigError):
            load_config(self.config_path, expected_uid=os.getuid())

    def test_rejects_the_example_image_placeholder(self) -> None:
        doc = config_doc(self.root)
        doc["image"] = "images:" + "0" * 64
        self.config_path.write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(self.config_path, expected_uid=os.getuid())

    def test_accepts_a_pinned_images_remote_fingerprint(self) -> None:
        doc = config_doc(self.root)
        doc["image"] = "images:" + "b" * 64
        self.config_path.write_text(json.dumps(doc), encoding="utf-8")
        self.assertEqual(load_config(self.config_path, expected_uid=os.getuid()).image, doc["image"])

    def test_accepts_a_locally_published_template_and_rejects_an_unlaunchable_digest(self) -> None:
        doc = config_doc(self.root)
        doc["image"] = "local:" + "c" * 64
        self.config_path.write_text(json.dumps(doc), encoding="utf-8")
        self.assertEqual(load_config(self.config_path, expected_uid=os.getuid()).image, doc["image"])
        # Incus reads sha256 as a remote name, so this form validates but never launches.
        doc["image"] = "sha256:" + "c" * 64
        self.config_path.write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(self.config_path, expected_uid=os.getuid())

    def test_rejects_an_event_log_bound_too_small_for_one_schema_record(self) -> None:
        doc = config_doc(self.root)
        doc["event_max_bytes"] = 511
        self.config_path.write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(self.config_path, expected_uid=os.getuid())

    def test_rejects_malformed_image_and_nonabsolute_host_paths(self) -> None:
        doc = config_doc(self.root)
        doc["image"] = "not-a-digest"
        self.config_path.write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(self.config_path, expected_uid=os.getuid())
        doc = config_doc(self.root)
        doc["state_dir"] = "relative-state"
        self.config_path.write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(self.config_path, expected_uid=os.getuid())


class LifecycleBoundaryTest(SandboxTestCase):
    def test_create_uses_only_fixed_incus_argv_and_records_allowlisted_event(self) -> None:
        self.helper.create("agent-1")
        self.assertEqual(self.commands[0], [
            "/usr/bin/incus", "launch", self.config.image, "agent-1", "--project", self.config.project,
            "--profile", self.config.profile, "--vm", "--device", "root,size=16GiB",
        ])
        self.assertIn(["/usr/bin/incus", "config", "set", "agent-1", "limits.cpu", "2",
                       "--project", self.config.project], self.commands)
        records = [json.loads(line) for line in self.config.event_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([record["action"] for record in records], ["create", "boot"])
        self.assertTrue(all(record["outcome"] == "success" for record in records))
        self.assertTrue(all("argv" not in record and "environment" not in record for record in records))

    def test_attach_starts_tmux_in_the_guest_and_never_uses_a_host_shell(self) -> None:
        self.helper.create("agent-1")
        self.commands.clear()
        self.helper.attach("agent-1")
        self.assertEqual(self.commands, [[
            "/usr/bin/incus", "exec", "agent-1", "--project", self.config.project, "--",
            "su", "-", "sandbox", "-c", "exec tmux new-session -A -s coding",
        ]])
        self.assertFalse(any(command[0] in {"sh", "bash"} for command in self.commands))

    def test_rejects_names_and_verbs_that_could_add_caller_control(self) -> None:
        with self.assertRaises(UsageError):
            self.helper.create("agent;host-command")
        with self.assertRaises(UsageError):
            self.helper.dispatch("exec", "agent-1")

    def test_stale_or_insufficient_observations_deny_admission_before_incus_runs(self) -> None:
        stale = LifecycleHelper(
            self.config, runner=lambda argv: self.commands.append(argv), event_writer=self.writer,
            observer=lambda: {"memory_mib": 99999, "disk_gib": 99999, "fresh": False},
            network_checker=lambda config: True,
        )
        with self.assertRaises(AdmissionError):
            stale.create("agent-1")
        self.assertEqual(self.commands, [])
        event = json.loads(self.config.event_log.read_text(encoding="utf-8").strip())
        self.assertEqual(event["error_code"], "admission_observation_stale")

    def test_start_and_create_reserve_aggregate_capacity_including_overhead(self) -> None:
        self.config.state_dir.mkdir(parents=True)
        allocation = self.config.state_dir / "allocations.json"
        allocation.write_text(json.dumps({"agent-0": {"cpu": 7, "memory_mib": 28000,
                                            "disk_gib": 480}}), encoding="utf-8")
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-1")
        self.assertEqual(self.commands, [])

    def test_failure_is_recorded_without_child_output_or_secret_canary(self) -> None:
        def failing(argv: list[str]) -> dict[str, int]:
            raise RuntimeError("secret-canary raw argv and terminal transcript")

        helper = LifecycleHelper(self.config, runner=failing, event_writer=self.writer,
                                 observer=lambda: {"memory_mib": 16000, "disk_gib": 256, "fresh": True},
                                 network_checker=lambda config: True)
        self.helper.create("agent-1")
        with self.assertRaises(RuntimeError):
            helper.stop("agent-1")
        record = json.loads(self.config.event_log.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(record["error_code"], "command_failed")
        self.assertNotIn("secret-canary", json.dumps(record))

    def test_failed_initial_create_releases_the_reservation(self) -> None:
        calls = 0

        def failing_launch(argv: list[str]) -> dict[str, int]:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("launch failed")
            return {"returncode": 0}

        helper = LifecycleHelper(self.config, runner=failing_launch, event_writer=self.writer,
                                 observer=lambda: {"memory_mib": 16000, "disk_gib": 256, "fresh": True},
                                 network_checker=lambda config: True)
        with self.assertRaises(RuntimeError):
            helper.create("agent-1")
        allocations = json.loads((self.config.state_dir / "allocations.json").read_text(encoding="utf-8"))
        self.assertNotIn("agent-1", allocations)

    def test_stopped_owner_can_delete_the_same_sandbox(self) -> None:
        self.helper.create("agent-1")
        self.helper.stop("agent-1")
        self.helper.delete("agent-1")
        allocations = json.loads((self.config.state_dir / "allocations.json").read_text(encoding="utf-8"))
        self.assertNotIn("agent-1", allocations)

    def test_stop_start_delete_and_list_use_the_closed_lifecycle(self) -> None:
        self.helper.create("agent-1")
        self.helper.stop("agent-1")
        self.helper.start("agent-1")
        self.helper.delete("agent-1")
        self.helper.dispatch("list")
        self.assertIn(["/usr/bin/incus", "list", "--project", self.config.project, "--format", "json"], self.commands)

    def test_local_observer_reports_named_nonnegative_host_facts(self) -> None:
        observed = observation()
        self.assertIn("fresh", observed)
        self.assertGreaterEqual(int(observed["memory_mib"]), 0)
        self.assertGreaterEqual(int(observed["disk_gib"]), 0)

    def test_network_address_drift_denies_new_vm_admission(self) -> None:
        helper = LifecycleHelper(self.config, runner=lambda argv: self.commands.append(argv), event_writer=self.writer,
                                 observer=lambda: {"memory_mib": 16000, "disk_gib": 256, "fresh": True},
                                 network_checker=lambda config: False)
        with self.assertRaises(AdmissionError):
            helper.create("agent-1")
        self.assertEqual(self.commands, [])

    def test_lifecycle_operations_reject_a_different_operator_before_incus(self) -> None:
        self.helper.create("agent-1")
        other = LifecycleHelper(self.config, runner=lambda argv: self.commands.append(argv), event_writer=self.writer,
                                observer=lambda: {"memory_mib": 16000, "disk_gib": 256, "fresh": True},
                                network_checker=lambda config: True, caller_uid=os.getuid() + 1)
        with self.assertRaises(UsageError):
            other.attach("agent-1")
        self.assertEqual(len(self.commands), 3)

    def test_status_normalizes_missing_guest_observations_instead_of_raw_incus_json(self) -> None:
        report = self.helper.normalized_observation("agent-1", None)
        self.assertEqual(report["schema"], "gc.incus-sandbox.status/v1")
        self.assertEqual(report["observed_state"], "unavailable")
        self.assertEqual(report["observed"]["availability"], "unavailable")
        self.assertIn("admission_headroom", report)

    def test_status_normalizes_observed_guest_resource_facts(self) -> None:
        report = self.helper.normalized_observation("agent-1", {
            "status": "Running",
            "state": {"cpu": {"usage": 123}, "memory": {"usage": 8 * 1024 * 1024},
                      "disk": {"root": {"usage": 2 * 1024 * 1024 * 1024}}},
        })
        self.assertEqual(report["observed_state"], "running")
        self.assertEqual(report["observed"]["cpu_usage_ns"], 123)
        self.assertEqual(report["observed"]["guest_memory_mib"], 8)
        self.assertEqual(report["observed"]["guest_disk_gib"], 2)

    def test_status_query_emits_only_the_normalized_document(self) -> None:
        self.helper.create("agent-1")
        responses = iter([
            SimpleNamespace(stdout=json.dumps({"status": "Running"})),
            SimpleNamespace(stdout=json.dumps({"cpu": {"usage": 7}})),
        ])
        with patch("tools.incus_sandbox.helper.subprocess.run", side_effect=lambda *args, **kwargs: next(responses)):
            self.helper.status("agent-1")
        record = json.loads(self.config.event_log.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(record["action"], "status")
        self.assertEqual(record["outcome"], "success")


class EventBoundaryTest(SandboxTestCase):
    def test_event_rotation_is_bounded_and_rejects_unallowlisted_fields(self) -> None:
        for index in range(20):
            self.writer.write({"action": "start", "outcome": "success", "sandbox_id": f"agent-{index}"})
        self.assertLessEqual(self.config.event_log.stat().st_size, self.config.event_max_bytes)
        with self.assertRaises(ValueError):
            self.writer.write({"action": "start", "outcome": "success", "argv": ["secret"]})

    def test_event_writer_rejects_a_symlink_substituted_after_setup(self) -> None:
        self.config.event_log.parent.mkdir(parents=True)
        target = self.root / "outside-log"
        self.config.event_log.symlink_to(target)
        with self.assertRaises(RuntimeError):
            self.writer.write({"action": "start", "outcome": "success"})

    def test_event_writer_rejects_invalid_resource_facts(self) -> None:
        with self.assertRaises(ValueError):
            self.writer.write({"action": "start", "outcome": "success", "assigned": {"bad": "fact"}})


class SetupContractTest(unittest.TestCase):
    def test_root_helper_is_directly_executable_as_a_python_program(self) -> None:
        root = Path(__file__).resolve().parents[2]
        helper = (root / "tools/incus_sandbox/helper.py").read_text(encoding="utf-8")
        self.assertTrue(helper.startswith("#!/usr/bin/python3\n"))

    def test_setup_installs_the_closed_guest_transfer_programs(self) -> None:
        root = Path(__file__).resolve().parents[2]
        setup = (root / "tools/incus_sandbox/setup.sh").read_text(encoding="utf-8")
        self.assertIn("guest_bootstrap.py", setup)
        self.assertIn("transfer.py", setup)
        self.assertIn("source.mjs", setup)
        self.assertIn("transfer.py *", setup)

    def test_dry_run_is_explicit_about_owned_resources_and_never_flushes_firewalls(self) -> None:
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run(["bash", str(root / "tools/incus_sandbox/setup.sh"), "--dry-run", "install"],
                                capture_output=True, text=True, check=True)
        self.assertIn("incus project create gc-sandbox", result.stdout)
        self.assertIn("nft -f", result.stdout)
        self.assertIn("btrfs size=64GiB", result.stdout)
        self.assertIn("quota write probe", result.stdout)
        self.assertIn('profile device add gc-sandbox-default root disk path=/ pool=gc-sandbox-pool --project gc-sandbox', result.stdout)
        self.assertIn('project set gc-sandbox restricted.devices.nic allow', result.stdout)
        self.assertIn('profile device add gc-sandbox-default agent disk source=agent:config --project gc-sandbox', result.stdout)
        self.assertIn("record network-addresses.sha256", result.stdout)
        self.assertNotIn("flush ruleset", result.stdout)
        self.assertNotIn("mkfs", result.stdout)

    def test_dry_run_rollback_refuses_to_remove_running_owned_vms(self) -> None:
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run(["bash", str(root / "tools/incus_sandbox/setup.sh"), "--dry-run", "rollback"],
                                capture_output=True, text=True, check=True)
        self.assertIn("refuse rollback while owned VMs are running", result.stdout)

    def test_firewall_has_a_scoped_input_deny_and_rollback_requires_the_ownership_record(self) -> None:
        root = Path(__file__).resolve().parents[2]
        rules = (root / "tools/incus_sandbox/gc-incus-sandbox.nft").read_text(encoding="utf-8")
        setup = (root / "tools/incus_sandbox/setup.sh").read_text(encoding="utf-8")
        self.assertIn("chain input", rules)
        self.assertIn('iifname "gcbr0" ip daddr @host_ipv4 drop', rules)
        self.assertIn("require_complete_ownership_record", setup)
        self.assertIn("setup-owned", setup)


def write_lifecycle_event(path: str, max_bytes: int, sandbox: str) -> None:
    """Write one event from an independent process, as the helper and transfer do."""
    EventWriter(Path(path), max_bytes, expected_uid=os.getuid()).write(
        {"action": "transfer", "outcome": "success", "sandbox_id": sandbox},
    )


class EventConcurrencyTest(SandboxTestCase):
    def test_concurrent_lifecycle_processes_keep_every_event(self) -> None:
        names = [f"agent-{index}" for index in range(8)]
        arguments = [(str(self.config.event_log), 1024 * 1024, name) for name in names]
        with multiprocessing.get_context("fork").Pool(4) as pool:
            pool.starmap(write_lifecycle_event, arguments)
        recorded = [json.loads(line)["sandbox_id"]
                    for line in self.config.event_log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(sorted(recorded), sorted(names))


class LifecycleTransitionTest(SandboxTestCase):
    def _failing_runner(self, failing: str):
        """Return a runner that fails the first command containing the given verb."""
        def runner(argv: list[str]) -> dict[str, int]:
            self.commands.append(argv)
            if failing in argv:
                raise subprocess.CalledProcessError(1, argv)
            return {"returncode": 0}
        return runner

    def test_create_refuses_a_sandbox_that_is_already_allocated(self) -> None:
        self.helper.create("agent-1")
        self.helper.stop("agent-1")
        self.commands.clear()
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-1")
        # A stopped sandbox keeps its VM and its allocation; nothing is deleted.
        self.assertEqual(self.commands, [])
        records = json.loads((self.root / "state" / "allocations.json").read_text(encoding="utf-8"))
        self.assertIn("agent-1", records)

    def test_a_failed_launch_deletes_nothing(self) -> None:
        self.helper.runner = self._failing_runner("launch")
        with self.assertRaises(subprocess.CalledProcessError):
            self.helper.create("agent-1")
        self.assertEqual([argv for argv in self.commands if "delete" in argv], [])
        records = json.loads((self.root / "state" / "allocations.json").read_text(encoding="utf-8"))
        self.assertNotIn("agent-1", records)

    def test_a_failed_configuration_step_deletes_the_instance_this_call_created(self) -> None:
        self.helper.runner = self._failing_runner("limits.cpu")
        with self.assertRaises(subprocess.CalledProcessError):
            self.helper.create("agent-1")
        self.assertEqual([argv[1] for argv in self.commands if "delete" in argv], ["delete"])

    def test_a_failed_start_restores_the_stopped_allocation(self) -> None:
        self.helper.create("agent-1")
        self.helper.stop("agent-1")
        self.helper.runner = self._failing_runner("start")
        with self.assertRaises(subprocess.CalledProcessError):
            self.helper.start("agent-1")
        records = json.loads((self.root / "state" / "allocations.json").read_text(encoding="utf-8"))
        self.assertFalse(records["agent-1"]["active"])
        self.helper.runner = lambda argv: self.commands.append(argv) or {"returncode": 0}
        self.helper.start("agent-1")

    def test_start_refuses_a_sandbox_this_operator_never_created(self) -> None:
        with self.assertRaises(UsageError):
            self.helper.start("agent-9")


class BoundaryProbeTest(unittest.TestCase):
    def test_canary_probes_cover_sibling_host_private_metadata_and_ipv6_without_user_command_input(self) -> None:
        commands = boundary_probe_commands("agent-1", "10.74.0.1", "10.74.0.129")
        rendered = json.dumps(commands)
        self.assertIn("169.254.169.254", rendered)
        self.assertIn("10.74.0.1", rendered)
        self.assertIn("10.74.0.129", rendered)
        # The guest's own loopback proves nothing about the sandbox firewall.
        self.assertNotIn("::1\"", rendered)
        self.assertIn(IPV6_CANARY, rendered)
        self.assertTrue(all(command[0:2] == ["incus", "exec"] for command in commands))

    def test_probe_main_fails_when_a_prohibited_target_answers(self) -> None:
        listed = SimpleNamespace(returncode=0, stdout='"10.74.0.129 (enp5s0)"\n')
        for guest_status, expected in ((0, 0), (1, 1)):
            responses = [listed, SimpleNamespace(returncode=guest_status)]
            with patch("tools.incus_sandbox.probe.subprocess.run", side_effect=responses) as run:
                self.assertEqual(probe_main(["agent-1", "10.74.0.1", "agent-2"]), expected)
            self.assertEqual(run.call_count, 2)

    def test_probe_main_rejects_an_incomplete_argument_vector(self) -> None:
        with self.assertRaises(ValueError):
            probe_main(["agent-1"])

    def test_probe_rejects_invalid_names_and_non_ipv4_host_addresses(self) -> None:
        with self.assertRaises(ValueError):
            boundary_probe_commands("agent;1", "10.74.0.1", "10.74.0.129")
        with self.assertRaises(ValueError):
            boundary_probe_commands("agent-1", "::1", "10.74.0.129")
        with self.assertRaises(ValueError):
            sibling_address("\n")


if __name__ == "__main__":
    unittest.main()
