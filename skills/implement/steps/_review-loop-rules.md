# Review loop rules (canonical)

This document is the single source of truth for the Step 6.5 pre-push Codex
review loop. The retired test-quality reviewer is not part of `/implement` and
has no MCP tool surface.

## The loop

1. Generate one bounded `idempotency_key` and call
   `gc_codex_review_cycle` with `async=true`. Poll `gc_codex_job` until it
   returns `status="done"`. Reuse a key only when the start response was lost;
   use a new key after a terminal attempt and an intentional tree change.
2. Read the full cycle envelope. `findings_summary`, `diff_mode`, and
   `review_coverage` are server-derived facts. A
   `review_coverage_incomplete` result consumed no cycle and wrote no durable
   review record, so repair the coverage failure and retry.
3. Classify each finding as `one-off` or `class`. For a class finding, sweep
   the diff and adjacent code for every instance and repair the category rather
   than only the named site.
4. Fix every real finding. There is no deferral disposition. `wontfix`
   requires explicit user authorization; `not-applicable` requires a factual
   rationale.
5. **Fix locks itself.** For executable code or a runtime-consumed data contract,
   add or extend a regression test that fails when the named defect is reintroduced.
   Record the test file path and test-case or describe-block name.
   For prose-only, no executable surface to lock, record that fact instead.
6. The auto-posted decision record is written before the repair. Do not claim
   that the pre-fix record contains post-fix test evidence; keep that evidence
   in the review-band state.
7. Re-stage with `git add -A` before any permitted re-invocation. Do not commit
   or push between review cycles.

Run the narrowest relevant tests during repair. CI owns repository-wide completion and policy suites.
Preserve pre-commit, review, CI, Sonar, and final-report gates.

## Dispatch and cap semantics

- `post_clean_decision_record_and_advance_to_phase_c`: advance to Phase C.
- `fix_findings_and_reinvoke`: fix all findings, test, re-stage, and run the
  next in-cap cycle.
- `fix_findings_then_ask_over_cap_or_proceed`: this was the last in-cap cycle.
  Fix all findings, test, and re-stage. Then ask the user one binary question:
  whether to run one additional review cycle. Do not re-invoke automatically.
- `ask_over_cap_or_proceed`: the cap was already reached, so no review ran and
  no tree change occurred. Ask the same binary question without manufacturing
  redundant verification.

The cap bounds reviewer effort; it is not a requirement for a clean terminal
verdict. If the user declines another cycle or says to proceed, set
`status: "accepted_at_cap"` and advance to Phase C. Authorization is required
only to spend another cycle. Declining another cycle is not a waiver of a known
finding: every real finding from completed cycles must already be fixed or
explicitly dispositioned before the question is asked.

The reason for this boundary is empirical: later review cycles often find
issues introduced while fixing the prior cycle, expanding the loop without
commensurate value. The agent's targeted verification proves its intended
repairs; CI, SonarCloud, and human PR review cover the remaining risk.

## Automated cap disposition (optional, default off)

When `workflow.review_disposition.enabled` is true, call
`gc_review_cap_disposition` after last-in-cap findings are fixed, tested, and
re-staged. The only reviewer value is `"codex"`.

- `proceed`: advance to Phase C.
- `one_more_cycle`: re-invoke `gc_codex_review_cycle` once with
  `override_cap=true` and `auto_grant=true`; the durable disposition marker is
  the authority.
- `escalate_to_human`: ask whether to spend another cycle. If the user
  declines, proceed.

Shadow mode records the disposition but still asks the user. Never pass
`auto_grant=true` without a matching authoritative `one_more_cycle` marker.

## Unobserved station

`escalate_unobserved_station_under_hard_external_dependency` means Codex never
rendered a verdict after its bounded free retries. The tool already opened the
station-observation obligation. Report the concrete observation failure and ask
for the action that restores the station; do not turn an unobserved review into
a finding disposition or a spent review cycle.

## Review envelope

```json
{
  "status": "clean" | "accepted_at_cap" | "capped",
  "cycles_run": 1,
  "summary": "<one-line summary of what was found and fixed>",
  "commit_shas": [],
  "decision_record_urls": ["<URL per cycle>"],
  "escalation_reason": null
}
```

`escalation_reason` is populated only while a capped choice or an external
dependency is still awaiting the user. Verbatim findings remain in the
server-posted durable record.

## Update succinctness

A GitHub update gives exactly what is needed: no restated context, padding, or
hedging. The renderer byte caps enforce this for PR bodies and final reports.
