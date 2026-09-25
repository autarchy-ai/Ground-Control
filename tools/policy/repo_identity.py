"""Policy checks: repository identity drift.

Extracted from tools/policy/checks.py (issue #1355), which had reached 5,679 lines against
the repo's 500-LOC limit. checks.py remains the entry point and re-exports this module, so
every existing import path and the CLI keep working.

The first cut named each file for the section that began where the previous chunk ended, so
every name described a neighbour's contents. The modules are named for what they hold.
"""

from __future__ import annotations
import re
from pathlib import Path
from .core import (
    require_scanned,
    REPO_ROOT,
    Violation,
)


# Repository identity drift check (GC-P026 / issue #1383).
#
# After the GitHub owner move to autarchy-ai/Ground-Control, several active
# surfaces still named the stale KeplerOps/Ground-Control owner, and defaulted
# repo-bound operations could target an inaccessible repository. This static
# post-condition pins every ACTIVE repository-identity surface (config,
# workflows, scripts, docs, deploy units, frontend placeholders) to the single
# canonical owner, so a re-introduced stale slug — or the next owner move — fails
# `make policy`. Adding a new active surface that names the repo is one inventory
# row.
#
# Historical records are intentionally EXCLUDED (not in the inventory): ADRs and
# CHANGELOG.md / changelog.d/** record the owner that was current at the time and
# must NOT be rewritten. Test files are excluded too — their generic URL-parsing
# and negative-case fixtures legitimately carry arbitrary owners. The Java
# package `com.keplerops.groundcontrol`, the SonarCloud org/project, and the GHCR
# image namespace are separate concepts, not repository-identity slugs.
CANONICAL_REPO_OWNER = "autarchy-ai"


CANONICAL_REPO_SLUG = "autarchy-ai/Ground-Control"


# Prior owners this issue eradicates (KeplerOps -> Brad-Edwards -> autarchy-ai).
# A bare-owner reference (e.g. a UI placeholder that carries only the owner, not
# a full owner/repo slug) cannot be validated against the canonical slug, so
# active surfaces are also guarded against these specific stale-owner literals.
STALE_REPO_OWNERS = ("KeplerOps", "Brad-Edwards")


# owner/Ground-Control inside a GitHub URL or git@ remote (badges, clone URLs,
# raw-content URLs, issue links). Anchored on the canonical repo NAME so links
# to unrelated third-party repos are not flagged; only the owner is validated.
_REPO_IDENTITY_URL_RE = re.compile(
    r"(?:github\.com[/:]|githubusercontent\.com/)([A-Za-z0-9][A-Za-z0-9-]*)/Ground-Control\b"
)


# Bare owner/Ground-Control config slug (github_repo:, --repo, etc.). The
# negative lookbehind excludes filesystem paths like `src/Ground-Control`, so a
# local checkout path is not mistaken for an identity
# slug.
_REPO_IDENTITY_SLUG_RE = re.compile(
    r"(?<![\w./-])([A-Za-z0-9][A-Za-z0-9-]*)/Ground-Control\b"
)


# Identity-declaration assignments (`github_repo:` / `GH_REPO`) carry the FULL
# owner/repo of *this* repository, so BOTH segments are validated against the
# canonical slug — a well-formed drift to a wrong repo NAME (e.g.
# `autarchy-ai/Other`) must fail too, not just a wrong owner. Tolerates the
# YAML `key: value` and JSON/shell `"KEY": "value"` / `KEY=value` forms.
_REPO_IDENTITY_ASSIGN_RE = re.compile(
    r"(?:github_repo|GH_REPO)\b['\"]?\s*[:=]\s*['\"]?"
    r"([A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._-]*)"
)


# Bare stale-owner literals (UI placeholders, prose) in active surfaces.
_STALE_OWNER_RE = re.compile(
    r"\b(" + "|".join(re.escape(owner) for owner in STALE_REPO_OWNERS) + r")\b"
)


# The full-slug assignment matcher runs ONLY on real config declarations, where
# `github_repo:` / `GH_REPO` carry this repo's live identity. Docs legitimately
# show a generic `github_repo: owner/repo` format example that is not a drift.
_REPO_IDENTITY_CONFIG_FILES = frozenset({".ground-control.yaml"})


# Active surfaces that name this repository, so an owner rename or a copied
# template cannot leave a stale slug routing an operation at an inaccessible
# repo (#1383). Absent entries are skipped, but a path whose subject the #1500
# re-platform deleted is pruned rather than left as a permanent skip: a list of
# never-resolving paths hides how little the gate is actually reading.
REPO_IDENTITY_INVENTORY: tuple[Path, ...] = (
    Path(".ground-control.yaml"),
    Path(".github/workflows/ci.yml"),
    Path(".github/workflows/security.yml"),
    Path(".github/workflows/sonarcloud.yml"),
    Path(".github/workflows/release-please.yml"),
    Path(".github/workflows/sync-main-to-dev.yml"),
    Path("scripts/bootstrap-claude-workflow.sh"),
    Path("scripts/install-hooks.sh"),
    Path("bin/install-skills.sh"),
    Path("README.md"),
    Path("CONTRIBUTING.md"),
    Path("AGENTS.md"),
    Path("docs/DEVELOPMENT_WORKFLOW.md"),
    Path("docs/WORKFLOW.md"),
    Path("docs/architecture/ARCHITECTURE.md"),
    Path("docs/ci/CI_PIPELINE.md"),
    Path("docs/notes/agent-knowledge-system-design.md"),
    Path("mcp/ground-control/README.md"),
    Path("mcp/citation/citation_mcp/http.py"),
)


def run_repo_identity_drift(root: Path = REPO_ROOT) -> list[Violation]:
    """Assert every inventoried active surface names the canonical repo identity.

    Three matchers run per line: a canonical-name URL/slug matcher (owner drift
    on `<owner>/Ground-Control` references), a `github_repo`/`GH_REPO` assignment
    matcher (the full `owner/repo` is validated, so a wrong repo NAME fails too),
    and a stale-owner literal matcher (bare prior-owner tokens such as a UI
    placeholder). A drifted reference in any inventoried config/workflow/script/
    doc/deploy artifact is the stale identity that routed defaulted operations at
    an inaccessible repository (#1383). Absent inventory files are skipped.
    """
    offenders: list[str] = []
    scanned = 0
    for rel_path in REPO_IDENTITY_INVENTORY:
        file_path = root / rel_path
        if not file_path.exists():
            continue
        scanned += 1
        text = file_path.read_text(encoding="utf-8")
        for line_number, line in enumerate(text.splitlines(), start=1):
            findings: list[tuple[str, str]] = []
            for pattern in (_REPO_IDENTITY_URL_RE, _REPO_IDENTITY_SLUG_RE):
                for match in pattern.finditer(line):
                    owner = match.group(1)
                    if owner != CANONICAL_REPO_OWNER:
                        findings.append(
                            (f"{owner}/Ground-Control", "non-canonical repository owner")
                        )
            if rel_path.as_posix() in _REPO_IDENTITY_CONFIG_FILES:
                for match in _REPO_IDENTITY_ASSIGN_RE.finditer(line):
                    slug = match.group(1)
                    if slug.lower() != CANONICAL_REPO_SLUG.lower():
                        findings.append((slug, "non-canonical repository identity"))
            for match in _STALE_OWNER_RE.finditer(line):
                findings.append((match.group(1), "stale repository owner literal"))
            seen: set[tuple[str, str]] = set()
            for token, why in findings:
                if (token, why) in seen:
                    continue
                seen.add((token, why))
                offenders.append(
                    f"{rel_path.as_posix()}:{line_number} {why}: '{token}' "
                    f"(expected '{CANONICAL_REPO_SLUG}')"
                )
    guard = require_scanned("repo-identity inventory", scanned)
    if guard:
        return guard

    if not offenders:
        return []
    return [
        Violation(
            code="repo-identity-drift",
            message=(
                "Active repository-identity surfaces must name the single "
                f"canonical '{CANONICAL_REPO_SLUG}' (GC-P026 / #1383). "
                "Historical ADR/changelog references and test fixtures are "
                "exempt (not inventoried)."
            ),
            details=offenders,
        )
    ]
