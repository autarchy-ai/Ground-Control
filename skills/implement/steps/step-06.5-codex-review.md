---
stage_id: review_cycle_1_consume
step: "Step 6.5"
tier: high
---

# Step 6.5: Pre-push Codex Review

The primary invocation session owns this review loop end-to-end. Ground Control
does not spawn or require a subagent for routine review work. The primary runs
the loop in [_review-loop-rules.md](_review-loop-rules.md) against
`gc_codex_review_cycle` until clean or cap-reached. The review remains a
server-side background job; that process boundary is not agent delegation.

The codex review is THE review pass for the PR - there is no second post-push codex review (see issue #804). Merge-commit drift relative to the target branch is the responsibility of CI (compile/tests/integration) and SonarCloud (quality), not a separate codex pass.

## Primary-session procedure

1. Stage everything with `git add -A`.
2. Generate one bounded `idempotency_key` for this logical cycle attempt. Call
   `gc_codex_review_cycle` with the key, `repo_path`, `issue_number`,
   `uncommitted=true`, and `async=true`. Reuse that key only when the start
   response was lost; use a new key after a terminal attempt and intentional
   tree change.
3. Poll `gc_codex_job` until the background review returns its terminal
   envelope. A missing/expired handle requires an issue-thread refresh and
   durable-record reconciliation before selecting a new key. Cycle jobs are
   non-cancellable because cancellation cannot roll back GitHub records.
4. Dispatch on `next_action` exactly as specified by
   [_review-loop-rules.md](_review-loop-rules.md). Fix real findings in this
   session, apply its canonical fix-locks-itself evidence rule, run
   proportionate targeted tests while iterating, and do not echo findings
   instead of fixing them.
5. Keep verbatim findings in the server-posted durable record. Cache only the
   compact status, cycle count, summary, and decision-record URLs.

When the cycle finishes:
- `status: "clean"` → advance to Phase C (Step 7).
- `status: "post_failed"` with `error: "review_coverage_incomplete"` → the
  review did not cover the whole diff (issue #1414). No findings record,
  decision record, or cycle marker was written and no cycle was consumed, so
  re-invoke this step. Do not treat it as clean and do not escalate a cap that
  was never spent.
- `status: "accepted_at_cap"` → the last in-cap findings were fixed and verified, and the user declined another review cycle; advance to Phase C. A clean terminal verdict is not required.
- `status: "capped"` → ask whether to spend one additional cycle. If the user declines or says to proceed, return `accepted_at_cap` and advance. If they authorize another cycle, rerun this step with `override_cap=true` + `override_reason`.

## Return contract

Return the compact `{status, cycles_run, summary, commit_shas,
decision_record_urls, escalation_reason}` envelope to the next workflow step.

## Notes

- **Cap source**: the cycle tool reads `workflow.codex_review.pre_push_cap` from `.ground-control.yaml`; default 1 per issue #906. The cap is enforced at the MCP layer (issue #794 / #796), not in agent prose.
- **Cap meaning**: the cap limits review iterations. It does not turn a clean Codex verdict into a prerequisite for publication. Known findings must be fixed or explicitly dispositioned; the user may decline an additional discovery pass and continue.
- **Findings record**: every successful cycle posts a verbatim findings comment to the resolved issue thread (per ADR-029). The comment carries the cycle/cap/mode header, the `Diff mode` line describing how the diff reached the reviewers, and both reviewers' verbatim text. The primary session needs only the compact cycle envelope.
- **Oversized diffs**: a diff larger than one prompt is split server-side into bounded inline slices that both reviewers read within this single cycle (issue #1414). Expect a longer wall-clock for a large diff and a `diff_mode: "manifest"` envelope; that is not a degraded review and needs no caller action.
- **Skip predicate**: skip this step only if the diff is so trivial (one-liner typo fix) that codex would have nothing to find. When in doubt, run it.
