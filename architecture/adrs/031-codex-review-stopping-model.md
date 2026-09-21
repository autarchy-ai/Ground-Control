# ADR-031: Severity Rubric and Stopping Model for Pre-Push Codex Review

## Status

Proposed

## Date

2026-05-09

> **Amended by issue #1679 (2026-09-21):** A publication now names the delivery
> it can authorize, and `wontfix` authority is verified rather than asserted.
> The review revision gains a **candidate tree**: the Git tree `git add -A` would
> stage, captured through a temporary index seeded from the repository's current
> index, which is exactly what the publish action commits and therefore the one
> identity that survives the commit. Seeding from HEAD instead would drop a path
> force-added from an ignored location, which the publisher does commit. Because
> staging runs configured clean and process filters, the capture applies the same
> executable-Git-configuration guard the other staging paths use, on every caller
> path; this is the first operation on the review path that reads untracked file
> contents rather than only their names. The
> publication marker family moves to `gc.review-publication/v2`, carrying that
> tree and the cycle's finding count alongside the existing digests; v1 markers
> stay readable for audit but cannot authorize a delivery.
> `readTrustedReviewPublicationEvidence` surfaces the revision digest, candidate
> tree, finding count and reviewed branch instead of discarding them, and the
> synchronization record carries the binding forward. Enforcement is placed where
> the evidence to enforce it exists: the **tree** binding is checked at the
> synchronization boundary and again at PR creation, which are the two points
> that hold the settled tree, and **both completion phases** check that the
> authorizing review ran on the branch the pull request delivers and record the
> revision it covered. Recording a binding is not checking one - the first
> version of this change reported the fields at completion without comparing
> them, which left a publication from another branch acceptable. The binding is
> asymmetric on purpose: a **zero-finding**
> cycle had nothing to repair, so the delivered tree must be the tree it read,
> while a **finding-bearing** cycle is expected to be followed by repairs under
> ADR-099, so its settled tree is recorded without claiming Codex reviewed it.
> Requiring equality in both cases would reverse ADR-099 into a clean-verdict
> requirement. Separately, a `wontfix` disposition is accepted only when
> `user_authorization` resolves to an issue comment on this repository and issue
> whose body is exactly `/ground-control authorize-review-wontfix <finding-id>`,
> the same shape the repository already uses for execution-obligation wontfix.
> Finding ids are positional and recur in every cycle, so the approval is bound to
> its review run by time rather than by anything the person types: it counts only
> for a review run already under way when it was posted, and an older approval
> can never close a newer run's finding. The direct
> decision-record surface has no review run to bind a `wontfix` to and refuses
> it; such dispositions are recorded through `gc_publish_review_result`. The
> authorizing comment's author must have effective write permission, and the
> check runs at the repository boundary before the first publication write. The cap, severity
> rubric, and stopping semantics are unchanged.

> **Amended by issue #1632 (2026-09-18):** Executing a deferred review does not
> consume a cycle. The cycle is consumed only when the exact reviewed revision's
> sanitized record is published, after the server proves a complete one-to-one
> mapping to the retained findings and preserves classification and disposition.
> A stale or incomplete result is retained for diagnosis but cannot be
> published. This changes the publication boundary, not the cap or stopping
> semantics established here and amended by ADR-099.

> **Superseded in part by ADR-099 (2026-09-17):** The Codex cap is a bound on
> review iterations, not a clean-verdict delivery gate. After known findings are
> fixed or explicitly dispositioned and verified, declining another cycle
> advances the workflow. ADR-099 also removes the separate test-quality review
> stage and all of its tool surfaces.

> **Style sync for issue #751 (2026-06-14):** Repository-wide Vale cleanup normalized punctuation in workflow prose. This ADR's review stopping model stays the same.

> **Amended by issue #906 (2026-05-13):** The "three pre-push cycles per issue" baseline this ADR builds on is now a **configurable default of 1 cycle**. The cap value lives on the MCP tool as `CODEX_REVIEW_PREPUSH_HARD_CAP` and is overridden per-repo via `.ground-control.yaml::workflow.codex_review.pre_push_cap` (bounds `[1, 10]`). Repos that want the historical 3-cycle baseline this ADR describes set the knob explicitly. The severity rubric, stopping model, and `override_cap` escape semantics this ADR proposes are **unchanged**; only the default-cap-value assumption shifts. Empirical observation behind the drop: cycles 2 and 3 historically compounded the agent's own fix-introduced bugs more than they caught net-new bugs (for example, PR #903's 4-cycle run), and the catch-rate-vs-loop-cost tradeoff favors cycle-1 + CI / SonarCloud / human review for the typical diff. The "Sometimes a run goes 5+ cycles deep with real bugs every cycle" failure mode below still benefits from the `override_cap` escape; the "Sometimes a run reaches cycle 3 with all-Minor cosmetic findings" failure mode is moot under cap-1 (the cycle 3 boundary doesn't exist by default).

## Context

GC-O007 (amended by ADR-029) caps `gc_codex_review` at three pre-push cycles
per issue and routes any "concern remaining after cycle 3" to a user-facing
escalation comment. Empirically, two failure modes show up at the cap
boundary:

1. Sometimes a run goes 5+ cycles deep (with `override_cap=true`) and is
   still surfacing real bugs every cycle. The override exists for exactly
   this case and works.
2. Sometimes a run reaches cycle 3 with all-`Minor` cosmetic findings and
   the user is asked to authorize cycle 4 anyway, because the existing
   workflow has no notion of "this round was so trivial we should have
   stopped at cycle 2." The user's input is "vibes on whether the last
   round of findings was bad enough to warrant another."

The problem is structural: the workflow has a cycle cap but no severity
classification on findings, no pre-declared exit criteria for a given run,
no within-cap early stop signal, and no cross-model confirmation on the
highest-impact (`Critical`) findings. With none of those, the user's
terminal authorization at cycle 3 is unavoidably gut-feel.

The established software-engineering literature on this problem is mature.
Inspection-era work prescribes pre-declared numeric exit gates (Fagan IBM
Sys. J. 1976; Gilb & Graham, *Software Inspection*, 1993). Empirical studies
of inspection effectiveness show diminishing returns past two independent
passes (Porter, Siy, Mockus, Votta ACM TOSEM 7(1), 1998; Biffl & Halling
IEEE TSE 29(5), 2003). Capture-recapture defect-population estimation uses
overlap between independent reviewers (Briand, El Emam, Freimut,
Laitenberger IEEE TSE 26(6), 2000). Cost-benefit stopping is the framework
that justifies all the others (Freimut, Briand, Vollei IEEE TSE 31(12),
2005; Kemerer & Paulk IEEE TSE 2009).

Two further bodies of work specifically address LLM-judge calibration. The
rubric literature (Autorubric arXiv 2603.00077; LLM-Rubric
arXiv 2501.00274) finds anchored few-shot examples per ordinal class are
the strongest stabilizer. The bias literature documents systematic
overcorrection (arXiv 2508.12358, 2025: LLMs prompted to find defects
flag conforming code at higher rates; richer prompts make it worse) and
adversarial-framing instability (arXiv 2603.18740: verdict flips in
88.2% of cases). Severity inter-rater reliability is empirically poor in
human-rated bug data too (Tian, Ali, Lo, Hassan EMSE 2016: 28.9 to 50.8%
disagreement on duplicate-bug severity in OpenOffice / Mozilla / Eclipse).
Implication: absolute severity counts are not trustworthy as stopping
signals; deltas across cycles are.

Industry severity standards include IEEE Std 1044-2009 (qualitative
classes, no prescribed weights), CVSS v4.0 (0.0–10.0 numeric for security,
with Base/Threat/Environmental decomposition), Capers Jones DRE work
(Sev-1..Sev-4, no formal weights), and SARIF v2.1.0
(`error`/`warning`/`note`/`none`). DREAD has been retired by Microsoft for
subjectivity. None of these prescribes the {10,5,2,1}-style multiplicative
weights commonly attributed to them; those are engineering convention.

## Decision

Adopt a five-piece stopping model that refines GC-O007 without superseding
it or weakening the existing cap. Each piece is a separate refining
requirement so they can be implemented and tested independently.

### 1. Severity classification on every finding (GC-X101)

Every `gc_codex_review` finding carries an IEEE 1044-2009-aligned class
from `{Blocking, Critical, Major, Minor}`, plus a CVSS v4.0 Base vector +
numeric score for security findings. The reviewer's prompt includes ≥2
anchored example findings per class. Findings the reviewer cannot place
are returned as `Minor` with `unclassified=true` rather than guessed.

### 2. Pre-declared exit gates per run (GC-X102)

Each `/implement` run declares numeric gates before cycle 1:
`max_blocking=0`, `max_critical=0`, `max_major=N`,
no-new-categories-in-final-cycle; these are recorded as a marker block in the plan
comment. Meeting all gates terminates the loop early; missing them at the
existing three-cycle cap triggers escalation.

### 3. Severity-weighted early stop within the cap (GC-X103)

After each cycle, compute a weighted score (Blocking=10, Critical=10,
Major=5, Minor=1) and compare to cycle N-1. If cycle N's score is strictly
less than 25% of cycle N-1's AND no `Critical`/`Blocking` was introduced,
terminate without further cycles. The 25% threshold matches the lower
bound of the empirical 25-50% per-pass detection-rate decay reported in
inspection studies. Weights and threshold are engineering convention, not
standards-prescribed.

### 4. Independent-reviewer confirmation for `Critical`/`Blocking` (GC-X104)

A `Critical` or `Blocking` finding does not gate workflow termination,
escalation, or "what blocks merge" rendering until confirmed by a second
independent reviewer-model invocation (different model family or
fresh-context session). Disagreement on classification → lower severity
prevails for gating, both retained in audit. Confirmation does not consume
a `gc_codex_review` cycle against the cap.

### 5. Structured cycle-3 escalation decision aid (GC-X105)

When a run hits cycle 3 with gates not satisfied, the escalation comment
includes severity-weighted scores per cycle, decay ratios, category-novelty
signals, projected cycle-4 yield, count of unconfirmed `Critical` findings,
and a recommended action from `{approve_cap_override,
accept_remaining_findings_as_wontfix_with_rationale,
stop_run_and_open_new_issue}` with supporting signals. Decision authority
remains the user's; the requirement is that the decision input be
structured signal rather than free-text vibes.

### Invariants preserved

GC-O007's cap mechanics are unchanged. The override-cap path stays
available for legitimate "I see this is still finding real things" cases.
The five additions sit *inside* the cap, not in place of it.

The reviewer-of-record invariant (ADR-027 / ADR-029) is preserved: review
tools always route through `gc_codex_review`, `gc_codex_verify_finding`,
`gc_codex_architecture_preflight`. The independent-confirmation reviewer
(GC-X104) is invoked through the same MCP boundary; it is not a new direct
GitHub or LLM client.

Tool-layer enforcement boundary from ADR-029 is preserved: the MCP server
is the enforcement point for severity classification, weighted-score
computation, exit-gate evaluation, second-reviewer confirmation, and the
escalation decision-aid marker. Skills do not duplicate this in prose; the
workflow contract is enforced where the reviewer outputs are processed.

The 25% threshold and `{10,10,5,1}` weights are stated as engineering
convention. They may be tuned per-project via `.ground-control.yaml` in a
future schema revision once telemetry from real runs justifies the
per-project knob; the initial implementation hard-codes them.

## Consequences

### Positive

- The cycle-3 escalation prompt becomes structured signal (decay ratio,
  category novelty, projected yield, unconfirmed-Critical count,
  recommended action) instead of "should I do another cycle?" with no
  inputs. This was the explicit user-pain motivating the work.
- Within-cap early stop on severity decay eliminates the "cycle 2 was
  trivial but we ran cycle 3 anyway" failure mode.
- Independent confirmation of `Critical` findings absorbs the bulk of
  LLM-judge overcorrection bias (arXiv 2508.12358) before that
  classification gates anything user-facing, which is the highest-leverage point
  for false positives in the loop.
- Pre-declared exit gates make termination criteria a property of the run,
  recorded in the issue thread per ADR-029, rather than an undocumented
  in-run agent judgment.
- Per-finding severity class is the input format that GC-X100 (fix-the-class
  instruction injection) can also consume, so the two requirements compose
  cleanly.
- Aligns the workflow with the strongest empirical priors from the
  inspection literature (2-3 passes captures the bulk; further passes are
  exceptional) and the LLM-judge calibration literature (anchored examples
  per class are the strongest stabilizer).

### Negative

- Five new refining requirements add surface area that must be implemented
  and kept consistent. Partial implementation is worse than none for
  GC-X103 and GC-X105 (both depend on GC-X101's classification existing on
  every finding).
- Independent-reviewer confirmation (GC-X104) doubles the cost in tokens
  and wall time for any cycle that produced a `Critical` finding. Most
  cycles will not, so steady-state cost increase is small, but worst-case
  is non-trivial.
- `{10,10,5,1}` weights are convention, not standards-prescribed. The ADR
  records this honestly; implementations must not cite the weights as
  IEEE 1044 / Capers Jones / CVSS prescriptions.

### Risks

- **Severity rubric drift.** Anchored examples in the review prompt are
  the highest-leverage stabilizer per the rubric-LLM literature; if the
  examples drift to bad anchors over time, classification quality degrades
  and the rest of the model loses signal. Mitigation: rubric examples live
  in version control alongside the `gc_codex_review` prompt template;
  changes to them are reviewed under the normal `/implement` workflow.
- **Decay-rule false stops.** A 25% threshold could plausibly stop a run
  that would have surfaced a real `Critical` in cycle 3. The conjunction
  with "no `Critical` introduced this cycle" closes most of that gap, but
  not all. Mitigation: GC-X105's decision aid still runs at cycle 3 if
  gates aren't met, so legitimate continuation cases route through the
  user.
- **Independent reviewer collusion.** If both reviewer-model invocations
  come from the same model family with similar training, they may share
  the bias the second-reviewer step is supposed to correct for.
  Mitigation: requirement language specifies "different model family OR
  separately spawned session with no shared context"; implementation
  should prefer the former where available.
- **Audit-trail bloat.** Persisting both reviewer outputs for
  `Critical`/`Blocking` findings + structured decision-aid marker blocks
  adds material to issue threads that already get long under ADR-029. The
  marker-block format absorbs most of the parsing cost; human-readable
  rendering remains compact.
- **Per-project tuning pressure.** Threshold and weights are hard-coded in
  the initial implementation. Real telemetry from GC-X103 firing across
  runs may show the 25% threshold is wrong for some project mix. The
  escape valve is `.ground-control.yaml`, but introducing it before
  evidence justifies it adds schema surface that may not pay for itself.

## Related Requirements

- GC-O007 Gated Agentic Development Loop (refined, not amended)
- GC-X100 Codex review fix-the-class instruction (composes with GC-X101)
- GC-X101 Severity classification of Codex review findings
- GC-X102 Pre-declared exit gates for /implement Codex review loop
- GC-X103 Severity-weighted early stop within Codex review cycle cap
- GC-X104 Independent-reviewer confirmation for Critical findings
- GC-X105 Structured cycle-3 escalation decision aid

## Related ADRs

- ADR-021 Gated Agentic Development Loop (the base contract this refines)
- ADR-029 Issue-Thread Gate Model (durable record + tool-layer enforcement
  boundary preserved)
- ADR-027 Agent-Neutral Implement Workflow Packaging (reviewer-of-record
  invariant preserved)

## Amendments

**2026-05-19 (issue #931): verdict envelope replaces the findings-only tail.**
Codex now emits a JSON object inside `===REVIEW===...===END===` containing
`verdict` (`ship` | `ship-with-fixes` | `don't-ship`), required non-empty
`architectural_read`, `blocking[]` (the validated finding objects this ADR
documents, plus a required `sweep_evidence` field on one-off classifications
and an optional `structural_blocker` boolean), and optional `notes[]` capped
at 2. Cycle stopping and override semantics are unchanged. The principal-
engineer motivation: a clean review now returns `verdict: ship` as a
first-class outcome rather than the reviewer being structurally pushed to
manufacture findings. See issue #931 and the preflight note at
`architecture/notes/ai-review-recalibration-preflight.md`.

**2026-05-21 (issue #937): codex review runs as an async job.** `gc_codex_review`
and the `gc_codex_review_cycle` wrapper gain an opt-in `async` mode: the tool
spawns the `codex exec` child as a background job and returns a `job_id`
immediately; the new `gc_codex_job` tool polls for the verdict envelope or
cancels the job (the cancel aborts an `AbortController` whose signal terminates
the model invocation). Run synchronously, the call blocked past the
MCP client's per-call timeout and the client abandoned it while the child ran
on (issue #893). The stopping model this ADR defines is **unchanged**: the
per-issue cycle cap, the `gc:codex-review-cycle` marker family, the
`override_cap` semantics, and the `verdict: ship` clean outcome all behave
exactly as before. Async changes only how the agent waits for a cycle's
result, never when the loop stops. See ADR-036 (amendments) for the job model.

**2026-07-30 (issue #943): retained attempts are idempotent and serialized.**
The public Codex and test-quality cycle wrappers are async-only and require a
bounded idempotency key. Same-key/same-input starts reuse the retained running
or terminal job; changed input conflicts, and distinct keys cannot race the
same canonical repository/issue/reviewer scope. The synchronous internal
executors and every stopping decision remain unchanged under terminal
`result`. Cycle jobs are non-cancellable because aborting the reviewer cannot
roll back durable GitHub writes. After `job_not_found`, the caller refreshes
the issue thread before selecting a new key. Cap counters, marker families,
override authorization, and clean/findings/capped outcomes are unchanged.

**2026-08-08 (issue #1518): cancellation and timeout own the subprocess tree.**
The issue #937 wording above described the intended terminal behavior but the
shared subprocess helper signalled only the direct CLI child. A CLI-spawned
search process could therefore survive timeout or cancellation as an orphan.
Every bounded model invocation must have one process-tree ownership contract:
timeout, abort, direct-child failure, and direct-child success must leave no
descendants. Architecture preflight additionally defines repository-wide
inspection as repository-scoped inspection; `-C` and `workspace-write` are not
represented as host read-confinement controls. The binding guardrails and
non-goals are recorded in
`architecture/notes/codex-subprocess-containment-preflight.md`. Review caps,
job retention, durable-write ordering, and stopping decisions are unchanged.

**Amendment: renderer summary byte caps (#964).** `gc_render_pr_body` and `gc_post_final_report` now enforce reject-not-truncate byte caps on their caller-controlled summary fields. `gc_post_decision_record` (the per-cycle decision-record surface this ADR's stopping model writes to) is unchanged at the schema layer; its caller-controlled prose fields (`notes[].text`, finding rationales, titles) already had per-field caps. The canonical succinctness rule lives in `skills/implement/steps/_review-loop-rules.md § Update succinctness (canonical)`.

**Amendment: issue close mechanism (#862 typed-action-items PR).** The /implement Step 18 no longer runs `gh issue close`. The GitHub issue closes via `Closes #<issue-number>` in the PR body (rendered by `gc_render_pr_body` in Step 9) when the user merges the PR. Step 18 only removes the `in-progress` label set in Step 1. Closing from the agent decoupled the close event from the merge: an unmerged or rolled-back PR would leave a closed issue with no shipped code (GitHub does not re-open issues on revert). Step 19 (final report) is correspondingly tightened: traceability reconciliation (Steps 15 through 17) is an explicit precondition, and no earlier step surfaces a user-facing "complete" signal (prior escalations are for input, not for "done"). The /quickfix sibling lane is updated in lockstep.

**2026-05-26 (issue #989).** The `/integrate` lane (GC-O011) does not invoke `gc_codex_review` or `gc_test_quality_review`. The stopping model and cycle caps defined by this ADR apply only to issue-anchored lanes (`/implement`, `/quickfix`). The integration lane's completion gate uses the repo's configured `workflow.completion_command` and post-push CI/Sonar watches; there is no per-cycle Codex reviewer in that lane.

**2026-05-26 (issue #989 merge carve-out).** The `mode=merge` path of the `/integrate` lane executes inside the MCP server subprocess and invokes no Codex review. The stopping model is unaffected.

**2026-05-30 (issue #1058).** The new `gc_assert_traceability_reconciled` and `gc_close_issue_after_merge` MCP tools (issue #1058) gate the /implement workflow's transition-reconciliation and post-merge close paths, respectively. Neither tool runs a Codex review or any other reviewer cycle, so the stopping model and per-cycle caps in this ADR are unaffected. The pre-push Codex review at Step 6.5 and test-quality review at Step 6.6 remain the only Codex-driven cycles; the new tools are workflow-gate primitives consumed by Steps 17 and 20.

**2026-06-10 (issue #1099 threat/risk screening gate).** A new Phase A gate, Step 3.5 (GRC screening), runs between codebase assessment (Step 3) and planning (Step 4). The step reads the project's threat/risk workspaces and classifies the planned change surface, posting a durable screening record to the issue thread via `gc_post_grc_screening`. The GRC screening step does not invoke `gc_codex_review` or any other reviewer cycle, so the stopping model and per-cycle caps defined by this ADR are unaffected. The pre-push Codex review at Step 6.5 and test-quality review at Step 6.6 remain the only Codex-driven cycles.

**2026-06-13 (issue #1156 Phase D/Phase E closeout clarity).** `gc_post_final_report` now requires `/implement` callers to pass a bounded `plain_english_outcome`, and `gc_close_issue_after_merge` now returns an advisory `next_issue_recommendation` after a merge-verified close succeeds. Neither surface invokes `gc_codex_review`, `gc_test_quality_review`, or a decision-record cycle. The stopping model and per-cycle caps in this ADR are unchanged; issue #1156 only changes the durable closeout fields around the reviewer loop.

**2026-06-14 (issue #1103 Phase D consolidation).** The new `gc_assert_completion` MCP tool (Step 17) composes `gc_assert_traceability_reconciled`, `gc_assert_grc_reconciled`, and `gc_post_final_report` in a single call. None of these tools invoke `gc_codex_review` or any other reviewer cycle. The stopping model and per-cycle caps defined by this ADR are unchanged.

**2026-06-18 (issue #1181 model-tier refresh).** The high-tier capability model id was bumped from `claude-opus-4-7` to `claude-opus-4-8` in the `CLAUDE_MODEL_BY_TIER.high` default map (`mcp/ground-control/lib.js`) and the high-tier `.ground-control.yaml` routing stages. The Step 6.5 `review_cycle_1_consume` stage this ADR governs is high-tier and parent-only, so the bump changes which Claude model interprets a Codex review cycle's findings; the stopping model, the per-issue cycle cap, `override_cap` semantics, and the `gc_post_decision_record` contract are all unchanged.

**2026-06-19 (issue #1189 Cursor CLI driver).** Cursor CLI drives the same pre-push Codex review (Step 6.5) and test-quality review (Step 6.6) cycles via the existing MCP tools; the stopping model, cycle caps, and durable decision records on the issue thread are unchanged. Cursor CLI does not substitute its own review mode for Codex.

**2026-06-20 (issue #1191 Cursor skill install).** Cursor CLI discovers `/implement` after `bin/install-skills.sh` hard-copies `skills/implement/` into `~/.cursor/skills/implement/` (symlinked skill folders fail Cursor's root check). Ground-Control repos also ship `.cursor/skills/implement/SKILL.md` as a real wrapper file. The stopping model, cycle caps, and Step 6.5/6.6 MCP contracts are unchanged.

**2026-06-22 (issue #963 post-merge reconciliation ordering).** The pre-push Codex review stopping model is **unchanged** by issue #963. The review still runs in Phase C (Step 6.5), pre-push, with the same severity rubric, cycle caps, and durable findings/decision records on the issue thread. Issue #963 only moves the requirement transition, traceability reconciliation, and final report from Phase D (pre-merge) to a new Phase E (post-merge); that reordering is entirely downstream of the review and does not alter when or how Codex review runs, nor the reviewer-of-record invariant.

**2026-06-28 (issue #1245 automated review-cap disposition gate).** A new optional, config-gated gate automates the over-cap escalation this ADR's stopping model routes to the user. When `workflow.review_disposition.enabled` is true (default **false**; with it off, behavior is byte-for-byte unchanged: last-in-cap findings still return `fix_findings_then_ask_over_cap_or_proceed`, and the human `override_cap` plus quoted-authorization escape stays the only over-cap path), the orchestrator calls the new `gc_review_cap_disposition` MCP tool **after** the last-in-cap findings are fixed, self-verified, and re-staged (so fix churn is measurable). The tool scores the post-fix change with a deterministic risk model (diff size, changed-surface class, Step 3.5 GRC verdict, finding shape, prior auto-overrides) and returns `proceed` | `one_more_cycle` | `escalate_to_human`. A hard ceiling (`max_auto_overrides`, default 1) is enforced in the scorer **and** re-clamped after any gray-zone LLM judge, so the auto path can never grant a second over-cap cycle (effective maximum two cycles, beyond which only a human `override_cap` proceeds). Authority for the single auto-granted over-cap cycle comes from a durable `gc:review-auto-disposition` marker the tool posts (schema `gc.implement.review-auto-disposition/v1`), **not** from agent-supplied `override_reason` text: `gc_codex_review_cycle` / `gc_test_quality_review_cycle` verify that marker (via a new `auto_grant=true` parameter) before honoring the override. The pure cap evaluators (`evaluateCodexReviewPrePushCycleCap` / `evaluateTestQualityReviewCycleCap`), the severity rubric, and the per-issue cycle counter are unchanged. The deterministic ceiling and fast paths are authoritative; the LLM judge ranks only the gray zone. GC-O007's statement is amended in lockstep. See `architecture/notes/review-cap-disposition-gate-preflight.md` for the binding preflight guidance.

**2026-07-01 (issue #1264 Sonnet-tier refresh).** The `medium`-tier routing-default model id and the `gc_test_quality_review` engine default were bumped from `claude-sonnet-4-6` to `claude-sonnet-5`, and the routing model-id validator was loosened to accept single-segment canonical ids. This changes which Claude model runs the medium-tier stages (including the `gc_test_quality_review` Step 6.6 engine when no per-call `model` override is passed). The pre-push Codex and test-quality stopping model (severity rubric, cycle caps, per-issue cycle counters, and the reviewer-of-record invariant) is unchanged.

**2026-07-11 (issue #1346, ADR-089 GRC retirement).** ADR-089 retires the composed GRC product surface referenced by three amendments above. (1) The 2026-06-10 (#1099) Step 3.5 GRC screening gate is removed from the active `/implement` workflow; there is no screening step between codebase assessment and planning. (2) The 2026-06-14 (#1103) `gc_assert_completion` composition no longer includes `gc_assert_grc_reconciled`; it composes only `gc_assert_traceability_reconciled` and `gc_post_final_report`. (3) The 2026-06-13 (#1156) `next_issue_recommendation` clause is reversed - `gc_close_issue_after_merge` no longer performs a next-issue lookup or returns that field; its `plain_english_outcome` clause is unaffected. (4) The 2026-06-28 (#1245) `gc_review_cap_disposition` scorer no longer reads or emits a GRC verdict signal; its risk model is recalibrated over its remaining signals (diff size, changed-surface class, finding shape, prior auto-overrides) so removing the GRC input does not silently reclassify a formerly high-risk case as an automatic proceed. None of these changes touch the stopping model, per-cycle caps, severity rubric, or the reviewer-of-record invariant this ADR defines. See ADR-089 for the full retirement decision.

**2026-07-15 (issue #1399, GC-P027 Release Please adoption).** Release Please adoption retires the Towncrier changelog-fragment convention and adds a CI Conventional-Commit PR-title gate; the codex/test-quality stopping model, severity rubric, per-cycle caps, per-issue cycle counters, and the reviewer-of-record invariant are unchanged. Cross-referenced for the `workflow-guardrail-sync` contract. See ADR-021 (2026-07-15 amendment).

**2026-07-25 (issue #1416, caps pause rather than discard).** Review caps keep
their existing bounds and stopping purpose, but reaching a cap is not a
disposition for unresolved findings. Each remaining actionable finding is
recorded as an open execution obligation and the run pauses only under one of
the closed pause classes. Workload, file count, provenance, ownership, and the
anticipated diff are not stopping reasons. `not-applicable` remains a narrow
factual classification, not a substitute for repair.
Review-fix verification is proportionate rather than repetitive: related fixes
are batched and exercised by the narrowest relevant tests between cycles;
shared/cross-cutting or security-sensitive changes expand the test surface.
The completion command and repository policy suite run once on the final
post-fix tree before leaving the review band when that tree changed, not after
each small fix. This affects local scheduling only; review caps and every
mandatory pre-commit, review, CI, SonarCloud, and completion gate remain intact.

**2026-07-26 (issue #1421, primary-session review control).** The workflow
driver invokes the Codex and test-quality MCP review tools directly. Ground
Control routing selects provider, model, and tier but does not require or
manufacture a subagent execution context. The MCP server may continue to run
long review processes as background jobs; that implementation detail does not
delegate routine development work or change this ADR's stopping model, caps,
finding obligations, or durable decision records.

**2026-07-26 (issue #1426, deterministic non-review bands).** The new
`gc_implement_mechanical` tool removes model turns from successful-path
bootstrap, completion/policy verification, publish/base synchronization,
CI/Sonar monitoring, readiness, and finalization. It does not alter the Codex
or test-quality review tools, their findings, cap counters, disposition
records, or escalation rules. Review agents still run only inside the existing
bounded review-cycle tools; the primary handles returned findings and cap
decisions under this ADR.

**2026-07-26 (issue #1414, review evidence over an over-cap diff).** Above
`GC_CODEX_REVIEW_MAX_DIFF_BYTES` (default 256 KiB), `gc_codex_review` used to
replace the diff with a numstat manifest and instruct the reviewer to fetch
per-file diffs through its own shell tool. Nothing verified that fetch, and both
reviewers were observed returning `verdict: ship` caveated on the manifest
alone. One described a 3:1 deletion-weighted change as introducing the feature
it deleted. The cycle recorded that as a clean pass indistinguishable at the
envelope level from a real one, spending the cap-1 cycle. A manifest is now
routing metadata, never review evidence: the MCP server splits the authoritative
diff into bounded inline slices (`diff --git` file boundaries, falling back to
`@@` hunk boundaries when one file exceeds the budget) and runs both reviewers
over every slice. Findings, architectural reads, and notes are aggregated
deterministically through the existing `dedupFindings`,
`checkVerdictBlockingConsistency`, and architectural-read merge logic: an empty
union is the only path to `ship`, and `don't-ship` survives only with a
structural blocker. **The stopping model is unchanged:** all slices of a review
are ONE logical cycle against the per-issue counter, slices are never counted as
cycles, no per-slice marker family exists, and the cap, `override_cap`
semantics, and auto-grant ceiling are untouched. Two bounded fields now travel
on the direct result, the compact cycle envelope, and the durable findings
record: `diff_mode` (`inline` | `manifest`, the transport fact) and
`review_coverage` (`strategy`, `chunks_total`, `chunks_completed`,
`files_total`, `files_covered`, `complete`). Coverage is validated before any
GitHub write; an incomplete slice set returns `ok: false`,
`status: "post_failed"`, `error: "review_coverage_incomplete"` with no findings
record, decision record, or cycle marker written and no cycle consumed, so a
retry is free. `review_partial_failure` is correspondingly narrowed to the case
where the review completed but publishing it partially failed; an unparseable
reviewer envelope is now a coverage failure in both inline and manifest mode.
`gc_review_cap_disposition` re-derives `diff_mode` server-side from the post-fix
tree and adds a bounded 0.15 risk contribution for a sliced or unknown-coverage
review, so it is never scored as low-risk as a fully inlined one; the
deterministic ceiling, fast paths, and judge boundary are unchanged. Two related
diff-correctness repairs land with it: an `uncommitted=true` review now covers
untracked files (previously absent from both the diff and the manifest while the
prompt claimed they were included), and the slice budget stays on the existing
`GC_CODEX_REVIEW_MAX_DIFF_BYTES` seam with its documented `0`-disables behavior
rather than adding a second knob. See
`architecture/notes/codex-manifest-review-evidence-preflight.md` for the binding
preflight guidance.

**2026-07-26 (issue #1414 review cycle 1).** Three fixes tighten the boundary
the amendment above establishes, with no change to the stopping model, caps, or
durable-record ordering. (1) Slice boundaries now descend through file, hunk,
and line, so a binary/rename-only block or a single oversized hunk can no longer
become an unbounded prompt. A single line larger than the budget is the smallest
unit that survives splitting intact; it is emitted whole and counted in
`review_coverage.oversized_slices` rather than truncated, because dropped bytes
read as reviewed content nobody saw. (2) A slice engine failure (a dead or
failing `codex` child) is captured as an incomplete reviewer result and returns
the same `review_coverage_incomplete` envelope as an invalid reviewer tail,
instead of escaping as an untyped exception the cycle wrapper never sees; the
failing reviewer stops launching further slices once coverage is already lost.
(3) Untracked content is screened before any reviewer prompt is built. Untracked
files are the one review input the developer never selected, and the branch under
review controls `.gitignore`, so a narrowed ignore rule could expose a
pre-existing local credential file to the model provider ahead of
`detectSensitiveBodyContent`, which guards GitHub publication only. Matching
paths are withheld from the reviewed diff and reported by path alone in
`review_coverage.withheld_untracked_paths` and the manifest, keeping the
exclusion visible without disclosing the body.

**2026-07-26 (issue #1414 review cycle 2).** Two further corrections, both to
the cycle-1 fixes above. (1) A sub-file fragment must be a valid standalone
diff. Because every slice is reviewed by an independent process, repeating an
oversized hunk's original `@@` header on later fragments would make each
`line` in a finding point at the wrong code, and a metadata-only fragment
without its `diff --git` line has no file attribution at all. Line-split hunks
now carry a recomputed header whose old/new starts and counts describe the
fragment (walking the body the way git does: context advances both sides, `-`
the old, `+` the new, `\ No newline` neither), and metadata-only fragments
repeat their `diff --git` line. (2) The untracked-file coverage added in the
first #1414 amendment is **withdrawn as an egress channel**. That amendment
followed the preflight note's guidance to include untracked content; the
security review established a concrete attacker model that supersedes it. A
branch under review controls `.gitignore`, so narrowing a rule exposes a
developer's local `.pgpass` or `.dockercfg`, and neither a filename deny-list
(credential filenames are unbounded) nor content inspection (an opaque token
reads as ordinary text) can serve as the authorization boundary for sending
unselected working-tree content to a model provider. Staging is the
repository's existing explicit consent boundary and is now the one the tool
uses: untracked bodies are never transmitted. The prompt states that it reviews
staged and unstaged changes rather than claiming untracked coverage, the
reviewer-visible manifest carries a count of unreviewed untracked paths, and
the caller receives the path list off-prompt in
`review_coverage.unreviewed_untracked_paths`. The original defect this
addressed, a prompt asserting coverage the diff did not have, is closed by
correcting the claim rather than by widening the transmitted content.
`/implement` Step 6.5 stages with `git add -A` before review, so genuinely new
work is still reviewed, as staged content.

**2026-07-26 (issue #1429, configuration-derived policy gate).** The
review-loop batching rule in `skills/implement/steps/_review-loop-rules.md`
now names `cfg.workflow.policy_command` where it previously named `make policy`;
the rule itself is unchanged - broad repository gates run once on the final
post-fix tree, not after every small fix. The stopping model, severity rubric,
per-cycle caps, per-issue cycle counters, and the reviewer-of-record invariant
are unchanged. Cross-referenced for the `workflow-guardrail-sync` contract. See
ADR-021 and ADR-027 (2026-07-26 amendments).

**2026-07-29 (issue #1476 bounded non-verdict re-attempts).** The stopping model
gains a second, disjoint bound. The review cycle cap bounds how many times a
station renders a *verdict*; the new per-reviewer
`non_verdict_retry_limit` bounds how many times a station that rendered *no*
verdict is automatically re-attempted (bounds `[0, 2]`, default 1; `0` restores
the previous never-retry behavior). The two never interact: every retry-eligible
failure class returns before any findings record or cycle marker is written, so
a re-attempt provably consumes no cycle, no cap override, and no
auto-disposition grant.

Retry eligibility is an allow-list of stable error codes - engine invocation
failure (including timeout), unparseable validated output, and incomplete
reviewer coverage - not a heuristic over messages, because a wrong "retryable"
would re-run a station that already spent a cycle. Cancellation, cap refusal,
invalid input or configuration, repository/authorization failure,
reserved-marker and sensitive-content rejection, and GitHub posting failure are
never retried; the last of these matters because re-running an engine to retry a
GitHub write would burn a review for a transport problem.

The retry boundary wraps one complete station attempt, never a slice, poll, or
durable write: partial work from an incomplete attempt is discarded with that
attempt and never merged into a later verdict. Measurement follows the same
split - one ADR-090 station attempt per real execution, `not_evaluable` for each
non-verdict and `pass`/`fail` for the observed one, with `not_evaluable` outside
the first-pass-yield and iterations-to-green denominators so an outage never
reads as rework. Cap evaluators, the per-issue cycle counter, the verbatim
findings record, the zero-deferral rule, and the human `override_cap` escape are
unchanged. See ADR-029 (2026-07-29 amendment) for the obligation side.

**2026-09-06 (issue #1557, review scope versus repository evidence).** The
authoritative diff continues to define what Codex reviews. A reviewer must not
re-derive that diff, review a file outside it, attribute another slice's
coverage to itself, or anchor a finding anywhere except a path and right-side
line in its supplied diff. Repository reads answer a separate question: the
working tree at the invocation root is readable evidence for factual claims
such as whether a path exists, what a canonical helper currently does, or what
an ADR says. Both the core and security prompts must require that verification
before asserting a repository fact. Evidence reads cannot enlarge review scope
or replace the server-derived `review_coverage` contract.

Read-only inspection is limited to the current repository and the selected
review corpus. It does not authorize reads of untracked or ignored file bodies,
which remain outside the staging consent boundary established by issue #1414.
It also does not authorize GitHub, network, Git, or filesystem mutations. The
review prompt may permit repo-scoped read commands needed to inspect or search
files, so it must not retain a contradictory blanket ban on every shell-backed
read. This is behavioral guidance, not a claim of host confidentiality:
`codex exec -C <repo> --sandbox read-only` still selects a working directory and
prevents writes but does not confine reads to that directory. The existing
minimal `codexEngineEnv`, prompt-data delimiters, bounded process lifecycle,
output validation, sensitive-content publication filter, and MCP-owned GitHub
writes remain the security boundaries.

For sliced reviews, the whole-change context adds a separate name-status block
from the same `computeReviewDiff` selectors as the authoritative diff and
numstat manifest. It may establish only the change kind (`A`, `M`, `D`, `R`,
and related Git statuses), not file behavior. The existing numstat string stays
byte-compatible because `parseNumstatManifest` and the review-cap disposition
scorer consume it; name-status is additive, not a replacement or a second
parsed schema. `diff_mode`, slice planning, finding envelopes, coverage
validation, cycle counters, durable records, async jobs, and telemetry are
unchanged, so ADR-036 does not move.
