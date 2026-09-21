"""Behaviour tests for the GC-O010 documentation-coverage gate (issue #1679).

These four behaviours had test coverage until commit `f11e31af` removed the
test-quality decision-record contract files they happened to live in. The gate
itself stayed live in `tools/policy/cli.py`, so from then on nothing failed if
`run_documentation_coverage_check` stopped classifying a surface, stopped
noticing a missing `## Documentation` section, started demanding one from a
docs-only diff, or started raising when no PR body was available. They are
restored here, beside the module that owns them, rather than beside an unrelated
contract.

The repository's other documentation-coverage tests assert catalogue and path
integrity; these assert what the check decides. Both are needed.
"""

import unittest

from tools.policy.checks import run_documentation_coverage_check

# `mcp/ground-control/lib.js` is a classified surface (ADR-054), so a diff that
# touches it must record a documentation outcome.
CLASSIFIED_SURFACE = "mcp/ground-control/lib.js"
# Anything under `docs/` is itself the documentation, so it requires no outcome.
DOC_SURFACE = "docs/DOC_STYLE.md"
OUTCOME_MISSING = "doc-coverage-outcome-missing"


def _body(*, documentation: bool) -> str:
    """A minimal PR body, with or without the `## Documentation` section."""
    sections = [
        "## Summary\nAdded classifier.",
        "## Requirement UIDs\n- ADR-054",
        "## Related Issues\nCloses #896",
        "## ADR Impact\n- ADR-054",
        "## Changes\n- Added classifyChangedSurface",
    ]
    if documentation:
        sections.append("## Documentation\n\nUpdated: see diff.")
    return "\n\n".join(sections) + "\n"


def _codes(violations: list) -> list[str]:
    """The violation codes a run produced."""
    return [violation.code for violation in violations]


class DocumentationCoverageBehaviorTest(unittest.TestCase):
    """What the live GC-O010 gate decides for each shape of diff and body."""

    def test_classified_surface_with_outcome_passes(self) -> None:
        """A PR body carrying `## Documentation` satisfies a classified surface."""
        violations = run_documentation_coverage_check(
            [CLASSIFIED_SURFACE],
            pr_body=_body(documentation=True),
        )
        self.assertNotIn(OUTCOME_MISSING, _codes(violations))

    def test_classified_surface_without_outcome_fails(self) -> None:
        """A classified surface with no `## Documentation` section is a violation.

        This is the assertion the gate exists for: without it the check could be
        reduced to a no-op and CI would stay green.
        """
        violations = run_documentation_coverage_check(
            [CLASSIFIED_SURFACE],
            pr_body=_body(documentation=False),
        )
        self.assertIn(OUTCOME_MISSING, _codes(violations))

    def test_docs_only_diff_passes_without_outcome(self) -> None:
        """A docs-only diff is its own documentation and needs no outcome."""
        violations = run_documentation_coverage_check(
            [DOC_SURFACE],
            pr_body=_body(documentation=False),
        )
        self.assertNotIn(OUTCOME_MISSING, _codes(violations))

    def test_unavailable_pr_body_skips_gracefully(self) -> None:
        """With no PR body to read the check skips instead of raising or failing.

        The local `bin/policy` run has no pull request, so a hard failure here
        would block every pre-commit run in the repository.
        """
        violations = run_documentation_coverage_check([CLASSIFIED_SURFACE], pr_body=None)
        self.assertNotIn(OUTCOME_MISSING, _codes(violations))


if __name__ == "__main__":
    unittest.main()
