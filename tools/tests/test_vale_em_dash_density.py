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

class ValeEmDashDensityTest(unittest.TestCase):
    """Regression tests for the GoogleProject.EmDashDensity Vale rule."""
    _VALE_BIN = REPO_ROOT / ".tools" / "vale" / "current" / "vale"
    _VALE_INI = REPO_ROOT / ".vale.ini"
    _RULE_CHECK = "GoogleProject.EmDashDensity"
    def _run_vale(self, fixture_path: Path) -> list[dict]:
        """Run vale --output=JSON against *fixture_path* and return the alerts list."""
        import subprocess

        # No --minAlertLevel override: vale inherits MinAlertLevel from .vale.ini
        # (error). The rule is error-level, so the positive assertion below sees
        # it. Removing the override means a future regression that downgrades
        # the rule to warning makes the positive test fail (no error-level alert
        # emitted) instead of silently passing under a relaxed test threshold.
        proc = subprocess.run(
            [
                str(self._VALE_BIN),
                f"--config={self._VALE_INI}",
                "--output=JSON",
                "--no-exit",
                str(fixture_path),
            ],
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
        )
        # Vale JSON output is a mapping of file-path -> list-of-alerts.
        # We flatten all alerts across all files into a single list.
        try:
            data = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            self.fail(
                f"vale produced non-JSON output (rc={proc.returncode}): "
                f"{proc.stdout!r} stderr={proc.stderr!r} — {exc}"
            )
        alerts: list[dict] = []
        for file_alerts in data.values():
            alerts.extend(file_alerts)
        return alerts
    def setUp(self) -> None:
        if not self._VALE_BIN.exists():
            self.skipTest(
                f"Vale binary not found at {self._VALE_BIN}; "
                "skipping EmDashDensity regression test."
            )
    def test_emdash_density_fires_for_two_emdashes(self) -> None:
        """A paragraph with two em-dashes must produce at least one EmDashDensity alert."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".md", delete=False, encoding="utf-8"
        ) as fh:
            # Two em-dashes (U+2014) in a single paragraph.
            fh.write(
                "This sentence—which has an aside—goes on too long.\n"
            )
            fixture = Path(fh.name)
        try:
            alerts = self._run_vale(fixture)
            matching = [a for a in alerts if a.get("Check") == self._RULE_CHECK]
            self.assertGreater(
                len(matching),
                0,
                f"Expected at least one {self._RULE_CHECK} alert for a paragraph "
                f"with two em-dashes, but got none.  All alerts: {alerts}",
            )
        finally:
            fixture.unlink(missing_ok=True)
    def test_emdash_density_silent_for_one_emdash(self) -> None:
        """A paragraph with exactly one em-dash must produce zero EmDashDensity alerts."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".md", delete=False, encoding="utf-8"
        ) as fh:
            # One em-dash (U+2014) — well within the soft budget.
            fh.write(
                "This sentence—which has an aside is perfectly fine.\n"
            )
            fixture = Path(fh.name)
        try:
            alerts = self._run_vale(fixture)
            matching = [a for a in alerts if a.get("Check") == self._RULE_CHECK]
            self.assertEqual(
                matching,
                [],
                f"Expected zero {self._RULE_CHECK} alerts for a paragraph with "
                f"one em-dash, but got: {matching}",
            )
        finally:
            fixture.unlink(missing_ok=True)
