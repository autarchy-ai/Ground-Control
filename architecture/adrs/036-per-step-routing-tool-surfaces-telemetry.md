# ADR-036: Per-Step Model Routing, Durable-Record Tool Surfaces, and Step Telemetry

## Status

Accepted

## Date

2026-05-11

> **Issue #1632 amendment (2026-09-18):** The deterministic durable-record
> surface now includes `gc_get_review_result` and
> `gc_publish_review_result`. Review execution can return an opaque,
> restart-durable handle without a GitHub write; explicit publication validates
> a sanitized complete mapping, exact revision, cycle slot, and trusted
> provenance before writing the canonical issue-thread records. Publication
> retry reconciliation uses those records, while the original review remains
> local. No backend, database, or new telemetry state is introduced.

> **Issue #1303 amendment (2026-09-11):** The #1500 MCP-only re-platform removed
> the persistence targets for step, workflow-run, and tool-call measurements.
> The remaining telemetry emitters, lifecycle adapters, configuration knob, and
> orchestration calls are now deleted rather than retained as non-enforcing
> shadow work. This ADR remains Accepted for advisory per-step routing and the
> deterministic durable-record tools. Its telemetry decisions below are
> historical and superseded; telemetry is neither a gate nor a supported
> current surface.

> **Style sync for issue #751 (2026-06-14):** Repository-wide Vale cleanup normalized punctuation in workflow prose. This ADR's routing and durable-record tool contracts stay the same.

## Context

ADR-021 ("Gated Agentic Development Loop") and ADR-029 ("Issue-Thread Gate Model")
codify GC-O007: the four-phase `/implement` workflow with one human touchpoint
(PR merge), one Codex review pass (pre-push, hard-capped at three cycles), and
the GitHub issue thread as the durable record. The workflow contract is sound;
the cost profile of running it is not.

Issue #867 (and its scoped sibling #868) measured the within-run token cost
surface and identified three structural changes that reduce cost without
weakening any gate:

1. **Per-step model routing.** Today every step in a `/implement` run executes
   on the parent session's model (typically Opus-class). Most steps don't need
   Opus-class reasoning: polling CI, parsing preflight output, drafting
   structured comments, and applying a fix that codex already designed are
   firmly in haiku/sonnet-tier territory. Without explicit routing, the entire
   run amortizes at the parent's price.
2. **Tool surfaces for durable records.** Step 6.5's decision records, Step
   19's final reports, and Step 9's PR body are templated long-form comments
   produced once per cycle / per run. They are agent-authored free prose
   today: large in tokens, easy to drift from the policy gates they must
   satisfy (`check_pr_body`, ADR-029 zero-deferral, traceability markers).
   Replacing them with deterministic MCP tools that take structured input
   collapses the prose cost to ~zero and lifts gate compliance into the tool
   layer.
3. **Per-step telemetry.** Without per-step measurement, every "this saved
   tokens" claim is unverifiable and every routing decision is a guess. A
   small append-only JSONL log per run, plus a summarizer, makes cost a
   first-class operational signal.

The three changes ride the same architectural seam: deterministic tool
surfaces. Each new MCP tool is structured-input-in, canonical-output-out, no
LLM call, no workflow state. They become Temporal activities directly under
GC-O009 with no shape change.

The gate model is preserved end to end: one human touchpoint (PR merge), no
plan-approval gate, no post-push Codex review, ADR-029's configurable
pre-push cap (default 1 cycle per issue #906; per-repo override via
`.ground-control.yaml::workflow.codex_review.pre_push_cap`, bounds `[1, 10]`),
zero deferral. This ADR amends ADR-021 with cost-side machinery; it does
not redefine GC-O007's gate contract.

## Decision

### Provider-neutral routing seam

The `/implement` SKILL declares a stable **workflow step id** plus a
**capability tier** for each step. The tier is provider-neutral:

| Tier | Intended capability | Claude Code mapping |
|------|---------------------|---------------------|
| `low` | Mechanical action, polling, gh wrapping, file reads | `claude-haiku-4-5` |
| `medium` | Bounded reading + applying a designed decision; structured drafting | `claude-sonnet-5` |
| `high` | Architectural reasoning, novel-fork interpretation, first-cycle review consume | `claude-opus-4-8` (the parent) |

Drivers map tier to a concrete model. Claude Code drivers spawn an `Agent`
subagent with the corresponding model for routed steps. Codex drivers have no
equivalent surface today; they ignore the tier annotation and run all steps
on the session model. The architecture is forward-compatible; a future
Codex-side router consumes the same step-id+tier contract without further ADR
work.

Routing is opt-in per repo via `.ground-control.yaml`'s `routing.enabled`
knob (default `false`). Existing repos see no behavior change until they flip
the knob. The executable routing contract is stage/purpose based: callers ask
`gc_resolve_workflow_route` for a stage such as `implementation`,
`test_quality_review`, or `final_report`, and the tool returns the configured
provider, agent, canonical model id, tier, and fallback policy. The skill keeps
the step matrix legible, but the resolver is the boundary that prevents silent
fallback from being mistaken for routed execution.

The routing seam is calibrated so subagent context-establishment overhead does
not exceed the savings. Very short steps (sub-second polling, single-call
helpers) only get routed to `low` tier when their context cost is also
bounded; otherwise the parent absorbs them.

### Durable-record tool surfaces

Three new MCP tools replace agent-authored long-form comments:

- **`gc_post_decision_record(issue_number, cycle, reviewer, findings[])`**:
  renders the canonical Step 6.5 decision-record Markdown from structured
  input, filters secrets via `detectSensitiveBodyContent`, posts to the
  issue thread with a `gc:decision-record` marker, returns `{ ok, comment_url,
  comment_id, finding_count }`. Rejects `decision: "defer"` server-side
  (defense in depth on top of the `block-defer-language.py` PreToolUse hook).
- **`gc_post_final_report(issue_number, pr_number, ...)`**: same pattern for
  Step 19. Structured input (in-scope requirements, files by change kind,
  reviews per reviewer, traceability reconciliation, CI/SonarCloud status) →
  canonical Markdown → issue thread → `gc:final-report` marker.
- **`gc_render_pr_body(issue_number, change_class, ...)`**: renders a PR
  body that satisfies `check_pr_body`'s policy gates (template sections,
  requirement UIDs, ADR impact, three Ground Control Checks, IMPLEMENTS/TESTS
  markers, no defer language). Returns the body string for the caller to
  pass to `gh pr create --body`. `change_class ∈ {doc-only, source,
  source+migration}` shapes the integration-tests / changelog-fragment cells.
  Renderer is decoupled from `check_pr_body`; a Python test in
  `tools/tests/test_policy.py` asserts the rendered output passes the policy
  predicate, so drift breaks a test.

All three tools share the same boundary: structured input → pure renderer →
sensitive-content filter → GitHub post (or string return for the PR body) →
structured envelope. They reuse `ensureGitRepo`, `getOwnerRepo`,
`detectSensitiveBodyContent`, and the existing `gh api` argv-style execution
path; no new GitHub client, no new marker family beyond the two listed above.

The SKILL stops `gh issue comment`-ing decision records and final reports
once these tools land. Step 9 calls `gc_render_pr_body` and uses the returned
body; **per issue #901, Step 9 also validates the PR *title* locally against
two stable conventional-commit rules before `gh pr create`: single
`<type>(<optional-scope>): <subject>`, optional breaking-change `!` before
the colon per issue #1593 (no compound `security/docs:` prefixes)
and a lowercase-leading subject (`^[a-z].*$`, uppercase acronyms reshaped).
The body renderer and the title validator are independent concerns living in
the same Step 9; the renderer is an MCP tool, the title rule is a local
predicate the agent re-applies on every reshape.** Step 6.5 calls `gc_post_decision_record` for every cycle; **Step 6.6
calls `gc_test_quality_review`** (per #884 v2; the prior `Skill("review-tests")`
boundary returned prose findings that the autoregressive parent agent
kept echoing back to the user instead of fixing in-turn, defeating the
SKILL.md prose rule; the MCP tool returns a structured envelope with
`next_action` that the agent reads as a directive). Issue #906 moved this
call pre-push (former Step 13 → new Step 6.6) so the PR opens with both
AI-assisted reviewers clean; the same #906 amendment dropped the default
pre-push cap for both reviewers from 3 to 1, configurable per repo via
`workflow.codex_review.pre_push_cap` and `workflow.test_quality_review.pre_push_cap`.
The MCP tool itself is unchanged; only its workflow placement and default
cap value shifted. After Step 6.6's
cycle the parent calls `gc_post_decision_record` with the
`fix`/`wontfix`/`not-applicable` dispositions (cycle counter, durable
record); a clean cycle is the structured advance-to-Phase-C signal once
that post returns `ok: true` (the string was `..._advance_to_step_14`
before issue #906 collapsed Step 14 into Step 10's existing CI watch;
new MCP envelope returns `..._advance_to_phase_c`). See
`architecture/notes/test-quality-review-engine.md` for the full MCP
tool mechanism (claude CLI exec, `ANTHROPIC_API_KEY` strip / OAuth,
cycle markers, failure modes). Step 19 calls `gc_post_final_report`.

### Telemetry contract

Operational measurement only; **not** workflow state, not a cycle counter,
not compliance evidence. The issue thread and Ground Control traceability
remain the audit record.

Each routed step writes one JSONL line via `gc_log_step_telemetry` to
`.gc/telemetry/<issue>-<sanitized-branch>.jsonl`:

```json
{
  "schema": "gc.implement.telemetry/v2",
  "ts": "2026-05-11T07:00:00Z",
  "issue": 868,
  "branch": "868-route-tools-telem",
  "step": "4.5",
  "tier": "medium",
  "model": "claude-sonnet-5",
  "expected_model": "claude-sonnet-5",
  "model_matches_expected": true,
  "wall_time_ms": 12480,
  "input_tokens": 8421,
  "output_tokens": 612,
  "outcome": "ok"
}
```

- `expected_model` and `model_matches_expected` (schema v2, issue #1181) are
  derived server-side from the step's `tier` via `CLAUDE_MODEL_BY_TIER`. The
  `model` field itself is self-reported by the orchestrator and was found
  unreliable in the recorded data (tier/model mismatches, intra-run
  contradictions, model ids that postdated the config). `model_matches_expected`
  is a recorded tier/model **consistency assertion**: `false` flags a record
  whose reported model diverged from the tier's canonical model - routing that
  did not land where the tier intended, or a mis-report. It is recorded, never
  gating; telemetry stays operational measurement only. Capturing the *actual*
  dispatched-subagent model from the harness (rather than the reported value)
  remains future work tracked in #1181. Note that high-tier `agent: parent`
  steps run on the parent session model, so the configured `high:` id is
  advisory for those steps.
- `wall_time_ms` is mandatory; the agent measures around its delegation calls.
- `input_tokens` and `output_tokens` are optional; Claude Code's `Agent` tool
  does not surface per-call counts today, so the writer accepts `null`. When
  token counts are absent, the summarizer reports wall time and the per-step /
  per-model call counts; dollar-cost translation is **not** in v1's scope and
  is explicitly future work (a per-model price table goes stale faster than the
  workflow surface; shipping cost estimation without a maintained price source
  is worse than shipping wall time alone). The contract is "measure what we
  can measure reliably."
- The `branch` field in every record AND the branch-derived path segment are
  both sanitized: any character outside `[A-Za-z0-9._-]` becomes `_`, and the
  result is truncated to 60 characters. Empty / pathological inputs become
  `unknown`. The record stores the sanitized form (not the raw input) so the
  filename and the record cannot disagree; the original branch identity is
  always carried via the issue number, which is canonical anyway. Path is
  repo-relative, validated via `resolveRepoRelativePath` +
  `assertRealpathInRepo` against the canonicalized repo root so symlinks can
  never let the writer escape `.gc/telemetry/`.
- Telemetry is opt-in per repo via `.ground-control.yaml`'s
  `telemetry.enabled` knob (default `false`).
- `.gc/telemetry/` is gitignored. The local summarizer (`make
  implement-cost-summary`) that aggregated per-step and per-model totals was
  removed in #1507 (see Amendments); this reference is historical.

### Forward compatibility with GC-O009

Every tool surface in this ADR is deterministic, side-effect-bounded, takes
structured input, and returns a stable JSON envelope. Specifically:

- No tool reads or writes Temporal-incompatible state.
- No tool blocks on the agent's chat-style stream.
- Telemetry path is local-file; the contract maps cleanly to Temporal's
  built-in visibility when the workflow moves to Temporal.
- The routing tier abstraction is provider-neutral, so GC-O009's
  "(f) Configurable LLM provider" clause inherits it without re-litigation.

When GC-O009 lands, the four new tools become Temporal activities directly.
This ADR does NOT implement Temporal, introduce a workflow engine, durable
queue, or worker code. It only ensures the bridge surface is Temporal-shaped.

### Replaces / amends

- **ADR-021** is amended (gain a new amendment blockquote citing this ADR).
  The gate model and phase structure are unchanged; only the cost-side
  machinery changes.
- **ADR-029** is amended by issue #906 only to make the Codex cap
  configurable per repo (default 1, override via
  `workflow.codex_review.pre_push_cap`); the zero-deferral rule,
  issue-thread-as-durable-record contract, and one-human-touchpoint contract
  all stand.
- **ADR-027** is unchanged; the agent-neutral packaging seam absorbs the new
  tools as additions, not redefinitions.
- **ADR-028** is unchanged; this ADR is the SKILL/MCP-level precursor to its
  Temporal boundary.

The `workflow-guardrail-sync` policy rule
(`architecture/policies/adr-policy.json`) gains this ADR in its `requireAll`
list so future SKILL changes must keep it in sync.

## Consequences

### Positive

- Within-run cost drops by routing the bulk of `/implement` steps to
  haiku/sonnet tiers; opus-class reasoning is preserved where it is needed
  (Step 4 plan writing, Step 6.5 first-cycle review interpretation).
- Decision records, final reports, and PR bodies become deterministic
  artifacts produced by tools, not agent prose. Drift from policy gates is
  caught by a renderer-vs-policy test, not by waiting for CI to complain.
- Per-step telemetry makes cost a measurable, comparable signal across runs
  and across drivers.
- The four new tools are Temporal-shaped; GC-O009 inherits them as activities.

### Negative

- A second config knob in `.ground-control.yaml` (`routing` + `telemetry`)
  and a second ADR for the workflow surface (this one). Both must be kept in
  sync with the SKILL.
- Subagent context-establishment overhead is a fixed per-call cost; if the
  matrix mis-tiers a tiny step the savings can evaporate. Mitigation: the
  matrix is calibrated conservatively, and the telemetry signal will surface
  mis-tiering quickly.
- Per-call token counts depend on the harness exposing them; Claude Code
  does not today, so telemetry's `input_tokens`/`output_tokens` are `null`
  until that lands.

### Risks

- **Telemetry-as-state drift.** If a future agent or sweep treats the
  telemetry log as workflow state (a counter, a gate), it would re-introduce
  exactly the local-file-state-vs-issue-thread divergence ADR-029 closed.
  This ADR makes the operational-only contract explicit; a future tool that
  treats telemetry as gate state must amend this ADR first.
- **Routing degrades Codex driver coverage.** Codex has no `Agent`-with-model
  surface today. The architecture is provider-neutral so Codex routing is
  unblocked, but until a Codex-side router ships, Codex runs all steps on
  the session model. That asymmetry is acceptable for a bridge ADR.
- **PR-body renderer vs policy drift.** If `check_pr_body` adds a new
  required header and the renderer is not updated, the body fails the policy
  gate at CI time. Mitigation: the renderer-vs-policy compose test
  (`tools/tests/test_policy.py`) catches drift on the same PR.

## Implementation references

- `architecture/notes/implement-cost-routing-tool-surfaces-preflight.md`: preflight
  design context for this ADR.
- `mcp/ground-control/lib.js` and `mcp/ground-control/index.js`: the four
  new tool implementations and registrations.
- `mcp/ground-control/lib.test.js`: renderer / validator / containment tests.
- `skills/implement/SKILL.md`: the routing matrix and Step 6.5 / 9 / 19
  wiring.
- `docs/WORKFLOW.md` and `docs/DEVELOPMENT_WORKFLOW.md`: the workflow-side
  documentation of the routing seam, tool boundary, and telemetry contract.
- `tools/policy/checks.py` and `tools/tests/test_policy.py`: the
  renderer-vs-policy compose test and the workflow-guardrail-sync rule that
  pins this ADR to future SKILL edits.
- `Makefile`, `tools/summarize_implement_telemetry.py`: the summarizer
  target.
- `.ground-control.yaml` (this repo): opts in to `routing.enabled: true`
  and `telemetry.enabled: true` so the change is dogfooded.
- `changelog.d/868.changed.md`: release note fragment.

## Amendments

**2026-05-19 (issue #931).** No change to the routing stage names, tier
semantics, or telemetry record shape. The downstream deterministic tools
(`gc_post_decision_record`, `gc_post_final_report`, `gc_render_pr_body`) gain
optional verdict-envelope fields on `gc_post_decision_record` (`verdict`,
`architectural_read`, `notes[]`) alongside the existing `findings[]` input.
The renderer contract (canonical Markdown, sensitive-content scrub,
reserved-marker rejection, marker family `gc:decision-record`, defer
rejection) is unchanged. See ADR-029 (amendments) for the envelope shape and
issue #931 for the principal-engineer recalibration motivation.

**2026-05-19 (issue #934).** Extends the routing design from cheap-workers-for-cheap-steps toward subagents-as-context-boundaries and MCP-tools-as-loop-drivers. No change to the routing stage names, the tier-to-model
mapping, the telemetry record shape, or the GC-O007 gate contract. What
changes is the **packaging of the workflow prose** and the **boundary at
which loops execute**.

1. **Thin orchestrator + per-step files.** `skills/implement/SKILL.md` is
   reduced from a monolithic 716-line script to a ~100-line orchestrator
   that enumerates step ids and delegates per-step work to subagents.
   Per-step prose lives at `skills/implement/steps/step-NN-<id>.md`, one
   file per step. The canonical Review loop rules live at
   `skills/implement/steps/_review-loop-rules.md`; Steps 6.5 and 6.6
   reference it by path (the duplicated prose at the bottom of the old
   SKILL.md and across the two step bodies is removed). Per-step files are
   workflow prose packaging only; the executable schema remains
   `.ground-control.yaml` + `gc_get_repo_ground_control_context`; stage
   ids are unchanged.

2. **Subagents as context boundaries.** For every step whose route resolves
   to `agent: subagent`, the parent spawns a subagent whose prompt is
   verbatim "Execute `skills/implement/steps/step-NN-<id>.md` against issue
   N; return `{status, cached_for_next_step}`". The parent never loads the
   step file. The subagent's return envelope is structured: never raw
   `gh`/`git` output, never full file contents, never verbatim review
   prose. The savings target is the parent-orchestrator context, which
   used to carry the full SKILL prose for the entire 1–2 hour run.

3. **MCP tools drive loops, not the agent.** Four new tools land:

   - `gc_codex_review_cycle`: wraps the existing `gc_codex_review` AND
     auto-posts the per-cycle decision record. Returns a compact terminal
     envelope: `{ok, reviewer, cycle, cap, status, next_action,
     findings_summary, findings_record_url, decision_record_url}`.
     Verbatim review prose stays server-side via the underlying findings
     record. Auto-posted decisions are always `decision: "fix"` (the only
     decision the cycle tool can record without user authorization). A
     subagent that has obtained user authorization for a wontfix calls
     `gc_post_decision_record` directly with the override AFTER the cycle.
   - `gc_test_quality_review_cycle`: same shape as the codex wrapper, for
     test-quality reviews. Both cycle wrappers share one parameterized
     internal seam (`_runReviewCycleShared`) parameterized by reviewer and
     cap source; there is exactly one cycle implementation, not one per
     reviewer.
   - `gc_watch_ci_run`: server-side GitHub Actions poller. Replaces the
     per-poll agent turn cost of /implement Step 10. Returns one terminal
     envelope `{conclusion, failed_steps[], log_summary}` after the run
     reaches a terminal state, hits the queued-too-long cap (5 min
     default), or hits the total cap (45 min default). Raw CI logs stay
     server-side; only the bounded UTF-8 tail of `gh run view --log-failed`
     is returned.
   - `gc_watch_sonar_analysis`: server-side SonarCloud poller. Returns
     `{quality_gate, issues_summary, hotspots_summary,
     full_issue_export_path}` after the analysis is fetched and
     paginated. The `SONAR_TOKEN` is read at call time and passed only in
     the Authorization HTTP header; never in argv, telemetry, exports,
     or returned envelopes (the issue #934 preflight binding rule).

4. **Issue-thread cache.** `gc_get_issue_thread` returns the body +
   comments + a sha256 content hash on first call. Subsequent calls with
   the same `expected_hash` return `{unchanged: true}` without re-fetching
   from GitHub. The cache is keyed by `(repoRoot, issueNumber)`,
   explicitly NOT branch-keyed, and is operational only; the GitHub
   issue thread remains the durable record per ADR-029. `expected_hash=null`
   always forces a fresh fetch, used by callers after a posting may have
   failed or when marker state is uncertain.

5. **Telemetry actually writes.** The `gc_log_step_telemetry` tool was
   correctly implemented from #868 but never called by the SKILL prose.
   The new orchestrator calls it at the end of every routed step from
   one place (the per-step harness), producing one JSONL line per
   step in `.gc/telemetry/<issue>-<sanitized-branch>.jsonl`. Schema
   unchanged.

6. **Policy follows the new layout.** The
   `tools/policy/checks.py::run_test_quality_decision_record_contract`
   check, which used to read `skills/implement/SKILL.md` directly, now
   reads `skills/implement/steps/step-06.6-test-quality-review.md` as
   the primary contract source and falls back to SKILL.md for backward
   compatibility. The step heading regex accepts H1 in addition to
   H2–H4 to match the per-step file convention. The Step 6.6 file
   explicitly restates the required contract markers
   (`gc_post_decision_record`, `findings: []`, `ok: true`,
   findings-fix-in-same-turn directive); the cycle wrapper auto-implements
   them, but the step file documents them for the policy check.

The four new tools are additive: `gc_codex_review`, `gc_test_quality_review`,
`gc_post_decision_record`, and the rest stay unchanged in shape and signature
so direct callers (including `/quickfix` and external scripts) keep working.

The cycle wrappers, watch tools, and issue-thread cache are the substrate
GC-O009 (Workflow Orchestration via Temporal) will eventually formalize as
Temporal **activities** with typed inputs/outputs. This work is bridge work
toward GC-O009 by moving repeated loops into MCP boundaries that return one
terminal envelope per invocation, instead of having the agent drive each
iteration. No Temporal adoption, no DB tables, no branch-keyed counters, no
new workflow DSL; the issue thread on GitHub remains the durable record.

**2026-05-21 (issue #937).** Closes the MCP tool-call boundary timeout that
made the codex-driven governance gates unreliable. `gc_codex_review`,
`gc_codex_review_cycle`, `gc_codex_architecture_preflight`,
`gc_test_quality_review`, and `gc_test_quality_review_cycle` each spawn a
`codex exec` / `claude --print` child that legitimately runs for several
minutes (the child cap is `DEFAULT_CODEX_TIMEOUT_MS`, 20 min). Run
synchronously, a single MCP tool call blocked far longer than the MCP
client's per-call timeout; the client abandoned the call, the child was left
running with no result handle, and the workflow never received a review
envelope (first observed in issue #893). No change to the GC-O007 gate
contract, the cycle caps, the marker families, or the decision-record shape.

Two coordinated changes:

1. **Client timeout alignment.** `.claude/settings.json` now sets
   `MCP_TOOL_TIMEOUT` (3,600,000 ms) and `MCP_TIMEOUT` (30,000 ms) explicitly,
   in the checked-in repo settings, so every Claude Code session in the repo
   gives long-running MCP tools the headroom they need. This also covers the
   `gc_watch_ci_run` (2700 s) and `gc_watch_sonar_analysis` (1800 s)
   server-side-hold tools added in the #934 amendment, which previously relied
   on an unset client default.

2. **Async job model.** The five review/preflight tools gain an opt-in
   `async` boolean (default `false`; synchronous behavior and every direct
   caller are unchanged). With `async: true` the tool starts the work as a
   background job and returns `{ok, status: "running", job_id}` immediately. A
   new tool, `gc_codex_job`, polls the job (`action: "poll"` → a running
   envelope, or `{status: "done", result: <review envelope>}` once finished)
   and cancels it (`action: "cancel"`). The job registry is in-memory in the
   long-lived MCP server process; jobs are reaped 30 min after completion;
   poll for an unknown id returns `job_not_found` and the agent re-runs.
   Cancellation aborts an `AbortController` whose signal is threaded down to
   the child process exec, so a cancelled job leaves no orphan. The /implement
   step files (2.5, 6.5, 6.6 and `_review-loop-rules.md`) drive the
   start-then-poll pattern; `result.next_action` is dispatched exactly as the
   synchronous envelope was.

`gc_codex_job` is the sixth tool in this ADR's surface family and, like the
cycle wrappers and watch tools, is bridge work toward GC-O009; the
start/poll/cancel triple is the shape a Temporal activity handle takes.

**2026-07-30 (issue #943): idempotent async-only cycle boundary.** The public
`gc_codex_review_cycle` and `gc_test_quality_review_cycle` registrations no
longer expose a synchronous path. Omitted or true `async` starts a background
job; false is refused. Each start requires a bounded `idempotency_key` scoped
with a server-derived fingerprint to the authorized canonical repository,
issue, and reviewer. Same-key/same-input retries return the retained running or
terminal job, changed input returns `job_idempotency_conflict`, and distinct
keys are single-flight within that reviewer scope. Authorization and safe Git
configuration checks happen before job lookup, so a retained idempotency hit
cannot bypass repository identity. Cycle jobs are registered non-cancellable:
the current abort signal reaches the reviewer child but cannot prove rollback
after findings, cycle, station, or decision records begin posting. A
`job_not_found` result therefore requires issue-thread refresh before a new
logical attempt; the in-memory registry never claims exactly once recovery
across process loss. The synchronous internal cycle executors, durable posting
order, marker families, cap counters, terminal result envelope, and closed
telemetry shape are unchanged.

**Amendment: renderer summary byte caps (#964).** Two of the three durable-record renderer tools in this ADR's surface family (`gc_render_pr_body` and `gc_post_final_report`) now enforce reject-not-truncate byte caps on their caller-controlled summary fields (`PR_BODY_SUMMARY_MAX = 1200`, `FINAL_REPORT_SUMMARY_MAX = 800`, `FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX = 600`, `FINAL_REPORT_REVIEW_SUMMARY_MAX = 240` for `reviews[].summary`). `gc_post_decision_record`'s schema is unchanged; its caller-controlled prose fields already had per-field caps. The canonical succinctness rule is in `skills/implement/steps/_review-loop-rules.md § Update succinctness (canonical)` and is referenced from all three renderer tool descriptions. `buildFinalReport` no longer emits placeholder lines in the In-scope requirements or Reviews sections when those inputs are empty.

**Amendment: issue close mechanism (#862 typed-action-items PR).** The /implement Step 18 no longer runs `gh issue close`. The GitHub issue closes via `Closes #<issue-number>` in the PR body (rendered by `gc_render_pr_body` in Step 9) when the user merges the PR. Step 18 only removes the `in-progress` label set in Step 1. Closing from the agent decoupled the close event from the merge: an unmerged or rolled-back PR would leave a closed issue with no shipped code (GitHub does not re-open issues on revert). Step 19 (final report) is correspondingly tightened: traceability reconciliation (Steps 15 through 17) is an explicit precondition, and no earlier step surfaces a user-facing "complete" signal (prior escalations are for input, not for "done"). The /quickfix sibling lane is updated in lockstep.

**2026-05-26 (issue #989).** The new `/integrate` skill lane (GC-O011) runs on the parent session for every step. The lane's work is mechanical (label-based PR discovery, worktree rebase, completion gate, CI/Sonar watch, force-with-lease push) and does not benefit from per-step model tiering. If a future stage of the lane benefits from LLM reasoning, the `gc_resolve_workflow_route` resolver and the `routing.stages.*` configuration block already support adding stages without changing this ADR.

**2026-05-26 (issue #989 merge carve-out).** The `/integrate` lane's `mode=merge` execution path runs inside the MCP server subprocess (via `gc_integration_manager` action=prepare mode=merge). This is the same tool surface boundary that the prepare path uses; no new routing stage or telemetry surface is required. The merge carve-out does not change the step-routing contract for any other lane.

**2026-05-30 (issue #1058 Phase E + close stage).** A new orchestrator stage `close_issue_after_merge` is added to the routing table for the /implement Phase E (Step 20) post-merge close. The stage's tier defaults to `low` (the work is mechanical: verify `merged_at`, run `gh issue close`) and is configurable per repo via `routing.stages.close_issue_after_merge` in `.ground-control.yaml`. The two underlying tools (`gc_assert_traceability_reconciled` and `gc_close_issue_after_merge`) consume the existing `repoPath` / `issueNumber` boundary and produce telemetry records via the existing `gc_log_step_telemetry` writer; no new telemetry schema is required. The step-routing contract for every other lane and stage is unchanged.

**2026-06-13 (issue #1156 outcome + recommendation).** The `final_report` renderer surface now requires `/implement` callers to pass `plain_english_outcome`; quickfix remains optional. The field is capped independently and renders as an Outcome section before structured evidence, so the durable final report gives the user a plain-language Phase D result without overloading `summary`. The `close_issue_after_merge` stage envelope now includes the advisory `next_issue_recommendation` object, or an explicit no-recommendation/failure reason, after the merge-verified close succeeds. No new routing stage or telemetry schema is required.

**2026-06-10 (issue #1099 threat/risk screening gate).** A new orchestrator stage `grc_screening` is added to the routing table for the /implement Phase A (Step 3.5) GRC screening gate. The stage's tier is `medium` (reading workspaces + classifying change surface + optional GRC entity writes) and is configured via `routing.stages.grc_screening` in `.ground-control.yaml` if per-repo override is needed. The underlying tool (`gc_post_grc_screening`) consumes the existing `repoPath` / `issueNumber` boundary and produces telemetry records via the existing `gc_log_step_telemetry` writer; no new telemetry schema is required. The step-routing contract for every other lane and stage is unchanged.

## Amendment (issue #1103)

The Phase D completion assertions and final report are consolidated into one deterministic tool `gc_assert_completion` that composes the existing assertion runners (`runAssertTraceabilityReconciled`, `runAssertGrcReconciled`) and the final-report runner (`runPostFinalReport`) in a single sequenced call. The former Steps 17 (verify), 18 (label removal), and 19 (final report) are collapsed into a single Step 17. The markers (`traceability_reconciled`, `grc_reconciled`) and all gates are unchanged; `gc_assert_completion` uses `internalVerifiedPhases` to pass the just-posted markers to `runPostFinalReport` internally, avoiding a GitHub read-after-write race. The `in-progress` label removal is now optional best-effort, not a mandatory step gate. Phase D boundary is now Steps 9 → 17.

**2026-06-19 (issue #1189 Cursor CLI driver).** Cursor CLI is a third orchestrator driver for the `/implement` skill. Like Codex, it runs every step on the parent session and ignores Claude-model subagent delegation from `gc_resolve_workflow_route`; poll-loop stages (`architecture_preflight`, `review_cycle_1_consume`, `test_quality_review`) stay parent-only. No new routing provider, telemetry schema, or MCP tool is required. Skill discovery uses `bin/install-skills.sh` (hard-copy into `~/.cursor/skills/<name>`) plus the project wrapper at `.cursor/skills/implement/SKILL.md`; CLI permissions live in `.cursor/cli.json`.

**2026-06-22 (issue #963 post-merge reconciliation ordering).** No routing stage is added or renamed: the `transition_reconcile` stage (Steps 15/16) and the `final_report` stage (Step 17) keep their tier/agent mappings. What changes is *which phase* those stages execute in - they move from Phase D (pre-merge) to the new Phase E (post-merge), after the user merges, so Ground Control state never runs ahead of shipped code (see ADR-021 / ADR-029 §2026-06-22). `gc_assert_completion` gains a `phase` parameter: `phase="post_merge"` (default) is merge-gated (refuses `completion_pr_not_merged` unless the PR is merged) and runs the reconciliation assertions + final report; `phase="pre_merge"` posts the Phase D readiness record (a `ready_for_review` marker, no `gc:final-report` marker, no reconciliation assertions). The composite-tool surface, `internalVerifiedPhases` race avoidance, and telemetry contract are otherwise unchanged.

**2026-07-03 (issue #1271, ADR-081 program).** ADR-081 adopts the Temporal dev workflow and console program (milestone 17). This ADR's durable-record MCP tool surfaces (`gc_post_decision_record`, `gc_post_final_report`, `gc_render_pr_body`, and the later renderer/assertion family) were deliberately Temporal-shaped (deterministic, structured-input/output, no LLM call); under ADR-081's build order they become the implementations behind GC-O009 deterministic activities, with their input/output records published as versioned contracts under ADR-082's `contracts/schemas/` surface before the corresponding activity lands. The routing table (`gc_resolve_workflow_route`) and step-telemetry contract are unchanged; per-phase ownership transfer to Temporal follows ADR-081's cutover model and is recorded on ADR-021/ADR-029, not here.

**2026-07-11 (issue #1346, ADR-089 reversal of the recommendation clause).** The 2026-06-13 (#1156) amendment above bundled two unrelated changes. Its `plain_english_outcome` requirement on the `final_report` renderer surface remains in force unchanged. Its `next_issue_recommendation` clause is reversed: the `close_issue_after_merge` stage envelope no longer includes `next_issue_recommendation` (advisory, `null`, or otherwise). `gc_close_issue_after_merge` performs only linked-PR resolution, merge-state verification, and idempotent close; no next-issue lookup runs. No routing stage or telemetry schema changes as a result. See ADR-089 for the full retirement decision.

**2026-07-15 (issue #1399, GC-P027 Release Please adoption).** `gc_render_pr_body` gains a `changelog_mode` input (`fragments` default | `release-please`); in `release-please` mode it neither requires nor accepts a `changelog_fragment` (Release Please owns `CHANGELOG.md`, #1336). The workflow passes `release-please` mode for any repo that ships a root `release-please-config.json` (a generic, repo-agnostic signal), rather than special-casing a single repo in prose or adding a `.ground-control.yaml` schema key that would require server/config lockstep. `tools/policy/checks.py` retires `run_changelog_fragment_check` for `run_version_mirror_consistency_check` (code `version-mirror-drift`). The routing table, the step-telemetry contract, and the other durable-record renderer surfaces are unchanged.

**2026-07-25 (issue #1416, execution-boundary tools).** Four MCP surfaces are
added without introducing a routing stage or changing telemetry:
`gc_prepare_implement_branch` creates/checks out the issue branch in the
invocation checkout and verifies repository identity before and after the
operation; `gc_record_execution_obligation` writes validated durable obligation
events; `gc_mark_implement_issue_picked_up` owns pickup label/comment writes;
and `gc_authorize_execution_obligation_wontfix` creates structured authorization
records from exact, permission-checked source commands. Delegated stages receive the immutable execution contract containing
the canonical principles digest, invocation root, and `same_checkout` mode.
Direct branch-development, pickup GitHub commands, and worktree creation are
outside the `/implement` tool boundary. All mutating surfaces bind their
caller-supplied path and repository identity to the workspace/origin captured
when the MCP process launches, so supplying a second checkout or later
retargeting origin cannot redirect ambient credentials. Branch preparation
also disables hooks and caller-selected executable Git configuration, compares
the pinned origin internally, and omits the raw remote URL from its response.
Because the binding principles are passed verbatim to every routed step,
risk-proportionate verification is driver-neutral: targeted iteration,
risk-triggered breadth, one final post-fix completion/policy boundary, and the
single pre-publish pre-commit gate apply identically to parent and subagent
routes.

**2026-07-26 (issue #1421, advisory routing and synchronized PR tools).**
Routing no longer returns or accepts an `agent` or fallback execution-control
decision. The resolver returns advisory provider/model/tier metadata; routine
steps, including both review-cycle poll loops, execute in the primary
invocation session. Server-side background review jobs remain unchanged and
are not agent delegation. A new low-tier `base_sync` stage describes Step 8.5.
The deterministic tool family adds `gc_synchronize_implement_branch` and
`gc_create_synchronized_implement_pr`; their durable synchronization marker
uses ADR-029. The synchronization completion action owns final-tree completion
and policy execution, binds their unchanged tree to the merge commit, and
resumes safely after post-commit failures. PR lookup and creation are pinned to
the authorized repository and validate an existing PR before idempotent reuse.
Existing step telemetry remains operational-only.

**2026-07-26 (issue #1426, mechanical execution bands).**
`gc_implement_mechanical` is an action-multiplexed deterministic tool with
`bootstrap`, `verify`, `publish`, `monitor`, `readiness`, and `finalize`
actions. Successful script-only bands do not resolve a model route; route
resolution remains advisory and is performed only when a model will do
semantic or repair work. Telemetry may record one event per band instead of
one per mechanical sub-step. The tool uses the existing guarded primitives and
durable evidence, invokes no LLM, and returns `agent_required: true` only with
a bounded repair reason. Existing routing stages and telemetry's
operational-only status remain unchanged.

**2026-07-28 (issue #1473, async mechanical execution).**
The existing in-process review/preflight job registry becomes the shared
background-job registry; `gc_codex_job` remains the one polling surface.
`gc_implement_mechanical` gains opt-in background execution for only
`verify`, `publish`, and `monitor`, the actions whose repository commands or
remote watchers can outlive one MCP request. `/implement` and `/quickfix` use
that mode by default for those actions. `bootstrap`, `readiness`, and
`finalize` remain synchronous.

Each background mechanical start requires a bounded `idempotency_key` for one
logical attempt. The server fingerprints normalized mechanical input under the
canonical checkout, issue, and action. Repeating the same key and input reuses
the running or terminal job; changing input under one key returns
`job_idempotency_conflict`. Distinct active `verify` and `publish` jobs share a
single-flight checkout scope, preventing overlapping verification and Git
mutation after the initiating request returns. The registry has a fixed
capacity, never evicts running work, and retains terminal results under its
existing 30-minute TTL.

The job and action envelopes remain separate. `status: "done"` means the
background function returned; its unchanged `result` may correctly have
`ok: false` and `agent_required: true` for an expected red gate. Only an
unexpected rejection produces top-level `status: "failed"`. Stored unexpected
errors are bounded and sensitive-content scrubbed. Job IDs and idempotency keys
are bounded at the public schema.

Review and preflight jobs remain cancellable because their child processes
honor the registry's `AbortSignal`. Mechanical actions do not yet honor abort
across their entire shell, Git/GitHub, fetch, retry-delay, and polling graph, so
their job records declare `cancellable: false`; cancel returns
`job_not_cancellable` and leaves the action running to its ordinary terminal
result. This is an explicit correctness boundary, not a deferred promise or a
reason to increase the MCP request timeout. Jobs remain operational,
process-local waiting state. Existing issue-thread records, synchronization
attestations, workflow-run lifecycle events, station attempts, routing stages,
and telemetry retain authority and unchanged semantics.

**2026-08-13 (issue #1495, bounded mechanical-publish recovery).**
Mechanical jobs stay `job_not_cancellable`: their full Git/gate/GitHub subprocess
and polling graph does not honour abort, so advertising cancellation (or a
signal-driven wall-clock deadline, which only bites if the abort it raises is
honoured) would be false. An earlier revision of this change marked `publish`
cancellable and deadlined; review rejected it because the abort context reached
only the final-tree gates, so a cancellation could keep mutating before the next
gate and could report a terminal status without proving the checkout was
reconciled. The reported hang (a `publish` left `running` with `MERGE_HEAD`
present after every child had exited) is closed structurally instead:

- The shared streaming gate runner now runs each gate as its own process-group
  leader and reaps the group when the leader exits. A gate that spawned a
  background descendant and returned previously left that descendant holding the
  stdout pipe, so `close` never fired; reaping an already-empty group is a no-op,
  so a well-behaved gate is unaffected. This is the direct fix for the observed
  "running with no active subprocess" hang, and it protects every gate run
  (`verify` and `publish` alike), not only publish.
- `publish` holds a dedicated, heartbeat-backed filesystem lease for its
  authorized per-worktree Git directory from before staging through final
  reconciliation, releasing it on every settled path. In-memory single-flight
  remains an optimization, not the mutation lock. This lease must not reuse
  `/integrate`'s repo-wide lock; that lane has a distinct
  isolated-worktree/rebase lifecycle.
- A small versioned write-ahead recovery journal in the authorized per-worktree
  Git metadata records the opaque sync record ID, pre-publish and pre-sync
  identities, fetched-base and expected-merge SHAs, and a closed phase, updated
  before/after each mutating phase and required (not best-effort) before a
  mutation. It is operational recovery state, never a success attestation or PR
  authority; only the trusted issue-thread synchronization record authorizes PR
  creation. Its temporary file is created with an unpredictable name under
  `O_EXCL|O_NOFOLLOW` with a regular-file check, so a planted symlink cannot
  redirect the write. Recovery envelopes stay closed and scrubbed: phases,
  timestamps, object IDs, branch/ref identity, and operation-state flags only;
  never command text, output, environment, credentials, origin URLs, lock or
  journal paths, or stack traces.
- The base-sync completion re-reads `HEAD`, `MERGE_HEAD`, and the unmerged set
  immediately before the merge commit (a compare-and-swap against the persisted
  attempt), so a checkout that changed under the long gates (the incident's
  externally recovered merge) is refused without mutating rather than committed
  and then rejected against stale state.
- After process loss, a later authorized `publish` acquires the lease and
  reconciles the journal against `HEAD`, `MERGE_HEAD`, and the tree before doing
  new work. A journal-matching staged merge is resumed through the existing
  base-sync retry contract (`retry_input`); a dirty-but-not-merging tree is
  ordinary repair-and-retry territory that clears the spent journal and proceeds;
  a mismatched, foreign, or corrupt journal is a bounded refusal that preserves
  the checkout. The tool never auto-aborts, resets, chooses a conflict side, or
  attributes an unrecorded merge to the current issue.

Job starts, polls, and reconciliation remain transport/operation facts: they add
no station, lifecycle state, marker family, or measurement schema. Making the
whole publish graph honour an abort context, and only then adopting a genuine
server-owned deadline and cancellation, are prerequisites this change does not
claim.

The test-quality reviewer's child-process ceiling is 30 minutes. A repository-
scale test cutover exceeded the former ten-minute ceiling while its async job
was healthy, so the shorter bound incorrectly converted legitimate review work
into `test_quality_review_engine_failed`. The background job remains
cancellable through the same `AbortSignal`; the ceiling is only the final
stuck-child bound and does not replace polling or widen an MCP request timeout.

**2026-07-26 (issue #1414, sliced review inside one async job).** An over-cap
diff is reviewed as several bounded inline slices, which multiplies the number
of `codex exec` children a single `gc_codex_review` / `gc_codex_review_cycle`
call spawns. This stays entirely inside the existing async job model: one
`startAsyncJob` job, one `job_id`, one `gc_codex_job` poll loop, and one
abort signal that still kills every child. Slices run sequentially within a
reviewer so the existing `GC_CODEX_REVIEW_PARALLEL` setting remains the only
concurrency knob. The deterministic record renderers gain two bounded output
fields (`diff_mode` and `review_coverage`) on the direct result, the compact
cycle envelope, and the findings record; neither carries diff content, prompts,
or child output. Per-step telemetry is unchanged: a sliced review is still one
routed review step, and slices are not telemetry events.

**2026-07-26 (issue #1429, policy command in the tool surfaces).** No routing
stage is added, renamed, or retiered, and the step-telemetry contract is
unchanged. Two deterministic tool surfaces change behavior:
`gc_implement_mechanical action=verify` and
`gc_synchronize_implement_branch action=complete` run
`workflow.policy_command` (normalized default `make policy`) through the
same repo-authored-command boundary they already use for
`workflow.completion_command`, rather than a hardcoded `make policy` argv. The
`verify` envelope adds `policy_command` alongside the existing
`completion_command` so the caller can see which gate ran. Neither surface takes
a caller-supplied policy command - it is read from the repository context only -
and `gc_render_pr_body` gains no input and emits no command text (see ADR-029).
`gc_implement_mechanical action=publish` likewise runs
`workflow.precommit_command` (normalized default `pre-commit run --all-files`)
and now resolves and validates the repository context before the hook boundary,
so an invalid `.ground-control.yaml` cannot fall through to a default hook
command.

**2026-07-29 (issue #1354, durable step-telemetry sink).** The per-step
telemetry contract above still holds (`gc_log_step_telemetry`, `telemetry.enabled`
opt-in, operational-measurement-only, non-gating), but the **sink changes**.
The forward `.gc/telemetry/<issue>-<sanitized-branch>.jsonl` write is retired:
`gc_log_step_telemetry` now records each routed step as a durable observation on
the ADR-061 `WorkflowRun` / `WorkflowPhaseEvent` reporting projection, so a
completed `/implement` run leaves a queryable per-step record instead of a
gitignored per-clone file. The binding design lives in ADR-090's 2026-07-29
amendment ("durable ADR-036 step observations"); this ADR records the
consequences for its own surface:

- The step record maps onto the ADR-090 production-line measurement model,
  keyed on work item `(project, repo, issue_number)`, the run's
  `(project, repo, issue_number, branch)` natural key, the catalogue
  `station_id` (resolved backend-side from the ADR-036 stage), and the
  capability `tier`. It is distinguished from a lifecycle/station attempt by an
  `emitter` value (`ADR036_STEP_JSONL`); lifecycle hot-spot, yield/rework, and
  context-graph consumers exclude it.
- The v2 JSONL schema semantics are frozen: the step record's `outcome` stays
  **operation outcome** and never becomes a station verdict (`station_result`
  is `UNOBSERVED`), so it cannot by itself produce first-pass yield.
- `gc_log_step_telemetry` gains `stage` (the ADR-036 stage id, carried as the
  event `phase`) and a non-negative `attempt` index; `step` (the numbered SKILL
  step) becomes a non-identity alias. The durable `(run_id, source_id)`
  identity is namespaced to the ADR-036 emitter
  (`adr036_step:<stage>:<attempt>`) so it never collides with a live station
  attempt.
- The write is strictly fail-open and never falls back to a local authoritative
  file: a durable record is guaranteed only when `telemetry.enabled` and the
  authenticated backend is reachable. Any pre-existing local JSONL files are
  inert historical artifacts; the local `make implement-cost-summary` summarizer
  that read them was removed in #1507 (see Amendments). They are not
  backfilled, dual-written, or promoted to a second source of truth.

The routing table, the tier→model mapping, and the telemetry record's
operational-only status are otherwise unchanged.

**2026-08-04 (issue #1507).** The retired local `/implement` telemetry
summarizer is deleted: `tools/summarize_implement_telemetry.py` and the
`make implement-cost-summary` target (already removed with the #1500 backend
teardown) no longer exist, and the dead local-JSONL data-contract helpers
(`buildTelemetryRecord`, `buildTelemetryRelPath`, `sanitizeTelemetryBranch`) are
removed with their tests. Earlier references in this ADR to the summarizer and
that target are historical. Routing metadata, the durable ADR-061
step-observation path (`gc_log_step_telemetry` / `buildStepObservationEvent`),
and the `telemetry.enabled` contract are unchanged; a future run-economics
summary must consume the durable projection, not revive per-clone
`.gc/telemetry` scanning.

**2026-08-04 (issue #1199, repo-neutral PR-body envelope).** `gc_render_pr_body`'s
evidence envelope is made repo-neutral: the Test Plan, Ground Control Checks,
migration reminder, and Checklist attest only gates the workflow enforces for
every repository, named semantically, and never publish configured command
strings. The Ground Control Checks drop the removed `gc_evaluate_quality_gates` /
`gc_run_sweep` tools (retired with the #1500 teardown) for a two-line set
(`Configured repository policy command passes`; `Pre-push code review and
test-quality review completed…`), kept byte-identical to
`tools/policy/authz_matrix.py::check_pr_body` via the render→check compose
fixture. The Checklist drops Ground Control's Java/domain rules (Envers,
framework-import layering, no-business-logic-in-API) and hardcoded documentation
paths; the `source+migration` reminder names no framework, ORM, or test class.
`test_notes` and the final rendered body gain explicit byte caps
(`PR_BODY_TEST_NOTES_MAX`, `PR_BODY_MAX`). No stack/language flag and no
`workflow.pr_body` config block were introduced; removing stack-specific claims
solves the contract without a taxonomy that would immediately grow language and
framework combinations. `.github/PULL_REQUEST_TEMPLATE.md` moves in lockstep. See
`architecture/notes/repository-neutral-pr-body-rendering-preflight.md`.

**2026-09-06 (issue #946, MCP-host provisioning and unevaluable Sonar gates).**
Two corrections to the `gc_watch_sonar_analysis` surface described above. The
routing table, the tier-to-model mapping, and the telemetry contract are
unchanged.

1. **Host provisioning is a server responsibility, not an inheritance
   assumption.** This ADR recorded that `SONAR_TOKEN` is read at call time and
   passed only in the Authorization header, but stated no requirement about how
   the variable reaches the server. In practice it arrived by inheritance from
   the launching agent process, which made the tool's correctness a property of
   which runtime happened to host it: a Claude Code-spawned server inherits its
   parent's full environment, a Codex-spawned one exactly eight variables, and
   the token is not among them. `gc_watch_sonar_analysis` was therefore
   unusable, deterministically, in every Codex-hosted run in a repository that
   declares a `sonarcloud:` block. The server now resolves its optional
   variables from declared sources it reads itself, in `lib/host-env.js`:
   an inherited non-empty value, then `.env` in the launch directory, then the
   per-host `~/.config/ground-control/env`. The per-host file covers what the
   launch root cannot - a launcher whose working directory is not a repository
   root, and provisioning one credential once per machine rather than once per
   checkout. Both files are read at startup, so provisioning or rotation takes
   effect on the next server start; the token's handling is otherwise unchanged
   and it still never enters argv, telemetry, exports, or a returned envelope.
   The credential is never placed in `.ground-control.yaml`, `.mcp.json`, a
   Codex `config.toml`, or the MCP tool schema.

2. **An unevaluable gate is not a rejecting verdict.** `gc_implement_mechanical
   action="monitor"` folded every non-passing Sonar envelope into one branch and
   answered all of them with `fix_sonar_findings_then_rerun_publish_and_monitor`.
   For a missing host credential that named code defects no one had read, and
   re-running was deterministic, so each attempt ended in an escalated execution
   obligation. `lib/sonar-gate.js` now classifies the envelope on the same axis
   `lib/ci-conclusion.js` applies to CI: an envelope the watcher could not
   produce, and an analysis that never appeared within the watch window, are
   `not_evaluable` and carry a repair that fits
   (`provision_sonar_token_on_mcp_host_then_rerun_monitor`,
   `diagnose_sonar_watch_failure_then_rerun_monitor`, or
   `rerun_monitor_after_sonar_analysis_completes`). Only a gate that actually
   returned open issues or hotspots remains `sonar_findings_open`, records a
   `fail` station result, and consumes a Step 11 fix cycle. The failure envelope
   gains `sonar_gate` (`not_evaluable` | `findings_open`) so the distinction is
   machine-readable, and `skills/implement/steps/step-11-sonarcloud.md` gains the
   branch it previously lacked.

**2026-09-06 (issue #1562, the launch directory is the configuration scope).**
This supersedes item 1 of the #946 amendment above. Item 2, the `not_evaluable`
gate classification, stands unchanged and is unrelated to where variables come
from.

#946 was right that a tool's correctness must not be a property of whichever
runtime happened to host the server, and wrong about the remedy. It kept the
inherited environment as the highest-precedence source and added a per-host
`~/.config/ground-control/env` behind the launch root. Both halves are removed.

`<launch directory>/.env` is now the only source of Ground Control's
configuration and credentials. No machine-level or user-level file is consulted
for any purpose, and no owned variable falls back to the ambient environment,
including the review engine's Claude auth - those are just variables and they
belong in `.env` like every other variable. If a variable a tool needs is
absent, the tool stops before its side effect and returns a bounded error naming
the variable, or the accepted alternatives, and the file; the message never
carries a value.

The launch directory is the correct scope because it is a deliberate control.
It is what lets separate checkouts draw on resources belonging to different
projects or organizations, and what makes it possible to deploy Ground Control
into a single-repo sandbox. A machine-level file assumes there is a machine
level - an assumption about deployment topology Ground Control has no business
making - and, ranked ahead of nothing, it silently substituted a global
credential into a repository that deliberately has none.

Three mechanisms carry the decision, in `mcp/ground-control/lib/server-env.js`:

1. **One finite inventory** of the names Ground Control reads or deliberately
   forwards. It is a provenance boundary, not a second validation schema -
   `parseCodexTimeoutMs`, the review-size consumers, and `reviewEngineEnv`'s
   auth-conflict rule keep owning their values. Inherited values for inventoried
   names are deleted before anything is installed, so a missing, empty,
   malformed, or unreadable file can never reactivate one.
2. **Only inventoried keys are installed** from the file, so an unrelated `.env`
   entry cannot replace `PATH` or `HOME`. The rest of the inherited environment
   is left alone: the rule governs Ground Control's variables, not the ability of
   `node`, `git`, `gh`, `codex`, and `claude` to execute.
3. **The entry point binds before the runtime evaluates.** ESM hoists static
   imports, so a source-order loader call below them is not an ordering
   contract - which is why `DEFAULT_CODEX_REVIEW_PARALLEL` and
   `DEFAULT_CODEX_REVIEW_MAX_DIFF_BYTES` permanently missed a value declared only
   in `.env`. `index.js` is now an environment bootstrap that dynamically imports
   `server-runtime.js`, and those two defaults resolve per call as
   `getDefaultCodexTimeoutMs` already did (issue #1521).

`REVIEW_ENGINE_ENV_FALLBACK` and its `~/.config/ground-control/review-env` read
are gone with the same reasoning. `reviewEngineEnv` remains the single child
environment builder for the test-quality reviewer and the disposition judge, and
now refuses before spawning `claude` when no auth mode is declared. That refusal
carries its own code so `lib/review-reattempt.js` does not spend a free
non-verdict retry re-running a deterministic provisioning fault.

`SONAR_TOKEN`'s handling is otherwise unchanged: read at call time, passed only
in the Authorization header, never argv, telemetry, an export, or a returned
envelope, and never placed in `.ground-control.yaml`, `.mcp.json`, a Codex
`config.toml`, or a tool schema. Only its recovery message changed, to name one
file instead of two. See
`architecture/notes/launch-directory-env-authority-preflight.md`.

Substituting the pull request's `SonarCloud Code Analysis` check-run for the
server-side scrape was considered and rejected. A green check means the hosted
quality gate did not fail; it does not mean the issue and hotspot lists are
empty, which is what Step 11 requires before advancing. Accepting it would
certify pull requests with INFO-through-BLOCKER findings unread, converting a
fixable credential defect into a permanent reduction in the gate's coverage. See
`architecture/notes/sonar-watcher-token-provisioning-preflight.md`.

**2026-09-06 (issue #1559, an analysis that cannot arrive is not an analysis
that is late).** The `gc_watch_sonar_analysis` surface described above waits for
SonarCloud's `project_status` to stop answering 404. That is the right wait
while a scan is running, and a guaranteed spend of the whole 30-minute cap once
the repository's own CI has declared the scan terminal: the component never
appears, the job is not cancellable, and no state exists in which the poll could
succeed. Because the credential gate ran first, a host without `SONAR_TOKEN`
reported the absence as `sonar_watch_token_missing`; the token was provisioned
and nothing changed, because the token was never the cause. The routing table,
the tier-to-model mapping, and the telemetry contract are unchanged.

The tool now resolves whether an analysis is *possible* before it waits for one.
Ahead of the propagation wait and ahead of reading the credential, it performs
one origin-pinned `gh pr view --json headRefOid,statusCheckRollup` read, selects
the producer named by the new optional `sonarcloud.analysis_check` (absent, any
check or workflow whose name matches `/sonar/i`), and classifies it on the
station axis `lib/ci-conclusion.js` already owns, so the `{skipped, neutral}`
grouping is stated once for both remote gates. Only a producer set that is
entirely skipped ends the watch, with `sonar_watch_analysis_not_produced`.
Everything else keeps the existing behavior byte-for-byte - including a producer
that *failed*, because the `SonarCloud Code Analysis` check reports the hosted
quality-gate result, so a red one means an analysis exists and was rejected;
terminating there would suppress the issue and hotspot read and report an
evaluated failure as an unevaluable gate.

**The evidence terminates the watch; it does not clear the gate.** A terminal
skipped check-run proves that no analysis is coming. It does not carry the
consuming repository's ownership decision, so it cannot prove *why* the scan was
skipped, and Ground Control has no integration that can obtain that decision -
copying another repository's path-ownership classifier, or trusting a
caller-supplied skip flag, are both rejected. Missing integration therefore
yields unknown scope, not a waiver: the envelope stays `ok: false`, `sonar_gate`
stays `not_evaluable`, nothing new passes `sonarGatePassed`, and the legacy
`skipped: true` boolean is not overloaded with a second meaning. What the
envelope adds is a normalized, bounded `scope_evidence` record - repository, pull
request, head revision, project key, producer selector, and each matched check's
conclusion - bounded at its origin because the mechanical `failure()` helper
scrubs its message and not a nested object. Verified readiness/finalize
clearance for a legitimately out-of-scope pull request is issue #1533's
contract, and it consumes this server-acquired evidence rather than a caller's
assertion.

`classifySonarGateFailure` gains a table from confirmed condition to repair, so
an unrecognized error routes to diagnosis instead of to the nearest-looking
cause. `provision_sonar_token_on_mcp_host_then_rerun_monitor` is now reachable
only from `sonar_watch_token_missing`: a credential SonarCloud rejected is
`sonar_watch_authentication_failed`, an unreadable `.ground-control.yaml` is
`sonar_watch_config_invalid`, and a response body carrying neither a gate status
nor an error document is `sonar_watch_quality_gate_malformed` rather than
another indistinguishable "not available" poll.

**The privileged read is authorized, not merely pinned.** Both remote-gate
watchers resolved their GitHub destination from the caller-selected checkout's
git origin and then spent the MCP host's credentials on it. Pinning `--repo`
stops a rogue `GH_REPO` from retargeting the read; it does not establish that
the checkout is one this server may act on, so a caller could pass any local
path - or retarget a writable checkout's origin at a private repository the
host's token can reach - and receive that repository's pull-request metadata
back in the envelope, without any Sonar credential. `lib/watcher-repo-authorization.js`
puts one boundary in front of both: `authorizeImplementRepoRoot` pins the read to
the immutable workspace identity captured at MCP launch, and the `owner/name`
slug comes from what was authorized rather than from what the caller supplied.
`runWatchCiRun` carried the same origin-only trust and is fixed with it. The two
watchers differ in what a refusal costs: the CI watcher's whole job is that
read, so it is terminal (`ci_watch_repo_not_authorized`); the Sonar watcher's
producer lookup is an optimization over a watch that needs no GitHub access at
all, so an unauthorized checkout makes no request - which is what prevents the
harm - and keeps the gate it can still evaluate. Denying a legitimate Sonar watch
because a checkout has no resolvable GitHub identity would trade one fail-open
for a fail-closed on the wrong axis.

Three fail-open paths in the same call graph closed with it. The watcher read its
SonarCloud declaration through a best-effort reader that collapsed a missing
file, an unreadable one, unparseable YAML, an invalid declaration, and a valid
config with no `sonarcloud` block into one `null`, and `null` became
`skipped: true`, which `sonarGatePassed` accepts unconditionally - so a malformed
or unreadable `.ground-control.yaml` silently cleared the SonarCloud gate. The
strict reader distinguishes those states, treats only `ENOENT` as proof that the
repository never opted in, and fails closed on the rest; the permissive reader is
deleted rather than left exported for a future caller to reach. Separately,
`total_timeout_seconds` bounded only the polling loop, so the propagation wait,
the retry backoffs, and the issue/hotspot pagination all ran outside the
documented cap. One budget now spans the call: every sleep is clipped to what
remains, and each loop consults it before spending another request. See
`architecture/notes/sonar-scope-monitor-preflight.md`.

**2026-09-12 (issue #1568, tail-anchored failed-job diagnostics).** The
"stored unexpected errors are bounded and sensitive-content scrubbed" clause
above held, but its bound was head-anchored: the first 600 characters of the
error message survived and everything after was dropped. For a codex or claude
worker killed at the wall cap that is exactly inverted. The characters that
identify what the worker was doing are at the end of its output; the characters
at the beginning are the engine's startup banner and its echo of the prompt, so
a head-only cap was structurally guaranteed to retain only the least
informative bytes a long run produced. Two consecutive 20-minute
architecture-preflight kills returned banner text and nothing else.

Three changes close it, none of them relaxing a bound. `formatCommandFailure`
now reports the child's own terminal state (exit code, signal, killed) and a
tail-anchored excerpt of *both* stdout and stderr rather than the untruncated
first non-empty one - preferring stderr when present let a single unrelated
warning line hide the whole stdout trace. The registry's message bound is
head-and-tail preserving, so the sentence naming the failure and the
diagnostics appended after it both survive. And a failing tool may attach a
structured `diagnostics` object to its error, which a failed poll envelope
carries through a closed whitelist of bounded scalars and bounded string lists
- the same shape discipline the running-job `progress` snapshot has under issue
#1497 - dropped whole if it trips the sensitive-content scrub.

`gc_codex_architecture_preflight` is the first producer. It runs codex under
`--sandbox workspace-write`, so a killed run has usually already written to the
checkout; it now reports the paths it changed, against the pre-run baseline it
already captured, in both the failure message and the structured diagnostics.
A retry therefore cannot build silently on partial output from an attempt whose
mechanical result was failure. The `preflight` phase marker is still not
written on a failed run, and no gate is weakened: the run remains a failure
that must be re-run, only now with the evidence to diagnose it.

**2026-09-14 (issue #1581, per-run queued cap and one run per envelope).** The
`gc_watch_ci_run` surface above names a queued-too-long cap, and the watcher
enforced it against its own elapsed time: once five minutes of watching had
passed, any run reading `queued` ended the watch as `queued_too_long`. A run's
status reads `queued` again between jobs, while `needs:` dependents wait for a
runner, so a healthy run past five minutes failed the Step 10 gate and sent the
agent back through publish to repair nothing. The cap now applies per run, to
the time since the run's latest attempt started, and only while none of that
run's jobs has started; a run with a started job is bounded by the total cap
alone. A run with no started job that stays queued past the cap still reports
`queued_too_long`, including one that was already queued when the watch began.

The terminal envelope gained one invariant and one field. `run_id`, `status`,
and `url` always come from the run the conclusion is about, where they had
mixed the first watched run's id with another run's status and URL. A success
over several runs no longer names an arbitrary member as the CI result: it
reports `run_id` and `url` as null, and every envelope carries `runs[]` with
each watched run's id, workflow, status, conclusion, and URL. The caps, their
defaults, and the bounded log-summary contract are unchanged.

**2026-09-14 (issue #1580, host commit signing at the implement Git boundary).**
The implement Git boundary passed `-c commit.gpgSign=false` on every call, so
publish, base-sync merge, and PR-remediation commits were unsigned even when the
host configuration required signatures, and nothing reported it. The override is
removed: these commits follow the host's global `commit.gpgSign`, `gpg.format`,
and `user.signingKey`. System configuration stays excluded as before. Refusing
caller-selected executable Git configuration now also covers the keys that
choose a signing program: `gpg.program`, `gpg.<format>.program`, and
`gpg.ssh.defaultKeyCommand`. The checkout-configuration guard reads both the
local and the worktree scope, because `git config --local` does not read a
worktree's `config.worktree`, which let a checkout with
`extensions.worktreeConfig` set any refused key unseen. Git never replaces a
required signature with an unsigned commit. When the signature cannot be
produced, publish, base-sync completion, and remediation return
`implement_commit_signing_failed`, no commit is created, and nothing is pushed.
