---
name: ship
description: Ship current branch - CI, SonarCloud, code review, security review, fix all issues, merge. Assumes code is already committed and pushed.
disable-model-invocation: true
---

# Ship Current Branch

Assumes code is already committed and pushed. Handles: PR creation, CI monitoring, SonarCloud, code review, security review, fixing all issues, and merging.

**IMPORTANT:** NEVER include Co-Authored-By, "Generated with Claude Code," or any Claude/AI attribution in commit messages, PR descriptions, or any other artifacts.

## Phase 0: Read Repo Workflow Config

If you are running `/ship` directly (not as part of an earlier `/implement` session), call the `gc_get_repo_ground_control_context` MCP tool with the absolute repo path to load the repo's workflow config. If running after `/implement`, reuse the config already cached in that session.

Cache the following fields for use below:
- `sonarcloud.project_key` and `sonarcloud.organization` - used by Phase 3. If the whole `sonarcloud` block is null, Phase 3 is skipped entirely.

If the tool does NOT return `status: "ok"`, stop and ask the user to create `.ground-control.yaml` at the repo root (include the `suggested_ground_control_yaml` from the tool response).

## Phase 1: Create PR

1. Determine the current branch: `git branch --show-current`
2. Check if a PR already exists: `gh pr list --head <branch> --json number,url`
3. If no PR exists, create one:
   ```
   gh pr create --base dev --title "<concise title>" --body "<description>"
   ```
4. Note the PR number.

## Phase 2: CI Monitor

1. Find the latest workflow run: `gh run list --branch <branch> --limit 1 --json status,conclusion,databaseId`
2. If the run is in progress, watch it: `gh run watch <id>`
3. If it failed:
   - Get failed logs: `gh run view <id> --log-failed`
   - Diagnose and fix the issue.
   - `git add`, `git commit`, `git push`.
   - Go back to step 1.
4. If it succeeded, proceed.

## Phase 3: SonarCloud Check

**Skip this entire phase if `sonarcloud` was null in the Phase 0 config.** Log "SonarCloud skipped - no sonarcloud block in .ground-control.yaml" and proceed to Phase 4.

Otherwise:
1. Wait 60 seconds for SonarCloud analysis to propagate.
2. Use `get_project_quality_gate_status` with the `sonarcloud.project_key` cached in Phase 0 to check the quality gate.
3. Use `search_sonar_issues_in_projects` with the same key to find new issues on the current branch.
4. If issues found:
   - Fix them.
   - `git add`, `git commit`, `git push`.
   - Re-run Phase 2.
5. If clean, proceed.

## Review loop rules (apply to every review phase below)

The Codex cross-model review phase follows this loop:

1. **Invoke the review.**
2. **Read the FULL output.** Do not stop after the first few findings.
3. **Fix ALL issues the reviewer identifies - blocking or not, severity-rated or not, "nitpick" or not.** There is no triage bucket. "Low priority," "nice to have," "follow-up PR," "out of scope" are not valid reasons to skip a finding.
4. **If you cannot or believe you should not fix a specific finding**, you MUST stop and ask the user for explicit permission to leave it unfixed. Do not decide unilaterally. State the finding, explain why you think it should be skipped, and wait for the user's answer. Resume only after they explicitly confirm.
5. **Re-run the SAME review after fixing.** Do not assume your fixes are complete - the re-run is the verification.
6. **Repeat until the reviewer reports zero findings, OR the cycle cap is hit.**
7. **Cycle cap: 5 iterations per review phase.** If a review still reports findings after 5 invoke→fix→re-run cycles, STOP and escalate to the user with the full history of findings, fixes, and remaining issues. Do not loop indefinitely.

For every cycle, after applying fixes, commit and push BEFORE re-running the review so the reviewer sees the updated tree. Format every fix commit as `Fix review findings (<reviewer>, cycle <N>)` so the loop history is visible in git log.

## Phase 4: Codex Cross-Model Review

`gc_codex_review` runs two focused codex reviewers in parallel - a core production-readiness reviewer and a dedicated application-security reviewer - against a single pre-computed diff. Both post their findings as inline PR review comments with a reviewer-tagged title (`[core]` or `[security]`). The tool returns a single deduplicated list; you then drive a per-finding fix/verify loop via `gc_codex_verify_finding`, which handles the GitHub API bookkeeping for you.

1. Run `pwd` to capture the absolute repository root.
2. Determine the pull request number for the current branch: `gh pr view --json number`. Cache it.
3. Call the `gc_codex_review` MCP tool with:
   - `repo_path`: absolute path from `pwd`
   - `base_branch`: `dev`
   - `pr_number`: the PR number from step 2
4. The tool returns `{pr_number, finding_count, comments: [{comment_id, thread_id, reviewer, path, line, title, html_url}, ...], reviewers, core_review_text, security_review_text}`. Each comment carries a `reviewer` field (`core` or `security`) so you can triage attention, but the fix/verify loop below is the same regardless. Codex has already posted each finding as an inline PR review comment - you do NOT need to post anything yourself.
5. If `finding_count` is 0, skip to Phase 6 (Final CI re-verification).
6. Otherwise, for EACH entry in `comments`, run the following fix/verify loop:
   1. Read the comment body if needed: `gh api /repos/<owner>/<repo>/pulls/comments/<comment_id>`.
   2. Fix the finding locally. Apply the same "fix every finding, no triage, ask user permission if you will not fix" rules from the **Review loop rules** section above.
   3. Run the local completion gate to make sure nothing regressed locally.
   4. Call `gc_codex_verify_finding` with `repo_path`, `pr_number`, and the `comment_id`. Codex will read your local changes and decide:
      - **`status: "resolved"`** - the review thread has already been marked resolved on GitHub. Move on to the next comment.
      - **`status: "unresolved"`** - codex posted a threaded reply with `reply_body` containing concrete new directions. Read `reply_body`, fix per those directions, and re-invoke `gc_codex_verify_finding`. **Per-finding cap: 2 verify calls.** If the third call would be needed, STOP and escalate to the user with the finding, your fix history, and the latest `reply_body`.
7. After all findings in the returned `comments` list are marked `resolved`, commit and push the fixes (one commit per fix cycle, message `Fix review findings (codex, cycle <N>)`), then re-invoke `gc_codex_review` with the same arguments to confirm no new issues surfaced after your fixes.
8. **Overall phase cap: 5 iterations of `gc_codex_review`.** If the fifth invocation still returns findings, STOP and escalate to the user.

**Tool shape**: `gc_codex_verify_finding` accepts only `repo_path`, `pr_number`, and `comment_id`. It reads the comment directly from GitHub; do not try to paraphrase the finding or pass additional context through the tool.

## Phase 5: (retired)

The dedicated test-quality review was removed by ADR-099, along with its MCP
tools and the `review-tests` skill this phase used to invoke. Test design is an
implementation responsibility, checked through the normal implementation,
targeted-test, CI, SonarCloud and human-review surfaces. The phase number is kept
so the numbering below does not move.

## Phase 6: Final CI re-verification

After the review phase has reported zero findings (or you have documented user-approved exceptions):

1. Verify the branch is pushed with the latest fix commits.
2. Re-run Phase 2 (CI Monitor) to confirm CI is still green after the review fixes.
3. Re-run Phase 3 (SonarCloud) - or skip again if `sonarcloud` was null.
4. If either re-check fails, loop back through the review phase - the cycle cap (5) applies to that phase.

## Phase 7: Report (DO NOT MERGE)

**You MUST NOT merge the PR. You MUST NOT run `gh pr merge`. The user reviews and merges.**

- Summary of all changes made during the ship process
- Review findings and what was fixed
- Confirmation: CI green, SonarCloud passed (or skipped if not configured), PR ready for user review
- PR URL
