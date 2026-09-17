import copy
import hashlib
import json
import re
import subprocess
import tempfile
import unittest

from tools.tests.policy_fixtures import PolicyChecksFixture
from unittest import mock
from unittest.mock import patch

from tools.policy.checks import (
    DEFERRAL_CASES_PATH,
    MCP_LIB_PATH,
    REPO_ROOT,
    Violation,
    _is_release_pr,
    _jsonpath_keys,
    _resolve_pr_refs,
    check_pr_body,
    classify_deferral_language,
    extract_step_section,
    main,
    parse_args,
    read_changed_files,
    run_adr_guard,
    _trigger_is_in_scope,
    run_documentation_coverage_check,
    run_repo_identity_drift,
    run_no_deferral_disposition_check,
    run_pr_body_check,
    run_test_quality_decision_record_contract,
    run_version_mirror_consistency_check,
    run_workflow_routing_contract,
    run_implement_execution_contract,
)

if __name__ == "__main__":
    unittest.main()

class AdrGuardChecksTest(PolicyChecksFixture):
    def test_adr_guard_requires_workflow_docs(self):
        violations = run_adr_guard([".claude/skills/implement/SKILL.md"])
        self.assertTrue(any(item.code == "workflow-guardrail-sync" for item in violations))
    def test_adr_guard_fires_on_canonical_implement_skill_path(self):
        violations = run_adr_guard(["skills/implement/SKILL.md"])
        self.assertTrue(any(item.code == "workflow-guardrail-sync" for item in violations))
    def test_adr_guard_fires_on_delegated_implement_step_and_principles(self):
        for path in (
            "skills/implement/steps/step-04.4-tdd.md",
            "skills/implement/_development-principles.md",
        ):
            with self.subTest(path=path):
                violations = run_adr_guard([path])
                self.assertTrue(any(item.code == "workflow-guardrail-sync" for item in violations))
    def test_implement_execution_contract_is_structurally_complete(self):
        self.assertEqual(run_implement_execution_contract(root=REPO_ROOT), [])
    def test_implement_execution_contract_rejects_direct_pr_creation(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._implement_contract_root(tmp_dir)
            step9 = root / "skills/implement/steps/step-09-pr-body.md"
            step9.write_text(
                step9.read_text(encoding="utf-8") + "\n`gh pr create`\n",
                encoding="utf-8",
            )
            violations = run_implement_execution_contract(root=root)
            self.assertIn(
                "implement-direct-pr-create",
                {item.code for item in violations},
            )
    def test_implement_execution_contract_rejects_dropped_policy_command_token(self):
        # Negative path for the issue #1429 token requirements. Without this,
        # deleting the `cfg.workflow.policy_command` anchors from
        # run_implement_execution_contract would be invisible to the suite, and
        # the skill prose could silently drift back to a hardcoded command.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._implement_contract_root(tmp_dir)
            step6 = root / "skills/implement/steps/step-06-completion-gate.md"
            step6.write_text(
                step6.read_text(encoding="utf-8").replace(
                    "CI owns repository-wide\ncompletion and policy suites", "Run a local full suite"
                ),
                encoding="utf-8",
            )
            violations = run_implement_execution_contract(root=root)
            self.assertIn(
                "implement-verification-boundary-drift",
                {item.code for item in violations},
            )
