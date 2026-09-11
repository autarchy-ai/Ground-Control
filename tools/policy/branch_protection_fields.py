"""The pinned values the branch-protection baseline must declare (GC-P031).

`branch_protection_baseline.py` validates the declaration's *shape*: every governed
key present at every mapping level, nothing extra, every scalar its declared type.
This module asserts the handful of declared *values* that are not free choices.

Most protection values are not pinned. Flipping `admin_bypass_allowed` or
`conversation_resolution_required` is a tightening, and a gate that fails a
tightening is pointed the wrong way, so their agreement with live state is the live
comparison's job and a deliberate change is a reviewed baseline diff. The two pinned
here are the ones whose only available direction is weakening: changes that land
without a pull request, and a non-strict required-check set that lets a stale branch
merge past checks it never ran against.
"""

from __future__ import annotations

from .core import Violation


def protection_policy_violations(branch: str, config: dict[str, object]) -> list[Violation]:
    """The pinned-value failures in one validated branch declaration."""
    violations: list[Violation] = []
    checks = config.get("required_status_checks")
    if not isinstance(checks, dict) or checks.get("strict") is not True:
        violations.append(
            Violation(
                code="ci-required-context-not-strict",
                message="Required status checks must stay strict on every protected branch.",
                details=[f"{branch}: expected strict=true"],
            )
        )
    if config.get("changes_land_via_pull_request") is not True:
        violations.append(
            Violation(
                code="ci-required-context-pull-request-required",
                message="Changes must land on every protected branch through a pull request.",
                details=[f"{branch}: expected changes_land_via_pull_request=true"],
            )
        )
    return violations
