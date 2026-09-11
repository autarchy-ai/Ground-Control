"""Scope-language and completion-boundary checks for the /implement workflow."""

import re
from pathlib import Path

from .core import Violation


def _forbidden_implement_sources(
    root: Path, implement_sources: list[Path], step1: Path
) -> list[str]:
    """Find workflow files that bypass the MCP mutation boundaries."""
    forbidden = []
    for path in implement_sources:
        text = path.read_text(encoding="utf-8")
        direct_branch = re.search(
            r"\bgit\s+worktree\s+add\b|\bgh\s+issue\s+develop\b",
            text,
        )
        direct_pickup = path == step1 and re.search(
            r"\bgh\s+(?:api|label|issue)\b[^\n]*\bin-progress\b", text
        )
        if direct_branch or direct_pickup:
            forbidden.append(str(path.relative_to(root)))
    return forbidden


def _contradictory_scope_sources(root: Path, implement_sources: list[Path]) -> list[str]:
    """Find workflow files that permit scope-based non-action."""
    contradictory = []
    for path in implement_sources:
        text = path.read_text(encoding="utf-8").lower()
        if "outside the diff's scope" in text or "no scope creep" in text:
            contradictory.append(str(path.relative_to(root)))
    return contradictory


# The issue body's `## Requirements` section is a run's only scope authority, and
# gc_update_issue_requirements is its only supported writer (issue #1569). Before that
# tool existed, Step 1 and Step 4 stated the obligation as prose with nothing behind it,
# so a requirement introduced mid-run stayed out of scope and Phase E verified nothing.
# Anchoring the tool name in both surfaces keeps the instruction from drifting back to
# unbacked prose or to a hand-run `gh issue edit`.
SCOPE_WRITER_TOOL = "gc_update_issue_requirements"

# Writing the section changes the run's authoritative scope after `in_scope_requirements[]`
# has already been parsed and cached, and Steps 4.5, 9, 15, 16, and 17 all enumerate that
# cached array. Naming the tool without also requiring the reconciliation would let an
# added UID be dropped from clause mapping, the PR body, the transition, and traceability,
# after which Step 17 re-derives the issue's scope and refuses the mismatch.
SCOPE_WRITER_RECONCILIATION = "reconcile the cached scope"

SCOPE_WRITER_TOKENS = (SCOPE_WRITER_TOOL, SCOPE_WRITER_RECONCILIATION)

SCOPE_WRITER_SURFACES = (
    "skills/implement/steps/step-01-issue-branch-resolution.md",
    "skills/implement/steps/step-04-planning.md",
)


def _missing_scope_writer_surfaces(root: Path) -> list[str]:
    """Find workflow files missing the scope-writer tool or its reconciliation contract."""
    missing = []
    for rel in SCOPE_WRITER_SURFACES:
        text = (root / rel).read_text(encoding="utf-8")
        missing.extend(f"missing {token} in {rel}" for token in SCOPE_WRITER_TOKENS if token not in text)
    return missing


def check_scope_and_completion_contract(root: Path) -> list[Violation]:
    """Reject bypass language and require completion-obligation enforcement."""
    violations: list[Violation] = []
    paths = {
        "skill": root / "skills/implement/SKILL.md",
        "principles": root / "skills/implement/_development-principles.md",
        "step1": root / "skills/implement/steps/step-01-issue-branch-resolution.md",
    }
    completion = (root / "skills/implement/steps/step-17-completion.md").read_text(
        encoding="utf-8"
    )
    cursor = (root / ".cursor/skills/implement/SKILL.md").read_text(encoding="utf-8")
    cursor_flat = " ".join(cursor.split()).lower()
    implement_sources = [
        paths["skill"],
        paths["principles"],
        *sorted((root / "skills/implement/steps").glob("*.md")),
    ]
    forbidden = _forbidden_implement_sources(root, implement_sources, paths["step1"])
    if forbidden:
        violations.append(
            Violation(
                code="implement-direct-worktree-or-branch-command",
                message="/implement workflow surfaces must use MCP branch and pickup boundaries.",
                details=[f"direct branch/worktree/pickup command in {path}" for path in forbidden],
            )
        )

    missing_scope_writer = _missing_scope_writer_surfaces(root)
    if missing_scope_writer:
        violations.append(
            Violation(
                code="implement-scope-writer-tool",
                message=(
                    "Step 1 and Step 4 must name the MCP tool that writes an issue's "
                    "Requirements section and require reconciling the cached scope after it."
                ),
                details=missing_scope_writer,
            )
        )

    contradictory = _contradictory_scope_sources(root, implement_sources)
    if contradictory:
        violations.append(
            Violation(
                code="implement-contradictory-scope-language",
                message="Workflow text still permits scope-based non-action.",
                details=contradictory,
            )
        )

    if "completion_open_execution_obligations" not in completion:
        violations.append(
            Violation(
                code="implement-obligation-completion-gate",
                message="Step 17 must document completion refusal while obligations are open.",
                details=["missing completion_open_execution_obligations"],
            )
        )

    # A no-change post-merge Phase E resume must not manufacture an edit or run
    # implementation verification for bookkeeping (issue #1543). Step 17 is the
    # completion boundary, so anchor the contract there.
    phase_e_noop_tokens = (
        "manufacture a placeholder requirement-file edit",
        "finalize` runs no `verify` gate",
    )
    missing_phase_e = [token for token in phase_e_noop_tokens if token not in completion]
    if missing_phase_e:
        violations.append(
            Violation(
                code="implement-phase-e-noop-contract",
                message=(
                    "Step 17 must document that a no-change Phase E resume commits "
                    "nothing and runs no implementation verification."
                ),
                details=[f"missing token: {token}" for token in missing_phase_e],
            )
        )
    if "_development-principles.md" not in cursor or "before route resolution" not in cursor_flat:
        violations.append(
            Violation(
                code="implement-driver-principles",
                message="The Cursor driver wrapper must load the canonical principles before routing.",
                details=["update .cursor/skills/implement/SKILL.md"],
            )
        )
    return violations
