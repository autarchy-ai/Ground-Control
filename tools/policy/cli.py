"""Policy checks: command-line entry point.

Extracted from tools/policy/checks.py (issue #1355), which had reached 5,679 lines against
the repo's 500-LOC limit. checks.py remains the entry point and re-exports this module, so
every existing import path and the CLI keep working.

The first cut named each file for the section that began where the previous chunk ended, so
every name described a neighbour's contents. The modules are named for what they hold.
"""

from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from .file_size import run_file_size_limit_check
from .ci_strictness import (
    run_ci_required_context_contract,
    run_github_action_pin_contract,
    run_pr_title_contract,
    run_sonar_strictness_contract,
)
from .workflow_contracts import run_doc_coverage_anchor_contract, run_scan_floor_contract
from .adr_guard import (
    read_changed_files,
    run_adr_guard,
)
from .execution_contract import (
    RELEASE_PLEASE_PR_HEAD_PREFIX,
    RELEASE_PR_BASE,
    RELEASE_PR_HEAD,
    SYNC_PR_BASE,
    SYNC_PR_HEAD,
    _resolve_pr_body,
    run_implement_execution_contract,
)
from .repo_identity import (
    run_repo_identity_drift,
)
from .workflow_routing import (
    parse_args,
    render_and_exit,
    run_workflow_routing_contract,
)
from .documentation_coverage import run_documentation_coverage_check
from .version_mirror import run_version_mirror_consistency_check
from .authz_matrix import (
    check_pr_body,
)
from .requirement_specs import (
    run_requirement_specs_frontmatter_check,
)
from .repo_map import (
    run_repository_map_freshness_check,
)


def main(argv: list[str] | None = None) -> int:
    """Run all repository policy checks and render their violations."""
    args = parse_args(argv or sys.argv[1:])
    explicit_files = args.files if args.files is not None else args.paths
    if args.files and args.paths:
        explicit_files = [*args.files, *args.paths]
    changed_files = read_changed_files(
        files=explicit_files,
        base=args.base,
        staged=args.staged,
        env_var=args.files_env,
    )

    # After the context-graph teardown (issue #1500) the backend, frontend, DB,
    # deploy artifacts, and GRC ontology/measurement surfaces are gone, so the
    # checks that guarded them are retired. What remains is repo-native: ADRs,
    # the requirement-spec files, the /implement execution + workflow contracts,
    # reviewer-separation decision records, repo identity, version mirrors, and
    # the file-size and PR-body contracts.
    violations = []
    violations.extend(run_adr_guard(changed_files, base=args.base))
    violations.extend(run_version_mirror_consistency_check())
    violations.extend(run_repo_identity_drift())
    violations.extend(run_workflow_routing_contract())
    violations.extend(run_implement_execution_contract())
    violations.extend(run_scan_floor_contract())
    violations.extend(run_doc_coverage_anchor_contract())
    violations.extend(run_sonar_strictness_contract())
    violations.extend(run_ci_required_context_contract())
    violations.extend(run_pr_title_contract())
    violations.extend(run_github_action_pin_contract())
    violations.extend(run_file_size_limit_check())
    violations.extend(run_requirement_specs_frontmatter_check())
    violations.extend(run_repository_map_freshness_check())

    base_ref, head_ref = _resolve_pr_refs(args)
    if args.skip_pr_body or _is_release_pr(base_ref, head_ref):
        # The dev -> main release PR aggregates feature PRs that each already
        # satisfied the body contract on the way into dev; re-imposing it (and
        # the ## Documentation outcome) on the aggregate is redundant ceremony
        # that fails every release. The changed-file checks above still run.
        violations.extend(run_documentation_coverage_check(changed_files, pr_body=None))
    else:
        body = _resolve_pr_body(args)
        if body is not None:
            # check_pr_body composes the no-deferral check (ADR-029) so all
            # PR-body validation routes share the same contract.
            violations.extend(check_pr_body(body))
            violations.extend(run_documentation_coverage_check(changed_files, pr_body=body))
        else:
            violations.extend(run_documentation_coverage_check(changed_files, pr_body=None))

    return render_and_exit(violations)


def _resolve_pr_refs(args: argparse.Namespace) -> tuple[str | None, str | None]:
    """Best-effort ``(base_ref, head_ref)`` for the PR under check.

    Sourced from the GitHub event payload or ``--pr-number`` (``gh pr view``),
    mirroring ``_resolve_pr_body``. Returns ``(None, None)`` when the refs cannot
    be determined (e.g. the local pre-push driver), so the body contract applies
    by default — only a positively-identified release PR is exempted.
    """
    refs: tuple[str | None, str | None] = (None, None)
    event_path = args.event_path or os.getenv("GITHUB_EVENT_PATH")
    if event_path:
        try:
            event = json.loads(Path(event_path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
        else:
            pull_request = event.get("pull_request") or {}
            refs = (
                (pull_request.get("base") or {}).get("ref"),
                (pull_request.get("head") or {}).get("ref"),
            )
    elif args.pr_number is not None:
        try:
            result = subprocess.run(
                ["gh", "pr", "view", str(args.pr_number), "--json", "baseRefName,headRefName"],
                check=True,
                capture_output=True,
                text=True,
            )
            data = json.loads(result.stdout)
            refs = data.get("baseRefName"), data.get("headRefName")
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            pass
    return refs


def _is_release_pr(base_ref: str | None, head_ref: str | None) -> bool:
    """True for automation PRs exempt from the per-PR body contract (GC-P027).

    Covers the ``dev`` -> ``main`` promotion, the Release Please release PR, and the
    ``main`` -> ``dev`` back-merge PR.
    """
    if base_ref == RELEASE_PR_BASE and head_ref == RELEASE_PR_HEAD:
        return True
    if (
        base_ref == RELEASE_PR_BASE
        and head_ref is not None
        and head_ref.startswith(RELEASE_PLEASE_PR_HEAD_PREFIX)
    ):
        return True
    return base_ref == SYNC_PR_BASE and head_ref == SYNC_PR_HEAD
