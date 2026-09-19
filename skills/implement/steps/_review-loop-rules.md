# Review loop rules (canonical)

This document is the single source of truth for the Step 6.5 pre-push Codex
review loop. The retired test-quality reviewer is not part of `/implement` and
has no MCP tool surface.

## The loop

1. Generate one bounded `idempotency_key` and call
   `gc_codex_review_cycle` with `async=true` and
   `publication_mode="deferred"`. Poll `gc_codex_job` until it returns
   `status="done"`. Reuse a key only when the start response was lost; use a
   new key after a terminal attempt and an intentional tree change.
2. Read the full cycle envelope. `findings_summary`, `diff_mode`, and
   `review_coverage` are server-derived facts. A
   `review_coverage_incomplete` attempt consumed no cycle and wrote no GitHub
   record. A direct attempt's diagnostic artifact is not publishable. When
   the cycle wrapper exhausts its bounded retries, it returns a distinct
   `non_verdict` handle with closed failure classes and attempt ordinals.
   Publish that handle with `gc_publish_review_result`
   (`publication_kind="non_verdict"`, no verdict prose or findings) before
   escalating; it opens/escalates the station-observation obligation without
   consuming a cycle.
3. Inspect the returned `review_handle` with `gc_get_review_result`. Prepare a
   public rendering that maps every stable finding id exactly once, preserves
   the retained verdict and classification, carries bounded sanitized notes,
   and assigns each finding one valid ADR-029 disposition. Redact or generalize
   only the prose. Before changing the tree, call `gc_publish_review_result` with
   that rendering. Publication rechecks the exact reviewed revision, writes
   findings, cycle, and decision records, and is safe to retry after a lost
   response. An unpublished handle is not a completed cycle.
   For a `non_verdict` handle, skip sanitized verdict rendering and take the
   separate failure-publication path in item 2.
4. Classify each finding as `one-off` or `class`. For a class finding, sweep
   the diff and adjacent code for every instance and repair the category rather
   than only the named site.
5. Fix every real finding. There is no deferral disposition. `wontfix`
   requires explicit user authorization; `not-applicable` requires a factual
   rationale.
6. **Fix locks itself.** For executable code or a runtime-consumed data contract,
   add or extend a regression test that fails when the named defect is reintroduced.
   Record the test file path and test-case or describe-block name.
   For prose-only, no executable surface to lock, record that fact instead.
7. The published decision record is written before the repair. Do not claim
   that the pre-fix record contains post-fix test evidence; keep that evidence
   in the review-band state.
8. Re-stage with `git add -A` before any permitted re-invocation. Do not commit
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
rendered a verdict after its bounded free retries. After explicit failure
publication, the tool has opened and escalated the station-observation
obligation. Inspect the retained closed `failure_causes`, reproduce the
reviewer boundary with read-only diagnostics, and repair any repository-owned
tool, prompt-budget, or parser defect with a targeted regression test. A
non-verdict consumed no review cycle, so retry after that repair and re-stage;
the later successful publication re-observes the open obligation. Ask the user
to restore the station only after safe in-scope diagnosis establishes a hard
external dependency. Never turn an unobserved review into a finding
disposition or a spent review cycle.

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
dependency is still awaiting the user. The retained original stays in
protected local Git metadata; only the provenance-bound sanitized rendering is
public.

## Update succinctness

A GitHub update gives exactly what is needed: no restated context, padding, or
hedging. The renderer byte caps enforce this for PR bodies and final reports.
