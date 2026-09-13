"""Policy checks: PR body contracts.

Extracted from tools/policy/checks.py (issue #1355), which had reached 5,679 lines against
the repo's 500-LOC limit. checks.py remains the entry point and re-exports this module, so
every existing import path and the CLI keep working.

The first cut named each file for the section that began where the previous chunk ended, so
every name described a neighbour's contents. The modules are named for what they hold.
"""

from __future__ import annotations
import argparse
import fnmatch
import hashlib
import json
import os
import posixpath
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable
from .core import (
    REQUIREMENT_FREE_MARKER_RE,
    Violation,
    extract_requirement_uid_tokens,
    extract_requirement_uids_section,
    run_no_deferral_disposition_check,
)


def run_pr_body_check(event_path: Path) -> list[Violation]:
    """Backwards-compatible wrapper that loads the PR body from a GitHub event payload."""
    event = json.loads(event_path.read_text(encoding="utf-8"))
    pull_request = event.get("pull_request") or {}
    body = pull_request.get("body") or ""
    return check_pr_body(body)


def _check_required_headers(body: str) -> Violation | None:
    """Return a Violation naming any required Ground Control section absent from ``body``."""
    required_headers = [
        "## Requirement UIDs",
        "## ADR Impact",
        "## Ground Control Checks",
        "## Traceability",
    ]
    missing_headers = [header for header in required_headers if header not in body]
    if not missing_headers:
        return None
    return Violation(
        code="pr-template-sections",
        message="PR body is missing required Ground Control sections.",
        details=[f"missing headers: {', '.join(missing_headers)}"],
    )


def _check_requirement_uid(body: str) -> Violation | None:
    """Return a Violation when ``body`` names no requirement UID and no free marker."""
    if not extract_requirement_uid_tokens(body) and not REQUIREMENT_FREE_MARKER_RE.search(
        extract_requirement_uids_section(body)
    ):
        return Violation(
            code="pr-requirement-uid",
            message="PR body must name at least one requirement UID.",
            details=["expected a UID like GC-O007 in the Requirement UIDs section"],
        )
    return None


def _check_adr_impact(body: str) -> Violation | None:
    """Return a Violation when ``body`` neither cites an ADR nor waives one."""
    if "No ADR required" not in body and "ADR-" not in body:
        return Violation(
            code="pr-adr-impact",
            message="PR body must call out ADR impact or say 'No ADR required'.",
            details=[],
        )
    return None


# Repo-neutral, semantically-named gates the workflow actually enforces for every
# repository (issues #1429, #1199). `workflow.policy_command` decides what the
# policy line runs. Byte-identical to the constants in
# `mcp/ground-control/lib/runtime-primitives.js` — the render→check compose
# fixture is the parity contract. The former `gc_evaluate_quality_gates` /
# `gc_run_sweep` lines named tools removed with the #1500 teardown.
PR_BODY_POLICY_CHECK_LINE = "- [x] Configured repository policy command passes"

# The pre-push review attestation (Steps 6.5/6.6) has three accurate forms
# (issues #1551, #1578): /implement runs both reviewers before the body is
# rendered, /quickfix leaves them off unless the user passes --review, and a run
# whose unobserved station was waived records that instead. A body must carry
# exactly one of these; the attestation is never optional, only accurate.
PR_BODY_REVIEW_CHECK_LINES = (
    "- [x] Pre-push code review and test-quality review completed; all findings fixed or dispositioned",
    "- [x] Pre-push code review and test-quality review not run for this lane; "
    "CI and repository policy gates enforced",
    # Issue #1578: a run whose unobserved review station was waived by a recorded writer command.
    # PR creation verifies the waiver against the issue-thread ledger before accepting this line.
    "- [x] Pre-push code review and test-quality review ran except review stations waived by "
    "recorded user authorization; all rendered findings fixed or dispositioned",
)


def _check_ground_control_checks(body: str) -> Violation | None:
    """Return a Violation naming any required verification checklist line missing from ``body``."""
    missing_checks: list[str] = []
    if PR_BODY_POLICY_CHECK_LINE not in body:
        missing_checks.append(PR_BODY_POLICY_CHECK_LINE)
    if not any(line in body for line in PR_BODY_REVIEW_CHECK_LINES):
        missing_checks.append(
            "one of the pre-push review attestations: " + " | ".join(PR_BODY_REVIEW_CHECK_LINES)
        )
    if missing_checks:
        return Violation(
            code="pr-ground-control-checks",
            message="PR body must record the Ground Control verification checklist.",
            details=missing_checks,
        )
    return None


def _check_traceability(body: str) -> Violation | None:
    """Return a Violation naming any IMPLEMENTS/TESTS traceability marker missing from ``body``."""
    traceability_markers = ["- IMPLEMENTS:", "- TESTS:"]
    missing_traceability = [marker for marker in traceability_markers if marker not in body]
    if missing_traceability:
        return Violation(
            code="pr-traceability-summary",
            message="PR body must summarize IMPLEMENTS and TESTS traceability.",
            details=missing_traceability,
        )
    return None


def check_pr_body(body: str) -> list[Violation]:
    """Validate a PR body against the Ground Control template requirements.

    Pure function over the body string so it can be driven from GitHub event
    payloads (CI), a local draft file (pre-push hook), or `gh pr view --json
    body`. The CI path is `run_pr_body_check`; local tooling should call this
    directly.
    """
    headers_violation = _check_required_headers(body)
    if headers_violation is not None:
        return [headers_violation]

    violations: list[Violation] = []
    for check in (
        _check_requirement_uid,
        _check_adr_impact,
        _check_ground_control_checks,
        _check_traceability,
    ):
        violation = check(body)
        if violation is not None:
            violations.append(violation)

    # The no-deferral check is composed into the PR-body validator so EVERY
    # PR-body validation route — bin/policy main(), run_pr_body_check (the
    # GitHub-event-payload path / bin/check-pr-body), and a direct
    # check_pr_body(body) call — enforces ADR-029's contract, not just main().
    violations.extend(run_no_deferral_disposition_check(pr_body=body))

    return violations


IMPLEMENT_SKILL_PATH = "skills/implement/SKILL.md"


# After issue #934 the monolithic SKILL.md is a thin orchestrator and the
# per-step prose lives at `skills/implement/steps/step-NN-<id>.md`. The
# test-quality contract check reads from the step file when the
# orchestrator no longer carries the Step 6.6 heading inline.
IMPLEMENT_STEP_TEST_QUALITY_PATH = (
    "skills/implement/steps/step-06.6-test-quality-review.md"
)


# Matches a Markdown step heading at any level (`#` through `####`) whose
# text starts with the given step label (e.g. `Step 13`). Captures the
# heading line so the splitter knows where the section begins. The H1
# branch covers per-step files split out of SKILL.md by issue #934 — each
# step file uses an H1 step heading rather than the H3 used inline in
# the monolithic SKILL.
_STEP_HEADING_RE = re.compile(r"^#{1,4}\s+(Step\s+\d+(?:\.\d+)?)\b.*$", re.MULTILINE)


def extract_step_section(body: str, step_label: str) -> str | None:
    """Return the body of a Markdown `### Step N: ...` section, or None.

    The section runs from its heading up to the next step heading of any
    level (or end of file). Returns None when the step is not present.
    """
    headings = list(_STEP_HEADING_RE.finditer(body))
    target_idx = None
    for i, match in enumerate(headings):
        if match.group(1).strip() == step_label:
            target_idx = i
            break
    if target_idx is None:
        return None
    start = headings[target_idx].end()
    end = headings[target_idx + 1].start() if target_idx + 1 < len(headings) else len(body)
    return body[start:end]
