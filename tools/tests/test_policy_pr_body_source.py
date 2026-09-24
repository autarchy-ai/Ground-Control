"""The CI policy check reads the live PR body, not the event payload's copy.

A workflow re-run replays the payload captured when the PR opened, so a body
corrected afterwards must still be what the gate evaluates.
"""

import argparse
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.policy.execution_contract import _resolve_pr_body


class ResolvePrBodyTest(unittest.TestCase):
    def test_live_body_outranks_stale_event_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            event = Path(tmp) / "event.json"
            event.write_text(json.dumps({"pull_request": {"body": "stale"}}), encoding="utf-8")
            args = argparse.Namespace(pr_body_file=None, pr_number="1750", event_path=str(event))
            live = mock.Mock(stdout="live")
            with mock.patch("tools.policy.execution_contract.subprocess.run", return_value=live) as run:
                self.assertEqual(_resolve_pr_body(args), "live")
        self.assertEqual(run.call_args.args[0][:4], ["gh", "pr", "view", "1750"])

    def test_event_payload_is_used_without_a_pr_number(self):
        with tempfile.TemporaryDirectory() as tmp:
            event = Path(tmp) / "event.json"
            event.write_text(json.dumps({"pull_request": {"body": "from event"}}), encoding="utf-8")
            args = argparse.Namespace(pr_body_file=None, pr_number=None, event_path=str(event))
            self.assertEqual(_resolve_pr_body(args), "from event")


if __name__ == "__main__":
    unittest.main()
