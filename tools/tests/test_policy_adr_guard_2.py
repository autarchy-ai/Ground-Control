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

class AdrGuard2ChecksTest(PolicyChecksFixture):
    def test_gc_render_pr_body_doc_only_output_passes_check_pr_body(self):
        # Same compose test but for change_class='doc-only': integration tests
        # marked N/A, changelog fragment marked N/A. Per F3 (codex cycle 1),
        # this invokes the actual renderer rather than a copied fixture, so
        # the compose contract holds even when the renderer changes.
        #
        # Per F1 (codex cycle 2), the renderer no longer fabricates a synthetic
        # `GC-O007` placeholder for requirement-free runs — honest traceability.
        # The PR-body policy gate (PR_REQUIREMENT_RE) still requires a UID-
        # shaped token anywhere in the body; doc-only runs satisfy it by
        # citing the ADR they document (this PR cites ADR-036). A doc-only
        # run with NEITHER a requirement nor an ADR ref is refused by
        # `runRenderPrBody`'s checkPrBodyShape gate (see lib.test.js).
        body = self._render_pr_body_via_js({
            "issueNumber": 999,
            "changeClass": "doc-only",
            "requirementUids": [],
            "adrRefs": ["ADR-036"],
            "summary": "Documentation update only.",
            "changelogMode": "release-please",
            "changes": ["Clarified workflow doc wording"],
            "traceability": {"implements": [], "tests": []},
        })
        violations = check_pr_body(body)
        codes = [v.code for v in violations]
        self.assertEqual(
            violations,
            [],
            f"buildPrBody (doc-only) output rejected by check_pr_body: {codes}",
        )
    def test_quickfix_lane_review_attestation_passes_check_pr_body(self):
        # Issue #1551: a /quickfix run with the pre-push reviewers off renders the
        # "not run" attestation instead of claiming both reviews completed. The
        # renderer and `_check_ground_control_checks` carry that line as two
        # byte-identical copies, so this drives the real renderer and feeds its
        # output straight to the policy gate — a one-sided edit fails here.
        body = self._render_pr_body_via_js({
            "issueNumber": 1551,
            "changeClass": "doc-only",
            "requirementUids": [],
            "adrRefs": ["ADR-021"],
            "summary": "Quickfix run with pre-push reviews off.",
            "changelogMode": "release-please",
            "changes": ["Corrected the token boundary"],
            "traceability": {"implements": [], "tests": []},
            "lane": "quickfix",
            "prePushReviews": "not_run",
        })
        self.assertIn(
            "- [x] Pre-push code review and test-quality review not run for this lane; "
            "CI and repository policy gates enforced",
            body,
            "renderer did not emit the quickfix review attestation",
        )
        violations = check_pr_body(body)
        self.assertEqual(
            violations,
            [],
            f"quickfix-lane body rejected by check_pr_body: {[v.code for v in violations]}",
        )

    def test_pr_body_renderer_waived_attestation_passes_policy_gate(self):
        """Issue #1578: the waived-station attestation is byte-identical in the renderer and the gate."""
        body = self._render_pr_body_via_js({
            "issueNumber": 1578,
            "changeClass": "doc-only",
            "requirementUids": [],
            "adrRefs": ["ADR-029"],
            "summary": "Run whose unobserved review station was waived.",
            "changelogMode": "release-please",
            "changes": ["Recorded the waived station"],
            "traceability": {"implements": [], "tests": []},
            "prePushReviews": "waived",
        })
        self.assertIn(
            "- [x] Pre-push code review and test-quality review ran except review stations waived by "
            "recorded user authorization; all rendered findings fixed or dispositioned",
            body,
            "renderer did not emit the waived-station review attestation",
        )
        violations = check_pr_body(body)
        self.assertEqual(
            violations,
            [],
            f"waived-station body rejected by check_pr_body: {[v.code for v in violations]}",
        )

    def test_pr_body_missing_every_review_attestation_is_rejected(self):
        # The attestation is never optional. A body carrying the policy-command
        # line but neither review attestation must still fail the gate.
        body = self._body_with_uid_section("- `GC-O007`").replace(
            "- [x] Pre-push code review and test-quality review completed; "
            "all findings fixed or dispositioned\n",
            "",
        )
        codes = [v.code for v in check_pr_body(body)]
        self.assertIn("pr-ground-control-checks", codes)

    def test_workflow_guardrail_sync_keeps_adr_036_reachable(self):
        # ADR-036 amends ADR-021, so it must stay one of the gate-model records
        # the rule accepts. Pinned here so a future policy edit that drops
        # ADR-036 from the rule entirely breaks this test.
        rule = self._workflow_guardrail_rule()
        self.assertIsNotNone(rule, "workflow-guardrail-sync rule must exist")
        self.assertIn(
            "architecture/adrs/036-per-step-routing-tool-surfaces-telemetry.md",
            rule.get("requireAll", []) + rule.get("requireAny", []),
            "ADR-036 must remain a workflow-guardrail-sync required or accepted record",
        )
    def test_workflow_guardrail_sync_does_not_force_every_gate_model_adr(self):
        # The rule's job is to stop guardrail prose drifting away from the gate
        # record, not to make one topic's change edit every gate ADR. Requiring
        # all four at once produced contentless amendments in ADRs the diff did
        # not touch — for example a change to requirement identity in the
        # mechanical tool had to write into ADR-031, the codex review stopping
        # model (issue #1434).
        rule = self._workflow_guardrail_rule()
        gate_model_adrs = [
            "architecture/adrs/021-gated-agentic-development-loop.md",
            "architecture/adrs/029-issue-thread-gate-model.md",
            "architecture/adrs/031-codex-review-stopping-model.md",
            "architecture/adrs/036-per-step-routing-tool-surfaces-telemetry.md",
        ]
        forced = [adr for adr in gate_model_adrs if adr in rule.get("requireAll", [])]
        self.assertEqual(
            forced,
            [],
            "no single gate-model ADR may be unconditionally required; "
            f"still forced: {forced}",
        )
    def test_workflow_guardrail_sync_satisfied_by_one_relevant_gate_record(self):
        violations = run_adr_guard([
            "skills/implement/steps/step-06-completion-gate.md",
            "docs/DEVELOPMENT_WORKFLOW.md",
            "docs/WORKFLOW.md",
            "architecture/adrs/021-gated-agentic-development-loop.md",
        ])
        codes = [v.code for v in violations]
        self.assertNotIn(
            "workflow-guardrail-sync",
            codes,
            "updating the workflow docs plus one gate-model record must satisfy the rule",
        )
    def test_workflow_guardrail_sync_still_fires_without_any_gate_record(self):
        # Loosening requireAll must not turn the rule into a no-op: guardrail
        # prose that records the change nowhere in the gate model still fails.
        violations = run_adr_guard([
            "skills/implement/steps/step-06-completion-gate.md",
            "docs/DEVELOPMENT_WORKFLOW.md",
            "docs/WORKFLOW.md",
        ])
        self.assertTrue(
            any(item.code == "workflow-guardrail-sync" for item in violations),
            "a guardrail change with no gate-model record must still fail",
        )
