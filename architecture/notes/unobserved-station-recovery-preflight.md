# Unobserved Station Recovery Preflight

Issue: #1476
Requirement: none

This note records the architecture boundaries for recovering a workflow station
that produced no verdict. It is not an implementation plan.

Issue #1578's [completion preflight](waived-station-completion-preflight.md)
defines the proposed station-only waiver and durable recovery extension to this
contract. It also identifies retired backend and measurement guidance below;
the current MCP-only architecture governs those boundaries. The extension
shipped with issue #1578; ADR-029's 2026-09-13 amendment is the authoritative
contract.

## Decisions

### Keep attempt, cycle, obligation, and finding state separate

A transient engine failure creates a new **station attempt** with
`stationResult=not_evaluable`. It does not create a failed verdict, consume a
review cycle, become a review finding, or change the run outcome. A later
automatic attempt is another station attempt against the same logical review
cycle. Only an attempt that renders a validated `pass` or `fail` verdict may
write the existing findings record and cycle marker and consume the review cap.

An execution obligation records that the required observation is still
missing. It is not a defect disposition. Add a distinct
`station_observation` obligation kind and a `reobserved` resolution
disposition. Do not add `reobserved` to backend `FindingDisposition`, product
`Finding`, gate-finding measurement dispositions, or ADR-029 review-decision
records. A re-observation can render `fail`: it closes only the missing-
observation obligation, while the actual findings remain subject to the
existing `fix | wontfix | not-applicable` rules.

### Retry only a declared transient non-verdict

The station owner classifies retry eligibility from stable error codes. The
initial eligible set is timeout, engine invocation/transport failure,
unparseable validated output, and incomplete reviewer coverage. Cancellation,
cap refusal, invalid configuration or input, repository/authorization failure,
reserved-marker or sensitive-content rejection, and GitHub posting failure are
not automatic station retries.

The retry boundary wraps one complete station attempt, not a slice, poll,
GitHub post, or decision-record write. For Codex, both reviewers over all
slices remain one station attempt; successful slices from an incomplete
attempt must not be combined with a later attempt and reported as one verdict.
For test-quality, changed-test discovery and the validated findings envelope
remain part of the owning station boundary. Do not recursively invoke the
public MCP tool or duplicate cap/marker logic to retry it.

The repository configuration seam belongs beside the existing reviewer cap:
`workflow.codex_review.non_verdict_retry_limit` and
`workflow.test_quality_review.non_verdict_retry_limit`, defined as the number
of additional attempts after the first. Use one bounded validator and a small
hard maximum (at most two automatic re-attempts); absence uses one canonical
default. The runner receives the normalized integer as a policy parameter.
Future stations may opt into that same parameter shape at their own executor
boundary, but there is no generic retrying-station framework until another
real executor needs it.

Issue #1415's test-quality child timeout, if delivered with this change,
belongs at `workflow.test_quality_review.timeout_ms`, with positive lower and
upper bounds and the current constant as the default. Resolve it only through
the existing `.ground-control.yaml` parser/context path and pass it as an
in-process argument. Do not add an environment-variable parser, shell
interpolation, or a caller-controlled MCP timeout override.

### Make re-observation tool-attested, not agent-asserted

The first transient non-verdict opens one deterministic observation obligation
per `(issue, station, logical cycle)`. Further automatic attempts update that
same obligation; they do not open one obligation per transport attempt. The
identifier must be stable, bounded, branch-independent, and valid under the
existing execution-obligation ID rules.

The existing v1 marker vocabulary cannot safely gain a new closed disposition:
old readers would ignore the resolution and leave the run blocked. Introduce a
v2 execution-obligation marker that carries the obligation kind, canonical
station id, logical cycle, and, for `reobserved`, the trusted observation
record it resolves against. The ledger parser must read v1 and v2 together, and
a v2 resolution may close a matching v2 observation obligation. Existing v1
problem obligations retain their current semantics and authorization checks;
do not heuristically reclassify their prose as station observations.

Only the station-owning MCP cycle wrapper may emit `reobserved`. The public
`gc_record_execution_obligation` input must not let an agent select that
disposition or supply a boolean claiming tool verification. Replay accepts a
`reobserved` resolution only when:

- the marker author is the trusted MCP posting identity, not merely any user
  with repository write permission;
- the obligation is a `station_observation` for the same issue, registered
  station id, and logical cycle;
- the referenced trusted findings/outcome record proves that a later attempt
  rendered a validated verdict for that station; and
- the resolution does not carry or imply a disposition for any returned
  finding.

Reuse the trusted-MCP-identity verification used by review auto-disposition and
the existing effective-repository-permission checks. Do not create a second
authorization hierarchy.

### Preserve durable-write ordering and replay safety

The hardened findings-record/cycle-marker writer remains the single posting
boundary. When an observation obligation is open, its safe order is:

1. post the validated findings/outcome record;
2. post the `reobserved` resolution bound to that record;
3. post the review cycle marker; and
4. let the existing cycle wrapper post the decision record.

The cap marker must not be written before the required re-observation
resolution. If any earlier post fails, the cycle stays unconsumed and a retry
is safe. Every write is idempotent by the deterministic obligation identity
and existing cycle identity; a process restart must reconcile already-written
trusted records rather than synthesize a verdict or require `wontfix`.

If all automatic attempts remain non-evaluable, keep the observation
obligation open and append an escalation with
`pause_class=hard_external_dependency`. The record names the canonical station,
attempt count, stable failure classes, and the concrete action needed to
restore observation. It must not request a `wontfix` decision about an
unobserved defect. Both `gc_assert_completion` phases continue to block on the
open obligation.

## Canonical Incumbents

- `runCodexReviewCycle`, `runTestQualityReviewCycle`, and
  `_runReviewCycleShared` own the pre-push station/cycle boundary. Extend this
  seam; do not add another workflow loop.
- `runCodexReview`, `runTestQualityReview`, `runReviewerOverSlices`, and
  `runSingleClaudeTestQualityReview` remain the engine and parser owners.
  Retry classification uses their structured error envelopes.
- `postFindingsRecordAndCycleMarker` and the corresponding Codex findings/
  marker writers own durable write ordering, body limits, sensitive-content
  checks, and cycle consumption.
- `buildExecutionObligationMarker`,
  `parseExecutionObligationMarkers`,
  `evaluateExecutionObligations`, `runRecordExecutionObligation`, and
  `readTrustedExecutionObligationState` remain the one ledger codec, writer,
  and completion read path. Extend them version-aware; do not create a second
  obligation store or completion exception.
- `resolveExecutionObligationTrust`, the review auto-disposition trusted-login
  checks, `authorizeImplementRepoRoot`, `ensureGitRepo`, and fixed-argv `gh api`
  posting remain the authority boundary.
- `normalizeReviewerConfig`, `normalizeWorkflowConfig`, and
  `getRepoGroundControlContext` remain the configuration boundary. Unknown or
  out-of-range keys fail closed rather than silently falling back.
- `_emitReviewStationAttempt` and `createWorkflowRunLifecycleEmitter` remain
  the ADR-090 measurement path. Move emission to the actual attempt boundary
  so every failed and successful attempt is recorded, while backend emission
  stays fail-open to workflow control.

No backend controller, Service+Aggregate, Repository, database migration,
`FindingDisposition`, or error envelope is required for the basic recovery
path. The existing `StationResult.NOT_EVALUABLE`, phase-event command, service
validation, project-scoped repository, and aggregate formulas already model
the measurement facts.

## Security, Validation, And Observability

- MCP Zod schemas and the pure semantic validator both keep closed enums,
  bounded strings/arrays, positive issue numbers, registered station ids, and
  strict configuration bounds. The marker parser validates every attribute
  rather than trusting rendered prose.
- Repository identity stays bound to the MCP launch workspace and origin.
  Every GitHub read/write remains server-side through fixed argv; agents do not
  invoke `gh`, `git`, or `curl` to clear the ledger.
- `wontfix` keeps the exact-command, durable URL, effective-permission, and
  replay verification path unchanged. `reobserved` has no user-authorization
  field and cannot be used to accept a finding.
- The Claude child continues to receive the prompt on stdin, strips
  `ANTHROPIC_API_KEY`, uses the existing read-only tool allowlist and abort
  signal, and exposes no retry or timeout value through shell interpolation.
  Retry/timeout configuration is non-secret and remains out of process argv
  and result markers.
- Reserved-marker rejection, `detectSensitiveBodyContent`, the GitHub comment
  body cap, and bounded field validation apply to the new v2 record. Provider
  output, prompts, diffs, stderr, stack traces, filesystem paths, tokens, and
  environment values must not enter obligation comments, logs, telemetry, or
  backend error details. Use stable failure codes only.
- Log each attempt with bounded station id, logical cycle, attempt ordinal,
  configured limit, duration, and stable failure/result code. Never log raw
  engine output. ADR-059 still records one MCP invocation and must not be
  repurposed as the retry counter.
- Emit one ADR-090 station attempt per actual execution:
  `not_evaluable` for every transient non-verdict, then `pass` or `fail` for
  the observed attempt. `not_evaluable` remains outside first-pass-yield and
  iterations-to-green denominators. Telemetry failure never changes retry,
  obligation, or completion behavior.
- The measurement REST path continues through its existing Zod/HTTP
  allowlist, Bean Validation, immutable command, service semantic validation,
  project-scoped lookup, database idempotency, shared Spring Security/IP
  allowlist, `ActorFilter`/`ActorHolder`, and
  `GroundControlException`/`GlobalExceptionHandler`/`ErrorResponse` layers.
  This issue does not add a new REST shape or exception hierarchy.

## Extensibility Seam

The reusable seam is a small, pure non-verdict retry policy receiving
`stationId`, `logicalCycle`, `maxReattempts`, and a stable failure
classification. Each executor still owns how one attempt runs and how a
verdict is parsed. The next station can opt in by supplying those values and a
registered station id; it must not require edits to obligation evaluation,
completion blocking, measurement formulas, or authorization rules.

Timeout remains an executor-specific parameter because different engines have
different safe bounds. Do not combine timeout, polling cadence, review-cycle
cap, and non-verdict retry limit into one generic “attempts” setting.

## Required Regression Coverage

- Pure retry-policy tests cover zero/default/max re-attempts, each eligible
  failure class, and every non-retryable class, including cancellation.
- Config parser tests cover defaults, bounds, unknown keys, and invalid config
  propagation for both reviewer blocks and the optional test-quality timeout.
- Both cycle wrappers prove fail-then-pass, fail-then-findings, exhausted
  retries, stable logical-cycle identity, no cap consumption before verdict,
  and no duplicate obligation on repeated transient attempts.
- Durable-record tests pin write ordering, partial-post recovery, v1/v2 parser
  coexistence, deterministic replay, evidence binding, and rejection of forged
  or agent-authored `reobserved` markers.
- Completion tests prove that pre-merge and post-merge remain blocked while
  exhausted observation obligations are open, accept a tool-attested
  re-observation, and still reject unauthorized `wontfix`.
- Measurement tests prove the attempt sequence
  `not_evaluable -> pass|fail`, unique attempt/source identity, fail-open
  backend behavior, and unchanged yield denominators. Existing backend service
  and repository tests are sufficient unless their contracts change; if a
  controller surface changes, add the canonical `@WebMvcTest` slice.

## Gotchas And Anti-Patterns

- Do not map timeout, parser failure, incomplete coverage, or tool `ok=false`
  to station `fail`.
- Do not count re-attempts as review cycles, cap overrides, finding-fix cycles,
  or ADR-036 routed steps.
- Do not close an observation obligation merely because the next MCP call
  returned `ok=true`; require a validated station verdict and trusted durable
  observation record.
- Do not interpret `reobserved` as `fixed`, clean, accepted, applicable, or
  authorized. A re-observed failing verdict still has real work to resolve.
- Do not widen `not-applicable` or weaken `wontfix` authorization to make a
  timeout fit the old vocabulary.
- Do not retry GitHub posts by re-running the engine, merge findings from
  separate attempts, or consume the cap after a partial durable write.
- Do not duplicate retry loops in SKILL prose, both reviewer runners, and the
  cycle wrapper. The tool layer owns enforcement; workflow prose only explains
  the returned structured actions.
- Do not add a generic retry framework, queue, scheduler, backend aggregate,
  or exception hierarchy for two local reviewer executors.

## Non-Goals

- No automatic retry after a rendered `pass` or `fail`, and no change to
  review-cycle caps, auto-disposition grants, or human over-cap authorization.
- No automatic acceptance, suppression, or disposition of a real finding.
- No retry policy for CI, SonarCloud, completion/policy, GitHub posting, or
  backend telemetry in this issue; those boundaries retain their current
  owners and caps.
- No backfill or prose-based reclassification of legacy v1 obligations.
- No station-result, finding-measurement, workflow-run, REST, database, UI,
  dashboard, or metric-vocabulary expansion.
- No new secret, credential path, environment-variable configuration surface,
  or OS-level privilege.
