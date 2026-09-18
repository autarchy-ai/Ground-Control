import copy
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import unittest
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

class AdrGuardTriggerScopingTest(unittest.TestCase):
    """Content-scoped triggers (issue #1355).

    `lib.js` and `checks.py` each hold many unrelated surfaces, so a bare path trigger on
    them fires on nearly every diff. A gate that fires constantly stops carrying
    information and trains contributors to satisfy it reflexively. Scoping narrows only
    *when* a trigger fires, never what it then requires — and only where a rule opts in.
    """
    RULE = {
        "id": "example",
        "whenAny": ["mcp/ground-control/lib.js", "docs/DOC_STYLE.md"],
        "triggerContent": {"mcp/ground-control/lib.js": "documentation_coverage"},
        "requireAll": ["architecture/adrs/054-documentation-coverage-gate.md"],
    }
    def test_unscoped_path_always_triggers(self):
        """A path the rule does not scope keeps its original unconditional behaviour."""
        self.assertTrue(
            _trigger_is_in_scope("docs/DOC_STYLE.md", self.RULE, base=None, root=REPO_ROOT)
        )
    def test_scoped_path_triggers_when_the_guarded_surface_changed(self):
        with mock.patch(
            "tools.policy.adr_guard.changed_lines_for",
            return_value="+  documentation_coverage = True",
        ):
            self.assertTrue(
                _trigger_is_in_scope(
                    "mcp/ground-control/lib.js", self.RULE, base="origin/dev", root=REPO_ROOT
                )
            )
    def test_scoped_path_does_not_trigger_on_an_unrelated_edit(self):
        with mock.patch(
            "tools.policy.adr_guard.changed_lines_for",
            return_value="+  const stationResult = 'pass';",
        ):
            self.assertFalse(
                _trigger_is_in_scope(
                    "mcp/ground-control/lib.js", self.RULE, base="origin/dev", root=REPO_ROOT
                )
            )
    def test_unreadable_diff_still_triggers(self):
        """Fail closed: "nothing matched" and "I could not look" must not resolve alike.

        If an unreadable diff resolved as out-of-scope, a git failure would silently
        disable every scoped gate — the exact way a control dies quietly.
        """
        with mock.patch("tools.policy.adr_guard.changed_lines_for", return_value=None):
            self.assertTrue(
                _trigger_is_in_scope(
                    "mcp/ground-control/lib.js", self.RULE, base="origin/dev", root=REPO_ROOT
                )
            )
    def test_scoping_never_relaxes_what_a_fired_rule_requires(self):
        """Narrowing applies to the trigger only; the requireAll set is untouched."""
        with mock.patch(
            "tools.policy.adr_guard.changed_lines_for",
            return_value="+  documentation_coverage = True",
        ):
            violations = run_adr_guard(["mcp/ground-control/lib.js"], base="origin/dev")

        self.assertIn(
            "architecture/adrs/054-documentation-coverage-gate.md",
            " ".join(d for v in violations for d in v.details),
        )
