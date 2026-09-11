"""Contract tests for the live-vs-versioned branch-protection check (GC-P031, ADR-091).

GC-P030 made the required-context declaration real against the jobs that produce
those checks, but it compares two files in the repository and never looks at what
GitHub enforces. Issue #1155 found the gap already open: live `main` carried
`required_status_checks.strict: false` while the baseline declared `strict: true`
and live `dev` declared `true`, and live `dev` allowed force pushes against the
documented intent. No check could notice, because none of them read live state.
"""

import json
import unittest

from tools.ci.branch_protection_compare import (
    compare_protection,
    render_markdown,
    report_for_invalid_baseline,
)
from tools.ci.branch_protection_readers import (
    PROTECTION_FIELD_READERS,
    PROTECTION_TOGGLE_SECTIONS,
)
from tools.ci.check_branch_protection import (
    GH_TIMEOUT_SECONDS,
    TARGET_REPO,
    build_protection_read_args,
)
from tools.policy.branch_protection_baseline import (
    BRANCH_PROTECTION_BASELINE_PATH,
    CI_STRICTNESS_CONTEXT_PROVIDERS,
    CI_STRICTNESS_BRANCHES,
    CI_STRICTNESS_PROTECTION_FIELDS,
    CI_STRICTNESS_REQUIRED_CONTEXTS,
    CI_STRICTNESS_REVIEW_POLICY_FIELDS,
    load_branch_protection_baseline,
)
from tools.policy.core import REPO_ROOT
from tools.policy.repo_identity import CANONICAL_REPO_SLUG

from tools.tests.branch_protection_fixtures import (
    CONTEXTS,
    baseline as _baseline,
    drifted_fields as _fields,
    live as _live,
    live_all as _live_all,
    live_checks as _live_checks,
    report as _report,
)


class CompareProtectionTest(unittest.TestCase):
    def test_accepts_live_protection_that_matches_the_baseline(self):
        report = _report()
        self.assertEqual(report.drifts, (), msg=f"unexpected: {[d.render() for d in report.drifts]}")
        self.assertEqual(report.unevaluable, ())

    def test_reports_strict_disabled_live_while_the_baseline_declares_it(self):
        # The #1155 defect exactly: baseline says strict, live main says otherwise.
        live = _live_all(main={"required_status_checks": _live_checks(CONTEXTS, strict=False)})
        drifts = _report(live=live).drifts
        self.assertIn(("main", "required_status_checks.strict"), _fields(drifts))
        drift = next(d for d in drifts if d.field == "required_status_checks.strict")
        self.assertEqual((drift.declared, drift.observed), (True, False))

    def test_reports_force_pushes_allowed_live_while_the_baseline_forbids_them(self):
        # The other live finding: dev allowed force pushes against documented intent.
        live = _live_all(dev={"allow_force_pushes": {"enabled": True}})
        drifts = _report(live=live).drifts
        self.assertIn(("dev", "force_pushes_allowed"), _fields(drifts))

    def test_reports_a_required_context_absent_from_live_protection(self):
        short = [name for name in CONTEXTS if name != "policy"]
        live = _live_all(main={"required_status_checks": _live_checks(short)})
        drifts = _report(live=live).drifts
        self.assertIn(("main", "required_status_checks.contexts"), _fields(drifts))
        self.assertIn("policy", " ".join(d.render() for d in drifts))

    def test_reports_a_stale_context_still_required_live(self):
        # A deleted job's context left behind blocks every pull request forever.
        live = _live_all(
            dev={
                "required_status_checks": _live_checks(
                    CONTEXTS + ["frontend"],
                    providers={**CI_STRICTNESS_CONTEXT_PROVIDERS, "frontend": 15368},
                )
            }
        )
        drifts = _report(live=live).drifts
        self.assertIn(("dev", "required_status_checks.contexts"), _fields(drifts))
        self.assertIn("frontend", " ".join(d.render() for d in drifts))

    def test_derives_context_names_from_checks_when_contexts_is_absent(self):
        # GitHub is deprecating the flat `contexts` array in favour of `checks`.
        checks = _live_checks(CONTEXTS)
        del checks["contexts"]
        live = _live_all(main={"required_status_checks": checks})
        drifts = _report(live=live).drifts
        self.assertNotIn(("main", "required_status_checks.contexts"), _fields(drifts))

    def test_reports_review_policy_drift(self):
        live = _live_all(
            dev={
                "required_pull_request_reviews": {
                    "dismiss_stale_reviews": True,
                    "require_code_owner_reviews": False,
                    "require_last_push_approval": False,
                    "required_approving_review_count": 2,
                }
            }
        )
        baseline = _baseline()
        drifts = _report(baseline=baseline, live=live).drifts
        self.assertIn(("dev", "review_policy.required_approving_review_count"), _fields(drifts))

    def test_reports_a_branch_whose_changes_can_land_without_a_pull_request(self):
        live = _live_all()
        del live["dev"]["required_pull_request_reviews"]
        drifts = _report(live=live).drifts
        self.assertIn(("dev", "changes_land_via_pull_request"), _fields(drifts))

    def test_fails_rather_than_reporting_clean_when_live_protection_is_unreadable(self):
        # "Read nothing" and "found nothing wrong" are different facts.
        report = _report(live={"main": _live(), "dev": None})
        self.assertEqual({i.branch for i in report.unevaluable}, {"dev"})
        self.assertEqual(report.drifts, ())

    def test_reports_a_protected_branch_the_baseline_does_not_declare(self):
        baseline = _baseline()
        del baseline["branches"]["dev"]
        drifts = _report(baseline=baseline).drifts
        self.assertIn(("dev", "baseline entry"), _fields(drifts))

    def test_reports_a_declared_field_the_comparator_cannot_compare(self):
        # A field added to the baseline and not to the comparator would otherwise
        # be decoration: declared intent that nothing defends.
        baseline = _baseline(main={"signatures_required": True})
        drifts = _report(baseline=baseline).drifts
        self.assertIn(("main", "signatures_required"), _fields(drifts))

    def test_render_markdown_names_the_branch_field_declared_and_observed_values(self):
        live = _live_all(main={"required_status_checks": _live_checks(CONTEXTS, strict=False)})
        output = render_markdown(_report(live=live))
        for fragment in ("main", "required_status_checks.strict", "True", "False"):
            self.assertIn(fragment, output)

    def test_render_markdown_says_so_when_there_is_no_drift(self):
        self.assertIn("matches", render_markdown(_report()).lower())


class ProtectionFieldCoverageTest(unittest.TestCase):
    """The declaration and the comparison must cover each other, both ways."""

    def test_the_comparator_covers_exactly_the_declared_protection_fields(self):
        self.assertEqual(set(PROTECTION_FIELD_READERS), set(CI_STRICTNESS_PROTECTION_FIELDS))

    def test_the_real_baseline_declares_every_field_for_every_protected_branch(self):
        baseline = json.loads(
            (REPO_ROOT / BRANCH_PROTECTION_BASELINE_PATH).read_text(encoding="utf-8")
        )
        for branch in CI_STRICTNESS_BRANCHES:
            with self.subTest(branch=branch):
                self.assertEqual(
                    set(baseline["branches"][branch]),
                    set(CI_STRICTNESS_PROTECTION_FIELDS),
                    "the baseline and the comparison must declare the same field set",
                )


class EvaluationOutcomeTest(unittest.TestCase):
    """Drift and "could not evaluate" are different outcomes, reported differently."""

    def test_a_clean_comparison_exits_zero(self):
        self.assertEqual(_report().exit_code, 0)

    def test_drift_exits_one(self):
        live = _live_all(dev={"allow_force_pushes": {"enabled": True}})
        report = _report(live=live)
        self.assertEqual(report.exit_code, 1)
        self.assertEqual(report.unevaluable, ())

    def test_inability_to_evaluate_exits_two_and_is_not_reported_as_drift(self):
        report = _report(live={"main": _live(), "dev": None})
        self.assertEqual(report.exit_code, 2)
        self.assertEqual({item.branch for item in report.unevaluable}, {"dev"})
        self.assertNotIn("dev", {drift.branch for drift in report.drifts})

    def test_names_a_stable_reason_for_each_unevaluable_branch(self):
        report = _report(live={"main": _live(), "dev": None})
        self.assertEqual(
            {item.reason for item in report.unevaluable}, {"live_protection_unreadable"}
        )

    def test_reports_disagreement_between_checks_and_the_legacy_contexts_array(self):
        # Two disagreeing views of the required set means the required set is not
        # determinable, which is not the same as matching one of them.
        live = _live_all(
            main={
                "required_status_checks": {
                    "strict": True,
                    "contexts": list(CONTEXTS),
                    "checks": [
                        {"context": name, "app_id": CI_STRICTNESS_CONTEXT_PROVIDERS[name]}
                        for name in CONTEXTS
                        if name != "trivy"
                    ],
                }
            }
        )
        report = _report(live=live)
        self.assertEqual(
            {(i.branch, i.reason) for i in report.unevaluable},
            {("main", "live_contexts_inconsistent")},
        )

    def test_reports_a_malformed_live_context_entry_instead_of_coercing_it(self):
        live = _live_all(
            dev={"required_status_checks": {"strict": True, "contexts": [123], "checks": []}}
        )
        report = _report(live=live)
        self.assertEqual(
            {(i.branch, i.reason) for i in report.unevaluable},
            {("dev", "live_contexts_malformed")},
        )

    def test_render_markdown_separates_unevaluable_branches_from_drift(self):
        live = _live_all(dev={"allow_force_pushes": {"enabled": True}})
        live["main"] = None
        output = render_markdown(_report(live=live))
        self.assertIn("could not be evaluated", output.lower())
        self.assertIn("live_protection_unreadable", output)
        self.assertIn("force_pushes_allowed", output)


class ReviewPolicyCoverageTest(unittest.TestCase):
    def test_reports_a_declared_review_leaf_live_protection_omits(self):
        live = _live_all()
        del live["main"]["required_pull_request_reviews"]["require_last_push_approval"]
        drifts = _report(live=live).drifts
        self.assertIn(("main", "review_policy.require_last_push_approval"), _fields(drifts))

    def test_compares_every_governed_review_leaf_not_only_the_declared_keys(self):
        baseline = _baseline()
        del baseline["branches"]["dev"]["review_policy"]["require_code_owner_reviews"]
        drifts = _report(baseline=baseline, live=_live_all()).drifts
        self.assertIn(("dev", "review_policy.require_code_owner_reviews"), _fields(drifts))

    def test_reports_last_push_approval_turned_off_live(self):
        # The leaf whose absence is exactly what a review gate silently loses.
        baseline = _baseline()
        baseline["branches"]["main"]["review_policy"]["require_last_push_approval"] = True
        drifts = _report(baseline=baseline).drifts
        self.assertIn(("main", "review_policy.require_last_push_approval"), _fields(drifts))


class LiveValueTypingTest(unittest.TestCase):
    """A malformed live value is unevaluable, never a match against a default.

    Python equality treats JSON `1` as `True` and `0` as `False`, so comparing
    without typing first would let `strict: 1` satisfy a declared `true` and report
    exit 0 on protection whose real state was never established.
    """

    def test_a_numeric_strict_does_not_satisfy_a_declared_boolean(self):
        live = _live_all(main={"required_status_checks": dict(_live_checks(CONTEXTS), strict=1)})
        report = _report(live=live)
        self.assertEqual(
            {(i.branch, i.reason) for i in report.unevaluable},
            {("main", "live_value_malformed")},
        )

    def test_a_numeric_review_leaf_does_not_satisfy_a_declared_boolean(self):
        live = _live_all()
        live["dev"]["required_pull_request_reviews"]["dismiss_stale_reviews"] = 0
        report = _report(live=live)
        self.assertEqual(
            {(i.branch, i.reason) for i in report.unevaluable},
            {("dev", "live_value_malformed")},
        )

    def test_a_boolean_review_count_does_not_satisfy_a_declared_integer(self):
        live = _live_all()
        live["main"]["required_pull_request_reviews"]["required_approving_review_count"] = False
        report = _report(live=live)
        self.assertEqual(
            {(i.branch, i.reason) for i in report.unevaluable},
            {("main", "live_value_malformed")},
        )

    def test_an_invalid_declaration_is_a_structured_non_clean_result(self):
        report = report_for_invalid_baseline(["branches.main.force_pushes_allowed is not a bool"])
        self.assertEqual(report.exit_code, 2)
        self.assertEqual({i.reason for i in report.unevaluable}, {"baseline_invalid"})
        self.assertEqual({i.branch for i in report.unevaluable}, set(CI_STRICTNESS_BRANCHES))


class ToggleFieldSectionTest(unittest.TestCase):
    """Every toggle-mapped field is driven away from its default, one field at a time.

    Three of these live sections (`enforce_admins`,
    `required_conversation_resolution`, `allow_deletions`) report the same default
    value, and two of them share the same non-inverted reading, so a reader bound to
    the wrong section would produce an identical result on every shared fixture and
    be caught by nothing — including the clean-state test. Flipping exactly one
    section and requiring drift on exactly its own field is what makes a section swap
    fail: a misbound reader reports either nothing or the wrong field.
    """

    def test_each_toggle_field_reads_its_own_live_section(self):
        # Every toggle section defaults to `{"enabled": false}` live, which the
        # default declaration already matches — inverted or not. So flipping exactly
        # one section on one branch must drift exactly that branch's own field.
        for field, (section, _negated) in sorted(PROTECTION_TOGGLE_SECTIONS.items()):
            with self.subTest(field=field, section=section):
                live = _live_all()
                live["main"][section] = {"enabled": True}
                report = _report(live=live)
                self.assertEqual(report.unevaluable, ())
                self.assertEqual(
                    _fields(report.drifts),
                    {("main", field)},
                    f"flipping {section} must drift {field} on main and nothing else",
                )

    def test_an_unreported_toggle_section_is_drift_not_a_false_default(self):
        for field, (section, _negated) in sorted(PROTECTION_TOGGLE_SECTIONS.items()):
            with self.subTest(field=field, section=section):
                live = _live_all()
                del live["dev"][section]
                report = _report(live=live)
                self.assertIn(("dev", field), _fields(report.drifts))

    def test_every_governed_field_is_either_a_toggle_or_one_of_the_three_mappings(self):
        # Keeps the data-driven coverage above honest: a new governed field must
        # either join the toggle table (and get a drift case for free) or be one of
        # the named mappings that have their own dedicated tests.
        self.assertEqual(
            set(PROTECTION_TOGGLE_SECTIONS)
            | {"changes_land_via_pull_request", "required_status_checks", "review_policy"},
            set(CI_STRICTNESS_PROTECTION_FIELDS),
        )


if __name__ == "__main__":
    unittest.main()
