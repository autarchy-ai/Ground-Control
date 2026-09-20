"""Shape contract for the automated Phase E workflow (issue #1671).

A merged delivery pull request finishes Phase E through
`.github/workflows/ground-control-phase-e.yml`, and the close gate trusts a final-report
marker written by that workflow only after verifying, through the Actions API, that the
run it cites belongs to that exact file. So the path is a trust anchor in two places at
once, and drift between them is silent in the worst way: renaming the workflow, or
loosening what it runs on, would not fail anything — it would just stop finalizing
deliveries, or start finalizing ones nobody validated.

Every check here is about what the job is allowed to be, not what it happens to contain:
it may run only for a merged pull request, may never check out or execute the
pull-request head, and may hold exactly one write permission.
"""

import re
from pathlib import Path

import yaml

from .core import REPO_ROOT, Violation

WORKFLOW_PATH = Path(".github/workflows/ground-control-phase-e.yml")
TRUST_ANCHOR_PATH = Path("mcp/ground-control/lib/automation-provenance.js")
MERGE_GUARD = "github.event.pull_request.merged == true"
RUN_NAME_RE = re.compile(r"^run-name:.*inputs\.pr", re.MULTILINE)
HEAD_REFERENCE_RE = re.compile(r"pull_request\.head\.(?:sha|ref)")
WRITE_PERMISSION_RE = re.compile(r"^\s*([a-z-]+):\s*write\s*$", re.MULTILINE)


def _violation(code: str, message: str, details: list[str]) -> Violation:
    """One failure in this contract's envelope."""
    return Violation(code=code, message=message, details=details)


def _trigger_config(document: dict[str, object]) -> dict[str, object]:
    """The workflow's trigger block, whichever way PyYAML resolved the `on:` key.

    PyYAML applies the YAML 1.1 ``y/yes/on`` rule, so an unquoted ``on:`` becomes the
    boolean ``True``; both spellings have to be accepted.
    """
    triggers = document.get("on", document.get(True))
    return triggers if isinstance(triggers, dict) else {}


def _trigger_violations(document: dict[str, object]) -> list[Violation]:
    """Refuse a trigger set that could run this job on unmerged or untrusted code."""
    triggers = _trigger_config(document)
    details: list[str] = []
    if "pull_request_target" in triggers:
        details.append(
            "pull_request_target runs the base workflow with a write token against fork code"
        )
    pull_request = triggers.get("pull_request")
    types = pull_request.get("types") if isinstance(pull_request, dict) else None
    if types != ["closed"]:
        details.append("pull_request must trigger on types: [closed] only")
    if "workflow_dispatch" not in triggers:
        details.append("workflow_dispatch is the maintainer repair path and must stay available")
    if not details:
        return []
    return [
        _violation(
            "phase-e-workflow-trigger",
            "The Phase E workflow must run only on a closed pull request or a manual dispatch.",
            details,
        )
    ]


def _guard_violations(document: dict[str, object]) -> list[Violation]:
    """Require the merged guard, so a merely-closed pull request finalizes nothing."""
    jobs = document.get("jobs")
    conditions = [
        job.get("if", "") for job in jobs.values() if isinstance(job, dict)
    ] if isinstance(jobs, dict) else []
    if any(MERGE_GUARD in str(condition) for condition in conditions):
        return []
    return [
        _violation(
            "phase-e-workflow-merge-guard",
            "The Phase E job must run only when the pull request actually merged.",
            [f"no job guards on `{MERGE_GUARD}`"],
        )
    ]


def _permission_violations(document: dict[str, object]) -> list[Violation]:
    """Require exactly one write permission, and require it to be `issues: write`."""
    permissions = document.get("permissions")
    if not isinstance(permissions, dict):
        return [
            _violation(
                "phase-e-workflow-permissions",
                "The Phase E workflow must declare an explicit permission set.",
                ["no top-level `permissions:` block"],
            )
        ]
    writes = sorted(name for name, value in permissions.items() if value == "write")
    if writes == ["issues"]:
        return []
    return [
        _violation(
            "phase-e-workflow-permissions",
            "The Phase E job writes the final report and closes the issue, and nothing else.",
            [f"write permissions are {writes or 'none'}; expected exactly ['issues']"],
        )
    ]


def _run_name_violations(text: str) -> list[Violation]:
    """Require the run name to carry the pull request.

    A `workflow_dispatch` run has no `pull_requests` association, so the close gate binds it
    to a pull request through the run name this workflow sets. Dropping `run-name:` would
    leave that branch accepting any dispatch run of this workflow for any pull request.
    """
    if RUN_NAME_RE.search(text):
        return []
    return [
        _violation(
            "phase-e-workflow-run-name",
            "The Phase E workflow must name the pull request it finalizes.",
            ["`run-name:` must include the dispatch input, or a dispatch run binds to nothing"],
        )
    ]


def _checkout_violations(text: str) -> list[Violation]:
    """Refuse any path that would place the untrusted pull-request head in the job."""
    details: list[str] = []
    if HEAD_REFERENCE_RE.search(text):
        details.append("the job references the pull-request head; Phase E reads the merged tree")
    if "merge_commit_sha" not in text:
        details.append("checkout must pin the event's immutable merge_commit_sha")
    if "persist-credentials: false" not in text:
        details.append("checkout must not leave a credential in the job's git config")
    if not details:
        return []
    return [
        _violation(
            "phase-e-workflow-head-checkout",
            "The Phase E job must check out the merge revision, never the pull-request head.",
            details,
        )
    ]


def _trust_anchor_violations(root: Path) -> list[Violation]:
    """Tie the workflow's path to the constant the close gate verifies runs against."""
    anchor = root / TRUST_ANCHOR_PATH
    try:
        text = anchor.read_text(encoding="utf-8")
    except OSError as error:
        return [
            _violation(
                "phase-e-trust-anchor-drift",
                "The automation trust anchor could not be read.",
                [f"{TRUST_ANCHOR_PATH.as_posix()}: {error}"],
            )
        ]
    if f'"{WORKFLOW_PATH.as_posix()}"' in text:
        return []
    return [
        _violation(
            "phase-e-trust-anchor-drift",
            "The close gate's trust anchor must name the workflow that exists.",
            [
                f"{TRUST_ANCHOR_PATH.as_posix()} does not pin "
                f"{WORKFLOW_PATH.as_posix()}; an automated final report would never be trusted"
            ],
        )
    ]


def _load_workflow(root: Path) -> tuple[str, dict[str, object] | None, Violation | None]:
    """The workflow's text and parsed document, or the single failure that stopped both."""
    try:
        text = (root / WORKFLOW_PATH).read_text(encoding="utf-8")
    except OSError:
        return "", None, _violation(
            "phase-e-workflow-missing",
            "Automated Phase E requires its merged-pull-request workflow.",
            [f"expected at {WORKFLOW_PATH.as_posix()}"],
        )
    document: object = None
    detail: str | None = None
    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError as error:
        detail = f"{WORKFLOW_PATH.as_posix()}: {error}"
    else:
        if not isinstance(document, dict):
            detail = f"{WORKFLOW_PATH.as_posix()} is not a mapping"
    if detail is not None:
        return text, None, _violation(
            "phase-e-workflow-unreadable",
            "The Phase E workflow could not be parsed.",
            [detail],
        )
    return text, document, None


def run_phase_e_automation_contract(root: Path = REPO_ROOT) -> list[Violation]:
    """Check the automated Phase E workflow and its trust anchor."""
    text, document, blocked = _load_workflow(root)
    if blocked is not None:
        return [blocked]
    return [
        *_trigger_violations(document),
        *_guard_violations(document),
        *_permission_violations(document),
        *_run_name_violations(text),
        *_checkout_violations(text),
        *_trust_anchor_violations(root),
    ]
