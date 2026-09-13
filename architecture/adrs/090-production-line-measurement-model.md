# ADR-090: Production-Line Measurement Model

## Status

Superseded (issue #1303)

## Date

2026-07-26

> **Supersession (2026-09-11):** Every persistent measurement owner named by
> this logical model was removed by #1500, and issue #1303 deletes the surviving
> emitters, adapters, and workflow hooks. Gate results continue to be enforced
> at their owning policy, MCP, CI, Sonar, and human boundaries; they are not
> projected into a second measurement plane. This historical model is not a
> current gate or implementation contract.

## Context

Ground Control currently records five useful but non-interoperable signals:
ADR-036 local step JSONL, ADR-061 workflow-run reporting, ADR-059 MCP tool
usage, the planned Micrometer/OpenTelemetry runtime surface (#1285), and the
process evaluation work named by #1297. Their similarly named fields do not
mean the same thing. In particular, a successful MCP call or routed-step
`outcome: ok` is not evidence that a quality gate passed.

The production-line questions are therefore not answerable reliably: where
does a work item first pass, how much retry/rework did a gate cause, and which
defects escaped an intended inspection point? Retrofitting those definitions
after dashboards exist would make historical comparisons misleading.

## Decision

### 1. One logical model; existing stores remain owners

This ADR defines a **logical measurement contract**, not a generic telemetry
table, workflow state machine, dashboard, or new execution abstraction. The
existing stores retain their responsibilities:

- ADR-029 GitHub issue records remain the durable workflow/audit record.
- ADR-061 `WorkflowRun` and `WorkflowPhaseEvent` remain the product reporting
  projection and the home for process-linked, project-scoped facts.
- ADR-059 `McpToolEvent` remains one operational fact per MCP tool invocation.
- ADR-036 JSONL remains local, opt-in economics measurement.
- OpenTelemetry remains runtime observability, not a replacement reporting
  database or an issue-thread parser.

Each emitter maps its native record to this model. A key it cannot know is
absent, never synthesized as `unknown`, copied from raw input, or joined by a
heuristic. `unobserved` is permitted only when a source can attest that the
dimension applied but cannot observe its value; it is not a replacement for an
absent correlation key. The common shape is the contract; it does not require
every source to persist every dimension immediately.

### 2. Canonical dimensions and correlations

| Dimension | Canonical identity and use | Guardrail |
|---|---|---|
| Work item | Exact `(project, repo, issue_number)` GitHub-issue tuple. Requirement UIDs and PRs are related references, not replacements. | No branch-only or issue-number-only cross-repository join. |
| Run | Existing ADR-061 `workflow_run.id`; its current idempotent natural key is `(project, repo, issue_number, branch)`. | A run is a reporting correlation, not workflow authority or a new distributed trace id. |
| Station (gate) | Stable machine `station_id`, mapped from the existing ADR-061 `phase` vocabulary or a registered workflow stage. | A numbered SKILL `step`, UI label, or free-text phase is an alias, never the identity. |
| Station attempt | Ordered attempt for one `(run, station_id)`, using existing `cycle_index` when available; otherwise an explicitly emitted `attempt_index`. | Retry ordering must be deterministic; a source with neither cannot contribute to iteration metrics. |
| Boundary | A registered architecture/contract boundary identifier associated with a station attempt. One attempt may inspect zero, one, or many boundaries. | A process station is not an architecture boundary. Do not use a file path, package name, or display title as a durable boundary id. |
| Capability tier | `low`, `medium`, `high`, `not_applicable`, or `unobserved`. The first three retain ADR-036's provider-neutral meaning. | Provider/model is a separate dimension. `unobserved` is not evidence of `low`; `not_applicable` means no model choice applied. |

Every new process-linked record carries `measurement_version`, `emitter`, and
an observation time, plus every correlation above that the emitter can
authoritatively supply. `project`, `repo`, and `issue_number` are mandatory
for a record claiming work-item or run correlation. High-cardinality
correlations (`run_id`, issue number, branch, boundary) are event/trace fields,
never Micrometer/Prometheus metric labels.

### 3. Keep three outcome axes separate

The model names three non-interchangeable fields:

- **Operation outcome:** whether an emitter operation ran (`ok`, stable error
  code, `skipped`). ADR-036 and ADR-059 already capture this axis.
- **Station result:** `pass`, `fail`, `skipped`, `cancelled`, `not_evaluable`,
  or `unobserved` for the thing a station inspected. Only this axis feeds
  yield/rework formulas.
- **Run outcome/state:** the existing ADR-061 lifecycle/economic result
  (`MERGED`, `CLOSED_WITHOUT_MERGE`, `RUNNING`, and related final states).

`PhaseEventType.COMPLETED`, `McpToolEvent.outcome`, and JSONL `outcome` do not
become `station_result=pass` merely by name. A station-result producer must
state its result explicitly and validate it against the closed vocabulary.

### 4. Process variables and formulas

For a run `r`, station `s`, and its time-ordered **evaluable** attempts
`A(r,s) = (a1, ..., an)`, evaluable means station result `pass` or `fail`.
Skipped, cancelled, and not-evaluable attempts remain measurable coverage but
are excluded from these denominators.

- **First-pass yield (FPY)** for station `s` is
  `count(A(r,s)[1] = pass) / count(r with a non-empty A(r,s))`.
  It measures the first evaluable inspection only; a later green retry never
  improves FPY.
- **Iterations to green** for a `(run, station)` is the smallest `i` where
  `A(r,s)[i] = pass`. If no pass occurs, record `unresolved`, do not substitute
  a maximum, zero, or an arbitrary timeout. Report the resolved distribution
  together with unresolved count.
- **Rework** is a failed evaluable attempt followed by another attempt at the
  same station in the same run. For a green sequence it is
  `iterations_to_green - 1`. Time from a failure to the next attempt is
  *time-to-retry*, not active repair time unless an emitter explicitly measures
  active repair work.
- **Gate cost** is a vector, not a fabricated dollar scalar:
  `sum(duration_ms)`, optional model token counts, and optional calibrated
  monetary `cost_proxy + currency`, grouped by station and tier. Cost per green
  is each component divided by the number of runs that first reach `pass` at
  that station. Parallel elapsed time must not be added and called wall-clock
  cycle time; no price table may infer money from tokens.
- **Escape** is a defect/finding first detected downstream after a station
  intended to catch it had passed, with an explicit finding/defect link and
  missed-station attribution. For station `s`,
  `escape_rate(s) = escaped_from_s / (caught_at_s + escaped_from_s)` over
  distinct attributed finding identities. An unlinked later failure is not an
  escape. If attribution coverage is absent, the metric is **unavailable**,
  not zero. Escape cost is the same gate-cost vector accrued from downstream
  detection through measured rework, apportioned only to explicitly attributed
  findings.

All aggregate responses must include numerator, denominator, unresolved count,
and measurement version. A percentage without coverage is not a process fact.
Tool-operation duration is reportable per tool, but contributes to gate cost
only when an explicit, safe station correlation is present.

### 5. Emitter mapping and migration

| Emitter | Valid mapping today | Required migration guardrail |
|---|---|---|
| ADR-036 `gc_log_step_telemetry` JSONL | Local step cost, provider/model, tier, operation outcome, timestamp, issue, and sanitized branch. | Freeze v2 semantics. A versioned successor adds authoritative project/repo/run correlation and stable `station_id`; retain `step` only as an alias. Its `outcome` must stay operation outcome, so it cannot by itself produce FPY. |
| ADR-061 workflow reporting | Work item/run correlation, stable phase/station candidate, attempt/cycle, phase timing, run state/outcome, and existing economics. | Extend its existing DTO → immutable Command DTO → `WorkflowTelemetryService` → Repository path with a closed station-result vocabulary and mapping catalogue. Do not add a parallel generic measurement aggregate. Existing free-text `outcome` and lifecycle event type are historical operational facts; backfill only safe dimensions and mark station result unobserved where it was never recorded. |
| ADR-059 MCP usage | One tool-operation cost/latency/outcome observation, and declared project when present. | Preserve its closed `{tool, action, outcome, duration_ms, project, ts}` capture shape, exactly one event invariant, and fail-open behavior. Do not scrape arbitrary tool arguments for issue/run/boundary context. A future workflow-scoped context must be explicit, allowlisted, and server-side; absent context remains uncorrelated. |
| Micrometer/OpenTelemetry (#1285) | Runtime operation duration/error and bounded station/tier/result dimensions. | Use standard resource attributes (`service.name`, version, deployment environment) plus an allowlisted `gc.measurement.*` event/span vocabulary. Metrics may label only bounded station, tier, result, and emitter values; work item/run/branch/boundary belong only in safe events or traces. The existing host-local Claude OTLP file is diagnostic input, not dashboard truth or a raw-record import source. |
| Process evaluation / #1297 | Boundary-linked findings, explicit detection station, missed-station attribution, and measured repair work when available. | It consumes this ontology rather than creating CLD-specific yield, rework, or escape definitions. Its withdrawn programme status does not authorize a new product surface; any resumed work must first use the versioned contract. |

The contract migration is additive and versioned. Old records remain readable
under their original semantics; aggregates segment or exclude records that lack
the fields required by a formula. No dashboard may silently combine legacy
operation outcomes with station-result data.

### 6. Retention and aggregation semantics

The durability split is deliberate:

- GitHub's issue thread remains the durable record of workflow decisions and
  evidence; telemetry never replaces it or copies raw comment bodies into a
  measurement store.
- ADR-061 and ADR-059 persistence hold the durable **measurement facts** for
  their bounded period. Process-linked raw facts retain for **400 days**, which
  covers the existing 366-day maximum reporting window plus late-ingestion and
  roll-up safety margin. They are project-scoped and redacted.
- Before raw expiry, retain daily station/tier/result roll-ups, including the
  formula numerator/denominator/coverage counters and measurement version, for
  **three years**. A roll-up is operational history, not a replacement audit
  record.
- ADR-036 JSONL is workspace-local and gitignored; it has no central retention
  promise. The current local OTLP collector's file rotation is its host
  diagnostic policy, not this ADR's durable-retention policy.

Expiry must be an owner-specific, tested telemetry cleanup path. It must not
reuse `AuditRetentionJob`, whose role is Envers revision cleanup, and it must
not delete graph-projected workflow facts until roll-up completeness,
referential safety, and snapshot/rebuild effects are verified. A failed or
incomplete roll-up blocks raw deletion.

### 7. Contract, validation, and security boundaries

The next schema is a versioned contract under `contracts/schemas/`; a breaking
field/vocabulary change receives a new version and `contracts/CHANGES.md`
declaration under ADR-082. Backend write paths use `@Valid` request records,
immutable Command DTOs, `@Validated` services, project-scoped repositories,
and the existing `GroundControlException` → `GlobalExceptionHandler` →
`ErrorResponse` path. No measurement-specific error envelope or exception
hierarchy is permitted.

Retention/roll-up and OpenTelemetry allowlist settings belong in validated
`@ConfigurationProperties` objects, not environment-string parsing, skill
prose, or duplicated constants. SLF4J logs use only bounded identifiers,
outcome codes, and retention counts; they never log a measurement payload.

MCP continues to use Zod input shapes and `buildUrl`,
`addAuthorizationHeader`, `RequestError`, and `parseErrorBody`; tokens,
prompts, request/response bodies, stack traces, raw issue comments, headers,
filesystem paths, and provider keys are prohibited from every measurement
record, log, metric attribute, and error response. Existing JSONL containment
and branch sanitisation remain mandatory. REST changes remain behind the shared
`/api/v1/**` security chain, `IpAllowlistFilter`, `ApiPathMatrix`,
`ActorFilter`/`ActorHolder`, and explicit `ROLE_ADMIN` handling for
cross-project roll-ups.

### 8. Enforcement

This model binds emitters through a structural gate, not through prose. The
`measurement-model-sync` rule in `architecture/policies/adr-policy.json`
requires this ADR in any diff that touches a process-measurement emitter
surface: the `workflowtelemetry` and `mcptelemetry` API and domain packages,
and the `gc_workflow_run`, ingest, and MCP tool-telemetry modules. A record
shape that changes without the model re-creates the divergence this ADR closes,
so the gate fails the diff instead of trusting review to notice.

The rule is pinned by `tools/tests/test_policy.py`, so removing it or dropping
the ADR from its `requireAll` list breaks a test rather than silently
disabling the gate.

### 9. Required consumer commitments

A consumer must reference this ADR and the versioned measurement contract
before defining a dashboard, exporter, metric label, or process KPI. #1285
(GC-P025) is the live consumer and carries that commitment. #1297 is closed and
ADR-087 is withdrawn, so no active consumer exists on that side; the commitment
binds any resumed evaluation work rather than a closed issue.

The following independently deliverable work is tracked and blocks consumers
claiming these metrics:

| Dependency | Issue |
|---|---|
| Live `/implement` lifecycle emission | #1435 (delivered) |
| Versioned contract and station catalogue | #1438 |
| ADR-061 station-result vocabulary and safe legacy handling | #1439 |
| Owner-specific retention and daily roll-ups | #1440 |
| Durable sink for ADR-036 step records | #1354 |

Each consumer's bounded attribute mapping stays with that consumer. These are
dependencies, not a new workflow lane or implementation plan.

## Consequences

### Positive

- Yield, retries, cost, and escapes have comparable definitions without
  flattening five storage/authority boundaries into one table.
- Measurements declare their coverage and provenance, making incomplete legacy
  data visible rather than deceptively precise.
- Runtime metrics avoid high-cardinality label explosions and telemetry avoids
  turning secrets or raw agent inputs into observability data.

### Negative

- Legacy records cannot support every formula; dashboards must show
  unavailable/partial coverage until versioned emitters land.
- Explicit station and escape attribution is more work than inferring meaning
  from strings, but is required for defensible metrics.

### Risks and anti-patterns

- Do not call a tool success, phase completion, or merged PR a gate pass.
- Do not make an architecture boundary, file path, GitHub label, or workflow
  phase a synonym for any other dimension.
- Do not create a `ProcessMeasurement` catch-all aggregate, generic event bus,
  duplicate validation/error taxonomy, or per-emitter dashboard schema.
- Do not send issue, run, branch, finding, or boundary identifiers as metrics
  labels; do not import raw host OTLP tool-detail logs into product reporting.
- Do not infer monetary cost from token counts, infer escape attribution from
  temporal order, or turn missing correlation into a synthetic join key.
- Do not use measurement as a gate, cycle counter, compliance evidence, or
  source of workflow state.

## Non-goals

- Implementing a dashboard, collector, exporter, retention job, migration,
  new REST/MCP endpoint, or process-metrics product in this ADR.
- Changing ADR-029's issue-thread authority, ADR-036's opt-in local telemetry,
  ADR-059's fail-open capture, or ADR-061's reporting-not-execution boundary.
- Reinstating the withdrawn CLD programme, introducing Temporal, or creating a
  new human workflow gate.

## Amendment (issue #1435, 2026-07-26): live ADR-061 emitter mapping

Live lifecycle emission uses the existing ADR-061 owners and maps to this
model without a second run, station, or outcome schema:

- work item: exact `(project, repo, issue_number)`;
- run: the `workflow_run.id` resolved by the existing
  `(project, repo, issue_number, branch)` upsert key;
- pull request: a related, late-bound `pr_number` supplied only after the tool
  layer authoritatively resolves the PR; it refines the existing run, is omitted
  while unknown rather than synthesized or sent as `null`, and is never part of
  work-item identity, run identity, or workflow authority;
- station: the stable ADR-061 `phase` id, never the SKILL step number,
  user-facing phase label, MCP tool name, or `next_action`;
- station attempt: the authoritative `cycle_index` when one exists, otherwise
  absent rather than inferred;
- observation time: `started_at`, `ended_at`, or event `occurred_at` supplied
  by the tool-layer transition owner;
- run state/outcome: ADR-061 lifecycle fields, kept separate from
  `PhaseEventType`, MCP operation outcome, and ADR-036 JSONL outcome.

The first live producer does not authorize a catch-all lifecycle event or a
second copy of the station catalogue planned by #1438. Its seam is a bounded
workflow-run observation helper in the MCP layer that accepts the explicit
correlation tuple and closed lifecycle/event values, uses the existing REST
client and authentication path, and returns no control-flow authority.
Emitter/version fields introduced by the #1438 versioned contract remain that
contract's responsibility; issue #1435 must not synthesize them, fork the
schema, or reinterpret legacy fields to imitate them.

At-least-once tool execution plus append-only phase events creates a
reconciliation requirement: every logical event needs deterministic source
identity so retries and issue-thread backfill converge. A timestamp is an
observation, not an idempotency key; provenance is a source class, not event
identity; and a cycle index distinguishes attempts but does not identify the
source record. Aggregates must not count both a live observation and its
backfilled copy as two station attempts.

Lifecycle capture inherits ADR-059's failure-isolation pattern, not its record
shape: determine the workflow result first, launch the bounded telemetry write
afterward, catch every write failure, log only safe correlation identifiers
plus a stable failure class, and preserve the original result unchanged.
Unlike ADR-059 tool-usage capture, lifecycle emission must be attached only to
registered workflow boundaries; wrapping every MCP call would conflate tool
operations with production stations.

### Decisions this amendment settles

The open questions above resolve as follows.

**Provenance.** `LIVE_EMISSION` is added to the closed provenance vocabulary.
A fact the tool layer observed as a phase transitioned is not a fact
reconstructed from the issue thread: the two carry different freshness and
different reconciliation semantics, and labelling the first `ISSUE_THREAD`
would erase the seam provenance exists to mark. Backfill keeps `ISSUE_THREAD`,
`MANUAL_IMPORT` stays economics-only, and `TEMPORAL_VISIBILITY` stays
historical.

**Event identity.** `workflow_phase_event.source_id` carries the identity of
the logical fact, unique within the run. When an emitter cannot attest it, the
service derives `phase:eventType:cycleIndex`. Re-recording an existing
`(run_id, source_id)` returns the stored event rather than appending a second
one, so the table stays append-only per logical fact instead of per HTTP call,
and a live observation plus its backfilled copy count as one station attempt.

**Attempt ordinal.** A `STARTED` event opens an attempt and takes the next
ordinal for `(run, phase, STARTED)`, read from durable history so an emitter
restart cannot silently reset it; the emitter threads that ordinal onto the
terminal event so both halves describe one attempt. Every other event type
without an explicit ordinal takes attempt `0`. An emitter that cannot order
attempts is describing the first one, and that is precisely what makes an
unordered reconciliation record converge instead of appending a phantom retry.

**Station vocabulary.** The `/implement` mechanical bands map to stable phase
ids one per gate: `issue_branch_resolution`, `completion_gate`, `git_publish`,
`ci`, `sonarcloud`, `ready_for_review`, `post_merge`. CI and SonarCloud stay
separate stations because they are separate gates with separate rework
profiles; collapsing them would make per-gate first-pass yield meaningless.
The versioned station catalogue remains #1438's.

**Terminal coverage.** The tool layer records `MERGED` when the post-merge
phase completes, `CLOSED`/`CLOSED_WITHOUT_MERGE` when it observes the linked PR
closed unmerged, and `SUPERSEDED` when a new live attempt opens on a different
branch of the same work item, the only abandonment observable at the moment
it happens, since an agent that walks away emits nothing. `FAILED` joins the
run-state vocabulary for an explicitly observed non-recoverable failure; it is
never inferred from a retryable phase failure, and a failed station attempt
leaves the run open. Consistent with the ADR-061 amendment, `RUNNING` means
that no terminal observation has been recorded, and closing the remaining gap
requires the lease/heartbeat decision that amendment defers.

**Transport isolation.** The emitter timestamps each transition locally and appends the write to an
internal FIFO chain that the workflow never awaits. A bounded timeout alone would still put the
backend on the critical path, because it caps the delay rather than removing it. The queue is what
makes observation genuinely unable to stall the observed operation, rather than merely bounded in
how long it stalls. Ordering within a run is preserved by the chain, and the recorded `occurred_at`
is the moment of transition, not the moment of delivery, so a late flush never distorts a duration.

**Enforcement.** `mcp/ground-control/workflow-run-lifecycle.js` and
`mcp/ground-control/gc-implement-mechanical.js` join the
`measurement-model-sync` trigger. A live emitter the gate does not name is a
hole in the gate.

## Amendment (issue #1436, 2026-07-27): live delivery is transport, not a new emitter

Issue #1436 adds a project-scoped SSE transport over the ADR-061 reporting
model. It introduces **no new emitter and no new measurement record**, so the
canonical dimensions, the three outcome axes, and the formulas in Decisions 2–4
are untouched. The stream re-reads the committed `WorkflowRun` and
`WorkflowPhaseEvent` projections and serialises the existing REST response
shapes; a subscriber sees exactly the rows a poll would have returned, only
sooner.

This is stated explicitly because a delivery path is the easiest place to
accidentally grow a second measurement model:

- **No stream-only schema.** The SSE payloads are `WorkflowRunResponse` and
  `PhaseEventResponse`. A stream-only envelope, event vocabulary, or DTO would
  be the parallel measurement shape Decision 1 forbids, and the frontend would
  then be reconciling two shapes of the same fact.
- **Push is not a station result.** Delivering an event is not evidence that a
  gate passed, that a station attempt occurred, or that a run is alive.
  Decision 3's separation stands: the operation outcome of a delivery is not a
  station result and never feeds a yield or rework denominator.
- **No emitter/version fields.** `measurement_version` and `emitter` remain the
  #1438 versioned contract's responsibility. The transport must not synthesize
  them, and re-delivering a fact does not create a new observation of it.
- **Duplicate delivery is not a second attempt.** Delivery is best-effort and
  may repeat; subscribers reconcile by entity id. The `(run_id, source_id)`
  identity settled by the #1435 amendment is what keeps a live frame and its
  backfilled copy counting as one station attempt, and the transport reuses it
  rather than introducing a delivery-side dedup key.
- **`RUNNING` still means "no terminal observation recorded."** An open
  connection is not a lease and a heartbeat is not a workflow liveness signal.
  The heartbeat proves the socket is open, nothing more. Strict liveness and
  stale-run reaping still require the separate lease decision both this ADR and
  ADR-061 defer, and the console must not present transport health as process
  health.

Consistent with Decision 7, the endpoint stays behind the shared `/api/v1/**`
security chain, `IpAllowlistFilter`, and `ApiPathMatrix` with project scoping
resolved through `ProjectService`; its bounds live in a validated
`@ConfigurationProperties` object rather than parsed environment strings; and
its logs carry only bounded identifiers, counts, and a closed disconnect reason.

Because process-local fan-out cannot reach a connection held by another node,
the internal post-commit change notification is the seam a multi-instance
deployment replaces with a broker, outbox, or database notification. That
replacement is a delivery concern and must not become a reason to fork the
measurement model.

## Amendment (issue #1437, 2026-07-30): Live Activity is a bounded read projection

The Live Activity workspace and its REST/MCP read surface project the existing
ADR-061 run, lifecycle, routing, station-attempt, and finding facts. They emit
no measurement record and create no new workflow, station, result, or liveness
axis. The REST snapshot and `gc_workflow_run activity` action are bounded and
project-scoped; both use the same authenticated repository-backed projection.

The gate strip is a catalogue-shaped presentation over the latest durable
attempt at each station. A catalogue station with no observed attempt is shown
as `UNOBSERVED`; the projection never derives pass/fail from a lifecycle event,
operation outcome, run state, or missing row. Routing model and tier come only
from the latest authoritative ADR-036 observation and remain separate from the
station result.

“Possibly stalled” is browser-side attention wording derived from the
server-provided observation time and a validated threshold. It is not a
heartbeat, lease, timeout, state transition, failure, station result, or
workflow control signal. `READY_FOR_REVIEW` and `ESCALATED` runs therefore use
honest waiting/escalation wording instead of being relabelled as running work.
This leaves the liveness boundary from the #1436 amendment unchanged.

## Amendment (issue #1438, 2026-07-27): the contract is published

Decision 7 required the model to become a versioned contract; issue #1438
publishes it, so the authority for these definitions moves out of this prose
and into artifacts a consumer can validate against:

- `contracts/schemas/measurement/measurement-record.v1.schema.json`
  (`gc.measurement.record.v1`): the record shape, with Decision 2's dimensions
  and Decision 3's three outcome axes.
- `contracts/schemas/measurement/station-catalogue.v1.schema.json` and
  `contracts/measurement/gc-station-catalogue-v1.json`: the station catalogue's
  shape and its data.

Three things this settles that the prose left open.

**Station identity.** `station_id` is authoritative. ADR-061 `phase` strings,
ADR-036 routing stages, issue-thread `gc:phase` values, MCP action names, and
SKILL step numbers are aliases declared *by kind*, so a display rename can never
become a breaking identity change. The divergence was wider than Decision 5
implied: five vocabularies were in use, and they collided rather than cleanly
renamed (`ci` as an emitted station id against `ci_monitor` as a routing stage).
Alias uniqueness is therefore an enforced invariant, not an assumption.

**Stations are not lifecycle markers.** A station inspects something and can
yield a station result. `ready_for_review`, `post_merge`, `pre_merge`, `plan`,
and `traceability_reconciled` record a transition and inspect nothing, so they
are lifecycle markers and can never carry pass/fail. The #1435 emitter currently
routes `ready_for_review` and `post_merge` through its station channel; the
catalogue records them honestly as markers and the drift gate accepts them as
declared. Reconciling the write path is #1439's work, which is why this issue
publishes the contract without changing persistence.

**Axis separation is structural.** The three axes are separate properties over
separate closed enums that share no value, so `pass` cannot reach the operation
axis and `ok` cannot reach the station axis. Decision 3's rule is now enforced by
construction rather than by reviewer vigilance.

The catalogue is authoritative rather than descriptive because
`run_measurement_catalogue_check` fails the build when a station id the MCP layer
emits, a `gc:phase` marker value, or an ADR-036 routing stage resolves to nothing
declared. Routing stages that map to no station and no marker are declared
explicitly with a reason, so the gate is total: it can never pass by silently
ignoring what it failed to resolve.

This amendment publishes data and gates only. It adds no aggregate, endpoint,
MCP tool, dashboard, roll-up, or retention job, and it backfills no legacy
station result: a record whose source never captured a verdict stays
`unobserved` and stays out of formula denominators.

## Amendment (issue #1355, 2026-07-28): the station result is persisted and findings are counted

Decision 3 named station result as a separate axis and Decision 4 built every yield
formula on it, but no emitter could state it and no store could hold it. Issue
#1355 closes that: the axis becomes a persisted field on the ADR-061 write path,
and the findings a station observed become subordinate rows linked to the terminal
event of its attempt.

**No new aggregate.** A station attempt stays a `WorkflowPhaseEvent` owned by
`WorkflowTelemetryService`. Findings are subordinate process observations, not a
second workflow state machine and not the product `Finding` aggregate, which models
retained GRC findings with their own lifecycle, links, and evidence semantics, and a
review or scanner observation is neither compliance evidence nor a graph-projected
product record.

**The axes stay disjoint by construction.** `PhaseEventType` remains the lifecycle
axis and keeps its meaning: `COMPLETED` still means the phase finished. The emitter
states `station_result` explicitly and validates it against the closed vocabulary;
a value it does not recognise (including an operation-axis value like `ok`)
degrades to `unobserved` rather than being coerced to its nearest neighbour. An
outage, parser error, or timeout is `not_evaluable`, never a failed gate, so a
backend problem can never enter the rework signal as a defect.

**Legacy rows are honest.** Every row written before this change carried no verdict,
so it reads `unobserved` and stays out of every formula denominator. No result is
backfilled from `COMPLETED`, from the free-text `outcome`, from merge state, or from
the absence of a later failure.

**Markers leave the station channel.** The #1438 amendment recorded that the first
live emitter routed `ready_for_review` and `post_merge` through `station()`. They
record a transition and inspect nothing, so they now emit as lifecycle markers. A
per-station yield computed over them would have been counting transitions as
inspections.

**Attempt counting.** Iterations to green orders distinct evaluable attempt
identities and takes the first pass; it never reads `MAX(cycle_index)`, because the
emitters mix zero-based attempt ordinals with one-based review-cycle labels. A review
cycle is one attempt per consumed cycle. Reviewer slices, async job polls, transport
retries, and issue-comment posts are delivery detail and are not rework. A cap
refusal runs no reviewer and records no attempt.

**Child gates report where they execute.** `completion_gate` is a composite station.
`spotbugs`, `policy`, and `vale` report their own verdicts from the structured
artifacts their own runs produce, carrying their own durations. The parent command's
duration is never divided among them, no combined console transcript is parsed as
several attempts, and no canonical gate is executed twice to measure it. A child gate
that cannot attest a duration omits it rather than inheriting the parent's.

**Emitted measurement is validated against the catalogue.** The station id is
checked for membership in the published catalogue, which the backend build copies
from `contracts/measurement/` rather than mirroring under its own resources, so a
validator can never disagree with the contract it enforces. An unrecognised id is
refused: a typo does not fail on its own, it opens a phantom station holding one
attempt and silently removes that attempt from the real station's denominator, and
nothing downstream can distinguish it from a station that genuinely ran once. The
combination is checked too. A lifecycle marker inspects nothing, so it carries no
station result and no findings; a `STARTED` attempt has not finished inspecting, so
it carries neither either; and a stage with no station has nothing to report. These
rows are permanent once written, because the disjointness of the axes means nothing
downstream re-derives one from another to notice the contradiction later.

**Findings carry facts, not prose.** A finding record holds its attempt identity, a
detector or reviewer id, source-native category and severity, classification where
the source has one, and a disposition. Title, body, remediation text, file path, line
number, raw tool output, and stack traces are excluded by the contract's
`additionalProperties: false`, so the projection cannot become a rival to the ADR-029
record or leak source content into a reporting store. Severity is preserved exactly:
Codex core and security findings carry none, so theirs is absent rather than guessed,
and cross-station normalization would require separately versioned mapping data.

**Detection is not disposition.** A newly observed finding is `open`. The review
wrapper's existing `decision: fix` is posted before the agent has repaired anything:
it is intent, and projecting it as `fixed` would report a repair that never happened.
`wontfix` and `not-applicable` keep ADR-029's authorization and rationale
requirements; measurement creates no second disposition or deferral vocabulary, and a
missing disposition is never counted as fixed.

**Contract.** The v1 station catalogue is a published version and stays on disk
unmodified. `spotbugs`, `policy`, and `vale` arrive in
`contracts/measurement/gc-station-catalogue-v2.json` under
`gc.measurement.station-catalogue.v2`, and the finding shape is published as
`gc.measurement.gate-finding.v1`. Both are declared in `contracts/CHANGES.md` under
ADR-082.

**Enforcement.** `_check_emitter_station_drift` previously scanned only
`gc-implement-mechanical.js`, so every station id emitted from the review path was
invisible to the gate, and a live emitter the gate does not name is a hole in it. The
check now scans every emitter source and resolves station ids named through lookup
tables and `stationId` fields, not only inline `.station("…")` literals; a gate that
understands one naming style is guarded only against that style.
`mcp/ground-control/lib.js` is deliberately **not** added to the
`measurement-model-sync` trigger: it is a 20,000-line module touched by most changes,
so requiring this ADR in every diff that edits it would make the gate fire constantly
and train contributors to add the reference reflexively. The record shape lives in
`gate-finding-adapters.js`, `workflow-run-lifecycle.js`, and `contracts/measurement/`,
which are on the trigger; lib.js only calls them, and its station identity is already
covered by the catalogue drift check.

## Relationship to existing ADRs

- ADR-027: agent-neutral context and privileged-side-effect boundary remain
  unchanged; GitHub interaction stays in the MCP server.
- ADR-029: issue records are the durable workflow/audit record.
- ADR-036: local step economics and provider-neutral tiers map into this model
  without becoming gate truth.
- ADR-059: tool-handler operational observations remain distinct and fail-open.
- ADR-061: the workflow reporting projection is the canonical product home for
  process-linked measurement facts; this ADR supplies its missing semantics
  and retention policy.
- ADR-082: the shared contract is versioned and compatibility-governed.
- ADR-089: no retired GRC product surface is revived by boundary/finding
  measurement.

## Amendment (issue #1473, 2026-07-28): background jobs are transport

The shared in-process job registry now also carries long
`gc_implement_mechanical` actions. A job start, poll, duplicate reuse,
idempotency conflict, capacity refusal, or non-cancellable response is an MCP
operation outcome, not a station attempt or lifecycle transition. The
underlying mechanical action continues to emit its existing workflow-run
station evidence exactly once. No job id, idempotency key, registry state, or
poll count enters the station catalogue, yield/rework formula, workflow phase
vocabulary, or ADR-036 step-telemetry record.

This keeps Decision 3's axes separate: `status: "done"` describes transport
completion, while the unchanged mechanical `result` carries the action's
pass/fail or repair outcome. Handler-level MCP usage telemetry may observe each
start and poll as it already observes every tool call, but those observations
remain distinct from production-line station facts under ADR-059. No
measurement schema, station catalogue entry, lifecycle emitter, persistence,
dashboard, or retention rule changes.

## Amendment (issue #943, 2026-07-30): review-cycle retry transport

Idempotent, single-flight review-cycle starts remain transport facts. Reusing
the async registry's normalized fingerprint helper from
`gc_implement_mechanical` is behavior-neutral for mechanical actions and does
not change their station emission. A retained review-cycle start likewise
does not emit another reviewer attempt, station result, lifecycle transition,
or finding batch because the reviewer does not run again. Job ids,
idempotency keys, namespaces, fingerprints, execution scopes, and poll counts
remain excluded from MCP usage payloads and workflow-run measurement records.
No measurement schema, station catalogue entry, emitter, dashboard, formula,
or retention rule changes.

## Amendment (issue #1354, 2026-07-29): durable ADR-036 step observations

ADR-036 step telemetry currently stops at a gitignored JSONL file. Issue #1354
makes new observations durable without creating another measurement owner:
`WorkflowRun` and `WorkflowPhaseEvent` remain the ADR-061 reporting projection,
and the existing run-upsert plus phase-event write path is the only product
ingest path. No step-telemetry entity, table, repository, REST prefix, generic
event store, or JSONB payload is introduced. Existing local JSONL files are
historical input only: they are not backfilled, dual-written, or promoted into
a second source of truth.

The durable record is a step observation carried by the existing phase-event
row, distinguished by the contract's `emitter` value. It reuses
`occurred_at`, `duration_ms`, the operation-outcome field, provenance,
`cycle_index`, and `(run_id, source_id)` idempotency. The closed event shape
adds only the ADR-036 facts that have no existing owner: measurement version,
the numbered SKILL step as a non-identity alias, capability tier, reported
model, expected model, the tier/model consistency assertion, and optional
input/output token counts. These are event-level facts: writing them onto
`WorkflowRun` would overwrite one routed step with the next. A free-form
payload bag would merely hide a second schema inside the first store and is
therefore forbidden.

Correlation is authoritative at every layer:

- The parent run supplies the exact `(project, repo, issue_number)` work item
  and `workflow_run.id`. The MCP boundary resolves project through the
  canonical repository context and repository identity through the existing
  origin-derived, fail-closed resolver; it never uses the sanitized JSONL
  branch, `GH_REPO`, an issue number alone, or a synthesized `unknown`. It
  upserts the existing `IMPLEMENT` run by the raw
  `(project, repo, issue_number, branch)` natural key before recording the
  event.
- `phase` carries the stable ADR-036 `stage_id`, not a numbered step or display
  label. The numbered step remains only an alias for compatibility and
  diagnostics. The backend resolves the stage through the published station
  catalogue. A station alias stores the canonical `station_id`; a declared
  lifecycle marker or non-station stage stores no station id. Absence in those
  two cases is correct modelling, not missing data.
- Capability tier is required and remains separate from provider/model.
  `low`, `medium`, and `high` keep their ADR-036 meanings; no model name is
  accepted as a tier.
- Every logical dispatch supplies a non-negative attempt index. The durable
  source identity is namespaced to the ADR-036 emitter and derived from the
  stable stage, step alias, and attempt index. A transport retry reuses that
  identity; a later real attempt receives another index. Observation time,
  provenance, and branch are never idempotency keys. Reusing an identity with
  different measurement facts is a conflict, not a silent overwrite or a
  second row.

The three outcome axes remain disjoint. ADR-036 `ok` / stable error / `skipped`
is operation outcome only. It may describe whether the routed step ran, but it
never becomes `station_result=PASS` or `FAIL`. A step observation carries
`UNOBSERVED` on the station-result axis; the existing lifecycle/gate emitter
continues to own explicit station verdicts and findings. Consequently a gate
can have both a routed-step cost observation and a separate evaluable station
attempt without either record impersonating the other.

Consumers must select the intended emitter explicitly. Per-step queries select
the ADR-036 emitter from the existing project/run-scoped event surface.
Lifecycle hot-spot queries, yield/rework calculations, and the context-graph
projection must not acquire extra attempts or edges merely because step
economics became durable; they continue to consume their existing
ADR-061/station facts unless separately amended. SSE may transport the extended
`PhaseEventResponse`, but it remains a projection transport and creates no
stream-only schema.

The durable write inherits the existing security and failure boundaries:
MCP Zod shape validation; `telemetry.enabled`; canonical repo-context and
origin identity resolution; the shared REST client and environment-sourced
bearer header; `IpAllowlistFilter`, the authenticated `ApiPathMatrix` rule,
`ProjectService`, Bean Validation, reserved-marker/range/catalogue/cross-field
validation in `WorkflowTelemetryService`, project-scoped locked repository
lookups, and database constraints. The standard
`GroundControlException`/`GlobalExceptionHandler`/`ErrorResponse` path owns
backend failures. Tokens, prompts, completions, raw reviewer/tool payloads,
issue bodies, credentials, response bodies, and stack traces never enter the
record or diagnostics. Credentials remain environment-to-header data and
never enter process argv. Because `WorkflowPhaseEvent` is already on the
Envers graph spine, its forward migration keeps the live and audit shapes
synchronized rather than adding a parallel audit mechanism.

Telemetry remains fail-open and cannot advance, fail, retry, or cap a workflow.
A bounded durable-write failure returns only safe correlation identifiers and
a stable failure class; it does not fall back to a local authoritative file.
This means the acceptance criterion assumes a reachable, authenticated
Ground Control backend with telemetry enabled. Durable queuing, offline
backfill, retention/partitioning, new aggregates or dashboards, price
translation, changing ADR-029 workflow authority, and making telemetry
mandatory workflow evidence are separate decisions.

## Amendment (issue #1439, 2026-07-29): canonical station binding on the ADR-061 write path

Issue #1355 added the station-result column and formula surface before #1439
reconciled the original ADR-061 migration issue. This overlap does not authorize
a second result field, event entity, measurement aggregate, endpoint, or
catalogue. #1439 makes the existing path obey the already-published contract.

For an ADR-061 phase event, the backend station catalogue is the authority for
binding. The service resolves the persisted `phase` as either a direct catalogue
entry or an `adr061_phase` alias. A station entry supplies the canonical
`station_id`; a lifecycle marker supplies no station id and can carry no verdict
or findings. A caller-provided station id is only a consistency assertion. It
must match the catalogue resolution and must never override it. The original
`phase` remains stored exactly as observed, so the binding adds identity without
rewriting history.

Legacy live and Envers rows may receive a `station_id` only where their persisted
phase resolves unambiguously through the published catalogue. Marker and
unresolved legacy phases retain a null station id. Every legacy station result
remains `UNOBSERVED`, including a row whose phase can be mapped safely. Station
identity may be resolved from a governed alias; a verdict must never be inferred
from phase, event type, free-text outcome, run state, temporal order, or the
absence of a later failure. Forward migration keeps the live and audit shapes in
lockstep and does not edit V203 or another applied migration.

The measurement contract uses lower snake-case values while the existing
REST/OpenAPI enum surface uses Java enum names. Contract-native emitters cross
that representation boundary in the workflow-run REST adapter. The generic
snake-to-camel key mapper remains a key mapper; it does not rewrite arbitrary
values. Global case-insensitive Jackson parsing, a second permissive enum, or a
second station-result vocabulary would hide drift instead of validating it.

Yield and rework continue to group by canonical `station_id` and consume only
explicit `PASS` and `FAIL` results. `UNOBSERVED`, `SKIPPED_STATION`,
`CANCELLED`, and `NOT_EVALUABLE` remain coverage facts outside formula
denominators. Aggregate ratios continue to expose numerator, denominator,
unresolved count, and `gc.measurement/v1`. The catalogue-backed resolver is the
extension seam: adding a catalogue station or alias must not require another
hard-coded service mapping.
