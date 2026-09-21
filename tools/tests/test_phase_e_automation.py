"""Contract tests for the automated Phase E workflow shape (issue #1671).

The workflow's path is a trust anchor: `gc_close_issue_after_merge` accepts a final-report
marker from the repository's Actions identity only after verifying that the run it cites
belongs to that exact file. Nothing else notices if the file is renamed, if the merged
guard is dropped, or if the job starts checking out the pull-request head — the failure
mode is a delivery that silently never finalizes, or one that finalizes from untrusted
code. The check is two-sided, so these tests assert both that the repository's real
workflow passes and that each way of breaking it is caught.
"""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import yaml

from tools.policy.core import REPO_ROOT
from tools.policy.phase_e_automation import (
    TRUST_ANCHOR_PATH,
    WORKFLOW_PATH,
    run_phase_e_automation_contract,
)


def _codes(violations: list) -> set[str]:
    """The violation codes a run produced."""
    return {violation.code for violation in violations}


class PhaseEAutomationContractTest(unittest.TestCase):
    """The repository's own workflow, and each mutation the contract must reject."""

    def setUp(self) -> None:
        """Load the real workflow and trust anchor once per test."""
        self.workflow_text = (REPO_ROOT / WORKFLOW_PATH).read_text(encoding="utf-8")
        self.anchor_text = (REPO_ROOT / TRUST_ANCHOR_PATH).read_text(encoding="utf-8")
        # Bound the scan: an empty or trivial workflow would pass several assertions below
        # by matching nothing at all.
        self.assertGreater(len(self.workflow_text.splitlines()), 30)
        document = yaml.safe_load(self.workflow_text)
        self.assertIn("finalize", document["jobs"])

    def _root_with(self, workflow_text: str, anchor_text: str | None = None) -> TemporaryDirectory:
        """A temp root carrying the two files this contract reads."""
        tmp = TemporaryDirectory()
        root = Path(tmp.name)
        workflow = root / WORKFLOW_PATH
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text(workflow_text, encoding="utf-8")
        anchor = root / TRUST_ANCHOR_PATH
        anchor.parent.mkdir(parents=True, exist_ok=True)
        anchor.write_text(anchor_text if anchor_text is not None else self.anchor_text, encoding="utf-8")
        return tmp

    def _codes_for(self, workflow_text: str, anchor_text: str | None = None) -> set[str]:
        """Run the contract against a temp root built from the given file contents."""
        with self._root_with(workflow_text, anchor_text) as name:
            return _codes(run_phase_e_automation_contract(Path(name)))

    def test_repository_workflow_satisfies_the_contract(self) -> None:
        """The shipped workflow must pass, or the gate is decorative."""
        self.assertEqual(_codes(run_phase_e_automation_contract(REPO_ROOT)), set())

    def test_missing_workflow_is_reported(self) -> None:
        """Automated Phase E cannot run without its workflow."""
        with TemporaryDirectory() as name:
            self.assertEqual(
                _codes(run_phase_e_automation_contract(Path(name))),
                {"phase-e-workflow-missing"},
            )

    def test_dropping_the_merged_guard_is_reported(self) -> None:
        """A merely-closed pull request must finalize nothing."""
        drifted = self.workflow_text.replace(
            "github.event.pull_request.merged == true", "always()"
        )
        self.assertIn("phase-e-workflow-merge-guard", self._codes_for(drifted))

    def test_pull_request_target_is_reported(self) -> None:
        """`pull_request_target` would hand a write token to fork-controlled code."""
        drifted = self.workflow_text.replace("  pull_request:\n", "  pull_request_target:\n", 1)
        self.assertIn("phase-e-workflow-trigger", self._codes_for(drifted))

    def test_widening_the_trigger_beyond_closed_is_reported(self) -> None:
        """The job has no business running while a pull request is still open."""
        drifted = self.workflow_text.replace("types: [closed]", "types: [closed, opened]")
        self.assertIn("phase-e-workflow-trigger", self._codes_for(drifted))

    def test_extra_write_permission_is_reported(self) -> None:
        """Phase E writes the final report and closes the issue, and nothing else."""
        drifted = self.workflow_text.replace("  contents: read", "  contents: write", 1)
        self.assertIn("phase-e-workflow-permissions", self._codes_for(drifted))

    def test_checking_out_the_pull_request_head_is_reported(self) -> None:
        """Phase E reads the merged tree; it must never place the head in the job."""
        drifted = self.workflow_text.replace(
            "github.event.pull_request.merge_commit_sha || github.sha",
            "github.event.pull_request.head.sha",
        )
        self.assertIn("phase-e-workflow-head-checkout", self._codes_for(drifted))

    def test_persisted_credentials_are_reported(self) -> None:
        """A credential left in the job's git config outlives the step that needed it."""
        drifted = self.workflow_text.replace("persist-credentials: false", "persist-credentials: true")
        self.assertIn("phase-e-workflow-head-checkout", self._codes_for(drifted))

    def test_trust_anchor_that_names_another_file_is_reported(self) -> None:
        """Renaming the workflow without the anchor would stop every automated close."""
        drifted_anchor = self.anchor_text.replace(
            WORKFLOW_PATH.as_posix(), ".github/workflows/something-else.yml"
        )
        self.assertIn(
            "phase-e-trust-anchor-drift",
            self._codes_for(self.workflow_text, drifted_anchor),
        )

    def test_dropping_the_run_name_binding_is_reported(self) -> None:
        """A run is bound to its pull request through the run name when GitHub supplies no
        association, which for the merged-pull-request trigger is always."""
        drifted = "\n".join(
            line for line in self.workflow_text.splitlines() if not line.startswith("run-name:")
        )
        self.assertIn("phase-e-workflow-run-name", self._codes_for(drifted))

    def test_a_run_name_missing_either_half_of_the_expression_is_reported(self) -> None:
        """Both triggers bind through the run name, so both halves have to be pinned.

        Issue #1683: the merged-pull-request trigger never carries a `pull_requests`
        association, so `github.event.pull_request.number` is load-bearing evidence, not a
        convenience. GitHub uses the pull-request title when `run-name:` is absent, so a
        half-pinned expression is a path from attacker-authored text to a trusted binding.
        """
        for replacement in (
            "run-name: Ground Control Phase E for PR ${{ inputs.pr }}",
            "run-name: Ground Control Phase E for PR ${{ github.event.pull_request.number }}",
        ):
            with self.subTest(replacement=replacement):
                drifted = "\n".join(
                    replacement if line.startswith("run-name:") else line
                    for line in self.workflow_text.splitlines()
                )
                self.assertIn("phase-e-workflow-run-name", self._codes_for(drifted))

    def test_unparseable_workflow_is_reported_distinctly(self) -> None:
        """A broken file is a different problem from a missing one."""
        self.assertIn("phase-e-workflow-unreadable", self._codes_for("name: [unclosed\n"))


if __name__ == "__main__":
    unittest.main()
