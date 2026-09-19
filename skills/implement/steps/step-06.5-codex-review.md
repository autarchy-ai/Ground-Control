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
   `uncommitted=true`, `publication_mode="deferred"`, and `async=true`. Reuse
   that key only when the start response was lost; use a new key after a
   terminal attempt and intentional tree change.
3. Poll `gc_codex_job` until the background review returns its terminal
   envelope. A missing/expired handle requires an issue-thread refresh and
   durable-record reconciliation before selecting a new key. Cycle jobs are
   non-cancellable because cancellation cannot roll back GitHub records.
4. Inspect the returned `review_handle` with `gc_get_review_result`, produce a
   complete sanitized rendering that preserves the retained verdict and every
   finding id/classification, carries bounded sanitized notes, assigns valid
   ADR-029 dispositions, and publish it with
   `gc_publish_review_result` before editing the reviewed tree. Retry the same
   publication after an ambiguous response; trusted provenance markers prevent
   duplicate records. An unpublished handle consumes no cycle and cannot
   satisfy readiness.
   If the cycle exhausted its non-verdict retries, inspect its separate
   `non_verdict` handle and publish with `publication_kind="non_verdict"`
   and no sanitized reviewer fields. The server posts only closed-code
   station-observation opened/escalated records. This consumes no review
   cycle, writes no decision record, and still blocks readiness. Inspect its
   closed `failure_causes` and repair a repository-owned cause before treating
   the station as an external dependency.
5. Dispatch on `next_action` exactly as specified by
   [_review-loop-rules.md](_review-loop-rules.md). Fix real findings in this
   session, apply its canonical fix-locks-itself evidence rule, run
   proportionate targeted tests while iterating, and do not echo findings
   instead of fixing them.
6. Keep the original result local. The issue thread receives only the
   provenance-bound sanitized rendering. Cache only the compact status, cycle
   count, summary, and decision-record URLs.

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
- **Findings record**: deferred execution performs no GitHub write. Explicit publication posts the sanitized findings, cycle marker, and decision record in that order, with hashes binding the local original, exact revision, and public rendering. The primary session uses the opaque handle only through the MCP tools; it does not read the artifact file directly.
- **Oversized diffs**: a diff larger than one prompt is split server-side into bounded inline slices that both reviewers read within this single cycle (issue #1414). Expect a longer wall-clock for a large diff and a `diff_mode: "manifest"` envelope; that is not a degraded review and needs no caller action.
- **Skip predicate**: skip this step only if the diff is so trivial (one-liner typo fix) that codex would have nothing to find. When in doubt, run it.
