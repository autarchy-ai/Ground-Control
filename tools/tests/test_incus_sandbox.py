"""Behavioral tests for the local Incus coding sandbox boundary."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from tools.incus_sandbox.config import ConfigError, load_config
from tools.incus_sandbox.events import EventWriter
from tools.incus_sandbox.helper import AdmissionError, LifecycleHelper, UsageError
from tools.incus_sandbox.probe import boundary_probe_commands


def config_doc(tmp: Path) -> dict[str, object]:
    return {
        "schema": "gc.incus-sandbox/v1",
        "project": "gc-sandbox",
        "profile": "gc-sandbox-default",
        "pool": "gc-sandbox-pool",
        "bridge": "gcbr0",
        "image": "sha256:" + "a" * 64,
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
        doc["image"] = "sha256:" + "0" * 64
        self.config_path.write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(self.config_path, expected_uid=os.getuid())


class LifecycleBoundaryTest(SandboxTestCase):
    def test_create_uses_only_fixed_incus_argv_and_records_allowlisted_event(self) -> None:
        self.helper.create("agent-1")
        self.assertEqual(self.commands[0], [
            "/usr/bin/incus", "launch", self.config.image, "agent-1", "--project", self.config.project,
            "--profile", self.config.profile, "--vm",
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
        self.assertEqual(len(self.commands), 4)

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


class EventBoundaryTest(SandboxTestCase):
    def test_event_rotation_is_bounded_and_rejects_unallowlisted_fields(self) -> None:
        for index in range(20):
            self.writer.write({"action": "start", "outcome": "success", "sandbox_id": f"agent-{index}"})
        self.assertLessEqual(self.config.event_log.stat().st_size, self.config.event_max_bytes)
        with self.assertRaises(ValueError):
            self.writer.write({"action": "start", "outcome": "success", "argv": ["secret"]})


class SetupContractTest(unittest.TestCase):
    def test_dry_run_is_explicit_about_owned_resources_and_never_flushes_firewalls(self) -> None:
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run(["bash", str(root / "tools/incus_sandbox/setup.sh"), "--dry-run", "install"],
                                capture_output=True, text=True, check=True)
        self.assertIn("incus project create gc-sandbox", result.stdout)
        self.assertIn("nft -f", result.stdout)
        self.assertIn("quota write probe", result.stdout)
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


class BoundaryProbeTest(unittest.TestCase):
    def test_canary_probes_cover_sibling_host_private_metadata_and_ipv6_without_user_command_input(self) -> None:
        commands = boundary_probe_commands("agent-1", "10.74.0.1", "agent-2")
        rendered = json.dumps(commands)
        self.assertIn("169.254.169.254", rendered)
        self.assertIn("10.74.0.1", rendered)
        self.assertIn("agent-2", rendered)
        self.assertIn("::1", rendered)
        self.assertTrue(all(command[0:2] == ["incus", "exec"] for command in commands))


if __name__ == "__main__":
    unittest.main()
