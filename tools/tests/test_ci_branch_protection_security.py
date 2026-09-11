"""Authorization-bearing halves of the branch-protection contract (GC-P031).

A required context name is satisfiable by whoever may post that name, and a
principal in `bypass_pull_request_allowances` can land changes without the
pull-request boundary. Both compare clean if the check looks only at names and
scalars, so both get their own drift cases here. The live read's own binding — which
repository, which host, with what timeout — is in the same module because it is the
same concern: an administration-capable credential pointed somewhere else, or left
hanging, is an authorization failure rather than a comparison bug.
"""

import unittest

from tools.ci.branch_protection_compare import compare_protection
from tools.ci.check_branch_protection import (
    GH_TIMEOUT_SECONDS,
    TARGET_REPO,
    build_protection_read_args,
)
from tools.policy.branch_protection_baseline import (
    CI_STRICTNESS_BRANCHES,
    CI_STRICTNESS_CONTEXT_PROVIDERS,
    CI_STRICTNESS_REQUIRED_CONTEXTS,
)
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


class BypassAllowanceTest(unittest.TestCase):
    """An allowance defeats the pull-request boundary while every scalar matches."""

    def test_an_unexpected_user_allowance_is_drift(self):
        live = _live_all()
        live["main"]["required_pull_request_reviews"]["bypass_pull_request_allowances"] = {
            "users": [{"login": "someone"}],
            "teams": [],
            "apps": [],
        }
        drifts = _report(live=live).drifts
        self.assertIn(
            ("main", "review_policy.bypass_pull_request_allowances.users"), _fields(drifts)
        )

    def test_an_unexpected_app_allowance_is_drift(self):
        live = _live_all()
        live["dev"]["required_pull_request_reviews"]["bypass_pull_request_allowances"] = {
            "users": [],
            "teams": [],
            "apps": [{"slug": "some-bot"}],
        }
        drifts = _report(live=live).drifts
        self.assertIn(
            ("dev", "review_policy.bypass_pull_request_allowances.apps"), _fields(drifts)
        )

    def test_an_absent_allowance_mapping_means_nobody_may_bypass(self):
        # GitHub omits the mapping entirely when no allowance is configured, so
        # treating absent as "unreported" would report drift on every correct branch.
        self.assertNotIn("bypass_pull_request_allowances", _live()["required_pull_request_reviews"])
        self.assertEqual(_report().exit_code, 0)

    def test_a_declared_allowance_absent_from_live_is_drift(self):
        baseline = _baseline()
        baseline["branches"]["dev"]["review_policy"]["bypass_pull_request_allowances"] = {
            "users": ["release-manager"],
            "teams": [],
            "apps": [],
        }
        drifts = _report(baseline=baseline).drifts
        self.assertIn(
            ("dev", "review_policy.bypass_pull_request_allowances.users"), _fields(drifts)
        )


class CheckProviderBindingTest(unittest.TestCase):
    """A required context name is satisfiable by whoever may post that name."""

    def test_an_unexpected_provider_for_a_required_context_is_drift(self):
        providers = {**CI_STRICTNESS_CONTEXT_PROVIDERS, "policy": 99999}
        live = _live_all(main={"required_status_checks": _live_checks(CONTEXTS, providers=providers)})
        drifts = _report(live=live).drifts
        self.assertIn(("main", "required_status_checks.checks.policy"), _fields(drifts))

    def test_an_unbound_required_context_is_drift(self):
        # A check with no app binding can be satisfied by any actor able to post a
        # commit status with that name, without the workflow ever running.
        providers = {**CI_STRICTNESS_CONTEXT_PROVIDERS, "sonar": None}
        live = _live_all(dev={"required_status_checks": _live_checks(CONTEXTS, providers=providers)})
        drifts = _report(live=live).drifts
        self.assertIn(("dev", "required_status_checks.checks.sonar"), _fields(drifts))

    def test_conflicting_bindings_for_one_context_are_unevaluable(self):
        checks = _live_checks(CONTEXTS)
        checks["checks"].append({"context": "policy", "app_id": 99999})
        live = _live_all(main={"required_status_checks": checks})
        report = _report(live=live)
        self.assertEqual(
            {(i.branch, i.reason) for i in report.unevaluable},
            {("main", "live_contexts_inconsistent")},
        )

    def test_providers_are_declared_for_exactly_the_required_contexts(self):
        self.assertEqual(
            set(CI_STRICTNESS_CONTEXT_PROVIDERS), set(CI_STRICTNESS_REQUIRED_CONTEXTS)
        )

    def test_a_live_response_without_the_checks_array_cannot_verify_providers(self):
        checks = _live_checks(CONTEXTS)
        del checks["checks"]
        live = _live_all(dev={"required_status_checks": checks})
        report = _report(live=live)
        self.assertEqual(
            {(i.branch, i.reason) for i in report.unevaluable},
            {("dev", "live_check_providers_unavailable")},
        )


class RepositoryIdentityTest(unittest.TestCase):
    def test_the_live_read_targets_the_canonical_repository(self):
        # A second repo-identity authority here would let the check compare the
        # declaration against some other repository's protection.
        self.assertEqual(TARGET_REPO, CANONICAL_REPO_SLUG)

    def test_the_gh_invocation_pins_host_repository_and_a_timeout(self):
        argv = build_protection_read_args("main")
        self.assertEqual(argv[:2], ["gh", "api"])
        self.assertIn("--hostname", argv)
        self.assertIn(f"repos/{CANONICAL_REPO_SLUG}/branches/main/protection", argv)
        self.assertGreater(GH_TIMEOUT_SECONDS, 0)


if __name__ == "__main__":
    unittest.main()
