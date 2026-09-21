---
stage_id: final_report
step: "Step 17"
tier: medium
---

# Step 17: Completion (Readiness pre-merge, Assertions + Final Report post-merge)

Use `gc_implement_mechanical action="readiness"` for the pre-merge invocation.
Besides the readiness record it writes the trusted **delivery handoff** (issue
#1671, ADR-102): an issue-thread record carrying the exact tool-shaped completion
payload, digest-bound to the issue, the PR, and the PR head OID whose required
hosted checks it just verified, plus a pointer comment on the PR naming that
record. That handoff is what lets the run end here: **the agent may terminate
permanently once readiness returns**, and `.github/workflows/ground-control-phase-e.yml`
replays the payload through `finalize` when the PR merges, with no model or agent
session. Nothing in this workflow polls for or waits on the merge.

`gc_implement_mechanical action="finalize"` performs the post-merge completion
assertion and the idempotent Step 20 issue close in one deterministic call. The
merged-PR workflow is its normal caller; an agent re-invoked on the issue after a
merge is the fallback, and reaches the same tool with the same result.

This step calls `gc_assert_completion`, and it is invoked **twice across the run** with a different `phase` (issue #963):

- **Phase D terminal - `phase="pre_merge"`.** Runs after Step 11 (SonarCloud) once all automated gates are green. The requirement `status:` transition (Step 15) and `## Traceability` reconciliation (Step 16) have already been made in the delivery diff (issue #1541), so this record names that state as **proposed** — authoritative only after merge. It posts a **readiness record** (a "Ready for review" comment carrying a `ready_for_review` phase marker - *not* a `gc:final-report` marker) and does not verify against a merge revision (there is none yet). Then the run **STOPS** for the user to review and merge the PR. This is the single human touchpoint.
- **Phase E completion - `phase="post_merge"` (default).** Runs after the user merges, normally inside the merged-PR workflow rather than in an agent session. Once the linked PR is observed as merged, enter Phase E immediately. Do not wait for post-merge GitHub Actions or other additional actions to complete; target-branch workflows, release jobs, security scans, and sibling-agent work are not Phase E prerequisites. It performs **no** requirement-file mutation. It is **merge-gated**: it refuses with `completion_pr_not_merged` unless the linked PR is merged, then re-derives the in-scope UID set from the issue and **verifies every requirement at the linked PR's immutable merge revision** (exact UID path, frontmatter id, expected lifecycle status, required traceability). It fails closed with `completion_requirement_state_unverified` (or `completion_scope_mismatch`) before posting anything, and renders the **observed merged values**, not caller-supplied status. Only on success does it post the final report. Steps 17–19 from the original workflow are collapsed into this single tool call per issue #1103.

The pre-merge/post-merge split exists so requirement state and the durable final report never claim more than the merged target branch actually holds. Issue #1541 moves the transition and traceability edits into the delivery PR (superseding the #963 post-merge mutation ordering) and makes Phase E verify them at the immutable merge result rather than trusting caller-supplied status.

For both phases, `gc_assert_completion` re-reads the trusted
`gc:execution-obligation` ledger from the issue thread. It refuses with
`completion_open_execution_obligations` while any real problem remains open.
Caller summaries or cached arrays cannot override this gate. Repair and verify
every obligation, record its resolution, then retry completion.
A station observation whose verdict is already on the thread is listed in
`recoverable_station_observations`, and `next_action` is
`reconcile_station_observations_then_retry` when nothing else is open. Resolve
each entry with `gc_reconcile_station_observation` (its `obligation_id` and
`findings_record_url`), then retry (issue #1582).

**Precondition (post_merge only)**: the requirement `status:` transition (Step 15) and `## Traceability` reconciliation (Step 16) must already be part of the merged delivery PR — they were committed pre-publish (issue #1541), not in Phase E. Phase E makes **no** requirement-file edits: do **not** manufacture a placeholder requirement-file edit, and do **not** run the completion command, the policy suite, the pre-push reviews, or any other implementation verification for Phase E — `finalize` runs no `verify` gate (issue #1543). The tool instead reads the merged requirement files at the immutable merge revision and refuses if their state does not match; the pre-merge readiness record names only proposed state.

**You MUST NOT merge the PR. You MUST NOT run `gh pr merge`. The user reviews and merges.**

**Do not wait for the merge.** Once the readiness call returns `ok: true`, Phase D is
complete and the run ends. The delivery handoff carries everything Phase E needs, so
there is nothing left for this session to do and nothing to poll.

## What gc_assert_completion does (`phase="post_merge"`)

Call `gc_assert_completion` with `phase="post_merge"` (the default) after the user merges. The tool first verifies the linked PR is merged (`merged_at` non-null AND state `MERGED`) - refusing with `completion_pr_not_merged` / `next_action:"wait_for_user_to_merge_the_pr"` otherwise - then verifies merged requirement state and posts the final report:

1. **Merged-state verification** (issue #1541): the tool re-derives the in-scope UID set from the issue, requires the caller `requirements[]` to match it exactly, resolves the PR's merge-commit OID, and reads each `docs/requirements/<UID>/requirement.md` at that immutable revision. Any missing file, malformed record, UID mismatch, status mismatch, or missing required traceability fails closed (`completion_requirement_state_unverified`) before the final report — identifying the UID plus expected/observed state without leaking requirement bodies. `override` + `override_reason` is the recorded escape hatch. Requirement-free runs skip this.
2. **Final report** (`gc_post_final_report`): renders the structured final-report Markdown (with the **observed** merged status, cited against the merge revision) and posts it as a comment. It enforces the real gates — CI green, Sonar pass-or-legit-skipped, the mandatory Codex review, and the sensitive/defer/reserved-marker scrubs.

The tool returns `{ok, assertions[], final_report}`. The `assertions` array contains one entry per assertion: `{name, ok, comment_url, comment_id}`.

## Required inputs

Pass to `gc_assert_completion`:

- `repo_path`, `issue_number`, `pr_number`
- `plain_english_outcome`: required; 1–3 short sentences explaining what the change lets product users, operators, or maintainers do now.
- `requirements`: array of `{uid, title, status, note?}` - one entry per UID in `in_scope_requirements[]`
- `files`: `{added, modified, renamed, deleted}` (any key may be omitted)
- `reviews`: array of `{reviewer, summary}` - one per reviewer
- `traceability`: `{added, updated, deleted, notes?}` - short strings describing reconciliation outcome
- `ci_status`: `"green"` (never `"skipped"` for a real PR)
- `sonar_status`: `"passed"`, `"failed"`, or `"skipped"` (when `cfg.sonarcloud` is null)
- `plan_comment_url`: URL cached in Step 4
- `touched_files` (optional): list of files touched, for the traceability assertion
- `project` (optional): Ground Control project key. When omitted, inferred from `repo_path`'s `.ground-control.yaml`; an explicit value overrides the config.
- `override` / `override_reason` (optional): user-authorized escape hatch for the post-merge merged-requirement-state assertion; fail-closed by default and recorded in the final report when used
- `phase`: `"post_merge"` (default) for the Phase E completion; `"pre_merge"` for the Phase D readiness call.

## The pre-merge readiness call (`phase="pre_merge"`)

At the end of Phase D (after Step 11), call `gc_assert_completion` with `phase="pre_merge"`. Pass `requirements` with their **proposed** status (the transition from Step 15 is already in the diff, so a materially-implemented requirement is ACTIVE here), plus `files`, `reviews`, `ci_status`, `sonar_status`, `plan_comment_url`, and `plain_english_outcome`. The tool skips both the merge gate and the merge-revision verification (there is no merge yet), renders the requirements as *proposed* (authoritative only after merge), still enforces every input gate (CI green, Sonar pass/legit-skip, codex review present, sensitive/reserved/defer scrubs, body size), and posts the readiness record. It returns `{ok, phase:"pre_merge", readiness_report:{comment_url, comment_id}, assertions:[]}`. **Then STOP** - the run is paused for the user to review and merge. Do not run Step 20 in this invocation.

## Label removal is not this step's job

Do NOT remove the `in-progress` label here, and do not run `gh` to touch it. This step is reached twice, and the pre-merge invocation above is the readiness call: at that point the pull request is open and awaiting review, so the issue genuinely IS in progress and the label is doing exactly what it exists for. Removing it here inverts the signal on the one issue that most needs it.

The label is dropped by `gc_close_issue_after_merge`, at the shared close boundary, once the issue is actually closed (issue #1686). Every caller reaches it — the merged-pull-request workflow, `gc_finalize_merged_pr`, an agent re-invoked after a merge, and `/quickfix` Q7 — so no lane has to remember. It is best-effort there: a failed removal never changes the close outcome or the reported result of finalization.

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "assertions": [
      {"name": "traceability_reconciled", "ok": true, "comment_url": "<URL>"}
    ],
    "final_report": {
      "comment_url": "<URL>",
      "comment_id": "<int>"
    }
  }
}
```

The `phase="pre_merge"` call is the **last step of Phase D**: do NOT proceed to merge; the user reviews and merges the PR, and this session ends. After the merge, Phase E runs as a validation-only sequence, normally in the merged-PR workflow with no agent session and otherwise by re-invoking `/implement <issue>`. The transition and reconciliation already merged with the PR (issue #1541): this step with `phase="post_merge"` (the merge-gated, merge-revision-verified final report above) → **Step 20** (`gc_close_issue_after_merge`, which requires the merged PR AND the validated `gc:final-report` marker before closing). The `phase="post_merge"` call is the last step before the close.
