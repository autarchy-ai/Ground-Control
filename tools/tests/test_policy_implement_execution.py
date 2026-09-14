import copy
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import unittest

from tools.tests.policy_fixtures import PolicyChecksFixture
from pathlib import Path
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

class ImplementExecutionChecksTest(PolicyChecksFixture):
    def test_implement_execution_contract_rejects_dropped_four_path_anchor(self):
        mutations = (
            (
                "skills/implement/steps/step-01-issue-branch-resolution.md",
                "implementation_intent",
                "intent_hint",
            ),
            (
                "skills/implement/steps/step-04-planning.md",
                "tdd_path",
                "test approach",
            ),
            (
                "skills/implement/steps/step-04.4-tdd.md",
                "Path B — Bug fix on shipped code",
                "Bug-fix guidance",
            ),
            (
                "skills/implement/steps/step-04.4-tdd.md",
                "cannot use the documentation-only carve-out",
                "usually needs a test",
            ),
        )
        for rel, anchor, replacement in mutations:
            with self.subTest(anchor=anchor), tempfile.TemporaryDirectory() as tmp_dir:
                root = self._implement_contract_root(tmp_dir)
                path = root / rel
                text = path.read_text(encoding="utf-8")
                self.assertIn(anchor, text)
                path.write_text(text.replace(anchor, replacement), encoding="utf-8")
                violations = run_implement_execution_contract(root=root)
                self.assertIn(
                    "implement-four-path-tdd-contract",
                    {item.code for item in violations},
                )

    def test_implement_execution_contract_rejects_dropped_fix_evidence_anchor(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._implement_contract_root(tmp_dir)
            rules = root / "skills/implement/steps/_review-loop-rules.md"
            text = rules.read_text(encoding="utf-8")
            anchor = "fails when the named defect is reintroduced"
            self.assertIn(anchor, text)
            rules.write_text(
                text.replace(anchor, "covers the changed code"),
                encoding="utf-8",
            )
            violations = run_implement_execution_contract(root=root)
            self.assertIn(
                "implement-review-fix-evidence-contract",
                {item.code for item in violations},
            )

    def test_implement_execution_contract_rejects_dropped_sync_policy_command_token(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._implement_contract_root(tmp_dir)
            step8_5 = root / "skills/implement/steps/step-08.5-sync-base.md"
            step8_5.write_text(
                step8_5.read_text(encoding="utf-8").replace(
                    "cfg.workflow.policy_command", "make policy"
                ),
                encoding="utf-8",
            )
            violations = run_implement_execution_contract(root=root)
            self.assertIn(
                "implement-pre-pr-sync-contract",
                {item.code for item in violations},
            )
    def test_implement_execution_contract_rejects_dropped_precommit_command_token(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._implement_contract_root(tmp_dir)
            step7 = root / "skills/implement/steps/step-07-stage-precommit.md"
            step7.write_text(
                step7.read_text(encoding="utf-8").replace(
                    "cfg.workflow.precommit_command", "pre-commit run --all-files"
                ),
                encoding="utf-8",
            )
            violations = run_implement_execution_contract(root=root)
            self.assertIn(
                "implement-verification-boundary-drift",
                {item.code for item in violations},
            )
    def test_implement_execution_contract_rejects_manual_precommit_instruction(self):
        # Issue #899: the publish action owns the only pre-commit invocation, so an
        # instruction to run it by hand anywhere else in the lanes' prose is drift.
        for rel in (
            "skills/implement/steps/step-05-quality-assurance.md",
            "skills/implement/steps/step-04.4-tdd.md",
            "skills/implement/SKILL.md",
            "skills/quickfix/SKILL.md",
        ):
            with self.subTest(path=rel), tempfile.TemporaryDirectory() as tmp_dir:
                root = self._implement_contract_root(tmp_dir)
                path = root / rel
                path.write_text(
                    path.read_text(encoding="utf-8")
                    + "\nRun `pre-commit run --all-files` before committing.\n",
                    encoding="utf-8",
                )
                violations = run_implement_execution_contract(root=root)
                manual = [
                    item for item in violations
                    if item.code == "implement-manual-precommit-instruction"
                ]
                self.assertEqual(len(manual), 1)
                self.assertEqual(manual[0].details, [f"manual pre-commit instruction in {rel}"])

    def test_implement_execution_contract_rejects_dropped_manual_precommit_boundary_token(self):
        mutations = (
            ("skills/implement/steps/step-04.4-tdd.md", "Do not run `pre-commit` by hand"),
            ("skills/quickfix/SKILL.md", "Do not run `pre-commit` here"),
        )
        for rel, anchor in mutations:
            with self.subTest(path=rel), tempfile.TemporaryDirectory() as tmp_dir:
                root = self._implement_contract_root(tmp_dir)
                path = root / rel
                text = path.read_text(encoding="utf-8")
                self.assertIn(anchor, text)
                path.write_text(text.replace(anchor, "Consider pre-commit"), encoding="utf-8")
                violations = run_implement_execution_contract(root=root)
                drift = [
                    item for item in violations
                    if item.code == "implement-verification-boundary-drift"
                ]
                self.assertEqual(len(drift), 1)
                self.assertIn(f"missing token: {anchor}", drift[0].details)

    def test_implement_execution_contract_accepts_step7_naming_the_default_command(self):
        violations = run_implement_execution_contract(root=REPO_ROOT)
        self.assertNotIn(
            "implement-manual-precommit-instruction",
            {item.code for item in violations},
        )
        self.assertNotIn(
            "implement-verification-boundary-drift",
            {item.code for item in violations},
        )

    def test_implement_execution_contract_rejects_dropped_review_batching_token(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._implement_contract_root(tmp_dir)
            rules = root / "skills/implement/steps/_review-loop-rules.md"
            rules.write_text(
                rules.read_text(encoding="utf-8").replace(
                    "`cfg.workflow.policy_command` after every small fix",
                    "the policy gate after every small fix",
                ),
                encoding="utf-8",
            )
            violations = run_implement_execution_contract(root=root)
            self.assertIn(
                "implement-verification-boundary-drift",
                {item.code for item in violations},
            )
    def test_implement_execution_contract_rejects_dropped_phase_e_noop_anchor(self):
        anchors = (
            "manufacture a placeholder requirement-file edit",
            "finalize` runs no `verify` gate",
        )
        for anchor in anchors:
            with self.subTest(anchor=anchor), tempfile.TemporaryDirectory() as tmp_dir:
                root = self._implement_contract_root(tmp_dir)
                path = root / "skills/implement/steps/step-17-completion.md"
                text = path.read_text(encoding="utf-8")
                self.assertIn(anchor, text)
                path.write_text(text.replace(anchor, "REMOVED"), encoding="utf-8")
                violations = run_implement_execution_contract(root=root)
                self.assertIn(
                    "implement-phase-e-noop-contract",
                    {item.code for item in violations},
                )

    def test_implement_verification_contract_is_proportionate_and_mandatory(self):
        principles = (
            REPO_ROOT / "skills/implement/_development-principles.md"
        ).read_text(encoding="utf-8")
        review_rules = (
            REPO_ROOT / "skills/implement/steps/_review-loop-rules.md"
        ).read_text(encoding="utf-8")
        step5 = (
            REPO_ROOT / "skills/implement/steps/step-05-quality-assurance.md"
        ).read_text(encoding="utf-8")
        step7 = (
            REPO_ROOT / "skills/implement/steps/step-07-stage-precommit.md"
        ).read_text(encoding="utf-8")
        self.assertIn("narrowest tests", principles)
        self.assertIn("repository-wide completion and policy suites once", principles)
        self.assertIn("never waives the mandatory", review_rules)
        self.assertIn("Do not run `pre-commit` here", step5)
        self.assertIn("single mandatory pre-publish", step7)
    def test_gc_render_pr_body_output_passes_check_pr_body(self):
        # Compose contract (ADR-036): the JS renderer in
        # `mcp/ground-control/lib.js::buildPrBody` produces a PR body that
        # MUST pass `check_pr_body`. Codex cycle 1 (F3) flagged the previous
        # version: a copied Python string fixture means a JS renderer change
        # cannot break this test. Fixed by invoking the actual renderer via
        # `tools/render_pr_body_fixture.mjs` and feeding stdout through the
        # Python policy predicate. Drift now breaks the test.
        body = self._render_pr_body_via_js({
            "issueNumber": 868,
            "changeClass": "source",
            "requirementUids": ["GC-O007", "GC-O009"],
            "adrRefs": ["ADR-036", "ADR-021 (amended)"],
            "summary": "Per-step routing + tool surfaces + telemetry.",
            "changelogMode": "release-please",
            "changes": ["Added gc_post_decision_record"],
            "traceability": {
                "implements": ["GC-O007 ← skills/implement/SKILL.md"],
                "tests": ["GC-O007 ← mcp/ground-control/lib.test.js"],
            },
        })
        violations = check_pr_body(body)
        codes = [v.code for v in violations]
        self.assertEqual(
            violations,
            [],
            f"buildPrBody (source) output rejected by check_pr_body: {codes}",
        )
