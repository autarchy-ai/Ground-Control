"""Policy coverage for the issue Requirements-section writer contract (issue #1569).

Step 1 and Step 4 used to state "make sure the UID is in the issue's Requirements
section" with no tool behind it, so a requirement introduced mid-run silently stayed
out of scope. The check anchors `gc_update_issue_requirements` in both surfaces; these
tests fail if that anchor is dropped from either one.
"""

import tempfile
import unittest

from tools.policy.implement_scope_contract import (
    SCOPE_WRITER_SURFACES,
    SCOPE_WRITER_TOKENS,
    check_scope_and_completion_contract,
)
from tools.tests.policy_fixtures import PolicyChecksFixture

VIOLATION_CODE = "implement-scope-writer-tool"


class IssueRequirementsWriterContractTest(PolicyChecksFixture):
    """The scope-writer tool must stay named in the workflow prose that requires it."""

    def test_accepts_the_live_workflow_surfaces(self) -> None:
        """The repository as it stands names the tool in both surfaces."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._implement_contract_root(tmp_dir)
            violations = check_scope_and_completion_contract(root)
            self.assertNotIn(VIOLATION_CODE, {item.code for item in violations})

    def test_rejects_dropping_either_token_from_either_surface(self) -> None:
        """Losing the tool name or the reconciliation contract is a violation naming it."""
        for rel in SCOPE_WRITER_SURFACES:
            for token in SCOPE_WRITER_TOKENS:
                with self.subTest(surface=rel, token=token), tempfile.TemporaryDirectory() as tmp_dir:
                    root = self._implement_contract_root(tmp_dir)
                    path = root / rel
                    text = path.read_text(encoding="utf-8")
                    self.assertIn(token, text)
                    path.write_text(text.replace(token, "something vaguer"), encoding="utf-8")
                    violations = check_scope_and_completion_contract(root)
                    matching = [item for item in violations if item.code == VIOLATION_CODE]
                    self.assertEqual(len(matching), 1)
                    self.assertEqual(matching[0].details, [f"missing {token} in {rel}"])


if __name__ == "__main__":
    unittest.main()
