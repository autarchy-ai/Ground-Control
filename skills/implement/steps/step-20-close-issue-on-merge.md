---
stage_id: close_issue_after_merge
step: "Step 20"
tier: low
---

# Step 20: Close the Issue (Phase E, Post-Merge)

On the normal path this step is already completed by
`gc_implement_mechanical action="finalize"` immediately after the post-merge
completion assertion. Use the standalone close primitive only to repair a
bounded finalize failure.

This step runs in **Phase E**, AFTER the user merges the PR, as the **last** Phase E step - it follows Step 17 `phase="post_merge"` (the merge-revision-verified final report). Since issue #1541, Phase E is validation-only: the requirement transition (Step 15) and traceability reconciliation (Step 16) already merged with the delivery PR, so Phase E is just Step 17 `post_merge` → this close. The /implement orchestrator detects the post-merge state at Step 1 - the Phase D readiness marker (`ready_for_review`) is present, a linked PR is merged, and the post-merge validation has not yet run (no `gc:final-report` marker) - and short-circuits to **Step 17 `post_merge`**. For a requirement-backed run the PR body's non-closing `Refs #<n>` leaves the issue OPEN until this close runs; for a requirement-free run the `Closes #<n>` keyword auto-closes it only when the PR merged into the repository's default branch, which this step's idempotent `already_closed` path handles; a PR merged into the integration branch leaves the issue OPEN for this close (issue #1601). Detection keys on the `gc:final-report` marker being absent, not on the issue being open.

Per ADR-089 (issue #1346), this step performs **only** linked-PR resolution, merge-state verification, and idempotent issue closure. It does not list open issues, rank candidates, or return a next-issue recommendation in any form - closure and next-work selection are separate concerns, and the merge-verified close envelope carries only the close result.

The canonical close path is the MCP tool `gc_close_issue_after_merge`, NOT the agent shelling out to `gh issue close`. The tool gates the close on `merged_at` non-null AND PR state `MERGED`, AND — for an OPEN issue — on a trusted `gc:final-report` marker, which is posted only after Phase E's merged-requirement-state validation succeeds (issue #1541). It refuses (`close_requirement_state_unverified`) otherwise, so the canonical close can never run ahead of validation. `override` + `override_reason` is the recorded escape hatch. For a **requirement-backed** run the PR body uses a non-closing `Refs #<n>` (rendered by `gc_render_pr_body` in Step 9), so GitHub does not auto-close at merge and this tool is the sole closer. For a **requirement-free** run the body keeps `Closes #<n>`, which GitHub honors only when the PR merges into the repository's default branch. On that merge this tool reaches its idempotent `already_closed` no-op; on a PR merged into the integration branch the issue is still open, and the tool closes it through the same marker gate, which Step 17 `post_merge` has already satisfied (issue #1601).

## What this step does

1. Call `gc_close_issue_after_merge` with `repo_path` and `issue_number`.
   - Optional: pass `pr_number` to skip the PR-resolution timeline lookup; the tool fetches the PR directly. When omitted, the tool resolves the merged PR from the issue's GitHub timeline.
2. Read the returned envelope:
   - `{ ok: true, already_closed: false, pr_number, pr_merged_at, pr_url }` - the tool closed the issue. Continue to the orchestrator's wrap-up.
   - `{ ok: true, already_closed: true, pr_number }` - the issue was already closed, for example by `Closes #<n>` on a default-branch merge. Idempotent no-op success; continue.

     **Best-effort tmux rename (step-20)**: On any `ok: true` response (regardless of `already_closed`), when `$TMUX` is set AND `cfg.short_code` is non-null, rename the current tmux session to `<cfg.short_code>-<issue_number>-done` with numeric collision avoidance:

     ```sh
     BASE="${cfg.short_code}-${issue_number}-done"
     TARGET="$BASE"
     N=1
     while tmux list-sessions -F '#S' 2>/dev/null | grep -qx "$TARGET"; do
       N=$((N+1))
       TARGET="${BASE}-${N}"
     done
     tmux rename-session -t "${TMUX_PANE%.*}" "$TARGET" 2>/dev/null || true
     ```

     Skip when `$TMUX` is unset or `cfg.short_code` is null. All errors suppressed.
   - `{ ok: false, error: "close_pr_not_merged", pr_state, pr_merged_at, next_action: "wait_for_user_to_merge_the_pr" }` - the linked PR is open or closed-without-merge. Surface to the user; do not retry until the user has actually merged. This is the gate doing its job: an open or force-closed PR must not trigger an issue close.
   - `{ ok: false, error: "close_no_linked_pr" }` - no PR is linked to the issue. Surface to the user. This typically means the agent is being invoked on the wrong issue, or `/implement` was used as a dry-run that never opened a PR.
   - `{ ok: false, error: "close_requirement_state_unverified", next_action: "post_the_validated_final_report_first_or_authorize_override" }` - the issue is open but no trusted `gc:final-report` marker is present, so merged requirement-state validation has not been recorded. Run Step 17 `phase="post_merge"` first; only if the user explicitly authorizes it, re-run with `override: true` + a non-empty `override_reason`.
   - Other `ok: false` envelopes (gh failures, lookup failures): surface to the user with the tool's `message`.

The tool is idempotent and safe to retry. Re-running on an already-closed issue returns `already_closed: true` with `ok: true`.

## Why this step exists (issue #1058)

Before issue #1058, the only enforcement that the issue closes coherently with the merge was the `Closes #<n>` keyword in the PR body and skill prose at Step 18 saying "do not run `gh issue close` here." That left the close path entirely keyword-dependent: any agent or hook running `gh issue close` between merge and the orchestrator's final report could close an issue against a PR that hadn't merged. Issue #1058 adds the MCP-tool gate so the structural enforcement matches the prose: the close is verified against `merged_at` before it runs, refusal is structured, and re-runs are idempotent.

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "issue_closed": true,
    "already_closed": false,
    "pr_number": <int>,
    "pr_merged_at": "<ISO-8601>",
    "pr_url": "<URL>"
  }
}
```

On `close_pr_not_merged` or `close_no_linked_pr`: return `status: "error"` with the tool's envelope verbatim so the orchestrator can surface it to the user. The orchestrator must not retry these errors until the user has changed the PR's state.

This is the last step of the workflow. After this step, the `/implement` run is complete: the issue is closed, the PR is merged, the Ground Control graph is reconciled, and the durable record on the issue thread is sealed.
