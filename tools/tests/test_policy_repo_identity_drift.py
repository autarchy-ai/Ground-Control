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

class RepoIdentityDriftChecksTest(PolicyChecksFixture):
    def test_repo_identity_drift_passes_on_committed_files(self):
        # After #1383 every inventoried active surface must name the single
        # canonical owner. Run against the live repo as the post-condition
        # assertion — a leftover KeplerOps/Brad-Edwards slug in an active
        # config/workflow/script/doc is exactly the stale identity that routed
        # defaulted operations at an inaccessible repository.
        violations = run_repo_identity_drift(root=REPO_ROOT)
        self.assertEqual(
            violations, [], msg=f"unexpected violations: {[v.render() for v in violations]}"
        )
    def test_repo_identity_drift_fires_on_noncanonical_owner(self):
        # A non-canonical owner in any inventoried file must fail loudly, naming
        # the file, line, and offending owner so the fix is unambiguous.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            cfg = root / ".ground-control.yaml"
            cfg.write_text("github_repo: KeplerOps/Ground-Control\n", encoding="utf-8")
            violations = run_repo_identity_drift(root=root)
            codes = {item.code for item in violations}
            self.assertIn("repo-identity-drift", codes)
            details = " ".join(detail for v in violations for detail in v.details)
            self.assertIn("KeplerOps", details)
            self.assertIn(".ground-control.yaml", details)
    def test_repo_identity_drift_fires_on_noncanonical_url(self):
        # The URL form (badges, clone URLs, raw-content URLs) is caught too.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            wf = root / ".github/workflows/ci.yml"
            wf.parent.mkdir(parents=True, exist_ok=True)
            wf.write_text(
                'RAW_BASE_URL="https://raw.githubusercontent.com/Brad-Edwards/Ground-Control/x"\n',
                encoding="utf-8",
            )
            violations = run_repo_identity_drift(root=root)
            self.assertIn("repo-identity-drift", {v.code for v in violations})
            details = " ".join(detail for v in violations for detail in v.details)
            self.assertIn("Brad-Edwards", details)
    def test_repo_identity_drift_accepts_canonical_owner(self):
        # The canonical owner must not trip the gate, and files outside the
        # inventory (and absent files) are simply skipped.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            cfg = root / ".ground-control.yaml"
            cfg.write_text("github_repo: autarchy-ai/Ground-Control\n", encoding="utf-8")
            violations = run_repo_identity_drift(root=root)
            self.assertEqual(
                violations, [], msg=f"unexpected violations: {[v.render() for v in violations]}"
            )
