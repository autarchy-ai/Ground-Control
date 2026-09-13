"""Tests for tools/gc_dispatch/ledger.py - the shared per-user capacity ledger.

These run real independent processes against a temporary state directory, because
the properties that matter (cross-process admission, crash recovery, and a lease
that outlives its supervisor) do not exist inside one interpreter.
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
sys.path.insert(0, str(TOOLS_ROOT))

from gc_dispatch.ledger import Ledger, LedgerError, prepare_state_dir

# Admits itself, reports the grant, then blocks on stdin so the test controls
# exactly when the lease is released. No sleeps, so nothing here is timing bound.
HOLDER = r"""
import json, os, sys
sys.path.insert(0, os.environ["GC_DISPATCH_TOOLS"])
from gc_dispatch.ledger import Ledger
ledger = Ledger(os.environ["GC_DISPATCH_STATE"], stale_after_seconds=3600)
ticket = ledger.enqueue("holder", int(sys.argv[1]), int(sys.argv[2]))
granted = ledger.try_admit(ticket, int(sys.argv[3]))
if len(sys.argv) > 4 and sys.argv[4] == "spawn-heir":
    # A grandchild that inherits the lease description, so killing this process
    # leaves the lease genuinely held by live work.
    os.posix_spawn(sys.executable, [sys.executable, "-c", "import sys; sys.stdin.read()"], os.environ)
print(json.dumps({"granted": granted, "ticket": ticket.id, "pid": os.getpid()}), flush=True)
sys.stdin.readline()
ledger.release(ticket)
"""


class LedgerTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gc-dispatch-ledger-"))
        self.state = self.tmp / "state"
        self.holders = []

    def tearDown(self):
        for proc in self.holders:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
            # Closing the pipes ends any heir still blocked on the inherited stdin.
            for stream in (proc.stdin, proc.stdout):
                if stream is not None and not stream.closed:
                    stream.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _ledger(self, stale_after_seconds=3600):
        return Ledger(self.state, stale_after_seconds=stale_after_seconds)

    def _start_holder(self, requested, minimum, capacity, mode=None):
        env = dict(os.environ)
        env["GC_DISPATCH_TOOLS"] = str(TOOLS_ROOT)
        env["GC_DISPATCH_STATE"] = str(self.state)
        args = [sys.executable, "-c", HOLDER, str(requested), str(minimum), str(capacity)]
        if mode:
            args.append(mode)
        proc = subprocess.Popen(
            args, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        self.holders.append(proc)
        line = proc.stdout.readline()
        self.assertTrue(line, "holder exited before reporting its grant")
        return proc, json.loads(line)

    def _stop_holder(self, proc):
        proc.stdin.write("go\n")
        proc.stdin.flush()
        self.assertEqual(proc.wait(timeout=30), 0)


class LedgerAdmissionTest(LedgerTestBase):
    def test_independent_processes_share_one_host_budget(self):
        _, first = self._start_holder(6, 6, 8)
        self.assertEqual(first["granted"], 6)

        ledger = self._ledger()
        mine = ledger.enqueue("local", 4, 4)
        self.assertIsNone(ledger.try_admit(mine, 8), "capacity was oversubscribed")

    def test_inexpensive_work_is_admitted_beside_a_running_suite(self):
        self._start_holder(6, 6, 8)
        ledger = self._ledger()
        mine = ledger.enqueue("lint", 2, 2)
        self.assertEqual(ledger.try_admit(mine, 8), 2)

    def test_capacity_is_reusable_after_a_clean_release(self):
        proc, _ = self._start_holder(8, 8, 8)
        self._stop_holder(proc)

        ledger = self._ledger()
        mine = ledger.enqueue("local", 8, 8)
        self.assertEqual(ledger.try_admit(mine, 8), 8)

    def test_release_is_idempotent(self):
        ledger = self._ledger()
        ticket = ledger.enqueue("local", 2, 2)
        ledger.try_admit(ticket, 8)
        ledger.release(ticket)
        ledger.release(ticket)
        self.assertEqual(ledger.snapshot(), [])


class LedgerRecoveryTest(LedgerTestBase):
    def test_a_killed_holder_releases_its_capacity(self):
        proc, _ = self._start_holder(8, 8, 8)
        proc.kill()
        proc.wait(timeout=30)

        ledger = self._ledger()
        mine = ledger.enqueue("local", 8, 8)
        self.assertEqual(ledger.try_admit(mine, 8), 8)

    def test_a_lease_held_by_a_live_heir_survives_its_dead_supervisor(self):
        # The record's pid is gone, so a pid-based liveness check would free
        # capacity the surviving process is still consuming.
        proc, report = self._start_holder(8, 8, 8, mode="spawn-heir")
        proc.kill()
        proc.wait(timeout=30)

        ledger = self._ledger()
        mine = ledger.enqueue("local", 8, 8)
        self.assertIsNone(ledger.try_admit(mine, 8))
        self.assertIn(report["ticket"], [e["ticket"] for e in ledger.snapshot()])

    def test_the_stale_bound_reclaims_a_lease_no_supervisor_owns(self):
        proc, _ = self._start_holder(8, 8, 8, mode="spawn-heir")
        proc.kill()
        proc.wait(timeout=30)

        ledger = self._ledger(stale_after_seconds=0)
        mine = ledger.enqueue("local", 8, 8)
        self.assertEqual(ledger.try_admit(mine, 8), 8)

    def test_a_corrupt_ledger_fails_closed_instead_of_resetting(self):
        ledger = self._ledger()
        ledger.release(ledger.enqueue("seed", 1, 1))
        (self.state / "ledger.json").write_text("{not json", encoding="utf-8")

        with self.assertRaises(LedgerError):
            self._ledger().enqueue("local", 1, 1)
        self.assertEqual((self.state / "ledger.json").read_text(encoding="utf-8"), "{not json")

    def test_a_queued_ticket_is_removed_when_its_wait_is_abandoned(self):
        ledger = self._ledger()
        ticket = ledger.enqueue("local", 8, 8)
        ledger.release(ticket)
        self.assertEqual(ledger.snapshot(), [])


class StateDirectoryTest(LedgerTestBase):
    def test_state_directory_is_created_private_to_the_owner(self):
        prepare_state_dir(self.state)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)

    def test_a_group_readable_state_directory_is_tightened(self):
        self.state.mkdir(parents=True)
        self.state.chmod(0o755)
        prepare_state_dir(self.state)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)

    def test_a_symlinked_state_directory_is_refused(self):
        real = self.tmp / "elsewhere"
        real.mkdir()
        link = self.tmp / "link"
        link.symlink_to(real, target_is_directory=True)
        with self.assertRaises(LedgerError):
            prepare_state_dir(link)

    def test_a_state_path_that_is_not_a_directory_is_refused(self):
        path = self.tmp / "file"
        path.write_text("x", encoding="utf-8")
        with self.assertRaises(LedgerError):
            prepare_state_dir(path)

    def test_ledger_records_carry_no_command_or_repository_data(self):
        ledger = self._ledger()
        ticket = ledger.enqueue("profile-name", 4, 2)
        ledger.try_admit(ticket, 8)
        allowed = {
            "ticket", "seq", "profile", "requested", "minimum", "granted",
            "state", "enqueued_at", "started_at", "supervisor", "orphaned_at",
        }
        for entry in ledger.snapshot():
            self.assertEqual(set(entry) - allowed, set())


class LeaseLifetimeTest(LedgerTestBase):
    """A grant is released only when nothing is still spending it (finding F1)."""

    def test_a_live_supervisor_keeps_its_grant_past_the_stale_bound(self):
        # The age bound exists to reclaim an orphaned lease, not to evict a suite
        # that is simply taking a long time.
        self._start_holder(8, 8, 8)
        ledger = self._ledger(stale_after_seconds=0)
        mine = ledger.enqueue("local", 8, 8)
        self.assertIsNone(ledger.try_admit(mine, 8))

    def test_a_queued_entry_is_not_evicted_while_its_owner_waits(self):
        holder, _ = self._start_holder(8, 8, 8)
        waiter = self._ledger(stale_after_seconds=0)
        queued = waiter.enqueue("waiter", 8, 8)
        self.assertIsNone(waiter.try_admit(queued, 8))

        other = self._ledger(stale_after_seconds=0)
        other.snapshot()
        self.assertIn(queued.id, [e["ticket"] for e in other.snapshot()])
        self._stop_holder(holder)

    def test_releasing_keeps_the_grant_while_a_descendant_still_holds_the_lease(self):
        ledger = self._ledger()
        ticket = ledger.enqueue("local", 4, 4)
        self.assertEqual(ledger.try_admit(ticket, 8), 4)

        heir = subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.stdin.read()"],
            stdin=subprocess.PIPE, pass_fds=(ticket.lease_fd,), text=True)
        self.holders.append(heir)

        ledger.release(ticket)
        entries = ledger.snapshot()
        self.assertEqual([e["ticket"] for e in entries], [ticket.id])
        self.assertEqual(entries[0]["granted"], 4)
        self.assertIsNone(entries[0]["supervisor"])
        self.assertIsNotNone(entries[0]["orphaned_at"])

    def test_an_abandoned_descendant_grant_is_reclaimed_after_the_stale_bound(self):
        ledger = self._ledger()
        ticket = ledger.enqueue("local", 4, 4)
        ledger.try_admit(ticket, 8)
        heir = subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.stdin.read()"],
            stdin=subprocess.PIPE, pass_fds=(ticket.lease_fd,), text=True)
        self.holders.append(heir)
        ledger.release(ticket)

        reclaiming = self._ledger(stale_after_seconds=0)
        mine = reclaiming.enqueue("later", 8, 8)
        self.assertEqual(reclaiming.try_admit(mine, 8), 8)


class LedgerSchemaTest(LedgerTestBase):
    """Well-formed JSON that is not a valid ledger must fail closed (finding F3)."""

    def _seed(self):
        ledger = self._ledger()
        ledger.release(ledger.enqueue("seed", 1, 1))
        return self.state / "ledger.json"

    def _corrupt(self, doc):
        path = self._seed()
        path.write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaises(LedgerError):
            self._ledger().enqueue("local", 1, 1)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), doc)

    def _entry(self, **overrides):
        entry = {
            "ticket": "0123456789abcdef", "seq": 1, "profile": "p", "requested": 4,
            "minimum": 4, "granted": 4, "state": "running", "enqueued_at": 1.0,
            "started_at": 2.0, "supervisor": None, "orphaned_at": None,
        }
        entry.update(overrides)
        return entry

    def test_a_running_entry_without_a_grant_is_rejected(self):
        # Retained but counted as zero, such a record would let the whole host be
        # granted out a second time.
        self._corrupt({"version": 1, "next_seq": 2, "entries": [self._entry(granted=0)]})

    def test_an_unsupported_ledger_version_is_rejected(self):
        self._corrupt({"version": 99, "next_seq": 1, "entries": []})

    def test_an_entry_with_unknown_fields_is_rejected(self):
        self._corrupt({"version": 1, "next_seq": 2,
                       "entries": [dict(self._entry(), extra="x")]})

    def test_a_non_integer_demand_is_rejected(self):
        self._corrupt({"version": 1, "next_seq": 2,
                       "entries": [self._entry(requested="lots")]})

    def test_an_out_of_range_demand_is_rejected(self):
        self._corrupt({"version": 1, "next_seq": 2,
                       "entries": [self._entry(requested=99999, minimum=1)]})

    def test_an_unknown_entry_state_is_rejected(self):
        self._corrupt({"version": 1, "next_seq": 2,
                       "entries": [self._entry(state="paused")]})

    def test_a_duplicate_ticket_is_rejected(self):
        self._corrupt({"version": 1, "next_seq": 3,
                       "entries": [self._entry(), self._entry(seq=2)]})

    def test_a_malformed_next_seq_is_rejected(self):
        self._corrupt({"version": 1, "next_seq": 0, "entries": []})

    def test_a_malformed_supervisor_record_is_rejected(self):
        self._corrupt({"version": 1, "next_seq": 2,
                       "entries": [self._entry(supervisor={"pid": "one", "token": None})]})


if __name__ == "__main__":
    unittest.main()
