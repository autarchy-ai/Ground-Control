"""Contract tests for the required-status-context gate (GC-P030, ADR-091).

A required status check with no job behind it never reports, so every pull
request stays blocked forever. That is what happened when the `mutation` job was
deleted while its context stayed declared (#1461), and again across the #1500
re-platform, when `build`, `frontend`, `integration`, `test`, and `verify` all
outlived the jobs that produced them. The gate that caught the first case went
with the CI tests it lived in, so the second case went unnoticed until #650.
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.policy.ci_strictness import (
    EXTERNALLY_POSTED_CONTEXTS,
    run_ci_required_context_contract,
)
from tools.policy.branch_protection_baseline import (
    CI_STRICTNESS_BRANCHES,
    CI_STRICTNESS_PROTECTION_FIELDS,
    CI_STRICTNESS_REQUIRED_CONTEXTS,
    CI_STRICTNESS_REVIEW_POLICY_FIELDS,
)


def _branch_entry(contexts, strict=True, **overrides):
    """One branch's baseline entry, declaring every field the contract governs."""
    entry = {
        "admin_bypass_allowed": True,
        "changes_land_via_pull_request": True,
        "conversation_resolution_required": False,
        "deletions_allowed": False,
        "force_pushes_allowed": False,
        "required_status_checks": {"strict": strict, "contexts": sorted(contexts)},
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


def _baseline(contexts, strict=True, branches=CI_STRICTNESS_BRANCHES, **overrides):
    return {
        "branches": {
            branch: _branch_entry(contexts, strict=strict, **overrides) for branch in branches
        }
    }


def _workflow(job_ids, on_pull_request=True, display_names=None, branches=("main", "dev")):
    """Render a workflow. `display_names` maps a job id to an explicit `name:`.

    `branches=None` omits the branch filter, which means the trigger matches every
    branch.
    """
    display_names = display_names or {}
    if on_pull_request:
        trigger = "  pull_request:\n"
        if branches is not None:
            trigger += f"    branches: [{', '.join(branches)}]\n"
    else:
        trigger = "  push:\n"
    jobs = ""
    for job in job_ids:
        jobs += f"  {job}:\n"
        if job in display_names:
            jobs += f"    name: {display_names[job]}\n"
        jobs += "    runs-on: ubuntu-latest\n    steps:\n      - run: true\n"
    return f"name: T\non:\n{trigger}\njobs:\n{jobs}"


class CiRequiredContextContractTest(unittest.TestCase):
    def _root(self, tmp_dir, *, contexts=None, produced=None, strict=True, branches=None):
        root = Path(tmp_dir)
        contexts = CI_STRICTNESS_REQUIRED_CONTEXTS if contexts is None else contexts
        produced = sorted(set(contexts) - EXTERNALLY_POSTED_CONTEXTS) if produced is None else produced
        (root / ".github" / "workflows").mkdir(parents=True)
        (root / ".github" / "branch-protection-baseline.json").write_text(
            json.dumps(_baseline(contexts, strict=strict, branches=branches or CI_STRICTNESS_BRANCHES)),
            encoding="utf-8",
        )
        (root / ".github" / "workflows" / "ci.yml").write_text(_workflow(produced), encoding="utf-8")
        return root

    def test_accepts_a_baseline_whose_every_context_has_a_producer(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            violations = run_ci_required_context_contract(root=self._root(tmp_dir))
            self.assertEqual(
                violations, [], msg=f"unexpected: {[v.render() for v in violations]}"
            )

    def test_rejects_a_required_context_no_job_produces(self):
        # The #1461 and #650 failure: the job was deleted, the context stayed.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            (root / ".github" / "workflows" / "ci.yml").write_text(
                _workflow(sorted(set(CI_STRICTNESS_REQUIRED_CONTEXTS) - EXTERNALLY_POSTED_CONTEXTS - {"policy"})),
                encoding="utf-8",
            )
            violations = run_ci_required_context_contract(root=root)
            self.assertIn("ci-required-context-unproduced", {v.code for v in violations})
            details = " ".join(d for v in violations for d in v.details)
            self.assertIn("policy", details)

    def test_rejects_a_baseline_that_drifts_from_the_declared_contract(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir, contexts=set(CI_STRICTNESS_REQUIRED_CONTEXTS) | {"integration"})
            violations = run_ci_required_context_contract(root=root)
            self.assertIn("ci-required-context-baseline-drift", {v.code for v in violations})
            details = " ".join(d for v in violations for d in v.details)
            self.assertIn("integration", details)

    def test_rejects_a_non_strict_branch(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir, strict=False)
            violations = run_ci_required_context_contract(root=root)
            self.assertIn("ci-required-context-not-strict", {v.code for v in violations})

    def test_rejects_a_missing_protected_branch(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir, branches=("main",))
            violations = run_ci_required_context_contract(root=root)
            self.assertIn("ci-required-context-baseline-malformed", {v.code for v in violations})
            details = " ".join(d for v in violations for d in v.details)
            self.assertIn("dev", details)

    def test_rejects_an_externally_posted_entry_that_is_not_required(self):
        # The allowlist is shrink-only: it exempts a context from needing a local
        # job, so an entry that no longer appears in the required set would
        # silently widen the exemption.
        self.assertLessEqual(
            EXTERNALLY_POSTED_CONTEXTS,
            CI_STRICTNESS_REQUIRED_CONTEXTS,
            "every externally-posted context must still be a required context",
        )

    def test_runtime_rejects_an_external_allowlist_entry_that_is_not_required(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            with patch(
                "tools.policy.ci_strictness.EXTERNALLY_POSTED_CONTEXTS",
                EXTERNALLY_POSTED_CONTEXTS | {"retired hosted check"},
            ):
                violations = run_ci_required_context_contract(root=root)
            self.assertIn("ci-required-context-external-allowlist-drift", {v.code for v in violations})

    def test_runtime_rejects_a_provider_map_that_does_not_exactly_cover_contexts(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            with patch(
                "tools.policy.ci_strictness.CI_STRICTNESS_CONTEXT_PROVIDERS",
                {"policy": 15368},
            ):
                violations = run_ci_required_context_contract(root=root)
            self.assertIn("ci-required-context-provider-map-drift", {v.code for v in violations})

    def test_uses_the_display_name_when_a_job_sets_one(self):
        # GitHub reports `jobs.<id>.name` when present, so branch protection waits
        # on the display name, not the id. A gate that compared ids would pass here
        # while every pull request blocked forever on a context nothing reports.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            produced = sorted(set(CI_STRICTNESS_REQUIRED_CONTEXTS) - EXTERNALLY_POSTED_CONTEXTS)
            (root / ".github" / "workflows" / "ci.yml").write_text(
                _workflow(produced, display_names={"policy": "Repo policy"}), encoding="utf-8"
            )
            violations = run_ci_required_context_contract(root=root)
            self.assertIn("ci-required-context-unproduced", {v.code for v in violations})
            details = " ".join(d for v in violations for d in v.details)
            self.assertIn("policy", details)

    def test_a_job_whose_display_name_is_the_required_context_satisfies_it(self):
        # The inverse of the previous test: the reported name is what counts, so a
        # job whose id differs but whose `name:` is the required context satisfies
        # it. Resolving ids alone would reject this valid arrangement.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            others = sorted(set(CI_STRICTNESS_REQUIRED_CONTEXTS) - EXTERNALLY_POSTED_CONTEXTS - {"policy"})
            (root / ".github" / "workflows" / "ci.yml").write_text(
                _workflow(others + ["repo-policy"], display_names={"repo-policy": "policy"}),
                encoding="utf-8",
            )
            violations = [
                v for v in run_ci_required_context_contract(root=root)
                if v.code == "ci-required-context-unproduced"
            ]
            self.assertEqual(
                violations, [], msg=f"unexpected: {[v.render() for v in violations]}"
            )

    def test_a_matrix_templated_name_does_not_satisfy_a_required_context(self):
        # `name: policy (${{ matrix.os }})` expands per leg, so no single reported
        # context equals the requirement. Guessing the id would be a false pass.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            produced = sorted(set(CI_STRICTNESS_REQUIRED_CONTEXTS) - EXTERNALLY_POSTED_CONTEXTS)
            (root / ".github" / "workflows" / "ci.yml").write_text(
                _workflow(produced, display_names={"policy": "policy (${{ matrix.os }})"}),
                encoding="utf-8",
            )
            violations = run_ci_required_context_contract(root=root)
            self.assertIn("ci-required-context-unproduced", {v.code for v in violations})

    def test_rejects_a_producer_that_excludes_one_protected_branch(self):
        # A pull_request trigger filtered to `dev` never runs for a `main` pull
        # request, so `main` requires a check nothing produces and its pull
        # requests hang. Pooling producers across workflows hides this.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            produced = sorted(set(CI_STRICTNESS_REQUIRED_CONTEXTS) - EXTERNALLY_POSTED_CONTEXTS)
            (root / ".github" / "workflows" / "ci.yml").write_text(
                _workflow(produced, branches=("dev",)), encoding="utf-8"
            )
            violations = run_ci_required_context_contract(root=root)
            self.assertIn("ci-required-context-unproduced", {v.code for v in violations})
            details = " ".join(d for v in violations for d in v.details)
            self.assertIn("main", details)

    def test_rejects_a_required_context_producer_with_path_filters(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            produced = sorted(set(CI_STRICTNESS_REQUIRED_CONTEXTS) - EXTERNALLY_POSTED_CONTEXTS)
            workflow = _workflow(produced).replace(
                "    branches: [main, dev]\n",
                "    branches: [main, dev]\n    paths: ['tools/**']\n",
            )
            (root / ".github" / "workflows" / "ci.yml").write_text(workflow, encoding="utf-8")
            violations = run_ci_required_context_contract(root=root)
            self.assertIn("ci-required-context-unproduced", {v.code for v in violations})

    def test_rejects_a_scalar_branch_filter_instead_of_treating_it_as_unfiltered(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            produced = sorted(set(CI_STRICTNESS_REQUIRED_CONTEXTS) - EXTERNALLY_POSTED_CONTEXTS)
            workflow = _workflow(produced).replace(
                "    branches: [main, dev]\n", "    branches: main\n"
            )
            (root / ".github" / "workflows" / "ci.yml").write_text(workflow, encoding="utf-8")
            violations = run_ci_required_context_contract(root=root)
            self.assertIn("ci-required-context-unproduced", {v.code for v in violations})

    def test_accepts_producers_split_across_branch_filtered_workflows(self):
        # Splitting the same checks across a main-only and a dev-only workflow
        # satisfies both branches; the gate must not demand one workflow do both.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            produced = sorted(set(CI_STRICTNESS_REQUIRED_CONTEXTS) - EXTERNALLY_POSTED_CONTEXTS)
            (root / ".github" / "workflows" / "ci.yml").write_text(
                _workflow(produced, branches=("main",)), encoding="utf-8"
            )
            (root / ".github" / "workflows" / "ci-dev.yml").write_text(
                _workflow(produced, branches=("dev",)), encoding="utf-8"
            )
            violations = [
                v for v in run_ci_required_context_contract(root=root)
                if v.code == "ci-required-context-unproduced"
            ]
            self.assertEqual(
                violations, [], msg=f"unexpected: {[v.render() for v in violations]}"
            )

    def test_an_unfiltered_trigger_covers_every_protected_branch(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            produced = sorted(set(CI_STRICTNESS_REQUIRED_CONTEXTS) - EXTERNALLY_POSTED_CONTEXTS)
            (root / ".github" / "workflows" / "ci.yml").write_text(
                _workflow(produced, branches=None), encoding="utf-8"
            )
            violations = [
                v for v in run_ci_required_context_contract(root=root)
                if v.code == "ci-required-context-unproduced"
            ]
            self.assertEqual(
                violations, [], msg=f"unexpected: {[v.render() for v in violations]}"
            )

    def test_fails_closed_when_no_workflow_resolves(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            (root / ".github" / "workflows" / "ci.yml").unlink()
            violations = run_ci_required_context_contract(root=root)
            self.assertTrue(violations, "a scan that resolved no workflow must fail, not pass")

    def test_the_real_repository_satisfies_the_contract(self):
        violations = run_ci_required_context_contract()
        self.assertEqual(violations, [], msg=f"{[v.render() for v in violations]}")

    def test_ci_runs_the_complete_pre_commit_configuration(self):
        workflow = (Path(__file__).parents[2] / ".github" / "workflows" / "ci.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("pre-commit run --all-files", workflow)


class ProtectionFieldContractTest(unittest.TestCase):
    """The declared protection policy must be real, not decoration.

    `admin_bypass_allowed` and `changes_land_via_pull_request` sat in the baseline
    read by nothing until issue #1155 (GC-P031), which is the same shape of problem
    as a required context with no producing job: declared intent that no gate
    defends.
    """

    def _root(self, tmp_dir, **overrides):
        root = Path(tmp_dir)
        contexts = CI_STRICTNESS_REQUIRED_CONTEXTS
        (root / ".github" / "workflows").mkdir(parents=True)
        (root / ".github" / "branch-protection-baseline.json").write_text(
            json.dumps(_baseline(contexts, **overrides)), encoding="utf-8"
        )
        (root / ".github" / "workflows" / "ci.yml").write_text(
            _workflow(sorted(set(contexts) - EXTERNALLY_POSTED_CONTEXTS)), encoding="utf-8"
        )
        return root

    def _codes(self, root):
        return {v.code for v in run_ci_required_context_contract(root=root)}

    def test_accepts_a_branch_declaring_every_protection_field(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            violations = run_ci_required_context_contract(root=self._root(tmp_dir))
            self.assertEqual(
                violations, [], msg=f"unexpected: {[v.render() for v in violations]}"
            )

    def test_rejects_a_branch_that_omits_a_declared_protection_field(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            baseline = json.loads(
                (root / ".github" / "branch-protection-baseline.json").read_text(encoding="utf-8")
            )
            del baseline["branches"]["dev"]["force_pushes_allowed"]
            (root / ".github" / "branch-protection-baseline.json").write_text(
                json.dumps(baseline), encoding="utf-8"
            )
            self.assertIn("ci-required-context-baseline-malformed", self._codes(root))

    def test_rejects_a_branch_declaring_a_field_nothing_compares(self):
        # The two-sided direction: a field the comparator cannot read is decoration.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir, signatures_required=True)
            self.assertIn("ci-required-context-baseline-malformed", self._codes(root))

    def test_rejects_a_protection_field_of_the_wrong_type(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir, force_pushes_allowed="false")
            self.assertIn("ci-required-context-baseline-malformed", self._codes(root))

    def test_rejects_a_branch_whose_changes_need_no_pull_request(self):
        # Landing changes without a pull request is the gate-weakening direction,
        # so this one field is pinned rather than merely type-checked.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir, changes_land_via_pull_request=False)
            self.assertIn("ci-required-context-pull-request-required", self._codes(root))

    def test_rejects_a_malformed_review_policy(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir, review_policy={"dismiss_stale_reviews": "yes"})
            self.assertIn("ci-required-context-baseline-malformed", self._codes(root))

    def test_the_real_baseline_satisfies_the_protection_field_contract(self):
        # The contract is only meaningful if the repository's own baseline passes it.
        violations = [
            v
            for v in run_ci_required_context_contract()
            if v.code
            in {
                "ci-required-context-baseline-malformed",
                "ci-required-context-pull-request-required",
                "ci-required-context-not-strict",
            }
        ]
        self.assertEqual(violations, [], msg=f"{[v.render() for v in violations]}")

    def test_rejects_a_review_policy_missing_a_governed_leaf(self):
        # A partial review policy is a policy whose unlisted leaves nothing compares.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(
                tmp_dir,
                review_policy={
                    "dismiss_stale_reviews": True,
                    "required_approving_review_count": 0,
                },
            )
            self.assertIn("ci-required-context-baseline-malformed", self._codes(root))

    def test_rejects_a_review_policy_leaf_nothing_compares(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(
                tmp_dir,
                review_policy={
                    "dismiss_stale_reviews": True,
                    "require_code_owner_reviews": False,
                    "require_last_push_approval": False,
                    "required_approving_review_count": 0,
                    "require_signed_commits": True,
                },
            )
            self.assertIn("ci-required-context-baseline-malformed", self._codes(root))

    def test_rejects_a_review_count_declared_as_a_boolean(self):
        # bool subclasses int, so `true` would otherwise pass as a review count.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(
                tmp_dir,
                review_policy={
                    "dismiss_stale_reviews": True,
                    "require_code_owner_reviews": False,
                    "require_last_push_approval": False,
                    "required_approving_review_count": True,
                },
            )
            self.assertIn("ci-required-context-baseline-malformed", self._codes(root))

    def test_rejects_a_baseline_declaring_a_branch_that_is_not_protected(self):
        # Iterating only the protected tuple would skip it entirely, so a stray
        # branch entry could carry any policy at all and never be looked at.
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            path = root / ".github" / "branch-protection-baseline.json"
            baseline = json.loads(path.read_text(encoding="utf-8"))
            baseline["branches"]["release/1.x"] = baseline["branches"]["main"]
            path.write_text(json.dumps(baseline), encoding="utf-8")
            self.assertIn("ci-required-context-baseline-malformed", self._codes(root))

    def test_rejects_contexts_declared_as_something_other_than_a_list(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            path = root / ".github" / "branch-protection-baseline.json"
            baseline = json.loads(path.read_text(encoding="utf-8"))
            baseline["branches"]["main"]["required_status_checks"]["contexts"] = {"policy": True}
            path.write_text(json.dumps(baseline), encoding="utf-8")
            self.assertIn("ci-required-context-baseline-malformed", self._codes(root))

    def test_rejects_a_non_string_context_entry_instead_of_coercing_it(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            path = root / ".github" / "branch-protection-baseline.json"
            baseline = json.loads(path.read_text(encoding="utf-8"))
            baseline["branches"]["dev"]["required_status_checks"]["contexts"] = [123]
            path.write_text(json.dumps(baseline), encoding="utf-8")
            self.assertIn("ci-required-context-baseline-malformed", self._codes(root))

    def test_rejects_duplicate_declared_contexts(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = self._root(tmp_dir)
            path = root / ".github" / "branch-protection-baseline.json"
            baseline = json.loads(path.read_text(encoding="utf-8"))
            contexts = baseline["branches"]["dev"]["required_status_checks"]["contexts"]
            baseline["branches"]["dev"]["required_status_checks"]["contexts"] = contexts + ["policy"]
            path.write_text(json.dumps(baseline), encoding="utf-8")
            self.assertIn("ci-required-context-baseline-malformed", self._codes(root))

    def test_the_governed_review_leaves_cover_the_settings_a_review_gate_loses(self):
        # `require_last_push_approval` and `require_code_owner_reviews` are the
        # scalars whose absence silently weakens review. The bypass allowances are
        # the collection that defeats the pull-request boundary outright while every
        # scalar still matches.
        self.assertEqual(
            CI_STRICTNESS_REVIEW_POLICY_FIELDS,
            frozenset(
                {
                    "bypass_pull_request_allowances",
                    "dismiss_stale_reviews",
                    "require_code_owner_reviews",
                    "require_last_push_approval",
                    "required_approving_review_count",
                }
            ),
        )

    def test_every_governed_field_is_named_in_the_declaration(self):
        self.assertIn("review_policy", CI_STRICTNESS_PROTECTION_FIELDS)
        self.assertIn("force_pushes_allowed", CI_STRICTNESS_PROTECTION_FIELDS)


if __name__ == "__main__":
    unittest.main()
