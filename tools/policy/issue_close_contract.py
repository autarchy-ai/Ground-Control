"""Post-merge issue-close checks for the /implement and /quickfix workflow prose.

GitHub honors a pull request's `Closes #n` keyword only when the pull request merges into
the repository's default branch. Workflow delivery PRs target the integration branch, so
the keyword cannot be the close path: an issue whose PR merged into a non-default base
stays open. Both lanes close through `gc_close_issue_after_merge` after the merge, and
prose that promises an unconditional auto-close is what let /quickfix ship without that
step (issue #1601).
"""

import re
from pathlib import Path

from .core import Violation

QUICKFIX_SKILL_PATH = "skills/quickfix/SKILL.md"
QUICKFIX_CLOSE_STEP_HEADING = "### Q7. Finalize after merge"
FINALIZE_TOOL = "gc_implement_mechanical"
FINALIZE_ACTION = 'action: "finalize"'
QUICKFIX_LANE = 'lane: "quickfix"'
DEFAULT_BRANCH_CONDITION = "default branch"

_SECTION_END_RE = re.compile(r"^(?:#{1,3} .*|---[ \t]*)$", re.MULTILINE)
_SENTENCE_BREAK_RE = re.compile(r"(?<=[.;:])\s+")
_CLOSE_CLAIM_RE = re.compile(r"auto-clos|closes via", re.IGNORECASE)


def _read(root: Path, rel: str) -> str:
    """One workflow surface's text."""
    return (root / rel).read_text(encoding="utf-8")


def _quickfix_close_step_section(text: str) -> str | None:
    """The body of /quickfix's post-merge close step, or None when the heading is absent."""
    start = text.find(QUICKFIX_CLOSE_STEP_HEADING)
    if start < 0:
        return None
    body_start = start + len(QUICKFIX_CLOSE_STEP_HEADING)
    end = _SECTION_END_RE.search(text, body_start)
    return text[body_start : end.start() if end else len(text)]


def _quickfix_close_step_details(root: Path) -> list[str]:
    """Why /quickfix does not carry a post-merge close through the close tool, if it doesn't."""
    section = _quickfix_close_step_section(_read(root, QUICKFIX_SKILL_PATH))
    if section is None:
        return [f"missing {QUICKFIX_CLOSE_STEP_HEADING.rstrip(':')} section in {QUICKFIX_SKILL_PATH}"]
    missing = [
        token for token in (FINALIZE_TOOL, FINALIZE_ACTION, QUICKFIX_LANE)
        if token not in section
    ]
    if missing:
        return [
            f"Quickfix finalizer in {QUICKFIX_SKILL_PATH} is missing {token}"
            for token in missing
        ]
    return []


def _lane_prose_paths(root: Path) -> list[Path]:
    """Every workflow prose file an /implement or /quickfix driver reads."""
    return [*sorted((root / "skills/implement").rglob("*.md")), root / QUICKFIX_SKILL_PATH]


def _unconditional_auto_close_claims(root: Path) -> list[str]:
    """Sentences that tie `Closes #` to an issue close without the default-branch condition."""
    claims = []
    for path in _lane_prose_paths(root):
        rel = path.relative_to(root).as_posix()
        for paragraph in path.read_text(encoding="utf-8").split("\n\n"):
            for sentence in _SENTENCE_BREAK_RE.split(" ".join(paragraph.split())):
                if (
                    "Closes #" in sentence
                    and _CLOSE_CLAIM_RE.search(sentence)
                    and DEFAULT_BRANCH_CONDITION not in sentence
                ):
                    claims.append(f"{rel}: {sentence[:160]}")
    return claims


def check_issue_close_contract(root: Path) -> list[Violation]:
    """Require the /quickfix post-merge close step and reject unconditional auto-close prose."""
    violations: list[Violation] = []
    close_step = _quickfix_close_step_details(root)
    if close_step:
        violations.append(
            Violation(
                code="quickfix-post-merge-close-step",
                message=(
                    "/quickfix must use the shared post-merge finalize action; a `Closes #n` "
                    "keyword does not close an issue on a non-default base."
                ),
                details=close_step,
            )
        )
    claims = _unconditional_auto_close_claims(root)
    if claims:
        violations.append(
            Violation(
                code="workflow-unconditional-auto-close-claim",
                message=(
                    "Workflow prose says `Closes #n` closes the issue at merge without naming the "
                    "default-branch condition GitHub applies."
                ),
                details=claims,
            )
        )
    return violations
