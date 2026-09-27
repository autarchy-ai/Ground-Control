"""VM capacity and ownership survive stops and failed lifecycle calls (issue #1721)."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.incus_sandbox.allocations import AdmissionError
from tools.incus_sandbox.config import load_config
from tools.incus_sandbox.events import EventWriter
from tools.incus_sandbox.helper import CleanupPendingError, LifecycleHelper, UsageError
from tools.incus_sandbox.observations import pool_space
from tools.tests.test_incus_sandbox import config_doc, initialize_ledger

HOST_FACTS = {"memory_mib": 16384, "disk_gib": 256, "pool_total_gib": 64, "pool_free_gib": 60, "fresh": True}
GIB = 1024 ** 3


def ledger(case: "LedgerTestCase") -> dict[str, dict[str, object]]:
    """The durable allocation records."""
    return json.loads((case.config.state_dir / "allocations.json").read_text(encoding="utf-8"))


def events(case: "LedgerTestCase") -> list[dict[str, object]]:
    """The durable lifecycle events."""
    return [json.loads(line) for line in case.config.event_log.read_text(encoding="utf-8").splitlines()]


class LedgerTestCase(unittest.TestCase):
    """A helper over a fake daemon whose instances follow the launch and delete calls it runs."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="gc-incus-ledger-")
        self.root = Path(self.tmp.name)
        doc = config_doc(self.root)
        doc["event_max_bytes"] = 64 * 1024
        doc["host"] = {**doc["host"], "max_disk_gib": 48}
        path = self.root / "config.json"
        path.write_text(json.dumps(doc), encoding="utf-8")
        path.chmod(0o600)
        self.config = load_config(path, expected_uid=os.getuid())
        initialize_ledger(self.config.state_dir)
        self.writer = EventWriter(self.config.event_log, self.config.event_max_bytes, expected_uid=os.getuid())
        self.commands: list[list[str]] = []
        self.failing: set[str] = set()
        self.instances: dict[str, dict[str, object]] = {}
        self.inventory_available = True
        self.facts = dict(HOST_FACTS)
        self.helper = self.make_helper()

    def make_helper(self, caller_uid: int | None = None) -> LifecycleHelper:
        return LifecycleHelper(
            self.config, runner=self._run, event_writer=self.writer, observer=lambda: dict(self.facts),
            network_checker=lambda config: True, caller_uid=os.getuid() if caller_uid is None else caller_uid,
            query=self._query,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def sandbox_vm(self, status: str = "Running", *, profile: str | None = None) -> dict[str, object]:
        return {"type": "virtual-machine", "status": status, "profiles": [profile or self.config.profile],
                "expanded_devices": {"root": {"type": "disk", "path": "/", "pool": self.config.pool}}}

    def _query(self, argv: list[str], deadline: int) -> str:
        if not self.inventory_available:
            raise subprocess.CalledProcessError(1, argv)
        if argv[2].endswith("recursion=1"):
            return json.dumps([{"name": name, **item} for name, item in sorted(self.instances.items())])
        return json.dumps([f"/1.0/instances/{name}" for name in sorted(self.instances)])

    def _run(self, argv: list[str], operation: str) -> dict[str, int]:
        self.commands.append(argv)
        if argv[1] == "launch" and "launch-creates" in self.failing:
            self.instances[argv[3]] = self.sandbox_vm()
        if any(verb in argv for verb in self.failing):
            raise subprocess.CalledProcessError(1, argv)
        if argv[1] == "launch":
            self.instances[argv[3]] = self.sandbox_vm()
        elif argv[1] == "delete":
            self.instances.pop(argv[2], None)
        elif argv[1] in {"stop", "start"}:
            self.instances[argv[2]]["status"] = "Stopped" if argv[1] == "stop" else "Running"
        return {"returncode": 0}

    def headroom(self) -> dict[str, int | None]:
        return self.helper.normalized_observation("agent-1", None)["admission_headroom"]


class StoppedDiskAccountingTest(LedgerTestCase):
    def test_stopped_vms_keep_their_disk_charged_against_the_aggregate(self) -> None:
        # A 48 GiB ceiling less 16 GiB overhead holds exactly two 16 GiB disks.
        for name in ("agent-1", "agent-2"):
            self.helper.create(name)
            self.helper.stop(name)
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-3")
        self.assertEqual(self.headroom(), {"cpu": 8, "memory_mib": 32768, "disk_gib": 0})
        self.assertEqual(events(self)[-1]["error_code"], "admission_insufficient")

    def test_starting_a_stopped_vm_does_not_charge_its_disk_twice(self) -> None:
        for name in ("agent-1", "agent-2"):
            self.helper.create(name)
            self.helper.stop(name)
        self.helper.start("agent-1")
        self.assertEqual(ledger(self)["agent-1"]["state"], "running")

    def test_only_a_confirmed_delete_returns_the_disk(self) -> None:
        for name in ("agent-1", "agent-2"):
            self.helper.create(name)
            self.helper.stop(name)
        self.failing = {"delete"}
        with self.assertRaises(subprocess.CalledProcessError):
            self.helper.delete("agent-2", "agent-2")
        self.assertEqual(self.headroom()["disk_gib"], 0)
        self.failing = set()
        self.helper.delete("agent-2", "agent-2")
        self.helper.create("agent-3")

    def test_the_storage_pool_size_caps_the_configured_ceiling(self) -> None:
        self.facts["pool_total_gib"] = 40
        self.helper.create("agent-1")
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-2")

    def test_a_pool_without_room_for_the_disk_denies_a_new_vm(self) -> None:
        self.facts["pool_free_gib"] = 15
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-1")
        self.assertEqual(self.commands, [])

    def test_an_unobserved_pool_denies_admission_and_reports_no_headroom(self) -> None:
        del self.facts["pool_total_gib"], self.facts["pool_free_gib"]
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-1")
        self.assertEqual(events(self)[-1]["error_code"], "admission_observation_stale")
        self.assertIsNone(self.headroom()["disk_gib"])


class PoolObservationTest(LedgerTestCase):
    def test_the_default_observer_measures_the_configured_pool(self) -> None:
        queried: list[str] = []

        def query(argv: list[str], deadline: int) -> str:
            queried.append(argv[2])
            return json.dumps({"metadata": {"space": {"total": 64 * GIB, "used": 10 * GIB}}})

        helper = LifecycleHelper(self.config, runner=self._run, event_writer=self.writer, query=query)
        observed = helper.observer()
        self.assertEqual(queried, [f"/1.0/storage-pools/{self.config.pool}/resources"])
        self.assertEqual((observed["pool_total_gib"], observed["pool_free_gib"]), (64, 54))

    def test_malformed_pool_facts_are_unavailable_not_zero(self) -> None:
        for payload in (None, [], {"space": {}}, {"space": {"total": True, "used": 0}},
                        {"space": {"total": GIB, "used": 2 * GIB}}, {"space": {"total": 0, "used": 0}}):
            with self.subTest(payload=payload):
                self.assertIsNone(pool_space(payload))


class FailedCompensationTest(LedgerTestCase):
    def test_a_failed_rollback_keeps_the_vm_pending_and_reports_both_failures(self) -> None:
        self.failing = {"limits.cpu", "delete"}
        with self.assertRaises(CleanupPendingError) as raised:
            self.helper.create("agent-1")
        self.assertEqual((raised.exception.primary_code, raised.exception.cleanup_code),
                         ("command_failed", "command_failed"))
        self.assertIn("grndctl sandbox delete agent-1 --confirm agent-1", str(raised.exception))
        self.assertIsInstance(raised.exception.__cause__, subprocess.CalledProcessError)
        self.assertEqual(ledger(self)["agent-1"]["state"], "cleanup_pending")
        self.assertEqual([(event["action"], event["outcome"]) for event in events(self)],
                         [("create", "failure"), ("cleanup", "failure")])
        # The VM that may still be running keeps its compute and its disk.
        self.assertEqual(self.headroom(), {"cpu": 6, "memory_mib": 28672, "disk_gib": 16})

    def test_a_pending_vm_is_only_inspected_or_deleted(self) -> None:
        self.failing = {"limits.cpu", "delete"}
        with self.assertRaises(CleanupPendingError):
            self.helper.create("agent-1")
        self.failing = set()
        for verb in (self.helper.start, self.helper.stop, self.helper.attach):
            with self.subTest(verb=verb.__name__), self.assertRaises(UsageError):
                verb("agent-1")
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-1")
        report = self.helper.normalized_observation("agent-1", None)
        self.assertEqual((report["desired_state"], report["failure_reason"]), ("deleted", "cleanup_pending"))
        self.helper.delete("agent-1", "agent-1")
        self.assertEqual(ledger(self), {})
        self.assertNotIn("agent-1", self.instances)

    def test_a_confirmed_rollback_releases_the_reservation_and_raises_the_primary_failure(self) -> None:
        self.failing = {"limits.cpu"}
        with self.assertRaises(subprocess.CalledProcessError):
            self.helper.create("agent-1")
        self.assertEqual(ledger(self), {})
        self.assertEqual(self.instances, {})

    def test_a_launch_that_failed_after_creating_the_instance_removes_it(self) -> None:
        self.failing = {"launch-creates", "launch"}
        with self.assertRaises(subprocess.CalledProcessError):
            self.helper.create("agent-1")
        self.assertEqual(self.instances, {})
        self.assertEqual(ledger(self), {})

    def test_a_launch_that_created_nothing_deletes_nothing(self) -> None:
        self.failing = {"launch"}
        with self.assertRaises(subprocess.CalledProcessError):
            self.helper.create("agent-1")
        self.assertEqual([argv for argv in self.commands if argv[1] == "delete"], [])
        self.assertEqual(ledger(self), {})

    def test_create_never_claims_an_unrecorded_instance_of_the_same_name(self) -> None:
        self.instances["agent-1"] = self.sandbox_vm()
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-1")
        self.assertEqual(self.commands, [])
        self.assertIn("agent-1", self.instances)
        self.assertEqual(events(self)[-1]["error_code"], "admission_conflict")

    def test_create_without_an_inventory_launches_nothing(self) -> None:
        self.inventory_available = False
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-1")
        self.assertEqual(self.commands, [])

    def test_a_timed_out_start_keeps_the_vm_reserved(self) -> None:
        self.helper.create("agent-1")
        self.helper.stop("agent-1")

        def stalled(argv: list[str], operation: str) -> None:
            raise subprocess.TimeoutExpired(argv, 1)

        self.helper.runner = stalled
        with self.assertRaises(subprocess.TimeoutExpired):
            self.helper.start("agent-1")
        self.assertEqual(ledger(self)["agent-1"]["state"], "running")


class AuditFailureAfterSideEffectTest(LedgerTestCase):
    """An Incus step that succeeded is never compensated for a later audit failure (review core-F3)."""

    def fail_success_events(self) -> None:
        real_write = self.writer.write

        def write(event: dict[str, object]) -> None:
            if event.get("outcome") == "success":
                raise OSError(28, "no space")
            real_write(event)

        self.writer.write = write

    def test_a_started_vm_stays_charged_when_its_event_cannot_be_written(self) -> None:
        self.helper.create("agent-1")
        self.helper.stop("agent-1")
        self.fail_success_events()
        with self.assertRaises(OSError):
            self.helper.start("agent-1")
        self.assertEqual(ledger(self)["agent-1"]["state"], "running")

    def test_a_created_vm_is_kept_and_owned_when_its_event_cannot_be_written(self) -> None:
        self.fail_success_events()
        with self.assertRaises(OSError):
            self.helper.create("agent-1")
        self.assertIn("agent-1", self.instances)
        self.assertEqual(ledger(self)["agent-1"]["state"], "running")
        self.assertEqual([argv for argv in self.commands if argv[1] == "delete"], [])


class ReconcileTest(LedgerTestCase):
    def reconcile(self) -> dict[str, object]:
        with patch("builtins.print") as printed:
            self.helper.dispatch("reconcile")
        return json.loads(printed.call_args.args[0])

    def test_forgets_only_positively_absent_vms_and_their_derived_state(self) -> None:
        self.helper.create("agent-1")
        self.helper.create("agent-2")
        binding = self.config.state_dir / "source-bindings" / "agent-1.json"
        binding.parent.mkdir(parents=True)
        binding.write_text("{}", encoding="utf-8")
        del self.instances["agent-1"]
        report = self.reconcile()
        self.assertEqual(report["forgotten"], ["agent-1"])
        self.assertEqual(set(ledger(self)), {"agent-2"})
        self.assertFalse(binding.exists())
        self.assertEqual(events(self)[-1]["action"], "reconcile")

    def test_a_create_racing_reconcile_is_never_forgotten(self) -> None:
        """Review core-F1/security-F1: the inventory and the ledger update are one serialized step."""
        racer = threading.Thread(target=self.make_helper().create, args=("agent-1",))
        real_query = self._query

        def query(argv: list[str], deadline: int) -> str:
            snapshot = real_query(argv, deadline)
            if argv[2].endswith("recursion=1") and not racer.is_alive() and not racer.ident:
                # A create starts after the inventory is read; it must not land before the save.
                racer.start()
                racer.join(1)
            return snapshot

        self._query = query
        self.helper = self.make_helper()
        self.reconcile()
        racer.join(10)
        self.assertIn("agent-1", self.instances)
        self.assertEqual(ledger(self)["agent-1"]["state"], "running")

    def test_adopts_an_orphaned_sandbox_vm_and_reports_foreign_instances(self) -> None:
        self.instances["agent-1"] = self.sandbox_vm("Stopped")
        self.instances["other"] = self.sandbox_vm(profile="default")
        self.instances["gc-template-build-1"] = self.sandbox_vm()
        report = self.reconcile()
        self.assertEqual((report["adopted"], report["unmanaged"]), (["agent-1"], ["other"]))
        self.assertEqual(ledger(self)["agent-1"]["state"], "stopped")
        self.helper.delete("agent-1", "agent-1")
        self.assertNotIn("agent-1", self.instances)

    def test_syncs_run_state_and_keeps_pending_cleanup(self) -> None:
        self.helper.create("agent-1")
        self.instances["agent-1"]["status"] = "Stopped"
        self.failing = {"limits.cpu", "delete"}
        with self.assertRaises(CleanupPendingError):
            self.helper.create("agent-2")
        report = self.reconcile()
        self.assertEqual((report["updated"], report["cleanup_pending"]), (["agent-1"], ["agent-2"]))
        self.assertEqual(ledger(self)["agent-1"]["state"], "stopped")
        self.assertEqual(ledger(self)["agent-2"]["state"], "cleanup_pending")

    def test_rebuilds_a_malformed_ledger_from_the_inventory_and_keeps_its_bytes(self) -> None:
        self.helper.create("agent-1")
        path = self.config.state_dir / "allocations.json"
        path.write_bytes(b'{"agent-1": {"cpu"')
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-2")
        report = self.reconcile()
        self.assertTrue(report["rebuilt"])
        self.assertEqual(ledger(self)["agent-1"]["state"], "running")
        self.assertEqual((path.parent / "allocations.json.invalid").read_bytes(), b'{"agent-1": {"cpu"')

    def test_an_unavailable_inventory_changes_nothing(self) -> None:
        self.helper.create("agent-1")
        before = ledger(self)
        self.inventory_available = False
        with self.assertRaises(AdmissionError):
            self.helper.dispatch("reconcile")
        self.assertEqual(ledger(self), before)
        self.assertEqual(events(self)[-1]["outcome"], "denied")

    def test_is_operator_only_and_takes_no_name(self) -> None:
        with self.assertRaises(UsageError):
            self.make_helper(os.getuid() + 1).dispatch("reconcile")
        with self.assertRaises(UsageError):
            self.helper.dispatch("reconcile", "agent-1")


if __name__ == "__main__":
    unittest.main()
