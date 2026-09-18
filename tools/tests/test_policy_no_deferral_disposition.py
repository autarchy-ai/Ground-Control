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
    run_version_mirror_consistency_check,
    run_workflow_routing_contract,
    run_implement_execution_contract,
)

if __name__ == "__main__":
    unittest.main()

class NoDeferralDispositionChecksTest(PolicyChecksFixture):
    def test_deferral_classifier_matches_golden_cases(self):
        # The shared golden-case file is the single source of truth for what
        # text, on what surface, gets flagged. The hook test
        # (tools/tests/test_block_defer_language.py) loads the same file, so
        # the hook's standalone classifier and this one cannot drift without
        # one of the two suites failing.
        cases = json.loads(DEFERRAL_CASES_PATH.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 10, "deferral_cases.json should have a substantive case set")
        failures = []
        for case in cases:
            decision, pattern = classify_deferral_language(case["text"], case["surface"])
            if decision != case["expect"]:
                failures.append(
                    f"{case['id']}: surface={case['surface']} expected {case['expect']} "
                    f"got {decision} (pattern={pattern}) — {case['why']}"
                )
        self.assertEqual(failures, [], "\n".join(failures))
    def test_no_deferral_disposition_check_flags_tier1_in_pr_body(self):
        violations = run_no_deferral_disposition_check(
            pr_body="## Summary\n\nFixed the gate. SonarCloud findings deferred to a follow-up PR.\n"
        )
        codes = {v.code for v in violations}
        self.assertIn("pr-body-deferral-disposition", codes)
        details = " ".join(d for v in violations for d in v.details)
        self.assertIn("tier1:", details)
    def test_no_deferral_disposition_check_allows_out_of_scope_section(self):
        # A PR body legitimately scope-bounds its own work; bare "out of scope"
        # with no deferral verb is not flagged on the pr-body surface.
        body = (
            "## Summary\n\nImplements the gate.\n\n"
            "## Out of scope\n\n- Retroactive cleanup of past issues.\n"
            "- Changing the existing hard cap behavior.\n"
        )
        self.assertEqual(run_no_deferral_disposition_check(pr_body=body), [])
    def test_no_deferral_disposition_check_allows_amended_gc_run_sweep_line(self):
        # After the A4 wording fix, the Ground Control Checks line no longer
        # carries "deferred"; the scanner must not flag the template line.
        body = "## Summary\n\nx\n- [x] `gc_run_sweep` reviewed; findings fixed or recorded with rationale\n"
        self.assertEqual(run_no_deferral_disposition_check(pr_body=body), [])
    def test_no_deferral_disposition_check_noop_when_no_body(self):
        self.assertEqual(run_no_deferral_disposition_check(pr_body=None), [])
    def test_parse_args_accepts_pre_commit_positional_files(self):
        args = parse_args(["--skip-pr-body", "docs/WORKFLOW.md", "mcp/ground-control/lib.js"])
        self.assertEqual(args.paths, ["docs/WORKFLOW.md", "mcp/ground-control/lib.js"])
        self.assertIsNone(args.files)
    def test_parse_args_accepts_pr_body_file(self):
        args = parse_args(["--pr-body-file", "/tmp/pr-body.md"])
        self.assertEqual(args.pr_body_file, "/tmp/pr-body.md")
    def test_parse_args_accepts_pr_number(self):
        args = parse_args(["--pr-number", "790"])
        self.assertEqual(args.pr_number, 790)
        self.assertIsNone(parse_args([]).pr_number)
    def test_parse_args_accepts_pr_comments_json(self):
        args = parse_args(["--pr-comments-json", "/tmp/pr-comments.jsonl"])
        self.assertEqual(args.pr_comments_json, "/tmp/pr-comments.jsonl")
