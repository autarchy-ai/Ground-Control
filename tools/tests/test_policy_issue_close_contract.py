import re
import tempfile
import unittest

from tools.tests.policy_fixtures import PolicyChecksFixture

from tools.policy.checks import REPO_ROOT, run_implement_execution_contract

QUICKFIX = "skills/quickfix/SKILL.md"
CLOSE_STEP_CODE = "quickfix-post-merge-close-step"
AUTO_CLOSE_CODE = "workflow-unconditional-auto-close-claim"


class IssueCloseContractTest(PolicyChecksFixture):
    """Issue #1601: GitHub honors `Closes #n` only on a default-branch merge."""

    def _codes(self, root):
        return {item.code for item in run_implement_execution_contract(root=root)}

    def _violation(self, root, code):
        matches = [item for item in run_implement_execution_contract(root=root) if item.code == code]
        self.assertEqual(len(matches), 1)
        return matches[0]

    def test_current_tree_carries_the_close_step_and_no_unconditional_claim(self):
        codes = self._codes(REPO_ROOT)
        self.assertNotIn(CLOSE_STEP_CODE, codes)
        self.assertNotIn(AUTO_CLOSE_CODE, codes)

    def test_rejects_quickfix_without_a_post_merge_close_step(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._implement_contract_root(tmp_dir)
            path = root / QUICKFIX
            text = path.read_text(encoding="utf-8")
            self.assertIn("### Step Q20:", text)
            path.write_text(text.replace("### Step Q20:", "### Wrap-up:"), encoding="utf-8")
            violation = self._violation(root, CLOSE_STEP_CODE)
            self.assertEqual(violation.details, [f"missing ### Step Q20 section in {QUICKFIX}"])

    def test_rejects_a_close_step_that_does_not_call_the_close_tool(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._implement_contract_root(tmp_dir)
            path = root / QUICKFIX
            text = path.read_text(encoding="utf-8")
            section = re.search(r"### Step Q20:.*?(?=\n### |\n---\n)", text, re.DOTALL).group(0)
            self.assertIn("gc_close_issue_after_merge", section)
            path.write_text(
                text.replace(section, section.replace("gc_close_issue_after_merge", "gh issue close")),
                encoding="utf-8",
            )
            violation = self._violation(root, CLOSE_STEP_CODE)
            self.assertEqual(
                violation.details,
                [f"Step Q20 in {QUICKFIX} does not call gc_close_issue_after_merge"],
            )

    def test_rejects_unconditional_auto_close_wording_on_each_lane_surface(self):
        claims = (
            "For a requirement-free run it emits `Closes #<issue-number>` and GitHub auto-closes at merge.",
            "The GitHub issue closes via `Closes #<issue-number>` in the PR body at PR merge.",
        )
        surfaces = (
            QUICKFIX,
            "skills/implement/SKILL.md",
            "skills/implement/steps/step-09-pr-body.md",
            "skills/implement/steps/step-20-close-issue-on-merge.md",
        )
        for rel in surfaces:
            for claim in claims:
                with self.subTest(path=rel, claim=claim), tempfile.TemporaryDirectory() as tmp_dir:
                    root = self._implement_contract_root(tmp_dir)
                    path = root / rel
                    path.write_text(path.read_text(encoding="utf-8") + f"\n{claim}\n", encoding="utf-8")
                    violation = self._violation(root, AUTO_CLOSE_CODE)
                    self.assertEqual(len(violation.details), 1)
                    self.assertTrue(violation.details[0].startswith(f"{rel}: "))

    def test_accepts_auto_close_wording_that_names_the_default_branch_condition(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._implement_contract_root(tmp_dir)
            path = root / QUICKFIX
            path.write_text(
                path.read_text(encoding="utf-8")
                + "\nGitHub auto-closes via `Closes #<issue-number>` only when the PR merges into "
                "the default branch.\n",
                encoding="utf-8",
            )
            self.assertNotIn(AUTO_CLOSE_CODE, self._codes(root))


if __name__ == "__main__":
    unittest.main()
