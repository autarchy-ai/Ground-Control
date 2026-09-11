"""Policy contracts for the repository's merge gates.

Two contracts live here. The Sonar one pins the strict quality-gate ordering.
The required-context one pins the correspondence between the branch-protection
baseline and the jobs that actually produce those checks, and the shape of the
protection policy that baseline declares.

The second contract is deliberately offline: it compares files in this
repository. Comparing the same declaration against the protection GitHub
actually enforces needs repository administration permission, which no CI token
here holds, so that half lives in `tools/ci/check_branch_protection.py` behind
`make branch-protection-check` (GC-P031).
"""

import fnmatch
import json
import re
from pathlib import Path

import yaml

from .branch_protection_fields import protection_policy_violations
from .branch_protection_baseline import (
    BRANCH_PROTECTION_BASELINE_PATH,
    CI_STRICTNESS_BRANCHES,
    CI_STRICTNESS_CONTEXT_PROVIDERS,
    CI_STRICTNESS_REQUIRED_CONTEXTS,
    BranchProtectionBaselineError,
    load_branch_protection_baseline,
)
from .core import (
    REPO_ROOT,
    SONAR_NEW_ISSUE_GATE_PATH,
    Violation,
    require_scanned,
)


WORKFLOWS_DIR = Path(".github/workflows")


# Contexts posted by a hosted app rather than by a job in this repository, so no
# local workflow can produce them. This exemption is deliberately tiny and
# shrink-only: a test asserts every entry is still a required context, so an
# entry cannot outlive the check it exempts and quietly widen the carve-out.
EXTERNALLY_POSTED_CONTEXTS = frozenset(
    {
        "GitGuardian Security Checks",
        "SonarCloud Code Analysis",
    }
)


SONAR_WORKFLOW_PATH = Path(".github/workflows/sonarcloud.yml")
SONAR_QUALITY_GATE_ANCHOR = "SonarSource/sonarqube-quality-gate-action@"
SONAR_TOKEN_BINDING = "SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}"
SONAR_ALWAYS_RUN_ANCHOR = "if: ${{ !cancelled() }}"
PR_TITLE_WORKFLOW_PATH = Path(".github/workflows/pr-title.yml")
GROUND_CONTROL_CONFIG_PATH = Path(".ground-control.yaml")
ACTION_USES_RE = re.compile(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)", re.MULTILINE)
IMMUTABLE_ACTION_RE = re.compile(r"^[^@\s]+@[0-9a-fA-F]{40}$")


def run_sonar_strictness_contract(root: Path = REPO_ROOT) -> list[Violation]:
    """Require Sonar's quality gate and the stricter zero-open-issues gate."""
    violations: list[Violation] = []
    workflow_path = root / SONAR_WORKFLOW_PATH
    issue_gate_path = root / SONAR_NEW_ISSUE_GATE_PATH

    if not workflow_path.exists():
        return [
            Violation(
                code="sonar-strictness-workflow-missing",
                message="The SonarCloud workflow is required for strict merge enforcement.",
                details=[f"expected at {SONAR_WORKFLOW_PATH.as_posix()}"],
            )
        ]
    if not issue_gate_path.exists():
        violations.append(
            Violation(
                code="sonar-strictness-script-missing",
                message="The zero-open-issues SonarCloud gate script is missing.",
                details=[f"expected at {SONAR_NEW_ISSUE_GATE_PATH.as_posix()}"],
            )
        )

    workflow_text = workflow_path.read_text(encoding="utf-8")
    quality_gate_offset = workflow_text.find(SONAR_QUALITY_GATE_ANCHOR)
    issue_gate_offset = workflow_text.find(SONAR_NEW_ISSUE_GATE_PATH.as_posix())
    if quality_gate_offset < 0:
        violations.append(
            Violation(
                code="sonar-strictness-quality-gate",
                message="SonarCloud CI must wait for the hosted quality gate.",
                details=[f"missing {SONAR_QUALITY_GATE_ANCHOR} in {SONAR_WORKFLOW_PATH.as_posix()}"],
            )
        )
    if issue_gate_offset < 0:
        violations.append(
            Violation(
                code="sonar-strictness-zero-issue-gate",
                message="SonarCloud CI must fail when any new-code issue remains open.",
                details=[f"missing {SONAR_NEW_ISSUE_GATE_PATH.as_posix()} invocation"],
            )
        )
    elif quality_gate_offset >= 0 and issue_gate_offset < quality_gate_offset:
        violations.append(
            Violation(
                code="sonar-strictness-gate-order",
                message="The zero-open-issues check must run after the hosted quality gate.",
                details=[f"repair step order in {SONAR_WORKFLOW_PATH.as_posix()}"],
            )
        )
    if workflow_text.count(SONAR_TOKEN_BINDING) < 3:
        violations.append(
            Violation(
                code="sonar-strictness-token-binding",
                message="Every Sonar scan, quality, and zero-issue step must receive SONAR_TOKEN.",
                details=["expected three step-scoped SONAR_TOKEN bindings"],
            )
        )
    if SONAR_ALWAYS_RUN_ANCHOR not in workflow_text:
        violations.append(
            Violation(
                code="sonar-strictness-zero-issue-always-runs",
                message="The zero-open-issues check must run after a hosted gate failure.",
                details=[f"missing {SONAR_ALWAYS_RUN_ANCHOR} on the zero-issue step"],
            )
        )
    return violations


def _matches_any(branch: str, patterns: list[object]) -> bool:
    """Whether `branch` matches any entry, which may be a glob."""
    return any(fnmatch.fnmatch(branch, str(pattern)) for pattern in patterns)


def _trigger_covers(branch: str, pull_request: object) -> bool:
    """Whether a `pull_request` trigger runs for pull requests into `branch`.

    An absent `branches` / `branches-ignore` filter matches every branch. Both
    filters accept glob patterns, which is why this matches rather than compares.
    """
    if pull_request is None:
        return True
    if not isinstance(pull_request, dict):
        return False
    if "paths" in pull_request or "paths-ignore" in pull_request:
        return False
    ignore = pull_request.get("branches-ignore")
    if "branches-ignore" in pull_request and (
        not isinstance(ignore, list) or not all(isinstance(item, str) for item in ignore)
    ):
        return False
    if isinstance(ignore, list) and _matches_any(branch, ignore):
        return False
    allowed = pull_request.get("branches")
    if "branches" in pull_request and (
        not isinstance(allowed, list) or not all(isinstance(item, str) for item in allowed)
    ):
        return False
    return not isinstance(allowed, list) or _matches_any(branch, allowed)


def _load_workflow(path: Path) -> dict[str, object] | None:
    """Parse one workflow, or None when it is unreadable or not a mapping.

    Returning None rather than raising keeps one malformed file from masking the
    rest of the scan; the scan-floor guard is what turns "resolved nothing" into
    a failure.
    """
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (yaml.YAMLError, OSError):
        return None
    return document if isinstance(document, dict) else None


def _pull_request_trigger(document: dict[str, object]) -> tuple[bool, object]:
    """Whether the workflow runs on `pull_request`, and that trigger's config."""
    # PyYAML resolves an unquoted `on:` key to the boolean True (the YAML 1.1
    # "y/yes/on" rule), so both spellings have to be accepted here.
    triggers = document.get("on", document.get(True))
    if isinstance(triggers, dict):
        return "pull_request" in triggers, triggers.get("pull_request")
    if isinstance(triggers, list):
        return "pull_request" in triggers, None
    return triggers == "pull_request", None


def _reported_check_name(job_id: object, definition: object) -> str | None:
    """The status context this job reports, or None when it resolves to no single name.

    GitHub reports a job's `name:` when it sets one and its `jobs.<id>` key
    otherwise, and branch protection waits on the reported name. A name carrying
    a `${{ }}` expression expands per matrix leg, so it is neither the id nor the
    raw template; such a job contributes no resolvable context, and whatever it
    was meant to satisfy fails as unproduced rather than passing on a guess.
    """
    name = definition.get("name") if isinstance(definition, dict) else None
    if not (isinstance(name, str) and name.strip()):
        return str(job_id)
    return None if "${{" in name else name.strip()


def _check_names_by_branch(root: Path) -> tuple[dict[str, set[str]], int]:
    """Reported check names per protected branch, and the workflow scan count.

    This is per-branch rather than one pooled set because a `pull_request`
    trigger filtered to one branch never runs for the other, so pooling would
    accept a repository where `main` requires a check only `dev` can produce and
    every `main` pull request waits forever. Only pull-request-triggered
    workflows count: a job that runs solely on push never reports a context on
    the pull request it is meant to gate.
    """
    by_branch: dict[str, set[str]] = {branch: set() for branch in CI_STRICTNESS_BRANCHES}
    scanned = 0
    workflows_dir = root / WORKFLOWS_DIR
    if not workflows_dir.is_dir():
        return by_branch, scanned
    paths = sorted(workflows_dir.glob("*.yml")) + sorted(workflows_dir.glob("*.yaml"))
    for path in paths:
        document = _load_workflow(path)
        if document is None:
            continue
        scanned += 1
        runs_on_pull_request, pull_request = _pull_request_trigger(document)
        jobs = document.get("jobs")
        if not runs_on_pull_request or not isinstance(jobs, dict):
            continue
        names = {
            name
            for job_id, definition in jobs.items()
            if (name := _reported_check_name(job_id, definition)) is not None
        }
        for branch in CI_STRICTNESS_BRANCHES:
            if _trigger_covers(branch, pull_request):
                by_branch[branch].update(names)
    return by_branch, scanned


def _load_baseline(root: Path) -> tuple[dict[str, object], Violation | None]:
    """The validated baseline in this module's `Violation` envelope.

    Parsing *and* schema validation live in `load_branch_protection_baseline`, so
    this gate and the live comparison judge the declaration by one implementation.
    A gate that validated separately from the comparison is how the two come to
    disagree about what a declared value means.
    """
    baseline: dict[str, object] = {}
    blocked: Violation | None = None
    if not (root / BRANCH_PROTECTION_BASELINE_PATH).exists():
        blocked = Violation(
            code="ci-required-context-baseline-missing",
            message="The branch-protection baseline is required to verify the merge gate.",
            details=[f"expected at {BRANCH_PROTECTION_BASELINE_PATH.as_posix()}"],
        )
    else:
        try:
            baseline = load_branch_protection_baseline(root)
        except BranchProtectionBaselineError as error:
            blocked = Violation(
                code="ci-required-context-baseline-malformed",
                message="The branch-protection baseline does not satisfy its declared schema.",
                details=error.details,
            )
        except OSError as error:
            blocked = Violation(
                code="ci-required-context-baseline-unreadable",
                message="The branch-protection baseline could not be read.",
                details=[f"{BRANCH_PROTECTION_BASELINE_PATH.as_posix()}: {error}"],
            )
    return ({}, blocked) if blocked else (baseline, None)


def _context_drift(branch: str, declared: set[str], expected: set[str]) -> Violation | None:
    """The drift between one branch's declared contexts and the contract, if any."""
    missing = sorted(expected - declared)
    extra = sorted(declared - expected)
    if not missing and not extra:
        return None
    return Violation(
        code="ci-required-context-baseline-drift",
        message="The branch-protection baseline must match the declared required-context set.",
        details=(
            [f"{branch}: missing '{name}'" for name in missing]
            + [f"{branch}: unexpected '{name}'" for name in extra]
        ),
    )


def _baseline_violations(branches: dict[str, object], expected: set[str]) -> list[Violation]:
    """Per-branch baseline shape: the branch is declared, strict, and matches the contract."""
    violations: list[Violation] = []
    # The loader has already closed the branch set and validated every declared
    # shape and scalar type, so this compares values rather than re-parsing them.
    for branch in CI_STRICTNESS_BRANCHES:
        config = branches[branch]
        checks = config["required_status_checks"]
        drift = _context_drift(branch, set(checks["contexts"]), expected)
        if drift:
            violations.append(drift)
        violations += protection_policy_violations(branch, config)
    return violations


def _unproduced_violation(
    by_branch: dict[str, set[str]], expected: set[str]
) -> Violation | None:
    """The contexts no pull-request job produces, named per protected branch."""
    details: list[str] = []
    for branch in CI_STRICTNESS_BRANCHES:
        produced = by_branch.get(branch, set())
        details += [
            f"{branch}: required context '{name}' has no pull-request job in "
            f"{WORKFLOWS_DIR.as_posix()}/ that runs for this branch"
            for name in sorted(expected - EXTERNALLY_POSTED_CONTEXTS - produced)
        ]
    if not details:
        return None
    return Violation(
        code="ci-required-context-unproduced",
        message=(
            "Every required status check must be produced by a pull-request job "
            "on every protected branch."
        ),
        details=details,
    )


def run_ci_required_context_contract(root: Path = REPO_ROOT) -> list[Violation]:
    """Assert every required status check is real, and that the baseline matches.

    A required context with no job behind it never reports, so the pull request
    waits on a check that can never arrive and merges become impossible. The
    inverse, a job that quietly stops being required, is the gate-weakening
    direction. Both are drift between two files nothing else compares, so the
    check is two-sided over `CI_STRICTNESS_REQUIRED_CONTEXTS` (GC-P030, ADR-091).

    The declaration's schema is validated by the loader, so a malformed baseline
    returns that single structured failure rather than a cascade of comparisons
    against values whose types were never checked.
    """
    baseline, blocked = _load_baseline(root)
    if blocked:
        return [blocked]

    expected = set(CI_STRICTNESS_REQUIRED_CONTEXTS)
    violations = _baseline_violations(baseline["branches"], expected)

    stale_external = sorted(set(EXTERNALLY_POSTED_CONTEXTS) - expected)
    if stale_external:
        violations.append(
            Violation(
                code="ci-required-context-external-allowlist-drift",
                message="The hosted-context exemption must be a subset of required contexts.",
                details=[f"unexpected external exemption '{name}'" for name in stale_external],
            )
        )

    provider_names = set(CI_STRICTNESS_CONTEXT_PROVIDERS)
    missing_providers = sorted(expected - provider_names)
    extra_providers = sorted(provider_names - expected)
    if missing_providers or extra_providers:
        violations.append(
            Violation(
                code="ci-required-context-provider-map-drift",
                message="Every required context must have exactly one declared provider.",
                details=(
                    [f"missing provider for '{name}'" for name in missing_providers]
                    + [f"provider declared for non-required context '{name}'" for name in extra_providers]
                ),
            )
        )

    by_branch, scanned = _check_names_by_branch(root)
    guard = require_scanned("pull-request workflow inventory", scanned)
    if guard:
        return violations + guard

    unproduced = _unproduced_violation(by_branch, expected)
    return violations + ([unproduced] if unproduced else [])


def _pr_title_ci_contract(root: Path) -> dict[str, object] | None:
    document = _load_workflow(root / PR_TITLE_WORKFLOW_PATH)
    jobs = document.get("jobs") if document else None
    job = jobs.get("lint-pr-title") if isinstance(jobs, dict) else None
    steps = job.get("steps") if isinstance(job, dict) else None
    if not isinstance(steps, list):
        return None
    for step in steps:
        values = step.get("with") if isinstance(step, dict) else None
        if not isinstance(values, dict) or "types" not in values:
            continue
        raw_types = values["types"]
        types = (
            [line.strip() for line in raw_types.splitlines() if line.strip()]
            if isinstance(raw_types, str)
            else raw_types
        )
        return {
            "types": types,
            "require_scope": values.get("requireScope", False),
            "subject_pattern": values.get("subjectPattern"),
        }
    return None


def run_pr_title_contract(root: Path = REPO_ROOT) -> list[Violation]:
    """Keep the advisory CI title check identical to the MCP creation gate."""
    try:
        config = yaml.safe_load((root / GROUND_CONTROL_CONFIG_PATH).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        config = None
    workflow = config.get("workflow") if isinstance(config, dict) else None
    mcp_contract = workflow.get("pr_title") if isinstance(workflow, dict) else None
    ci_contract = _pr_title_ci_contract(root)
    if isinstance(mcp_contract, dict) and mcp_contract == ci_contract:
        return []
    return [
        Violation(
            code="pr-title-contract-drift",
            message="CI and MCP PR-title validation must use one contract.",
            details=[
                f"MCP input: {GROUND_CONTROL_CONFIG_PATH.as_posix()}:workflow.pr_title",
                f"CI input: {PR_TITLE_WORKFLOW_PATH.as_posix()}:jobs.lint-pr-title",
            ],
        )
    ]


def run_github_action_pin_contract(root: Path = REPO_ROOT) -> list[Violation]:
    """Require immutable revisions for every external GitHub Action."""
    workflows_dir = root / WORKFLOWS_DIR
    paths = (
        sorted(workflows_dir.glob("*.yml")) + sorted(workflows_dir.glob("*.yaml"))
        if workflows_dir.is_dir()
        else []
    )
    guard = require_scanned(
        "GitHub Action workflow inventory", len(paths), code="github-action-pin-scan-empty"
    )
    if guard:
        return guard
    violations: list[Violation] = []
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            violations.append(
                Violation(
                    code="github-action-workflow-unreadable",
                    message="A GitHub Actions workflow could not be inspected.",
                    details=[f"{path.relative_to(root).as_posix()}: {error}"],
                )
            )
            continue
        for reference in ACTION_USES_RE.findall(text):
            if reference.startswith("./") or IMMUTABLE_ACTION_RE.fullmatch(reference):
                continue
            violations.append(
                Violation(
                    code="github-action-not-immutable",
                    message="External GitHub Actions must be pinned to a full commit SHA.",
                    details=[f"{path.relative_to(root).as_posix()}: {reference}"],
                )
            )
    return violations
