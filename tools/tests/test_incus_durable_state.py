"""The allocation ledger and event log are never truncated to an incomplete record (issue #1721)."""

from __future__ import annotations

import json
import multiprocessing
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.incus_sandbox import durable
from tools.incus_sandbox.allocations import AdmissionError, Ledger
from tools.incus_sandbox.events import EventWriter
from tools.tests.test_incus_ledger import LedgerTestCase, events, ledger


def add_record(state_dir: str, name: str) -> None:
    """Add one reservation from an independent process, as concurrent helpers do."""
    with Ledger(Path(state_dir)) as held:
        held.records[name] = {"cpu": 1, "memory_mib": 1, "disk_gib": 1, "owner_uid": 1, "state": "stopped"}
        held.save()


def crash_during_replace(state_dir: str) -> None:
    """Die, as a killed helper would, after writing the new ledger but before renaming it."""
    with patch("os.replace", side_effect=lambda *_: os._exit(9)), Ledger(Path(state_dir)) as held:
        held.records = {}
        held.save()


class DurableReplaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="gc-incus-durable-")
        self.path = Path(self.tmp.name) / "state.json"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_short_writes_are_completed(self) -> None:
        real_write = os.write
        with patch("os.write", side_effect=lambda fd, data: real_write(fd, bytes(data)[:3])):
            durable.replace_file(self.path, b"0123456789", 0o600)
        self.assertEqual(self.path.read_bytes(), b"0123456789")
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_a_write_that_makes_no_progress_fails_and_keeps_the_previous_file(self) -> None:
        durable.replace_file(self.path, b"previous", 0o600)
        with patch("os.write", return_value=0), self.assertRaises(OSError):
            durable.replace_file(self.path, b"next", 0o600)
        self.assertEqual(self.path.read_bytes(), b"previous")
        self.assertEqual(sorted(entry.name for entry in self.path.parent.iterdir()), ["state.json"])

    def test_a_ledger_that_was_never_written_is_not_an_empty_one(self) -> None:
        with self.assertRaises(AdmissionError):
            Ledger(self.path.parent)

    def test_a_symlinked_ledger_is_invalid_state(self) -> None:
        target = self.path.parent / "elsewhere.json"
        target.write_text("{}", encoding="utf-8")
        (self.path.parent / "allocations.json").symlink_to(target)
        with self.assertRaises(AdmissionError):
            Ledger(self.path.parent)


class LedgerDurabilityTest(LedgerTestCase):
    def test_a_short_ledger_write_is_completed(self) -> None:
        real_write = os.write

        def short_write(descriptor: int, data: bytes) -> int:
            return real_write(descriptor, bytes(data)[: max(1, len(data) // 2)])

        with patch("os.write", side_effect=short_write):
            self.helper.create("agent-1")
        self.assertIn("agent-1", ledger(self))

    def test_a_failed_ledger_write_leaves_the_previous_ledger(self) -> None:
        self.helper.create("agent-1")
        with patch("os.write", side_effect=OSError(28, "no space")), self.assertRaises(OSError):
            self.helper.stop("agent-1")
        self.assertEqual(ledger(self)["agent-1"]["state"], "running")

    def test_a_helper_killed_mid_replace_leaves_the_last_complete_ledger(self) -> None:
        self.helper.create("agent-1")
        child = multiprocessing.get_context("fork").Process(
            target=crash_during_replace, args=(str(self.config.state_dir),))
        child.start()
        child.join(10)
        self.assertEqual(child.exitcode, 9)
        self.assertEqual(ledger(self)["agent-1"]["state"], "running")
        # The lock died with the process, so the next helper proceeds.
        self.helper.stop("agent-1")

    def test_concurrent_helpers_lose_no_record_across_replacements(self) -> None:
        names = [f"agent-{index}" for index in range(8)]
        with multiprocessing.get_context("fork").Pool(4) as pool:
            pool.starmap(add_record, [(str(self.config.state_dir), name) for name in names])
        self.assertEqual(sorted(ledger(self)), sorted(names))

    def test_legacy_records_keep_their_meaning_and_are_rewritten_in_the_state_form(self) -> None:
        legacy = {"cpu": 2, "memory_mib": 4096, "disk_gib": 16, "owner_uid": os.getuid()}
        (self.config.state_dir / "allocations.json").write_text(json.dumps({
            "agent-1": {**legacy, "active": True}, "agent-2": {**legacy, "active": False}}), encoding="utf-8")
        self.instances.update({"agent-1": self.sandbox_vm(), "agent-2": self.sandbox_vm("Stopped")})
        # Both disks and one VM's compute are charged, so a third 16 GiB disk does not fit.
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-3")
        self.helper.stop("agent-1")
        self.assertEqual({name: record["state"] for name, record in ledger(self).items()},
                         {"agent-1": "stopped", "agent-2": "stopped"})

    def test_a_missing_ledger_fails_closed_until_reconcile_rebuilds_it(self) -> None:
        """Review core-F2: only setup's initialization means no VM is owned."""
        self.helper.create("agent-1")
        path = self.config.state_dir / "allocations.json"
        path.unlink()
        with self.assertRaises(AdmissionError):
            self.helper.create("agent-2")
        self.assertNotIn("agent-2", self.instances)
        with patch("builtins.print") as printed:
            self.helper.dispatch("reconcile")
        self.assertTrue(json.loads(printed.call_args.args[0])["rebuilt"])
        self.assertEqual(ledger(self)["agent-1"]["state"], "running")
        self.assertFalse((self.config.state_dir / "allocations.json.invalid").exists())

    def test_an_empty_or_malformed_ledger_fails_closed(self) -> None:
        path = self.config.state_dir / "allocations.json"
        for content in (b"", b"{", b"[]", b'{"agent-1": {"cpu": 2}}', b"\xff"):
            path.write_bytes(content)
            with self.subTest(content=content), self.assertRaises(AdmissionError):
                self.helper.create("agent-1")
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(self.commands, [])


class EventDurabilityTest(LedgerTestCase):
    def test_a_failed_event_write_leaves_the_retained_history(self) -> None:
        self.writer.write({"action": "start", "outcome": "success", "sandbox_id": "agent-1"})
        with patch("os.write", side_effect=OSError(28, "no space")), self.assertRaises(OSError):
            self.writer.write({"action": "stop", "outcome": "success", "sandbox_id": "agent-1"})
        self.assertEqual([event["action"] for event in events(self)], ["start"])

    def test_a_damaged_log_blocks_mutation_before_incus_and_is_kept(self) -> None:
        self.config.event_log.parent.mkdir(parents=True)
        damaged = b'{"action":"create"}\n{"action":"st'
        self.config.event_log.write_bytes(damaged)
        with self.assertRaisesRegex(RuntimeError, "malformed"):
            self.helper.create("agent-1")
        self.assertEqual(self.commands, [])
        self.assertEqual(self.config.event_log.read_bytes(), damaged)

    def test_rotation_discards_only_whole_oldest_events(self) -> None:
        writer = EventWriter(self.config.event_log, 1024, expected_uid=os.getuid())
        for index in range(12):
            writer.write({"action": "start", "outcome": "success", "sandbox_id": f"agent-{index}"})
        retained = [event["sandbox_id"] for event in events(self)]
        self.assertEqual(retained, [f"agent-{index}" for index in range(12 - len(retained), 12)])
        self.assertEqual(events(self)[-1]["schema"], "gc.incus-sandbox.event/v3")


if __name__ == "__main__":
    unittest.main()
