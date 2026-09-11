"""Compare a validated branch-protection declaration against live protection.

Pure functions over the branch-protection payload, so the whole comparison is
unit-tested without network access. `tools/ci/check_branch_protection.py` is the
GitHub adapter and CLI that feeds this module; nothing here performs IO.

Three outcomes, not two. "Matches", "differs", and "could not be determined" are
different facts, and a branch in the third state yields no drift claims at all:
naming a specific difference requires having read the thing being compared
(GC-P031, ADR-091).
"""

from __future__ import annotations

from dataclasses import dataclass, field as dataclass_field

from tools.policy.branch_protection_baseline import (
    BRANCH_PROTECTION_BASELINE_PATH,
    CI_STRICTNESS_BRANCHES,
    CI_STRICTNESS_BYPASS_PRINCIPAL_FIELDS,
    CI_STRICTNESS_CONTEXT_PROVIDERS,
    CI_STRICTNESS_PROTECTION_FIELDS,
    CI_STRICTNESS_REVIEW_POLICY_FIELDS,
    CI_STRICTNESS_SCALAR_TYPES,
    is_declared_type,
)

MISSING = object()


@dataclass(frozen=True)
class Drift:
    """One difference between the declared protection and the live protection."""

    branch: str
    field: str
    declared: object
    observed: object
    note: str | None = dataclass_field(default=None)

    def render(self) -> str:
        suffix = f" ({self.note})" if self.note else ""
        return (
            f"{self.branch}: {self.field} declared {self.declared!r}, "
            f"live {self.observed!r}{suffix}"
        )


@dataclass(frozen=True)
class Unevaluable:
    """One branch whose live protection could not be compared at all.

    `reason` is a stable key so a caller can branch on the kind of failure —
    unauthorized, unreachable, malformed, self-contradictory — without parsing
    prose. An unevaluable branch is never also reported as drift: claiming a
    specific difference requires having read the thing being compared.
    """

    branch: str
    reason: str
    detail: str

    def render(self) -> str:
        return f"{self.branch}: {self.reason} ({self.detail})"


@dataclass(frozen=True)
class ProtectionReport:
    drifts: tuple[Drift, ...]
    unevaluable: tuple[Unevaluable, ...]

    @property
    def exit_code(self) -> int:
        if self.unevaluable:
            return 2
        return 1 if self.drifts else 0


# Baseline field -> (live `{"enabled": bool}` section, whether its sense inverts).
# Declared as data rather than buried in closures so the tests can drive one drift
# case per entry: three of these sections report the same default value, so a reader
# bound to the wrong section would produce identical results on every fixture and be
# caught by nothing. `admin_bypass_allowed` is the one inverted entry, because
# administrators bypassing protection is the *absence* of enforcement and the
# baseline records the permission rather than the enforcement.
PROTECTION_TOGGLE_SECTIONS = {
    "admin_bypass_allowed": ("enforce_admins", True),
    "conversation_resolution_required": ("required_conversation_resolution", False),
    "deletions_allowed": ("allow_deletions", False),
    "force_pushes_allowed": ("allow_force_pushes", False),
}


def _toggle(section: str, *, negated: bool = False):
    """Read a `{"enabled": bool}` subsection, optionally inverting its sense.

    An absent or non-boolean wrapper reads as MISSING rather than as `false`:
    "GitHub did not report this" is not "GitHub reported it off".
    """

    def read(live: dict) -> object:
        subsection = live.get(section)
        if not isinstance(subsection, dict) or not isinstance(subsection.get("enabled"), bool):
            return MISSING
        return (not subsection["enabled"]) if negated else subsection["enabled"]

    return read


def _pull_request_required(live: dict) -> object:
    """Whether changes must land through a pull request.

    Classic branch protection expresses this as the presence of the
    `required_pull_request_reviews` document; there is no separate boolean.
    """
    return isinstance(live.get("required_pull_request_reviews"), dict)


def _required_status_checks(live: dict) -> object:
    checks = live.get("required_status_checks")
    return checks if isinstance(checks, dict) else MISSING


def _review_policy(live: dict) -> object:
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
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("context"), str):
            return None, "live_contexts_malformed"
        name = entry["context"]
        app_id = entry.get("app_id")
        if name in bindings and bindings[name] != app_id:
            return None, "live_contexts_inconsistent"
        bindings[name] = app_id
    return bindings, None


def live_required_checks(checks: dict) -> tuple[dict[str, object] | None, str | None]:
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
    if failure:
        return None, failure
    if "contexts" in checks:
        legacy = _legacy_context_names(checks.get("contexts"))
        if legacy is None:
            return None, "live_contexts_malformed"
        if legacy != set(bindings):
            return None, "live_contexts_inconsistent"
    return bindings, None


def _provider_drifts(branch: str, declared_contexts: set[str], bindings: dict) -> list:
    """Required contexts whose live App binding is absent or not the declared provider."""
    drifts = []
    for name in sorted(declared_contexts & set(bindings)):
        expected = CI_STRICTNESS_CONTEXT_PROVIDERS.get(name)
        observed = bindings[name]
        if expected is None or observed == expected:
            continue
        note = (
            "no App is bound, so any actor able to post this status satisfies the check"
            if observed is None
            else "a different App may satisfy this required check"
        )
        drifts.append(
            Drift(branch, f"required_status_checks.checks.{name}", expected, observed, note)
        )
    return drifts


def _status_check_drift(branch: str, declared: dict, live: dict) -> tuple[list, list]:
    """Strictness, the required-context set, and each context's provider binding."""
    drifts: list[Drift] = []
    declared_strict = declared["strict"]
    live_strict = live.get("strict")
    if not is_declared_type(live_strict, CI_STRICTNESS_SCALAR_TYPES["strict"]):
        return [], [
            Unevaluable(
                branch,
                "live_value_malformed",
                f"required_status_checks.strict is {live_strict!r}, not a boolean",
            )
        ]
    if declared_strict != live_strict:
        drifts.append(Drift(branch, "required_status_checks.strict", declared_strict, live_strict))

    bindings, failure = live_required_checks(live)
    if failure:
        return drifts, [
            Unevaluable(
                branch, failure, "live protection's required checks are not determinable"
            )
        ]

    declared_contexts = set(declared["contexts"])
    observed_contexts = set(bindings)
    if declared_contexts != observed_contexts:
        absent = sorted(declared_contexts - observed_contexts)
        stale = sorted(observed_contexts - declared_contexts)
        notes = [f"not required live: {', '.join(absent)}"] if absent else []
        # A context required live with nothing producing it blocks every pull
        # request forever, so name the stale entries as well as the absent ones.
        notes += [f"required live but undeclared: {', '.join(stale)}"] if stale else []
        drifts.append(
            Drift(
                branch,
                "required_status_checks.contexts",
                sorted(declared_contexts),
                sorted(observed_contexts),
                "; ".join(notes),
            )
        )
    return drifts + _provider_drifts(branch, declared_contexts, bindings), []


def _live_principals(allowances: object, collection: str) -> set[str]:
    """The identities live protection allows to bypass pull requests, for one collection.

    GitHub omits `bypass_pull_request_allowances` entirely when nothing is allowed,
    so an absent mapping means an empty collection. That is the only safe reading:
    treating absent as unreported would report drift on every correctly-configured
    branch and train the operator to ignore this check. Identities arrive as objects
    keyed differently per collection (`login`, `slug`, `name`), so each is reduced to
    whichever identifier it carries.
    """
    if not isinstance(allowances, dict):
        return set()
    entries = allowances.get(collection)
    if not isinstance(entries, list):
        return set()
    identities = set()
    for entry in entries:
        if isinstance(entry, str):
            identities.add(entry)
        elif isinstance(entry, dict):
            for key in ("login", "slug", "name"):
                if isinstance(entry.get(key), str):
                    identities.add(entry[key])
                    break
            else:
                identities.add(repr(entry))
    return identities


def _bypass_drifts(branch: str, declared: object, live: object) -> list:
    """Every bypass-principal collection whose live membership is not the declared one."""
    drifts = []
    for collection in sorted(CI_STRICTNESS_BYPASS_PRINCIPAL_FIELDS):
        expected = _live_principals(declared, collection)
        observed = _live_principals(live, collection)
        if expected == observed:
            continue
        drifts.append(
            Drift(
                branch,
                f"review_policy.bypass_pull_request_allowances.{collection}",
                sorted(expected),
                sorted(observed),
                "these principals can land changes without the pull-request boundary",
            )
        )
    return drifts


def _review_policy_drift(branch: str, declared: dict, live: dict) -> tuple[list, list]:
    """Every governed review leaf, compared after its live value is typed.

    Iterating the declared keys alone would close only top-level coverage: a leaf
    dropped from the declaration would stop being compared rather than be reported.
    The governed set is the authority, so a leaf missing from either side surfaces.
    """
    drifts = []
    for name in sorted(CI_STRICTNESS_REVIEW_POLICY_FIELDS):
        expected = declared.get(name, MISSING)
        if name == "bypass_pull_request_allowances":
            # Absent means "nobody", so this leaf is always comparable.
            drifts += _bypass_drifts(
                branch,
                None if expected is MISSING else expected,
                live.get(name),
            )
            continue
        observed = live.get(name, MISSING)
        if expected is MISSING:
            drifts.append(
                Drift(branch, f"review_policy.{name}", "declared", observed, "absent from the baseline")
            )
            continue
        if observed is MISSING:
            drifts.append(
                Drift(
                    branch,
                    f"review_policy.{name}",
                    expected,
                    "missing",
                    "live protection did not report it",
                )
            )
            continue
        if not is_declared_type(observed, CI_STRICTNESS_SCALAR_TYPES[name]):
            return [], [
                Unevaluable(
                    branch,
                    "live_value_malformed",
                    f"review_policy.{name} is {observed!r}, not the declared type",
                )
            ]
        if expected != observed:
            drifts.append(Drift(branch, f"review_policy.{name}", expected, observed))
    return drifts, []


def _field_drift(branch: str, name: str, declared: object, live: dict) -> tuple[list, list]:
    observed = PROTECTION_FIELD_READERS[name](live)
    if observed is MISSING:
        return [Drift(branch, name, declared, "missing", "live protection did not report it")], []
    if name == "required_status_checks":
        return _status_check_drift(branch, declared, observed)
    if name == "review_policy":
        return _review_policy_drift(branch, declared, observed)
    return ([] if declared == observed else [Drift(branch, name, declared, observed)]), []


def compare_branch(branch: str, declared: object, live: object) -> tuple[list, list]:
    """One branch's differences, and the reasons it could not be compared."""
    if isinstance(live, Unevaluable):
        return [], [live]
    if not isinstance(live, dict):
        # Unreadable and clean are different facts. Reporting the first as the
        # second is how a gate passes because it never looked.
        return [], [
            Unevaluable(branch, "live_protection_unreadable", "no protection document was read")
        ]
    if not isinstance(declared, dict):
        return [Drift(branch, "baseline entry", "declared", "missing")], []

    drifts: list[Drift] = []
    unevaluable: list[Unevaluable] = []
    for name in sorted(declared):
        if name not in PROTECTION_FIELD_READERS:
            drifts.append(
                Drift(branch, name, declared[name], "n/a", "declared but nothing compares it")
            )
            continue
        field_drifts, field_unevaluable = _field_drift(branch, name, declared[name], live)
        drifts += field_drifts
        unevaluable += field_unevaluable
    for name in sorted(set(PROTECTION_FIELD_READERS) - set(declared)):
        drifts.append(Drift(branch, name, "declared", "missing", "absent from the baseline"))
    return drifts, unevaluable


def compare_protection(
    baseline: dict, live_by_branch: dict, branches=CI_STRICTNESS_BRANCHES
) -> ProtectionReport:
    """Compare every protected branch's declaration against its live protection."""
    declared_branches = baseline.get("branches")
    declared_branches = declared_branches if isinstance(declared_branches, dict) else {}
    drifts: list[Drift] = []
    unevaluable: list[Unevaluable] = []
    for branch in branches:
        branch_drifts, branch_unevaluable = compare_branch(
            branch, declared_branches.get(branch), live_by_branch.get(branch)
        )
        # A branch that could not be read yields no drift claims: naming a specific
        # difference requires having read the thing being compared.
        if branch_unevaluable:
            unevaluable += branch_unevaluable
        else:
            drifts += branch_drifts
    return ProtectionReport(tuple(drifts), tuple(unevaluable))


def render_markdown(report: ProtectionReport) -> str:
    if not report.drifts and not report.unevaluable:
        declared = ", ".join(f"`{name}`" for name in sorted(CI_STRICTNESS_PROTECTION_FIELDS))
        return (
            "# Branch protection\n\nLive protection matches "
            f"`{BRANCH_PROTECTION_BASELINE_PATH.as_posix()}` on every protected "
            f"branch, across {declared}."
        )
    lines = ["# Branch protection"]
    if report.unevaluable:
        lines += [
            "",
            "## Could not be evaluated",
            "",
            "These branches were not compared, so nothing below is a verdict on them.",
            "",
            "| Branch | Reason | Detail |",
            "|---|---|---|",
        ]
        lines += [
            f"| `{item.branch}` | `{item.reason}` | {item.detail} |" for item in report.unevaluable
        ]
    if report.drifts:
        lines += [
            "",
            "## Drift",
            "",
            f"Live protection differs from `{BRANCH_PROTECTION_BASELINE_PATH.as_posix()}`.",
            "",
            "| Branch | Field | Declared | Live | Note |",
            "|---|---|---|---|---|",
        ]
        lines += [
            f"| `{d.branch}` | `{d.field}` | `{d.declared}` | `{d.observed}` | {d.note or ''} |"
            for d in report.drifts
        ]
    return "\n".join(lines)


def report_for_invalid_baseline(details: list[str]) -> ProtectionReport:
    """The structured non-clean result for a declaration that failed validation.

    Every protected branch is unevaluable rather than clean: with the contract
    itself unusable, nothing has been compared on any branch.
    """
    reason = "; ".join(details)
    return ProtectionReport(
        (),
        tuple(
            Unevaluable(branch, "baseline_invalid", reason) for branch in CI_STRICTNESS_BRANCHES
        ),
    )
