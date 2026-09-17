import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
AGENT_INSTRUCTIONS = ROOT / "AGENTS.md"
CI_MONITOR_STEP = ROOT / "skills/implement/steps/step-10-ci-monitor.md"
QUICKFIX_SKILL = ROOT / "skills/quickfix/SKILL.md"
DEVELOPMENT_WORKFLOW = ROOT / "docs/DEVELOPMENT_WORKFLOW.md"
WORKFLOW_INDEX = ROOT / "docs/WORKFLOW.md"
CI_PIPELINE = ROOT / "docs/ci/CI_PIPELINE.md"

PROHIBITION = (
    "Agents must never investigate, remediate, dismiss, suppress, bypass, or "
    "work around a GitGuardian finding."
)
USER_OWNERSHIP = "the user owns every GitGuardian investigation and resolution"
ALLOWED_METADATA = "GitHub check name, status, and check URL"


class GitGuardianUserOwnedPolicyTest(unittest.TestCase):
    def test_agent_and_ci_monitor_instructions_carry_the_mandatory_rule(self):
        for path in (AGENT_INSTRUCTIONS, CI_MONITOR_STEP, QUICKFIX_SKILL):
            text = path.read_text(encoding="utf-8")
            normalized = " ".join(text.split())
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertIn(PROHIBITION, normalized)
                self.assertIn(USER_OWNERSHIP, normalized)
                self.assertIn(ALLOWED_METADATA, normalized)

    def test_workflow_references_preserve_user_ownership_and_bounded_reporting(self):
        for path in (DEVELOPMENT_WORKFLOW, WORKFLOW_INDEX, CI_PIPELINE):
            text = path.read_text(encoding="utf-8")
            normalized = " ".join(text.split())
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertIn("GitGuardian", text)
                self.assertIn("user-owned", text)
                self.assertIn(ALLOWED_METADATA, normalized)


if __name__ == "__main__":
    unittest.main()
