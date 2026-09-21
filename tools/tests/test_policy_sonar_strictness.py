import tempfile
import unittest
from pathlib import Path

from tools.policy.ci_strictness import run_sonar_strictness_contract
from tools.policy.core import REPO_ROOT


class SonarStrictnessContractTest(unittest.TestCase):
    def test_sandbox_coverage_includes_every_javascript_test_module(self):
        workflow = (REPO_ROOT / ".github/workflows/sonarcloud.yml").read_text(encoding="utf-8")

        self.assertIn("node --test tools/incus_sandbox/*.test.mjs", workflow)

    def test_repository_enforces_zero_open_issues_after_quality_gate(self):
        self.assertEqual(run_sonar_strictness_contract(REPO_ROOT), [])

    def test_missing_zero_issue_invocation_is_a_policy_violation(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            workflow = root / ".github/workflows/sonarcloud.yml"
            gate = root / "tools/sonar/assert_no_new_issues.py"
            workflow.parent.mkdir(parents=True)
            gate.parent.mkdir(parents=True)
            workflow.write_text(
                "uses: SonarSource/sonarqube-quality-gate-action@pinned\n"
                "if: ${{ !cancelled() }}\n"
                "SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}\n",
                encoding="utf-8",
            )
            gate.write_text("raise SystemExit(0)\n", encoding="utf-8")

            codes = {item.code for item in run_sonar_strictness_contract(root)}

            self.assertIn("sonar-strictness-zero-issue-gate", codes)

    def test_zero_issue_invocation_must_follow_the_quality_gate(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            workflow = root / ".github/workflows/sonarcloud.yml"
            gate = root / "tools/sonar/assert_no_new_issues.py"
            workflow.parent.mkdir(parents=True)
            gate.parent.mkdir(parents=True)
            workflow.write_text(
                "run: python3 tools/sonar/assert_no_new_issues.py\n"
                "uses: SonarSource/sonarqube-quality-gate-action@pinned\n"
                "if: ${{ !cancelled() }}\n"
                + "SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}\n" * 3,
                encoding="utf-8",
            )
            gate.write_text("raise SystemExit(0)\n", encoding="utf-8")

            codes = {item.code for item in run_sonar_strictness_contract(root)}

            self.assertIn("sonar-strictness-gate-order", codes)

    def test_zero_issue_gate_must_run_after_hosted_gate_failure(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            workflow = root / ".github/workflows/sonarcloud.yml"
            gate = root / "tools/sonar/assert_no_new_issues.py"
            workflow.parent.mkdir(parents=True)
            gate.parent.mkdir(parents=True)
            workflow.write_text(
                "uses: SonarSource/sonarqube-quality-gate-action@pinned\n"
                "run: python3 tools/sonar/assert_no_new_issues.py\n"
                + "SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}\n" * 3,
                encoding="utf-8",
            )
            gate.write_text("raise SystemExit(0)\n", encoding="utf-8")

            codes = {item.code for item in run_sonar_strictness_contract(root)}

            self.assertIn("sonar-strictness-zero-issue-always-runs", codes)


if __name__ == "__main__":
    unittest.main()
