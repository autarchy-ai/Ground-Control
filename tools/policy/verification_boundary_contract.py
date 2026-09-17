"""Verification-boundary checks for the /implement and /quickfix workflow prose.

The lanes run each verification layer at one owned boundary: targeted tests at Step 5,
broad completion and policy suites in CI, and the single pre-commit invocation inside
Step 7's publish action. Prose that asks the agent to run a layer again elsewhere pays
for the same check twice, and the hand-run pre-commit-then-commit habit also lands a
commit outside publish's sensitive-path screening (issue #899).
"""

from pathlib import Path

from .core import Violation

PRECOMMIT_BOUNDARY_OWNER = "skills/implement/steps/step-07-stage-precommit.md"
QUICKFIX_SKILL_PATH = "skills/quickfix/SKILL.md"
MANUAL_PRECOMMIT_INVOCATION = "pre-commit run"
QUICKFIX_MAX_LINES = 200
QUICKFIX_REQUIRED_TOKENS = (
    'action: "bootstrap"',
    'action: "publish"',
    'action: "monitor"',
    'action: "finalize"',
    'lane: "quickfix"',
    "pre-commit boundary and its secret scanning are non-negotiable",
    "one automatic repair and re-analysis round",
    "does not recursively create another issue, pull request, or implementation run",
    "Never call `gc_synchronize_implement_branch` separately",
    "Never invoke `gc_watch_ci_run` or `gc_watch_sonar_analysis` separately",
)
QUICKFIX_RETIRED_TOKENS = (
    "test-quality",
    "Q6.6",
    "both reviewers",
    "Open a tracked issue AND a PR",
    "## Amendments",
    "gc_post_final_report",
)


def _read(root: Path, rel: str) -> str:
    """One workflow surface's text."""
    return (root / rel).read_text(encoding="utf-8")


def _read_flat(root: Path, rel: str) -> str:
    """One workflow surface's text with line wraps collapsed, so tokens match across them."""
    return " ".join(_read(root, rel).split())


def _lane_prose_paths(root: Path) -> list[Path]:
    """Every workflow prose file an /implement or /quickfix driver reads."""
    return [*sorted((root / "skills/implement").rglob("*.md")), root / QUICKFIX_SKILL_PATH]


def _manual_precommit_instruction_paths(root: Path) -> list[str]:
    """Lane prose outside the publish boundary that names a pre-commit invocation."""
    offending = []
    for path in _lane_prose_paths(root):
        rel = path.relative_to(root).as_posix()
        if rel == PRECOMMIT_BOUNDARY_OWNER:
            continue
        if MANUAL_PRECOMMIT_INVOCATION in path.read_text(encoding="utf-8"):
            offending.append(rel)
    return offending


def check_verification_surface_contract(root: Path) -> list[Violation]:
    """Keep verification batching and mandatory boundaries aligned."""
    violations: list[Violation] = []
    review_rules_flat = _read_flat(root, "skills/implement/steps/_review-loop-rules.md")
    step5 = _read(root, "skills/implement/steps/step-05-quality-assurance.md")
    step6_flat = _read_flat(root, "skills/implement/steps/step-06-completion-gate.md")
    step4_4_flat = _read_flat(root, "skills/implement/steps/step-04.4-tdd.md")
    step7 = _read(root, PRECOMMIT_BOUNDARY_OWNER)
    quickfix_flat = _read_flat(root, QUICKFIX_SKILL_PATH)
    verification_surface_tokens = (
        (review_rules_flat, "CI owns repository-wide completion and policy suites"),
        (step4_4_flat, "Do not run `pre-commit` by hand"),
        (step5, "Do not run `pre-commit` here"),
        (step6_flat, "CI owns repository-wide completion and policy suites"),
        (step7, "single mandatory pre-publish"),
        (step7, "cfg.workflow.precommit_command"),
        (quickfix_flat, "Do not run `pre-commit` here"),
    )
    missing_surfaces = [
        token for surface, token in verification_surface_tokens if token not in surface
    ]
    if missing_surfaces:
        violations.append(
            Violation(
                code="implement-verification-boundary-drift",
                message="/implement verification surfaces disagree on batching or mandatory boundaries.",
                details=[f"missing token: {token}" for token in missing_surfaces],
            )
        )

    manual = _manual_precommit_instruction_paths(root)
    if manual:
        violations.append(
            Violation(
                code="implement-manual-precommit-instruction",
                message=(
                    "Workflow prose names a pre-commit invocation outside Step 7; the publish "
                    "action owns the single mandatory pre-publish hook boundary."
                ),
                details=[f"manual pre-commit instruction in {rel}" for rel in manual],
            )
        )

    quickfix = _read(root, QUICKFIX_SKILL_PATH)
    quickfix_flat = " ".join(quickfix.split())
    quickfix_details = [
        f"missing token: {token}"
        for token in QUICKFIX_REQUIRED_TOKENS
        if token not in quickfix_flat
    ]
    quickfix_details.extend(
        f"retired token remains: {token}"
        for token in QUICKFIX_RETIRED_TOKENS
        if token in quickfix
    )
    line_count = len(quickfix.splitlines())
    if line_count > QUICKFIX_MAX_LINES:
        quickfix_details.append(
            f"quickfix runtime instruction has {line_count} lines; maximum is {QUICKFIX_MAX_LINES}"
        )
    if quickfix_details:
        violations.append(
            Violation(
                code="quickfix-thin-lane-drift",
                message=(
                    "/quickfix must remain a bounded wrapper over shared bootstrap, publish, "
                    "monitor, and finalize modules."
                ),
                details=quickfix_details,
            )
        )

    return violations
