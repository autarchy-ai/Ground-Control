"""Read facts out of GitHub's branch-protection response (GC-P031).

One job: turn a live protection document into the values the baseline declares.
`branch_protection_compare.py` decides what the differences mean; nothing here
compares anything or performs IO.

Nothing is coerced. An absent `{"enabled": ...}` wrapper reads as MISSING rather
than `false`, because "GitHub did not report this" is not "GitHub reported it off",
and a malformed collection resolves to a named failure rather than to a set that
happens to compare equal to something.
"""

from __future__ import annotations

from collections.abc import Callable

# Sentinel for "live protection did not report this field", distinct from any value
# it could report. A default would make an unreported field compare equal to one
# GitHub actually set.
MISSING = object()


PROTECTION_TOGGLE_SECTIONS = {
    "admin_bypass_allowed": ("enforce_admins", True),
    "conversation_resolution_required": ("required_conversation_resolution", False),
    "deletions_allowed": ("allow_deletions", False),
    "force_pushes_allowed": ("allow_force_pushes", False),
}


def _toggle(section: str, *, negated: bool = False) -> Callable[[dict[str, object]], object]:
    """Build a reader for a `{"enabled": bool}` subsection, optionally inverting it.

    An absent or non-boolean wrapper reads as MISSING rather than as `false`:
    "GitHub did not report this" is not "GitHub reported it off".
    """

    def read(live: dict[str, object]) -> object:
        """This section's value as the baseline records it, or MISSING."""
        subsection = live.get(section)
        if not isinstance(subsection, dict) or not isinstance(subsection.get("enabled"), bool):
            return MISSING
        return (not subsection["enabled"]) if negated else subsection["enabled"]

    return read


def _pull_request_required(live: dict[str, object]) -> object:
    """Whether changes must land through a pull request.

    Classic branch protection expresses this as the presence of the
    `required_pull_request_reviews` document; there is no separate boolean.
    """
    return isinstance(live.get("required_pull_request_reviews"), dict)


def _required_status_checks(live: dict[str, object]) -> object:
    """Live protection's required-status-checks document, or MISSING."""
    checks = live.get("required_status_checks")
    return checks if isinstance(checks, dict) else MISSING


def _review_policy(live: dict[str, object]) -> object:
    """Live protection's pull-request-review document, or MISSING."""
    reviews = live.get("required_pull_request_reviews")
    return reviews if isinstance(reviews, dict) else MISSING


# Baseline field -> how to read the same fact out of GitHub's protection document.
# A reader returning MISSING means live protection did not report the field, which
# is drift rather than a match against a default.
PROTECTION_FIELD_READERS = {
    **{
        field: _toggle(section, negated=negated)
        for field, (section, negated) in PROTECTION_TOGGLE_SECTIONS.items()
    },
    "changes_land_via_pull_request": _pull_request_required,
    "required_status_checks": _required_status_checks,
    "review_policy": _review_policy,
}


def _legacy_context_names(entries: object) -> set[str] | None:
    """The names in the deprecated flat `contexts` array, or None when malformed.

    Returning None rather than coercing is the point: `{str(name) for name in ...}`
    would turn a reported `123` into the context `"123"` and compare it against the
    declaration as though GitHub had said so.
    """
    if not isinstance(entries, list):
        return None
    if not all(isinstance(entry, str) for entry in entries):
        return None
    return set(entries)


def _check_bindings(entries: object) -> tuple[dict[str, object] | None, str | None]:
    """Each required check's context name mapped to the App id bound to it.

    The binding is part of the contract, not decoration: branch protection can
    restrict a required check to one App, and without that restriction any actor
    able to publish a commit status or check run can post a green `policy` on its own
    commit and satisfy the gate without the workflow running. A context named twice
    with different bindings leaves the real requirement undetermined.
    """
    if not isinstance(entries, list):
        return None, "live_contexts_malformed"
    bindings: dict[str, object] = {}
    failure: str | None = None
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("context"), str):
            failure = "live_contexts_malformed"
            break
        name = entry["context"]
        app_id = entry.get("app_id")
        if name in bindings and bindings[name] != app_id:
            failure = "live_contexts_inconsistent"
            break
        bindings[name] = app_id
    return (None, failure) if failure else (bindings, None)


def live_required_checks(
    checks: dict[str, object],
) -> tuple[dict[str, object] | None, str | None]:
    """The live required checks as context -> bound App id, or why they are not determinable.

    GitHub reports the required set both as the legacy flat `contexts` array and as
    `checks`, and is deprecating the former. Trusting one and ignoring the other
    would accept a response whose two views disagree, so when both are present they
    must agree on the names. The `checks` array is required, because it is the only
    view that carries the provider binding: without it the binding cannot be
    verified, which is not the same as a binding that is correct.
    """
    if "checks" not in checks:
        return None, "live_check_providers_unavailable"
    bindings, failure = _check_bindings(checks.get("checks"))
    if failure is None and "contexts" in checks:
        legacy = _legacy_context_names(checks.get("contexts"))
        if legacy is None:
            failure = "live_contexts_malformed"
        elif legacy != set(bindings or {}):
            failure = "live_contexts_inconsistent"
    return (None, failure) if failure else (bindings, None)
