"""Keep local hooks cheap without losing pre-publication secret detection."""
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


class LocalHookBudgetTests(unittest.TestCase):
    def test_hygiene_and_secrets_run_at_commit_not_again_on_push(self):
        config = yaml.safe_load((ROOT / ".pre-commit-config.yaml").read_text())
        hooks = [hook for repo in config["repos"] for hook in repo["hooks"]]
        self.assertEqual(config["default_stages"], ["pre-commit"])
        for hook in hooks:
            self.assertEqual(hook["stages"], ["pre-commit"], "Override upstream manifest stages explicitly")
        ids = {hook["id"] for hook in hooks}
        self.assertTrue({"gitleaks", "detect-private-key", "check-merge-conflict"} <= ids)
        self.assertNotIn("pr-body-policy", ids)
        local = [hook for repo in config["repos"] if repo["repo"] == "local" for hook in repo["hooks"]]
        self.assertEqual([hook["id"] for hook in local], ["bash-syntax"])
