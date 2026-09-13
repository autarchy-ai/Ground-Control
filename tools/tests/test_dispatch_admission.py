"""Tests for tools/gc_dispatch/admission.py - the pure CPU admission policy.

Admission is the seam a future weighted-fair policy replaces, so it is tested as a
pure function over (capacity, ledger entries, ticket) with no filesystem or process
state involved.
"""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

from gc_dispatch.admission import plan_admission


def queued(ticket, seq, requested, minimum=None):
    return {
        "ticket": ticket,
        "seq": seq,
        "state": "queued",
        "requested": requested,
        "minimum": requested if minimum is None else minimum,
        "granted": None,
    }


def running(ticket, seq, granted):
    return {
        "ticket": ticket,
        "seq": seq,
        "state": "running",
        "requested": granted,
        "minimum": granted,
        "granted": granted,
    }


class PlanAdmissionTest(unittest.TestCase):
    def test_sole_request_is_granted_in_full(self):
        entries = [queued("a", 1, 4)]
        self.assertEqual(plan_admission(8, entries, "a"), 4)

    def test_request_beyond_remaining_capacity_is_not_admitted(self):
        entries = [running("busy", 1, 6), queued("a", 2, 4)]
        self.assertIsNone(plan_admission(8, entries, "a"))

    def test_inexpensive_work_runs_alongside_an_expensive_grant(self):
        entries = [running("suite", 1, 6), queued("lint", 2, 2)]
        self.assertEqual(plan_admission(8, entries, "lint"), 2)

    def test_elastic_request_is_reduced_to_remaining_capacity(self):
        entries = [running("suite", 1, 6), queued("a", 2, 8, minimum=2)]
        self.assertEqual(plan_admission(8, entries, "a"), 2)

    def test_elastic_request_is_refused_below_its_minimum(self):
        entries = [running("suite", 1, 7), queued("a", 2, 8, minimum=2)]
        self.assertIsNone(plan_admission(8, entries, "a"))

    def test_capacity_is_never_oversubscribed_across_a_queue(self):
        entries = [queued("a", 1, 5), queued("b", 2, 5)]
        self.assertEqual(plan_admission(8, entries, "a"), 5)
        self.assertIsNone(plan_admission(8, entries, "b"))

    def test_strict_fifo_blocks_later_work_behind_a_head_that_does_not_fit(self):
        # 'small' would fit in the 2 remaining units, but admitting it ahead of the
        # blocked head is what starves a large suite forever.
        entries = [running("suite", 1, 6), queued("big", 2, 4), queued("small", 3, 1)]
        self.assertIsNone(plan_admission(8, entries, "big"))
        self.assertIsNone(plan_admission(8, entries, "small"))

    def test_later_work_is_backfilled_from_what_the_head_leaves(self):
        entries = [queued("head", 1, 6), queued("tail", 2, 2)]
        self.assertEqual(plan_admission(8, entries, "head"), 6)
        self.assertEqual(plan_admission(8, entries, "tail"), 2)

    def test_request_larger_than_the_host_runs_alone_rather_than_deadlocking(self):
        entries = [queued("a", 1, 64, minimum=64)]
        self.assertEqual(plan_admission(8, entries, "a"), 8)

    def test_over_capacity_request_still_waits_for_a_free_host(self):
        entries = [running("busy", 1, 1), queued("a", 2, 64, minimum=64)]
        self.assertIsNone(plan_admission(8, entries, "a"))

    def test_queue_order_follows_sequence_not_list_order(self):
        entries = [queued("late", 9, 6), queued("early", 2, 6)]
        self.assertEqual(plan_admission(8, entries, "early"), 6)
        self.assertIsNone(plan_admission(8, entries, "late"))

    def test_an_unknown_ticket_is_never_admitted(self):
        self.assertIsNone(plan_admission(8, [queued("a", 1, 1)], "ghost"))

    def test_a_running_ticket_is_not_re_admitted(self):
        self.assertIsNone(plan_admission(8, [running("a", 1, 4)], "a"))

    def test_overcommitted_state_does_not_produce_a_negative_grant(self):
        entries = [running("x", 1, 6), running("y", 2, 6), queued("a", 3, 1)]
        self.assertIsNone(plan_admission(8, entries, "a"))


if __name__ == "__main__":
    unittest.main()
