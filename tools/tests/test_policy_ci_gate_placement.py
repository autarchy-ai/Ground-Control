"""Contracts for CI checks whose configuration has more than one consumer."""

import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

import yaml

from tools.policy import ci_strictness


class PrTitleParityContractTest(unittest.TestCase):
    def test_real_repository_uses_one_pr_title_contract(self):
        violations = ci_strictness.run_pr_title_contract()
        self.assertEqual([], violations, msg=f"{[v.render() for v in violations]}")

    def test_rejects_drift_between_ci_and_mcp_configuration(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / ".github" / "workflows").mkdir(parents=True)
            (root / ".ground-control.yaml").write_text(
                "workflow:\n  pr_title:\n    types: [feat, fix]\n"
                "    require_scope: false\n    subject_pattern: '^[a-z].*$'\n",
                encoding="utf-8",
            )
            (root / ".github" / "workflows" / "pr-title.yml").write_text(
                "jobs:\n  lint-pr-title:\n    steps:\n      - with:\n"
                "          types: |\n            feat\n            docs\n"
                "          requireScope: false\n          subjectPattern: '^[a-z].*$'\n",
                encoding="utf-8",
            )
            codes = {v.code for v in ci_strictness.run_pr_title_contract(root)}
            self.assertIn("pr-title-contract-drift", codes)


class ImmutableActionPinContractTest(unittest.TestCase):
    def test_real_repository_pins_every_external_action(self):
        violations = ci_strictness.run_github_action_pin_contract()
        self.assertEqual([], violations, msg=f"{[v.render() for v in violations]}")

    def test_rejects_a_floating_action_reference(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / ".github" / "workflows").mkdir(parents=True)
            (root / ".github" / "workflows" / "ci.yml").write_text(
                "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n",
                encoding="utf-8",
            )
            codes = {v.code for v in ci_strictness.run_github_action_pin_contract(root)}
            self.assertIn("github-action-not-immutable", codes)

    def test_fails_closed_when_no_workflow_is_scanned(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            codes = {
                v.code
                for v in ci_strictness.run_github_action_pin_contract(Path(tmp_dir))
            }
            self.assertIn("github-action-pin-scan-empty", codes)


class MainToDevSyncWorkflowTest(unittest.TestCase):
    WORKFLOW_PATH = (
        Path(__file__).parents[2] / ".github" / "workflows" / "sync-main-to-dev.yml"
    )

    def _workflow_script(self) -> str:
        workflow = yaml.safe_load(self.WORKFLOW_PATH.read_text(encoding="utf-8"))
        steps = workflow["jobs"]["backmerge"]["steps"]
        return next(step["run"] for step in steps if step.get("name") == "Open or update the back-merge PR")

    def _run_workflow_script(
        self,
        *,
        remote_sha: str,
        main_sha: str,
        open_pr: dict[str, object] | None = None,
        merged_pr: dict[str, object] | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], list[str]]:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            log_path = root / "calls.log"
            git = root / "git"
            git.write_text(
                textwrap.dedent(
                    """\
                    #!/bin/bash
                    set -euo pipefail
                    printf 'git %s\\n' "$*" >>"${MOCK_CALL_LOG}"
                    case "$1" in
                      fetch) exit 0 ;;
                      diff) exit 1 ;;
                      ls-remote)
                        if [[ -n "${MOCK_REMOTE_SHA}" ]]; then
                          printf '%s\\trefs/heads/sync/main-to-dev\\n' "${MOCK_REMOTE_SHA}"
                        fi
                        ;;
                      rev-parse) printf '%s\\n' "${MOCK_MAIN_SHA}" ;;
                      push) exit 0 ;;
                      *) echo "unexpected git command: $*" >&2; exit 70 ;;
                    esac
                    """
                ),
                encoding="utf-8",
            )
            gh = root / "gh"
            gh.write_text(
                textwrap.dedent(
                    """\
                    #!/bin/bash
                    set -euo pipefail
                    printf 'gh %s\\n' "$*" >>"${MOCK_CALL_LOG}"
                    if [[ "$*" == *"pr list"*"--state open"* ]]; then
                      printf '%s\\n' "${MOCK_OPEN_PR_JSON}"
                    elif [[ "$*" == *"pr list"*"--state merged"* ]]; then
                      printf '%s\\n' "${MOCK_MERGED_PR_JSON}"
                    elif [[ "$*" == *"pr create"* ]]; then
                      printf 'https://example.invalid/pull/1\\n'
                    else
                      echo "unexpected gh command: $*" >&2
                      exit 71
                    fi
                    """
                ),
                encoding="utf-8",
            )
            git.chmod(0o755)
            gh.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{root}:{os.environ['PATH']}",
                "GITHUB_REF": "refs/heads/main",
                "MOCK_CALL_LOG": str(log_path),
                "MOCK_REMOTE_SHA": remote_sha,
                "MOCK_MAIN_SHA": main_sha,
                "MOCK_OPEN_PR_JSON": json.dumps(open_pr or {}),
                "MOCK_MERGED_PR_JSON": json.dumps(merged_pr or {}),
            }
            result = subprocess.run(
                ["bash", "-c", self._workflow_script()],
                cwd=Path(__file__).parents[2],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            calls = log_path.read_text(encoding="utf-8").splitlines()
            return result, calls

    def test_automation_branch_update_is_ref_owned_and_lease_bound(self):
        workflow = self.WORKFLOW_PATH.read_text(encoding="utf-8")
        self.assertIn('GITHUB_REF} != "refs/heads/main"', workflow)
        self.assertIn("number,author,headRefOid", workflow)
        self.assertIn('github-actions[bot]', workflow)
        self.assertIn('app/github-actions', workflow)
        self.assertIn('--force-with-lease="refs/heads/${branch}:${remote_sha}"', workflow)
        self.assertNotIn("git push --force origin", workflow)

    def test_retries_pr_creation_when_branch_already_matches_main(self):
        sha = "a" * 40
        result, calls = self._run_workflow_script(remote_sha=sha, main_sha=sha)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call.startswith("git push ") for call in calls), calls)
        self.assertTrue(any(call.startswith("gh pr create ") for call in calls), calls)

    def test_updates_branch_after_its_previous_bot_owned_pr_was_merged(self):
        old_sha = "a" * 40
        new_sha = "b" * 40
        result, calls = self._run_workflow_script(
            remote_sha=old_sha,
            main_sha=new_sha,
            merged_pr={
                "number": 123,
                "author": {"login": "github-actions[bot]"},
                "headRefOid": old_sha,
            },
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            f"git push --force-with-lease=refs/heads/sync/main-to-dev:{old_sha} "
            "origin origin/main:refs/heads/sync/main-to-dev",
            calls,
        )
        self.assertTrue(any(call.startswith("gh pr create ") for call in calls), calls)

    def test_refuses_stale_branch_without_current_or_completed_bot_ownership(self):
        result, calls = self._run_workflow_script(
            remote_sha="a" * 40,
            main_sha="b" * 40,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call.startswith("git push ") for call in calls), calls)
        self.assertFalse(any(call.startswith("gh pr create ") for call in calls), calls)


if __name__ == "__main__":
    unittest.main()
