# Unobserved Station Recovery Preflight

Issues: #1476; #1582 amendment
Requirement: GC-O007 (#1582)

This note records the architecture boundaries for recovering a workflow station
that produced no verdict. It is not an implementation plan.

The current runtime is the MCP-only architecture established by issues #1303
and #1500. Historical references below to backend measurement explain the
original #1476 boundary; they do not authorize restoring a backend, REST
surface, lifecycle emitter, or station telemetry for the #1582 amendment.

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

Only the station-owning MCP cycle wrapper may emit `reobserved` during normal
review execution. Issue #1582 adds one narrow recovery exception: the dedicated
server-side reconciliation action described below. The public
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
- Issue #1303 and #1500 retired the backend lifecycle, station-emission, and
  measurement surfaces. The issue thread and structured MCP result are the
  current observability surfaces; keep `retired-backend-surfaces.test.js`
  passing rather than restoring an emitter or projection.

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
- Do not add a new logger or telemetry record for reconciliation. The bounded
  structured outcome and append-only issue-thread marker are sufficient. Raw
  engine output and GitHub command errors stay out of both; unexpected handler
  failures continue through the existing MCP error envelope.

## Extensibility Seam

The reusable seam is a small, pure non-verdict retry policy receiving
`stationId`, `logicalCycle`, `maxReattempts`, and a stable failure
classification. Each executor still owns how one attempt runs and how a
verdict is parsed. The next station can opt in by supplying those values and a
registered station id; it must not require edits to obligation evaluation,
completion blocking, cap counting, or authorization rules.

Timeout remains an executor-specific parameter because different engines have
different safe bounds. Do not combine timeout, polling cadence, review-cycle
cap, and non-verdict retry limit into one generic “attempts” setting.

## Issue #1582 Amendment: Reconcile A Stranded Attestation

The normal cycle wrapper remains the owner of findings-record, re-observation,
cycle-marker, and decision-record ordering. A process or wrapper defect can,
however, leave a trusted findings record and its ordinary cycle marker on the
issue thread without the intervening `reobserved` record. Re-running the
review is then both over-cap and the wrong operation: the verdict already
exists and only its attestation is missing.

Expose one synchronous `gc_reconcile_station_observation` tool for that state.
Its bounded input is `repo_path`, a positive `issue_number`, an
`obligation_id`, and the exact GitHub `findings_record_url`. The obligation id
only selects a trusted open ledger entry; station and logical cycle are
server-derived from that entry, and the id must equal
`buildStationObservationObligationId` for those values. The action may post
only when a fresh issue-thread read proves all of the following:

- the repository is the MCP launch workspace authorized by
  `resolveAuthorizedIssueRepository`, and the URL names that repository and
  issue;
- a trusted v2 `station_observation` obligation is open for the derived id,
  station, and logical cycle;
- the URL selects the primary canonical findings record for that station,
  issue, and cycle, posted by the current authenticated MCP identity; and
- a separate ordinary cycle marker for the same station, issue, and explicit
  cycle is present from that identity.

Keep the two incumbent trust levels distinct. The existing trusted-ledger read
authorizes the opening through effective repository permission; it need not
have the same login as today's MCP process. The stricter current-MCP identity
check applies to the findings record, cycle marker, and `reobserved` attestation
that claim the station actually ran. Requiring the opening author to equal the
current login would add a second authorization rule and strand legitimate runs
after credential rotation.

The cycle marker is required recovery evidence. A findings record without it
is the existing partial-write state in which the cap was not consumed and the
station owner remains responsible for ordinary retry. The historical findings
record and marker may be required to agree on their recorded branch, but the
current branch and configured cap are not recovery identity: branch names and
cap configuration may change after the verdict. Do not infer a cycle from
marker count, accept a continuation comment, require a decision record, or
inspect finding disposition as proof of observation.

Pair records and markers deterministically; do not accept the first matching
record in thread order. For a matching cycle marker, its eligible record is the
latest canonical record for the same station, issue, cycle, and branch after
the most recent opening and before that marker. Multiple matching markers must
resolve to the same record or the evidence is ambiguous and the action refuses.
The caller's exact URL must select that derived record; caller selection is not
authority to choose between conflicting durable histories.

Reuse the existing Codex findings header, test-quality findings marker, and
the two cycle-marker codecs as the record-identity authority. Extend their
owning parsers to return explicit record identities, and keep the current
counting functions as projections over those parsers. Do not create duplicate
regular expressions or a generic record-schema framework for two stations.
The next station extends the closed station dispatch with its own canonical
findings and cycle codecs; it does not change the v2 obligation schema.

`postStationReobservation` remains the only renderer and posting helper. The
reconciliation action re-reads trusted ledger state after posting. Repeating
the same call after a successful post or a lost response returns a successful
`already_recorded` no-op only when the existing trusted resolution has the
same station, cycle, and findings-record binding. Idempotence is a durable
ledger-state guarantee, not permission to edit or delete issue comments.
Serialize the read/check/post/re-read critical section for the canonical
repository, issue, and obligation with the existing heartbeat-backed
filesystem lease mechanics. Otherwise two simultaneous calls can both observe
the obligation open and append duplicate resolutions. Do not turn this small,
synchronous repair into an async job or introduce a second lock
implementation; contention returns a structured retry action and releases in
`finally`.

Both completion phases continue to fail closed. When their live read finds an
open observation plus exactly validated recovery evidence, the existing
`completion_open_execution_obligations` envelope should additionally return a
bounded `recoverable_station_observations` entry and a reconciliation-specific
`next_action`. It must not return findings prose, comment bodies, authenticated
login, command output, or repository paths. An invalid, missing, ambiguous, or
untrusted candidate stays on the generic open-obligation diagnostic and never
causes an automatic write from readiness.

The new tool follows the existing Zod-plus-thin-handler registration pattern,
the structured `ok: false` domain envelope, the launch-workspace repository
pin, fixed-argv `gh api` calls, `detectSensitiveBodyContent`, the GitHub body
cap, reserved-marker rules, and bounded error extraction. It adds no config or
environment field, secret path, async job, retry counter, routing stage,
telemetry schema, marker family, persistence store, or exception hierarchy.
The Zod schema and direct-call validator reuse
`EXECUTION_OBLIGATION_ID_RE`, `parseIssueCommentUrl`, and one shared URL bound;
they must not copy the obligation-id regex or let the handler-only bound be
bypassed by library callers.

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
- Reconciliation tests prove both station record formats, exact
  repository/issue/station/cycle/comment binding, current-MCP author checks,
  matching trusted cycle-marker checks, deterministic duplicate-record
  pairing, partial-write refusal, sequential and concurrent idempotence,
  contention/release behavior, lost-response replay, and post-write ledger
  verification.
- Completion tests distinguish a recoverable missing attestation from an open
  observation with no valid evidence without weakening the shared open-
  obligation error contract.
- `retired-backend-surfaces.test.js` continues to prove the removed lifecycle,
  station-emission, and measurement adapters stay absent.

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
- No retry policy for CI, SonarCloud, completion/policy, or GitHub posting in
  this issue; those boundaries retain their current owners and caps.
- No backfill or prose-based reclassification of legacy v1 obligations.
- No station-result, finding-measurement, workflow-run, REST, database, UI,
  dashboard, or metric-vocabulary expansion.
- No new secret, credential path, environment-variable configuration surface,
  or OS-level privilege.
