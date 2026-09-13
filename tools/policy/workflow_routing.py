"""Policy checks: workflow routing.

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
import os
import posixpath
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable
from .core import (
    GROUND_CONTROL_YAML_PATH,
    REPO_ROOT,
    Violation,
)


def parse_args(argv: list[str]) -> argparse.Namespace:
    """Parse the policy CLI arguments from ``argv`` into a Namespace."""
    parser = argparse.ArgumentParser(description="Run repo policy checks.")
    parser.add_argument("--base", help="Git base ref to diff against.")
    parser.add_argument(
        "--files",
        nargs="*",
        default=None,
        help="Explicit repo-relative files to evaluate.",
    )
    parser.add_argument(
        "paths",
        nargs="*",
        help="Positional repo-relative files to evaluate. Used by pre-commit.",
    )
    parser.add_argument("--files-env", help="Read newline-delimited files from an env var.")
    parser.add_argument("--staged", action="store_true", help="Read staged files from git.")
    parser.add_argument(
        "--skip-pr-body",
        action="store_true",
        help="Do not evaluate the GitHub pull request body.",
    )
    parser.add_argument(
        "--event-path",
        help="Path to a GitHub event payload. Defaults to GITHUB_EVENT_PATH when present.",
    )
    parser.add_argument(
        "--pr-body-file",
        help=(
            "Path to a plain-text PR body draft. Use this in pre-push hooks to "
            "validate the PR body before push. Mutually exclusive with --event-path / "
            "--pr-number; --pr-body-file wins when supplied."
        ),
    )
    parser.add_argument(
        "--pr-number",
        type=int,
        help=(
            "GitHub PR number. When set (and neither --pr-body-file nor "
            "--event-path is supplied), the body is fetched via "
            "`gh pr view <n> --json body`."
        ),
    )
    parser.add_argument(
        "--pr-comments-json",
        help=(
            "Path to sanitized PR issue comments as a JSON array or JSONL "
            "objects with body and author fields. CI uses this so PR-head "
            "policy code does not receive a GitHub token."
        ),
    )
    return parser.parse_args(argv)


def render_and_exit(violations: list[Violation]) -> int:
    """Print the policy result and return the exit code (0 when clean, else 1)."""
    if not violations:
        print("Policy checks passed.")
        return 0

    print("Policy checks failed:")
    for violation in violations:
        print(violation.render())
    return 1


def run_workflow_routing_contract(root: Path = REPO_ROOT) -> list[Violation]:
    """Keep /implement routing advisory and free of executor controls."""
    violations: list[Violation] = []
    config_path = root / GROUND_CONTROL_YAML_PATH
    if not config_path.exists():
        violations.append(
            Violation(
                code="workflow-routing-config-missing",
                message=".ground-control.yaml is missing — workflow routing cannot be verified.",
                details=[f"expected at {GROUND_CONTROL_YAML_PATH.as_posix()}"],
            )
        )
        return violations

    config = config_path.read_text(encoding="utf-8")
    retired = [
        token
        for token in ("default_fallback:", "agent:", "fallback:")
        if re.search(rf"(?m)^\s+{re.escape(token)}", config)
    ]
    if retired:
        violations.append(
            Violation(
                code="workflow-routing-execution-control-retired",
                message="Routing metadata must not select an executor or fallback path.",
                details=[f"retired field present: {token}" for token in retired],
            )
        )
    if not re.search(r"(?m)^\s{4}base_sync:\s*$", config):
        violations.append(
            Violation(
                code="workflow-routing-base-sync-stage-missing",
                message="The advisory routing table must declare the Step 8.5 base_sync stage.",
                details=["expected routing.stages.base_sync in .ground-control.yaml"],
            )
        )
    return violations
