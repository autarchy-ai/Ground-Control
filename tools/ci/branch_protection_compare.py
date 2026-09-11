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

from .branch_protection_readers import (
    MISSING,
    PROTECTION_FIELD_READERS,
    live_required_checks,
)
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


@dataclass(frozen=True)
class Drift(object):
    """One difference between the declared protection and the live protection."""

    branch: str
    field: str
    declared: object
    observed: object
    note: str | None = dataclass_field(default=None)

    def render(self) -> str:
        """This difference as one line, naming both values."""
        suffix = f" ({self.note})" if self.note else ""
        return (
            f"{self.branch}: {self.field} declared {self.declared!r}, "
            f"live {self.observed!r}{suffix}"
        )


@dataclass(frozen=True)
class Unevaluable(object):
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
        """This refusal as one line, naming its stable reason."""
        return f"{self.branch}: {self.reason} ({self.detail})"


@dataclass(frozen=True)
class ProtectionReport(object):
    """One comparison's outcome: what differs, and what could not be compared."""

    drifts: tuple[Drift, ...]
    unevaluable: tuple[Unevaluable, ...]

    @property
    def exit_code(self) -> int:
        """0 when protection matches, 1 on drift, 2 when a branch was not compared."""
        if self.unevaluable:
            return 2
        return 1 if self.drifts else 0


def _provider_drifts(
    branch: str, declared_contexts: set[str], bindings: dict[str, object]
) -> list[Drift]:
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


def _status_check_drift(
    branch: str, declared: dict[str, object], live: dict[str, object]
) -> tuple[list[Drift], list[Unevaluable]]:
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


def _bypass_drifts(branch: str, declared: object, live: object) -> list[Drift]:
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


def _review_policy_drift(
    branch: str, declared: dict[str, object], live: dict[str, object]
) -> tuple[list[Drift], list[Unevaluable]]:
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


# The two governed fields that are mappings rather than scalars, and the comparison
# each needs. Dispatching through a table keeps `_field_drift` a single decision.
_MAPPING_FIELD_COMPARISONS = {
    "required_status_checks": _status_check_drift,
    "review_policy": _review_policy_drift,
}


def _field_drift(
    branch: str, name: str, declared: object, live: dict[str, object]
) -> tuple[list[Drift], list[Unevaluable]]:
    """One governed field's differences, and the reasons it could not be compared."""
    observed = PROTECTION_FIELD_READERS[name](live)
    if observed is MISSING:
        return [Drift(branch, name, declared, "missing", "live protection did not report it")], []
    compare = _MAPPING_FIELD_COMPARISONS.get(name)
    if compare is not None:
        return compare(branch, declared, observed)
    return ([] if declared == observed else [Drift(branch, name, declared, observed)]), []


def compare_branch(
    branch: str, declared: object, live: object
) -> tuple[list[Drift], list[Unevaluable]]:
    """One branch's differences, and the reasons it could not be compared."""
    refusal = _branch_refusal(branch, declared, live)
    if refusal is not None:
        return refusal
    return _compare_declared_branch(branch, declared, live)


def _branch_refusal(
    branch: str, declared: object, live: object
) -> tuple[list[Drift], list[Unevaluable]] | None:
    """Why this branch cannot be compared at all, or None when it can be.

    Unreadable and clean are different facts. Reporting the first as the second is
    how a gate passes because it never looked, so an unreadable branch yields a
    refusal rather than a comparison against an empty document.
    """
    refusal: tuple[list[Drift], list[Unevaluable]] | None = None
    if isinstance(live, Unevaluable):
        refusal = ([], [live])
    elif not isinstance(live, dict):
        refusal = (
            [],
            [Unevaluable(branch, "live_protection_unreadable", "no protection document was read")],
        )
    elif not isinstance(declared, dict):
        refusal = ([Drift(branch, "baseline entry", "declared", "missing")], [])
    return refusal


def _compare_declared_branch(
    branch: str, declared: dict[str, object], live: dict[str, object]
) -> tuple[list[Drift], list[Unevaluable]]:
    """Compare one branch whose declaration and live document are both readable."""
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
    baseline: dict[str, object],
    live_by_branch: dict[str, object],
    branches: tuple[str, ...] = CI_STRICTNESS_BRANCHES,
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
    """The drift report as Markdown, with unevaluable branches called out first."""
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
