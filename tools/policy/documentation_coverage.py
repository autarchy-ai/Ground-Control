"""Policy check for documentation coverage of changed repository surfaces."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .core import REPO_ROOT, Violation


_DOCUMENTATION_COVERAGE_FIXTURE = REPO_ROOT / "tools" / "documentation_coverage_fixture.mjs"
_DOCUMENTATION_SECTION_RE = re.compile(r"^##\s+Documentation\b", re.MULTILINE)


class _FixtureFailure(Exception):
    """Internal signal carrying a fail-closed fixture violation."""

    def __init__(self, violation: Violation) -> None:
        super().__init__(violation.message)
        self.violation = violation


def _fixture_error(message: str, details: list[str] | None = None) -> Violation:
    """Build a fixture-error violation, which is a drift signal rather than a pass."""
    return Violation(code="doc-coverage-fixture-error", message=message, details=details or [])


def _require_coverage_fixture() -> None:
    """Fail closed when the Node classifier fixture is absent."""
    if not _DOCUMENTATION_COVERAGE_FIXTURE.exists():
        raise _FixtureFailure(
            _fixture_error(
                "documentation_coverage_fixture.mjs not found — "
                "documentation coverage check cannot run.",
                [f"expected at {_DOCUMENTATION_COVERAGE_FIXTURE}"],
            )
        )


def _invoke_coverage_fixture(fixture_input: dict[str, object], root: Path) -> dict[str, object]:
    """Run the Node classifier fixture and return its parsed JSON result."""
    try:
        proc = subprocess.run(
            ["node", str(_DOCUMENTATION_COVERAGE_FIXTURE)],
            input=json.dumps(fixture_input),
            capture_output=True,
            text=True,
            cwd=str(root),
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise _FixtureFailure(
            _fixture_error(f"documentation_coverage_fixture.mjs failed to execute: {exc}")
        ) from exc

    if proc.returncode != 0:
        details = [f"stderr: {proc.stderr.strip()[:500]}"] if proc.stderr.strip() else []
        raise _FixtureFailure(
            _fixture_error(
                "documentation_coverage_fixture.mjs exited with non-zero status.", details
            )
        )

    try:
        return json.loads(proc.stdout)
    except (json.JSONDecodeError, TypeError) as exc:
        raise _FixtureFailure(
            _fixture_error("documentation_coverage_fixture.mjs produced invalid JSON output.")
        ) from exc


def _load_documentation_coverage_result(
    changed_files: list[str], root: Path
) -> tuple[Any, list[Violation]]:
    """Run the classifier and return its result or a fail-closed violation."""
    if shutil.which("node") is None:
        return None, []

    try:
        _require_coverage_fixture()
        fixture_input = {
            "repo_path": str(root),
            "changed_paths": list(changed_files),
        }
        return _invoke_coverage_fixture(fixture_input, root), []
    except _FixtureFailure as exc:
        return None, [exc.violation]


def _documentation_outcome_details(result: dict[str, object]) -> list[str]:
    """Build detail lines for the classified surfaces and suggested targets."""
    surface_classes = sorted({
        classification["surface_class"]
        for classification in result.get("classifications", [])
        if classification.get("surface_class") not in ("doc", "unclassified")
    })
    suggested = result.get("suggested_doc_targets", [])
    details = []
    if surface_classes:
        details.append(f"classified surfaces: {', '.join(surface_classes)}")
    if suggested:
        details.append(f"suggested doc targets: {', '.join(suggested)}")
    return details


def _documentation_outcome_violations(
    result: dict[str, object], pr_body: str | None
) -> list[Violation]:
    """Require a documentation outcome when the classifier says one is needed."""
    if not result.get("outcome_required") or pr_body is None:
        return []
    if _DOCUMENTATION_SECTION_RE.search(pr_body):
        return []
    return [
        Violation(
            code="doc-coverage-outcome-missing",
            message=(
                "Diff touches a documented surface but the PR body has no "
                "## Documentation section. Add a documentation_outcome field "
                "when calling gc_render_pr_body (ADR-054)."
            ),
            details=_documentation_outcome_details(result),
        )
    ]


def run_documentation_coverage_check(
    changed_files: list[str],
    root: Path = REPO_ROOT,
    pr_body: str | None = None,
) -> list[Violation]:
    """Classify the diff and verify that the PR body records its doc outcome."""
    result, violations = _load_documentation_coverage_result(changed_files, root)
    if result is None:
        return violations
    return _documentation_outcome_violations(result, pr_body)
