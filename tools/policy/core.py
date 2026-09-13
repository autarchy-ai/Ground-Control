"""Policy checks: core.

Extracted from tools/policy/checks.py (issue #1355), which had reached 5,679 lines against
the repo's 500-LOC limit. checks.py remains the entry point and re-exports this module, so
every existing import path and the CLI keep working.
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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[2]


ADR_POLICY_PATH = REPO_ROOT / "architecture" / "policies" / "adr-policy.json"




CODEOWNERS_PATH = Path(".github/CODEOWNERS")


CI_WORKFLOW_PATH = Path(".github/workflows/ci.yml")


PRE_COMMIT_CONFIG_PATH = Path(".pre-commit-config.yaml")


SONAR_NEW_ISSUE_GATE_PATH = Path("tools/sonar/assert_no_new_issues.py")


MODULE_GRAPH_LOCK_LEVELS = frozenset({"locked", "guarded", "fluid"})


MODULE_GRAPH_SURFACES = frozenset({"backend", "frontend", "mcp"})


# Surfaces enforced by the in-process import scanner below. The backend surface
# is enforced against the same registry by RegistryBoundaryArchitectureTest
# (ArchUnit reads compiled bytecode, which a source import scan cannot match).
MODULE_GRAPH_SCANNED_SURFACES = frozenset({"frontend", "mcp"})


MODULE_GRAPH_MODULE_KEYS = frozenset(
    {"id", "name", "surface", "owner", "lock_level", "risk_score", "selectors", "package", "projection"}
)


MODULE_GRAPH_REQUIRED_MODULE_KEYS = frozenset(
    {"id", "name", "surface", "owner", "lock_level", "risk_score", "selectors"}
)


MODULE_GRAPH_EDGE_KEYS = frozenset({"from", "to"})


MODULE_GRAPH_MAX_RISK_SCORE = 5


MODULE_GRAPH_SCAN_GLOBS = (
    "frontend/src/**/*.ts",
    "frontend/src/**/*.tsx",
    "frontend/src/**/*.js",
    "frontend/src/**/*.jsx",
    "mcp/ground-control/*.js",
)


# ESM/TS import specifier after `from`, bare `import`, dynamic `import(`, or `require(`.
MODULE_GRAPH_IMPORT_RE = re.compile(
    r"""(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]"""
)


DESIGN_AUTHORITY_APPROVAL_SCHEMA_VERSION = "gc.cld.design-authority-approval/v1"


DESIGN_AUTHORITY_APPROVAL_MARKER_PREFIX = "<!-- gc:design-authority-approval"


DESIGN_AUTHORITY_APPROVAL_MARKER_RE = re.compile(
    r"<!--\s*gc:design-authority-approval\s+([^>]*)-->", re.IGNORECASE
)


DESIGN_AUTHORITY_APPROVAL_DATA_RE = re.compile(
    r"<!--\s*gc:design-authority-approval-data\s+({.*?})\s*-->",
    re.IGNORECASE | re.DOTALL,
)


HTML_ATTR_RE = re.compile(r"([a-zA-Z_][a-zA-Z0-9_-]*)=\"([^\"]*)\"")


IMPLEMENTATION_PATH_SELECTORS = (
    "backend/src/main/**",
    "backend/src/test/**",
    "frontend/src/**",
    "mcp/**",
    "tools/**",
)


SKIPPED_TEST_ADDITION_RE = re.compile(
    r"^\+(?!\+\+).*(?:@Disabled\b|\.skip\s*\(|\b(?:describe|it|test)\.skip\s*\(|\b(?:xdescribe|xit|xtest)\s*\(|@pytest\.mark\.skip\b)",
    re.IGNORECASE,
)


CONTROLLER_PATH_RE = re.compile(
    r"^backend/src/main/java/com/keplerops/groundcontrol/api/.+Controller\.java$"
)


MIGRATION_PATH_RE = re.compile(r"^backend/src/main/resources/db/migration/V\d+__.+\.sql$")


# Requirement-UID identity corpus. Mirrors
# mcp/ground-control/lib.js::EXACT_REQUIREMENT_UID_RE verbatim — the two must
# stay in sync so the JavaScript renderer and this Python gate accept the same
# set. A stored UID is project-local identity within the backend's
# 50-character bound, not a client-side grammar, so `APP-2` (what
# RequirementUidAllocator mints for a prefix's second requirement) is as valid
# as `GC-O007` (issue #1425). Existence is the Ground Control lookup's call.
EXACT_REQUIREMENT_UID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$")


# The explicit requirement-free marker the PR-body renderer emits in place of a
# UID list: `- (none — ...)`.
REQUIREMENT_FREE_MARKER_RE = re.compile(r"-\s*\(none\b", re.IGNORECASE)


def extract_requirement_uids_section(body: str) -> str:
    """Return the lines between `## Requirement UIDs` and the next `## ` header."""
    marker = "## Requirement UIDs"
    start = body.find(marker)
    if start == -1:
        return ""
    after = body[start + len(marker) :]
    next_header = re.search(r"\n## ", after)
    return after[: next_header.start()] if next_header else after


def extract_requirement_uid_tokens(body: str) -> list[str]:
    """Parse the `## Requirement UIDs` section structurally and return its UIDs.

    Mirrors ``extractRequirementUidTokensFromSection`` in
    ``mcp/ground-control/lib.js``. The section is machine-rendered one UID per
    bullet, so position carries the meaning and each token is held to the
    identity corpus rather than a narrower search grammar. Scoping to the
    section is what stops an ``ADR-036`` reference elsewhere in the body from
    satisfying the requirement-UID gate by accident.
    """
    tokens: list[str] = []
    for line in extract_requirement_uids_section(body).splitlines():
        bullet = re.match(r"^\s*[-*+]\s+(.+?)\s*$", line)
        if not bullet:
            continue
        text = bullet.group(1)
        if re.match(r"^\(none\b", text, re.IGNORECASE):
            continue
        # The WHOLE bullet must be a single token in the corpus. Scanning for
        # any corpus-shaped word would count ordinary prose -- ``- (no real UID
        # here)`` contains ``no``, a syntactically valid identifier -- because
        # the corpus cannot tell a UID from a word without a lookup.
        candidate = text.strip("`").strip()
        if not EXACT_REQUIREMENT_UID_RE.match(candidate):
            continue
        if candidate not in tokens:
            tokens.append(candidate)
    return tokens


GROUND_CONTROL_YAML_PATH = Path(".ground-control.yaml")


DEFERRAL_CASES_PATH = Path(__file__).resolve().parent / "deferral_cases.json"


# Surfaces where Tier 2 (the softer signals) is enforced in addition to Tier 1.
_DEFERRAL_TIER2_SURFACES: frozenset[str] = frozenset({"issue-close", "issue-comment"})


_DEFERRAL_TIER1_PATTERNS: tuple[tuple[str, str], ...] = (
    (
        "defer-to-followup",
        r"\bdefer(?:red|s|ring|ral)?\b[^.\n]{0,40}?\b(?:to|until|for|into)\b[^.\n]{0,25}?"
        r"\b(?:follow[-\s]?up|subsequent|later|future|next|another)\b",
    ),
    (
        "in-subsequent-unit",
        r"\b(?:in|to|as)\s+(?:a\s+|the\s+|another\s+)?(?:subsequent|follow[-\s]?up)\s+"
        r"(?:PR|pull\s+request|issue|ticket|commit|iteration|sprint|cycle|change)\b",
    ),
    (
        "addressed-in-followup",
        r"\b(?:will|to|shall|can)\s+be\s+(?:addressed|handled|done|fixed|implemented|resolved|filed|tracked)\s+"
        r"(?:in|by|as)\s+(?:a\s+|the\s+|another\s+)?(?:follow[-\s]?up|subsequent|later|future|next)\b",
    ),
    (
        "fix-in-followup",
        r"\b(?:address|handle|fix|implement|resolve)(?:ed|d)?\s+(?:this\s+|that\s+|it\s+|them\s+|the\s+rest\s+)?"
        r"(?:in|as)\s+(?:a\s+|the\s+|another\s+)?(?:follow[-\s]?up|subsequent)\s+"
        r"(?:PR|pull\s+request|issue|ticket|commit|change)\b",
    ),
    (
        "nonaction-because-provenance",
        r"\b(?:not|won'?t|will\s+not|cannot|can'?t|skip(?:ping)?)\s+"
        r"(?:be\s+)?(?:fix|fixing|address|addressing|repair|repairing|resolve|resolving|handle|handling)\b"
        r"[^.\n]{0,80}\b(?:because|since|as)\b[^.\n]{0,60}"
        r"\b(?:pre-existing|unrelated|outside\s+(?:this\s+)?(?:PR'?s?\s+)?scope|out\s+of\s+scope|owned\s+by)\b",
    ),
    (
        "provenance-used-for-nonaction",
        r"\b(?:pre-existing|unrelated|outside\s+(?:this\s+)?(?:PR'?s?\s+)?scope|out\s+of\s+scope|owned\s+by[^,.;\n]{0,40})\b"
        r"[^.\n]{0,80}(?:\b(?:so|therefore|means)\b|[;:])[^.\n]{0,60}"
        r"\b(?:not|won'?t|will\s+not|skip(?:ping)?|left\s+unresolved|leave\s+unresolved)\b",
    ),
)


_DEFERRAL_TIER2_PATTERNS: tuple[tuple[str, str], ...] = (
    ("tbd-postponement", r"\bTBD\b\s*(?:[.;:,)\]]|$|\b(?:later|in\b|for\b|—|-))"),
    (
        "to-be-done-later",
        r"\bto\s+be\s+(?:done|addressed|filed|tracked|handled|fixed)\s+(?:later|separately|in\s+a\b|elsewhere)\b",
    ),
)


# Bare "defer*" word, Tier 2, applied with a negation guard on the preceding
# window and an exemption for the historical "deferred from #N" framing.
_DEFERRAL_BARE_WORD_RE = re.compile(r"\bdefer(?:red|s|ring|ral)?\b", re.IGNORECASE)


_DEFERRAL_NEGATION_BEFORE_RE = re.compile(
    r"\b(?:do\s+not|don'?t|never|no|not|should\s+not|shall\s+not|cannot|can'?t|without|avoid|stop)\b"
    r"(?:\W+\w+){0,3}\W*$",
    re.IGNORECASE,
)


_DEFERRAL_BARE_WORD_HISTORICAL_AFTER_RE = re.compile(r"^\W*from\b", re.IGNORECASE)


_DEFERRAL_TIER1_RES = tuple(
    (name, re.compile(pat, re.IGNORECASE | re.DOTALL)) for name, pat in _DEFERRAL_TIER1_PATTERNS
)


_DEFERRAL_TIER2_RES = tuple(
    (name, re.compile(pat, re.IGNORECASE)) for name, pat in _DEFERRAL_TIER2_PATTERNS
)


def classify_deferral_language(text: str, surface: str) -> tuple[str, str | None]:
    """Classify body/comment text for deferral-disposition language.

    Returns ``("deny", "<tier>:<pattern-name>")`` when the text contains
    forbidden deferral language for the given ``surface``, or ``("allow", None)``
    otherwise. ``surface`` is one of ``issue-create``, ``issue-edit``,
    ``issue-close``, ``issue-comment``, ``pr-create``, ``pr-edit``,
    ``pr-comment``, ``pr-body``.

    Tier 1 patterns deny on every surface; Tier 2 patterns deny only on the
    surfaces in :data:`_DEFERRAL_TIER2_SURFACES` (closing/commenting on the
    issue under implementation).
    """
    if not text:
        return ("allow", None)
    for name, rx in _DEFERRAL_TIER1_RES:
        if rx.search(text):
            return ("deny", f"tier1:{name}")
    if surface in _DEFERRAL_TIER2_SURFACES:
        for name, rx in _DEFERRAL_TIER2_RES:
            if rx.search(text):
                return ("deny", f"tier2:{name}")
        for match in _DEFERRAL_BARE_WORD_RE.finditer(text):
            before = text[max(0, match.start() - 32) : match.start()]
            if _DEFERRAL_NEGATION_BEFORE_RE.search(before):
                continue
            after = text[match.end() : match.end() + 12]
            if _DEFERRAL_BARE_WORD_HISTORICAL_AFTER_RE.match(after):
                continue
            return ("deny", "tier2:bare-defer")
    return ("allow", None)


_DEFERRAL_DENIAL_GUIDANCE = (
    "Deferral is not a valid disposition (ADR-029). Every reviewer finding must "
    "be one of: (a) fixed now in the same diff; (b) recorded `wontfix` with "
    "explicit user authorization quoted; or (c) recorded `not-applicable` with a "
    "rationale. 'Defer to a follow-up PR / issue / later iteration' is not in the "
    "contract — filing a tracking issue does not make it one. Re-route to fix-now "
    "or escalate to the user on the issue thread for authorization."
)


def run_no_deferral_disposition_check(
    *, pr_body: str | None = None, root: Path = REPO_ROOT
) -> list[Violation]:
    """Flag deferral-disposition language in the PR body at completion gate.

    This is the completion-gate layer over ADR-029's contract; the PreToolUse
    hook at ``.claude/hooks/block-defer-language.py`` is the tool-call-time
    layer. The PR body is treated as a ``pr-body`` surface — Tier 1 deferral
    phrases are flagged; the ``## Out of scope`` section heading and
    sibling-PR references are not (Tier 2 is not applied to ``pr-body``).
    Text scanning cannot prove a *silently dropped* finding — that remains the
    province of the issue-thread findings-vs-decisions record (ADR-029); this
    check only catches deferral language that was actually written.

    ``root`` is accepted for signature symmetry with the other ``run_*`` checks
    and is unused here.
    """
    del root  # signature symmetry; this check operates purely on the PR body text
    if pr_body is None:
        return []
    decision, pattern = classify_deferral_language(pr_body, "pr-body")
    if decision == "deny":
        return [
            Violation(
                code="pr-body-deferral-disposition",
                message="PR body contains deferral-disposition language (ADR-029 / #830).",
                details=[
                    f"matched pattern: {pattern}",
                    _DEFERRAL_DENIAL_GUIDANCE,
                ],
            )
        ]
    return []


DEPLOY_COMPOSE_PROD_PATH = Path("deploy/docker/docker-compose.prod.yml")


REQUIRED_ADR026_CREDENTIAL_SLOT_COUNT = 5


REQUIRED_ADR026_ALLOWLIST_SLOT_COUNT = 5


def _required_adr026_backend_env_keys() -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Return the (always-set, inherit-only) ADR-026 keys.

    Always-set keys are typed config (security toggles); list or map form is
    fine for them because their defaults are guaranteed non-empty. Inherit-only
    keys are the optional indexed credential / allowlist slots — those MUST
    use bare list form (``- KEY`` with no ``=``) so unset host variables
    are NOT injected as empty strings (Spring's
    ``SecurityProperties.validate()`` rejects blank principal/token/role/CIDR
    entries and the container fails startup).
    """
    always_set: list[str] = ["GC_SECURITY_ENABLED", "GC_SECURITY_OPENAPI_PUBLIC"]
    inherit_only: list[str] = []
    for index in range(REQUIRED_ADR026_CREDENTIAL_SLOT_COUNT):
        inherit_only.append(f"GROUNDCONTROL_SECURITY_CREDENTIALS_{index}_PRINCIPAL_NAME")
        inherit_only.append(f"GROUNDCONTROL_SECURITY_CREDENTIALS_{index}_TOKEN")
        inherit_only.append(f"GROUNDCONTROL_SECURITY_CREDENTIALS_{index}_ROLE")
    for index in range(REQUIRED_ADR026_ALLOWLIST_SLOT_COUNT):
        inherit_only.append(f"GROUNDCONTROL_SECURITY_IP_ALLOWLIST_{index}")
    return tuple(always_set), tuple(inherit_only)


(
    REQUIRED_ADR026_ALWAYS_SET_KEYS,
    REQUIRED_ADR026_INHERIT_ONLY_KEYS,
) = _required_adr026_backend_env_keys()


REQUIRED_ADR026_BACKEND_ENV_KEYS: tuple[str, ...] = (
    *REQUIRED_ADR026_ALWAYS_SET_KEYS,
    *REQUIRED_ADR026_INHERIT_ONLY_KEYS,
)


COMPOSE_ENV_KEY_RE = re.compile(r"^\s*-\s*([A-Z][A-Z0-9_]*)(?:=.*)?\s*$|^\s*([A-Z][A-Z0-9_]*)\s*:.*$")


COMPOSE_ENV_INHERIT_FORM_RE = re.compile(r"^\s*-\s*([A-Z][A-Z0-9_]*)\s*$")


@dataclass
class Violation:
    code: str
    message: str
    # Defaults to empty: most violations carry no detail lines, and a required field here
    # made every such call site raise TypeError at the moment it tried to report a
    # violation, turning a clean policy failure into a crash.
    details: list[str] = field(default_factory=list)

    def render(self) -> str:
        if not self.details:
            return f"[{self.code}] {self.message}"
        formatted = "\n".join(f"  - {detail}" for detail in self.details)
        return f"[{self.code}] {self.message}\n{formatted}"


def normalize_path(path: str) -> str:
    return Path(path).as_posix().lstrip("./")


def require_scanned(label: str, scanned: int, code: str = "scan-resolved-nothing") -> list[Violation]:
    """A scan that resolved zero sources must fail, not report clean.

    "Scanned everything and found nothing wrong" and "never looked" are different facts that a
    check reports identically unless it proves it looked. Every instance of this in issue #1355
    was a gate reporting green because its subject had moved: an inventory can be renamed, a glob
    can stop matching, and the resulting empty scan reads as a pass.

    This does not assert that any particular file exists — checks that deliberately skip absent
    inventory entries keep doing so. It asserts only that the scan as a whole resolved something.
    """
    if scanned > 0:
        return []
    return [
        Violation(
            code=code,
            message=f"{label} resolved no sources to scan, so its result is not evidence of anything.",
            details=["A check that scans nothing must fail rather than report clean."],
        )
    ]
