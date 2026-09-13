"""Shared branch-protection fixtures for the GC-P031 contract tests.

The declaration and GitHub's protection response are both nested documents that
every test in this area has to build, and the two halves of the contract (the
comparison and the authorization-bearing bindings) are tested in separate modules.
Keeping the builders here means one definition of "a correctly configured branch",
so a test that overrides one field is visibly varying that field alone.
"""

from tools.ci.branch_protection_compare import compare_protection
from tools.policy.branch_protection_baseline import (
    CI_STRICTNESS_BRANCHES,
    CI_STRICTNESS_CONTEXT_PROVIDERS,
    CI_STRICTNESS_REQUIRED_CONTEXTS,
)

CONTEXTS = sorted(CI_STRICTNESS_REQUIRED_CONTEXTS)


def declared(**overrides):
    """One branch's baseline entry, matching the repository's real declaration."""
    entry = {
        "admin_bypass_allowed": True,
        "changes_land_via_pull_request": True,
        "conversation_resolution_required": False,
        "deletions_allowed": False,
        "force_pushes_allowed": False,
        "required_status_checks": {"strict": True, "contexts": list(CONTEXTS)},
        "review_policy": {
            "bypass_pull_request_allowances": {"apps": [], "teams": [], "users": []},
            "dismiss_stale_reviews": True,
            "require_code_owner_reviews": False,
            "require_last_push_approval": False,
            "required_approving_review_count": 0,
        },
    }
    entry.update(overrides)
    return entry


def baseline(**per_branch):
    branches = {branch: declared() for branch in CI_STRICTNESS_BRANCHES}
    for branch, overrides in per_branch.items():
        branches[branch] = declared(**overrides)
    return {"branches": branches}


def live_checks(names, strict=True, providers=None):
    """A live `required_status_checks` document for `names`, bound to their providers."""
    providers = providers or CI_STRICTNESS_CONTEXT_PROVIDERS
    return {
        "strict": strict,
        "contexts": list(names),
        "checks": [{"context": name, "app_id": providers.get(name)} for name in names],
    }


def live(**overrides):
    """One branch's live protection document, in GitHub's response shape.

    `bypass_pull_request_allowances` is deliberately absent, which is how GitHub
    reports a branch that allows nobody to bypass pull requests.
    """
    document = {
        "required_status_checks": live_checks(CONTEXTS),
        "required_pull_request_reviews": {
            "dismiss_stale_reviews": True,
            "require_code_owner_reviews": False,
            "require_last_push_approval": False,
            "required_approving_review_count": 0,
        },
        "enforce_admins": {"enabled": False},
        "required_conversation_resolution": {"enabled": False},
        "allow_force_pushes": {"enabled": False},
        "allow_deletions": {"enabled": False},
    }
    document.update(overrides)
    return document


def live_all(**per_branch):
    documents = {branch: live() for branch in CI_STRICTNESS_BRANCHES}
    for branch, overrides in per_branch.items():
        documents[branch] = live(**overrides)
    return documents


def report(baseline=None, live=None):
    """The comparison for one case, defaulting either side to the correct fixture.

    The parameters shadow the builders deliberately: a call reads as "this baseline
    against this live state", and the builders are reached through the aliases below.
    """
    return compare_protection(
        baseline if baseline is not None else _build_baseline(),
        live if live is not None else _build_live_all(),
        CI_STRICTNESS_BRANCHES,
    )


_build_baseline = baseline
_build_live_all = live_all


def drifted_fields(drifts):
    return {(drift.branch, drift.field) for drift in drifts}
