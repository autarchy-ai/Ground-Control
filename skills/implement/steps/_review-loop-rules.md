# Review loop rules (canonical)

This document is the single source of truth for how the pre-push reviewers (codex at Step 6.5, test-quality at Step 6.6) drive their fix loops. Step 6.5 and Step 6.6 reference this file by path; the orchestrator does as well. Do not restate these rules elsewhere - keep them here.

Both AI-assisted reviews run **pre-push**: codex review at Step 6.5, test-quality review at Step 6.6. There is no post-PR review step (former Steps 12/13 were merged out by issues #804 and #906). Both follow the **same loop**, driven by the cycle wrapper tools (`gc_codex_review_cycle` and `gc_test_quality_review_cycle`, issue #934).

## The loop

1. **Invoke the async-only cycle tool with an idempotency key, then poll.** Generate one bounded `idempotency_key` for the logical attempt and call the cycle wrapper (`gc_codex_review_cycle` / `gc_test_quality_review_cycle`) with that key and `async=true` (omitting `async` has the same background behavior; `async=false` is refused). It returns `{ok:true, status:"running", job_id}` immediately. If the start response is lost, repeat the same key and identical input: the retained running or terminal job is returned without another reviewer run or durable post. A changed input under that key conflicts, and a different key cannot race another live attempt for the same repository, issue, and reviewer. Poll `gc_codex_job` every ~60s until `status:"done"`; the cycle envelope remains under `result`. Cycle jobs are non-cancellable because reviewer abort does not roll back every possible GitHub write. A `job_not_found` response means the handle expired or the MCP server restarted, not that no durable record exists: refresh the issue thread and reconcile its cycle/findings/decision markers before choosing a new logical-attempt key. Never blindly start another job. Verbatim review prose stays server-side in the durable findings record.
2. **Read the FULL envelope.** Do not stop after the first field. `findings_summary` carries `one_off_count`, `class_count`, and `top_categories[]` (grouped by `category.shape`, summed instance counts). The codex cycle envelope also carries `diff_mode` and `review_coverage` (issue #1414): `diff_mode` is `inline` when the complete diff fit one prompt and `manifest` when it did not, and `review_coverage` reports `{strategy, chunks_total, chunks_completed, files_total, files_covered, complete}`. An over-cap diff is reviewed as bounded server-supplied slices inside the SAME logical cycle - slices are never cycles, so a multi-slice review consumes exactly one cycle against the cap. These fields are server-derived facts, not reviewer claims; read them, do not attempt to set them.

   A cycle that returns `status: "post_failed"` with `error: "review_coverage_incomplete"` did not review the whole diff. Nothing durable was written and no cycle was consumed, so re-invoke the cycle tool rather than treating the run as clean or escalating a cap that was never spent.

   A cycle that returns `next_action: "escalate_unobserved_station_under_hard_external_dependency"` exhausted its bounded automatic re-attempts without the station ever rendering a verdict (issue #1476). The envelope carries `unobserved_station`, `obligation_id`, `logical_cycle`, and `station_attempts`. The tool has already opened and escalated a `station_observation` obligation under the `hard_external_dependency` pause class, so do NOT record another obligation, do NOT re-invoke the cycle tool, and do NOT ask the user to authorize a `wontfix` - nothing was measured, so there is no finding to disposition. Report the named station and its stable failure classes, and ask for the concrete action that restores observation. Once the station works, re-invoking the cycle tool resolves the obligation on the evidence without any user authorization. The resolution survives the call boundary: the cycle tool reads the open obligation from the issue thread before its first attempt (issue #1582). If a verdict was nonetheless posted without its resolution, `gc_assert_completion` lists the obligation under `recoverable_station_observations`; call `gc_reconcile_station_observation` with that `obligation_id` and `findings_record_url`, never `gc_record_execution_obligation`, which cannot close a station observation.
3. **Classify each finding before touching anything: `one-off` or `class`.** Codex review supplies `classification` (and, for `class` findings, `category = {shape, instances}`) on each finding object. The cycle wrapper preserves the classification when auto-building the decision record entries. If a finding arrived without a classification (for example test-quality review, which does not yet emit it consistently), classify it yourself first.
   - **`one-off`** - this exact site, no analogues. Apply the named fix to the named site. This is the existing path.
   - **`class`** - this site is one instance of a recurring pattern (the same brittle construction, the same missing pre-condition, the same bypassed helper). **STOP. Do not apply the named fix to the named site yet.** Instead:
     1. Re-read the category's `shape` - what makes a site an instance? What pre-condition fails? What invariant is violated?
     2. Sweep the diff **and adjacent repo code where the category plausibly extends** for every instance - the ones codex listed in `category.instances` *and* any it missed.
     3. Design the fix to address the **category**, not the symptom: a structural gate, a shared helper, a parameterization, a single point of repair, an API change. The fix should be one place, not N.
     4. Apply that single design to every instance at once.
     5. Only then re-run the cycle tool.

     A `class` finding that you fixed only on the codex-named site is a process violation in the same shape as silent deferral - it leaves the category un-addressed, and the next review cycle surfaces another instance, burning a cycle the cap is not meant to absorb. File count and workload are not pause conditions. If the category creates an unexpectedly material architecture or security decision, record it as an open execution obligation, post the affected surface and a concrete decision request, and pause for that decision.

4. **Fix every real finding regardless of provenance.** The zero-deferral rule applies: there is no `defer` decision - not "out of scope for this PR", not "follow-up issue to track it", not "addressed in a subsequent PR", not "deferred to a later iteration", not "TBD later" in a closing comment. Filing a tracking issue does **not** convert a deferral into a valid disposition. The PreToolUse hook (`.claude/hooks/block-defer-language.py`) and `bin/policy` enforce this mechanically. If repair requires significant architecture/security judgment or external authority, record an escalated execution obligation and ask the user; the obligation remains current work. `wontfix` requires explicit user approval. `not-applicable` is only for a condition that is factually false or does not apply to this codebase; a real problem outside the initiating diff is not `not-applicable`.

   **Fix locks itself.** For every finding accepted as `decision: "fix"` that
   touches executable code or a runtime-consumed data contract, add or extend
   proportionate regression evidence in the same review-fix cycle. Use a test that
   fails when the named defect is reintroduced. Record the test file path
   and test-case or describe-block name in the self-verification evidence used
   to leave the review band. A pure-prose repair may state "prose-only, no
   executable surface to lock". A pure rename or defensive narrowing with no
   behavior change may use a narrowly factual no-new-test rationale, but that
   per-finding rationale does not make an executable diff eligible for Step
   4.4's documentation-only carve-out.

   The auto-posted decision record is written before the agent applies the
   fix, so it cannot truthfully cite post-fix test evidence. Do not claim that
   it does. The regression evidence belongs to the fix loop's self-verification
   state unless a future versioned decision-record lifecycle adds an explicit
   post-fix evidence field.

5. **Decision records are auto-posted by the cycle tool.** The cycle wrapper (`gc_codex_review_cycle` / `gc_test_quality_review_cycle`) posts the per-cycle decision record automatically when the cycle ran. Every finding gets `decision: "fix"` with an auto-rationale - that is the only decision the cycle tool can record without user authorization. The `decision_record_url` is in the returned envelope.

   - **`wontfix` / `not-applicable` overrides.** If the agent obtains user authorization for a `wontfix` or marks a finding `not-applicable` with rationale, call `gc_post_decision_record` directly (with `user_authorization` for wontfix) AFTER the cycle, not through the wrapper. The wrapper handles only the auto-fix common path.
   - **`class` finding rationale.** When fixing a class, the `wontfix`/`not-applicable` decision record (if any override is filed) should explain how the category was closed, not just that the named site was patched. The auto-fix decision record's auto-rationale is acceptable for `class` findings because the next cycle's reviewer-clean is what proves the category was closed.

6. **Self-verify proportionately before re-invoking the cycle tool.** Batch
   related fixes and run the narrowest tests that exercise their changed
   behavior. Expand to broader suites when the fix changes a shared or
   cross-cutting boundary, is security-sensitive, or targeted evidence exposes
   wider risk. Do not run `cfg.workflow.completion_command` or
   `cfg.workflow.policy_command` after every small fix. Run those
   repository-wide gates once before leaving
   the review band on the final post-fix tree; if no relevant tree state
   changed since their last successful required boundary, reuse that evidence
   instead of rerunning it. This batching rule never waives the mandatory
   completion, policy, review, pre-commit, CI, Sonar, or final-report gates.
   Local verification proves the fix does the agent's intended thing; the
   reviewer's re-read catches what the agent did not intend.

7. **Dispatch on `next_action`, do not blindly re-invoke.** The loop continues only on `next_action: "fix_findings_and_reinvoke"`: fix, run proportionate targeted verification, re-stage (`git add -A`), and re-invoke the cycle tool. On `next_action: "fix_findings_then_summarize_and_escalate"` (the **last-in-cap** action - under the cap-1 default this fires on cycle 1 when findings are present), fix and run proportionate verification, then run the repository-wide completion and policy gates once on the final post-fix tree before returning `status: "escalated"`; **do not re-invoke**. On `next_action: "post_clean_decision_record_and_advance_to_phase_c"`, run those broad gates once only when fixes changed the tree since their last successful boundary, then advance. On `next_action: "post_summary_and_escalate_to_user"` (`status: "capped"`), the tool did NOT run a review and made no tree change; do not manufacture redundant verification - summarize the cap state to the user.

   The reason caps exist is bounded review depth - each pass surfaces one or two classes of defect that the prior pass couldn't reach, but cycle 2/3 gains compound the agent's own fix-introduced bugs more than they catch net-new bugs (the empirical observation that drove the #906 cap-1 default). Cycles are NOT for "fix verification" (that's the agent's own loop); they are for finding new classes of defect in the *current* state of the diff. The status field on the cycle envelope mirrors `next_action` - `clean` / `findings` / `capped` / `post_failed` - for ease of branching.

   On `next_action: "post_summary_and_escalate_to_user"` (`status: "capped"`), the cycle tool did NOT run a review (the cap was already reached). No fix work to do; summarize the cap state to the user and let them decide whether to authorize an over-cap cycle.

## Automated cap disposition (optional, default off)

When `workflow.review_disposition.enabled` is true in `.ground-control.yaml`, the cap boundary is dispositioned automatically instead of always stopping for the user (issue #1245, GC-O007 amendment; enforced in the MCP layer, not prose). With the knob absent or false, everything above is unchanged - `fix_findings_then_summarize_and_escalate` still hands control back to the user, and the human `override_cap` escape is the only over-cap path.

When enabled, on `next_action: "fix_findings_then_summarize_and_escalate"` (last-in-cap): fix and self-verify the findings and **re-stage** (`git add -A`) exactly as today, then - in place of escalating - call `gc_review_cap_disposition` with `repo_path`, `issue_number`, `reviewer` (`"codex"` | `"test-quality"`), `cycle`, `cap`, and `findings_summary` (pass the cycle envelope's `findings_summary` verbatim - the scorer treats a missing summary as unknown-risk and will not fast-path to `proceed`). It runs the same poll/`async` pattern as the cycle tools (poll `gc_codex_job`). It scores the **post-fix** diff server-side and returns one disposition; dispatch on it:

- `proceed` → advance to the next step (Phase C for codex / 6.6 for test-quality). No over-cap cycle.
- `one_more_cycle` → the tool has posted a `gc:review-auto-disposition` grant marker; re-invoke the **same** cycle tool with `override_cap=true` **and** `auto_grant=true`. The cycle wrapper independently verifies the marker before honoring the grant - agent-supplied `override_reason` text is **not** authority. The wrapper authorizes only when the grant marker was posted by the trusted MCP identity (provenance), `mode: authoritative` is set, and the grant has not already been spent on an over-cap cycle (single-use, bound to the cap boundary). The ceiling (`max_auto_overrides`, default 1) is enforced server-side; the auto path can never produce a second over-cap cycle, so after one auto cycle the gate returns `proceed` or `escalate_to_human`.
- `escalate_to_human` → summarize to the user and wait, exactly as without the gate.

`mode: shadow` (the default when enabled) posts the disposition but the run still escalates to the user - it builds agreement data before the gate acts authoritatively; only `mode: authoritative` lets `proceed`/`one_more_cycle` drive control flow, and only in authoritative mode will the cycle wrappers honor `auto_grant=true`. Never pass `auto_grant=true` without first obtaining a `one_more_cycle` disposition for the same issue+reviewer; the wrapper refuses an unbacked, forged, shadow-mode, or already-spent grant with `auto_grant_unauthorized`.

## Update succinctness (canonical)

A GitHub update gives exactly what's needed - not more, not less. No restating context the reader already has, no padding sections, no hedging prose.

This rule is mechanically enforced by byte caps on the three renderer tools in `mcp/ground-control/lib.js` (`PR_BODY_SUMMARY_MAX`, `FINAL_REPORT_SUMMARY_MAX`, `FINAL_REPORT_REVIEW_SUMMARY_MAX`). Prose elsewhere that references this rule does so by path pointer - do not duplicate the rule body.

## Local-only iteration

For every cycle, after applying fixes the agent must update the tree the reviewer sees BEFORE re-running:

- **Step 6.5 (pre-push codex review)** is local-only. Re-stage with `git add -A` and re-invoke; do NOT commit or push between cycles. The pre-push codex review reads the staged + unstaged diff against the base branch.
- **Step 6.6 (pre-push test-quality review)** is also local-only - moved pre-push by issue #906. Same re-stage-then-re-invoke loop as Step 6.5; do NOT commit or push between cycles.

Decision records (`gc_post_decision_record`) are posted per cycle for both reviewers via the cycle wrapper - that's the durable record per ADR-029 - but neither review needs a fix-commit since iteration is local.

## Review envelope

The primary invocation session drives each reviewer loop and keeps only this
compact envelope in workflow state:

```json
{
  "status": "clean" | "escalated" | "capped",
  "cycles_run": <int>,
  "summary": "<one-line summary of what was found and fixed>",
  "commit_shas": [],
  "decision_record_urls": [ "<URL per cycle>" ],
  "escalation_reason": null
}
```

`commit_shas` is empty pre-push (no commits between cycles). `escalation_reason` is null when `status: "clean"`; a string when `status: "escalated"` or `status: "capped"`.

Verbatim review prose and per-finding bodies stay in the server-posted durable
record. Ground Control does not create a subagent solely to contain this
routine workflow context.
