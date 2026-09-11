"""The branch-protection declaration both halves of the merge gate read.

`.github/branch-protection-baseline.json` says what the protected branches are
supposed to enforce. Two checks consume that declaration, and they are deliberately
separate: `tools/policy/ci_strictness.py` compares it against the workflow files
offline in `make policy`, and `tools/ci/check_branch_protection.py` compares it
against the protection GitHub actually enforces, which needs repository
administration permission no CI token here holds (GC-P030, GC-P031, ADR-091).

The declaration lives in its own module because both of those consumers need it and
neither owns it, and the loader here returns a *validated* projection rather than
raw JSON. A loader that only parsed would leave each consumer to interpret the
declaration's types for itself, and they would diverge: Python equality treats JSON
`1` as `True` and `0` as `False`, so an unvalidated `strict: 1` compares equal to a
declared `true` and the live gate reports a clean match for a malformed value.
Validation belongs with the declaration, once.

Every mapping level is closed. A declared key nothing compares is decoration, and a
declaration that grows a leaf no consumer reads is how an intended protection stops
being enforced without anything failing.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

from .core import REPO_ROOT

BRANCH_PROTECTION_BASELINE_PATH = Path(".github/branch-protection-baseline.json")


CI_STRICTNESS_BRANCHES = ("main", "dev")


# The required status checks recorded in .github/branch-protection-baseline.json.
# Every entry must be produced by a job in .github/workflows/ or by a hosted app:
# `policy` (ci.yml), `sonar` (sonarcloud.yml), `trivy` and `osv-scanner`
# (security.yml), plus the two app-posted contexts. A context with no producer
# behind it blocks every pull request forever, which is why the pre-#1500
# `build` / `frontend` / `integration` / `test` / `verify` entries were dropped
# with the jobs that produced them (issue #650).
CI_STRICTNESS_REQUIRED_CONTEXTS = frozenset(
    {
        "GitGuardian Security Checks",
        "SonarCloud Code Analysis",
        "osv-scanner",
        "policy",
        "sonar",
        "trivy",
    }
)


# The GitHub App permitted to satisfy each required context. Branch protection can
# bind a required check to one App id, and without that binding any actor able to
# publish a commit status or check run can post a green `policy` on its own commit
# and satisfy the gate without the workflow ever running. A required context name is
# therefore not a sufficient declaration; the producer is part of the contract.
# 15368 is GitHub Actions, 12526 SonarCloud, 46505 GitGuardian.
CI_STRICTNESS_CONTEXT_PROVIDERS = {
    "GitGuardian Security Checks": 46505,
    "SonarCloud Code Analysis": 12526,
    "osv-scanner": 15368,
    "policy": 15368,
    "sonar": 15368,
    "trivy": 15368,
}


CI_STRICTNESS_BASELINE_ROOT_FIELDS = frozenset({"branches"})


CI_STRICTNESS_PROTECTION_FIELDS = frozenset(
    {
        "admin_bypass_allowed",
        "changes_land_via_pull_request",
        "conversation_resolution_required",
        "deletions_allowed",
        "force_pushes_allowed",
        "required_status_checks",
        "review_policy",
    }
)


# The leaves of `required_status_checks`. Governed explicitly because the top-level
# field set cannot see inside it: adding `required_status_checks.provider_binding`
# leaves the branch's top-level keys unchanged, and both gates would read only
# `strict` and `contexts` while the new declaration sat there enforced by nothing.
CI_STRICTNESS_STATUS_CHECK_FIELDS = frozenset({"strict", "contexts"})


# The leaves of `review_policy`. `require_last_push_approval` and
# `require_code_owner_reviews` are in scope because their absence is what a review
# gate silently loses. `bypass_pull_request_allowances` is in scope because an actor
# listed there can land changes without the pull-request boundary that
# `changes_land_via_pull_request` is supposed to attest, while every scalar leaf
# still compares clean. Restrictions, signatures, linear history, branch locking,
# and fork syncing are deliberately outside this policy (ADR-091 amendment).
CI_STRICTNESS_REVIEW_POLICY_FIELDS = frozenset(
    {
        "bypass_pull_request_allowances",
        "dismiss_stale_reviews",
        "require_code_owner_reviews",
        "require_last_push_approval",
        "required_approving_review_count",
    }
)


# The principal collections inside `bypass_pull_request_allowances`. GitHub omits
# the whole mapping when nothing is allowed, so an absent mapping reads as all three
# collections empty — the only default that is safe to assume, because assuming the
# opposite would report drift on every correctly-configured branch.
CI_STRICTNESS_BYPASS_PRINCIPAL_FIELDS = frozenset({"apps", "teams", "users"})


# Declared scalar types, enforced before any comparison. `int` excludes `bool`
# because bool subclasses int, so a declared or reported `true` would otherwise pass
# as a review count.
CI_STRICTNESS_SCALAR_TYPES = {
    "admin_bypass_allowed": bool,
    "changes_land_via_pull_request": bool,
    "conversation_resolution_required": bool,
    "deletions_allowed": bool,
    "force_pushes_allowed": bool,
    "strict": bool,
    "bypass_pull_request_allowances": dict,
    "dismiss_stale_reviews": bool,
    "require_code_owner_reviews": bool,
    "require_last_push_approval": bool,
    "required_approving_review_count": int,
}


class BranchProtectionBaselineError(Exception):
    """The declaration is not usable as written.

    Carries every reason rather than the first, so a caller can report the whole
    set of schema failures instead of one at a time.
    """

    def __init__(self, details: list[str]) -> None:
        """Record every reason the declaration is unusable, not just the first."""
        super().__init__("; ".join(details))
        self.details = details


def is_declared_type(value: object, expected: type[object]) -> bool:
    """Whether `value` matches its declared type, refusing bool-as-int.

    Used for declared and live values alike, which is the point: the two sides must
    be judged by one notion of "a boolean" so `1` can never compare equal to `True`.
    """
    if expected is int:
        return isinstance(value, int) and not isinstance(value, bool)
    return isinstance(value, expected)


def _exact_keys(
    label: str, mapping: dict[str, object], governed: frozenset[str]
) -> list[str]:
    """Why one mapping level's key set is not exactly the governed set."""
    names = set(mapping)
    return [f"{label}: missing '{name}'" for name in sorted(governed - names)] + [
        f"{label}: '{name}' is declared but nothing compares it"
        for name in sorted(names - governed)
    ]


def _scalar_details(
    label: str, mapping: dict[str, object], governed: frozenset[str]
) -> list[str]:
    """Which of one mapping level's governed scalars are not their declared type."""
    return [
        f"{label}.{name} is not the declared {CI_STRICTNESS_SCALAR_TYPES[name].__name__}"
        for name in sorted(governed)
        if name in mapping
        and name in CI_STRICTNESS_SCALAR_TYPES
        and not is_declared_type(mapping[name], CI_STRICTNESS_SCALAR_TYPES[name])
    ]


def _context_details(label: str, declared: object) -> list[str]:
    """Why a declared context collection is not usable.

    Validated rather than coerced: `set(str(name) for name in ...)` turns a declared
    `123` into the context `"123"`, `or []` turns a malformed mapping into "nothing
    declared", and `set()` over an unhashable entry raises instead of reporting.
    """
    if not isinstance(declared, list):
        return [f"{label}.contexts is not a list"]
    details = [
        f"{label}.contexts entry {entry!r} is not a string"
        for entry in declared
        if not isinstance(entry, str)
    ]
    strings = [entry for entry in declared if isinstance(entry, str)]
    if len(set(strings)) != len(strings):
        details.append(f"{label}.contexts has duplicate entries")
    return details


def _bypass_details(label: str, declared: object) -> list[str]:
    """Why a declared bypass-allowance mapping is not usable."""
    if not isinstance(declared, dict):
        return [f"{label} is not a mapping"]
    details = _exact_keys(label, declared, CI_STRICTNESS_BYPASS_PRINCIPAL_FIELDS)
    for name in sorted(CI_STRICTNESS_BYPASS_PRINCIPAL_FIELDS & set(declared)):
        principals = declared[name]
        if not isinstance(principals, list) or not all(
            isinstance(entry, str) for entry in principals
        ):
            details.append(f"{label}.{name} is not a list of identities")
    return details


def _status_check_leaves(label: str, checks: dict[str, object]) -> list[str]:
    """The collection nested inside `required_status_checks`."""
    if "contexts" not in checks:
        return []
    return _context_details(label, checks["contexts"])


def _review_policy_leaves(label: str, review: dict[str, object]) -> list[str]:
    """The principal collections nested inside `review_policy`."""
    key = "bypass_pull_request_allowances"
    if key not in review:
        return []
    return _bypass_details(f"{label}.{key}", review[key])


def _nested_details(
    label: str,
    config: dict[str, object],
    key: str,
    governed: frozenset[str],
    leaves: Callable[[str, dict[str, object]], list[str]],
) -> list[str]:
    """Schema failures in one nested mapping level the branch declares.

    Both nested levels are validated the same way — exact keys, declared scalar
    types, then whatever collection lives one level deeper — so they share this
    shape rather than each growing its own branch in `_branch_details`.
    """
    if key not in config:
        return []
    nested = config[key]
    if not isinstance(nested, dict):
        return [f"{label}.{key} is not a mapping"]
    nested_label = f"{label}.{key}"
    details = _exact_keys(nested_label, nested, governed)
    details += _scalar_details(nested_label, nested, governed)
    return details + leaves(nested_label, nested)


def _branch_details(branch: str, config: object) -> list[str]:
    """Every schema failure in one branch's declaration, innermost level included."""
    label = f"branches.{branch}"
    if not isinstance(config, dict):
        return [f"{label} is not a mapping"]
    details = _exact_keys(label, config, CI_STRICTNESS_PROTECTION_FIELDS)
    details += _scalar_details(label, config, CI_STRICTNESS_PROTECTION_FIELDS)
    details += _nested_details(
        label,
        config,
        "required_status_checks",
        CI_STRICTNESS_STATUS_CHECK_FIELDS,
        _status_check_leaves,
    )
    details += _nested_details(
        label,
        config,
        "review_policy",
        CI_STRICTNESS_REVIEW_POLICY_FIELDS,
        _review_policy_leaves,
    )
    return details


def validate_baseline(baseline: object) -> list[str]:
    """Every reason the parsed declaration is not usable, innermost level included."""
    if not isinstance(baseline, dict):
        return ["the baseline is not a mapping"]
    details = _exact_keys("the baseline", baseline, CI_STRICTNESS_BASELINE_ROOT_FIELDS)
    branches = baseline.get("branches")
    if not isinstance(branches, dict):
        return details + ["branches is not a mapping"]
    details += _exact_keys("branches", branches, frozenset(CI_STRICTNESS_BRANCHES))
    for branch in sorted(set(branches) & set(CI_STRICTNESS_BRANCHES)):
        details += _branch_details(branch, branches[branch])
    return details


def load_branch_protection_baseline(root: Path = REPO_ROOT) -> dict[str, object]:
    """The validated declaration, or `BranchProtectionBaselineError` naming every fault.

    Raises rather than returning a default: a loader that returned `{}` would turn
    "could not read the contract" into "the contract requires nothing", and one that
    returned unvalidated JSON would let a consumer compare a malformed value and
    call the result clean.
    """
    try:
        baseline = json.loads(
            (root / BRANCH_PROTECTION_BASELINE_PATH).read_text(encoding="utf-8")
        )
    except json.JSONDecodeError as error:
        raise BranchProtectionBaselineError([f"not valid JSON: {error}"]) from error
    details = validate_baseline(baseline)
    if details:
        raise BranchProtectionBaselineError(details)
    return baseline
