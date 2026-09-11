# ADR-061: Workflow-Run Telemetry & Economics Reporting Surface

## Status

Superseded (issue #1303)

## Date

2026-06-24

> **Supersession (2026-09-11):** The reporting backend, database, REST, and UI
> were removed by #1500. Issue #1303 deletes the remaining workflow-run clients,
> lifecycle emitters, and measurement projection adapters. The GitHub issue
> thread remains the durable workflow record under ADR-029; it is not rebuilt as
> a telemetry read model.

## Context

High-concurrency `/implement` work leaves durable issue-thread records (ADR-029),
opt-in per-step JSONL economics (ADR-036), and per-MCP-tool-call usage counters
(ADR-059). None of these answer the operator question issue #859 raises: across
roughly eight concurrent agents, which runs are burning subscription/token budget,
where are the gate/CI/review hot spots, and what does a merged PR or closed issue
actually cost? There is no aggregate product surface that connects cost drivers to
workflow outcomes (merged PRs, closed issues, review/CI cycles, stuck gates,
escalations, wall-clock by phase) across repos and agents.

GC-O009 ("Workflow Orchestration via Temporal") will eventually own `/implement`
execution end to end, at which point Temporal Visibility is the authoritative
source of run/phase history (ADR-028). Issue #859 needs the **reporting** half of
that vision now, during the transition bridge, without building the workflow engine.

## Decision

### 1. A reporting read-model, not a workflow engine

Issue #859 adds a PostgreSQL **correlation/projection surface** for workflow runs,
phase/gate events, and economics, exposed through REST, MCP, and the web UI. It is
explicitly NOT a gate state machine and never drives execution, retries, signals, or
gate completion. ADR-028 remains binding: once GC-O009 owns execution, Temporal
Visibility is the source of truth and this model becomes a projection of it. The
read-model must not become a second executor.

### 2. Provenance is the transition-bridge seam

Every persisted run and phase event records a `provenance`
(`ISSUE_THREAD` | `TEMPORAL_VISIBILITY` | `MANUAL_IMPORT`) so stale, partial, and
superseded bridge data stays distinguishable from authoritative data. During the
bridge, facts are seeded from GitHub issue-thread `gc:` markers
(`provenance=ISSUE_THREAD`); the same schema later ingests Temporal Visibility
without a migration. ADR-036 JSONL files are bridge-era local measurements and are
NOT the product source of truth; they may only supplement phase timing.

### 3. Two entities, idempotent upsert

- `workflow_run`: one row per run, keyed for idempotent upsert by
  `(project, repo, issue_number, branch)`. Re-observing a run merges the non-null
  fields of the new observation, so a later phase marker, the merge outcome, or a
  manual cost import refine the same row instead of duplicating it. Carries run
  dimensions, `final_state`, merge/close `outcome`, and economics.
- `workflow_phase_event`: append-only per-phase/gate events (preflight, plan, tdd,
  completion_gate, codex_review, precommit, ci, sonarcloud, test_quality_review,
  transition, traceability_reconcile, issue_close, escalation, …) with a stable
  machine `phase` id (never user-visible prose), `event_type`, `cycle_index`,
  duration, and a denormalized `project` so phase aggregates scope without a join.

Neither table carries an Envers audit shadow: like `mcp_tool_event` (ADR-059) these
are operational telemetry, and an audit history of idempotently overwritten rows is
not worth the storage. `workflow_run` is mutable only through idempotent
re-ingestion, not user-edited configuration.

### 4. Closed, redacted field set enforced in the backend

Only safe correlation and economics scalars are stored. Prompts, completions,
bearer tokens, provider/GitHub keys, raw reviewer payloads, and raw issue-comment
bodies are excluded at the DTO layer, and every caller-supplied string is rejected
if it carries the reserved `<!-- gc:` marker sequence: forged-marker text can never
round-trip into telemetry (cf. GC-TM-004). Bridge ingestion trusts only canonical
`gc:` marker families and records malformed/forged-shaped input as a bounded skip
count, never raw text.

### 5. Project scoping mandatory; cross-project rollup is admin-only

Project-scoped reads/writes route through `ProjectService` and project-scoped
queries (cf. GC-TM-005/GC-TM-007 disclosure classes). The cross-project operator
rollup is a dedicated endpoint, `GET /api/v1/workflow-runs/cross-project-aggregate`,
gated to `ROLE_ADMIN` in the shared `ApiPathMatrix`, an explicit authorization
decision, never an accidental fall-through from a project read (ADR-026). Project
scoping is not SaaS tenant isolation and creates no Temporal namespace per project.

### 6. Aggregation runs in the database, window policy in the service

Throughput counts, outcome counts, cycle-time percentiles
(`percentile_disc` over `ended_at − started_at` minutes), cost sums, and per-phase
hot spots all run as `GROUP BY` / `COUNT FILTER` queries in Postgres against the
`(project, started_at)` and `(project, phase, occurred_at)` indexes; the service
never materializes the raw event window in JVM memory. The default window (30 days)
and maximum window (366 days) are named constants in `WorkflowTelemetryService`. The
time anchor is `COALESCE(started_at, created_at)` so runs without a recorded start
still fall in a window.

### 7. Three surfaces over one model

- **REST** (`/api/v1/workflow-runs**`): record/upsert run, append phase event,
  import cost, list runs, project-scoped aggregate, admin cross-project aggregate.
- **MCP**: `gc_workflow_run` (action-discriminated: record / record_event /
  import_cost / list / activity / aggregate / cross_project_aggregate) and
  `gc_workflow_run_ingest` (bridge ingestion from the issue thread). The two
  project-scoped read paths are added to the `gc_query` allowlist (ADR-035); POST
  and admin paths stay off it. GitHub reads for the bridge stay in the MCP server,
  not in Codex/Claude sandboxes (ADR-027/031).
- **Web UI**: a project-scoped dashboard (throughput, cycle-time distribution,
  review/gate hot spots, cost proxies per merged PR / closed issue, active workflow
  status) rendered with lightweight inline SVG/CSS (no new chart dependency) and
  showing only aggregate facts, never raw bodies.

## Consequences

**Positive:**
- Operators gain per-project and cross-project economics, gate health, and active
  run visibility over any window up to a year, from one read-model.
- The provenance seam distinguishes bridge-sourced data from other origins without
  a schema change (see the 2026-07-12 amendment: the originally anticipated
  Temporal Visibility ingestion path did not materialize).
- The closed, redacted field set plus reserved-marker rejection make leaking
  prompts/secrets into telemetry a deliberate, reviewable code change.

**Negative / risks:**
- Append-only `workflow_phase_event` rows grow without bound; a retention/partition
  strategy is deferred to a follow-on issue (as for `mcp_tool_event`).
- Bridge ingestion fidelity is bounded by what the issue-thread markers record;
  partial/stale runs are expected and flagged by provenance, not hidden.

**Out of scope:**
- No Temporal worker/activity implementation, no new human gate or plan-approval
  signal, no SaaS tenant model, no dynamic plugin/activity loading, and no
  OpenTelemetry/Prometheus decision (those await a later requirement).

## Amendment (issue #1359, 2026-07-12): Temporal transition retracted

GC-O009's Temporal engine (ADR-028, ADR-081) is withdrawn; it will not
eventually own `/implement` execution, and Temporal Visibility will not
become this surface's authoritative source. Every "transition bridge" /
"eventually" framing in the Context and Decision sections above no longer
applies: `ISSUE_THREAD` bridge ingestion (via `gc_workflow_run_ingest`) is
this surface's permanent, sole ingestion path, not a stopgap. This surface's
own decisions - the reporting read-model that never drives execution, the
closed redacted field set, project scoping, the three-surface (REST/MCP/UI)
shape - are unaffected and continue exactly as decided. `TEMPORAL_VISIBILITY`
remains a defined `provenance` value for historical data recorded before this
amendment; no active ingestion path writes it going forward.

## Amendment (issue #1311, 2026-07-19): audited context-graph projection

ADR-084 subsequently made Envers revisions the context graph's canonical time
spine. Its snapshot metadata is only honest when every entity read by a graph
contributor participates in Envers. Decision 3's original no-audit choice is
therefore superseded for `WorkflowRun` and `WorkflowPhaseEvent`: both entities
are audited, and V203 adds their forward-only audit shadows. The unprojected
`workflow_run_requirement_uid` collection remains `@NotAudited`.

The reporting model joins the registered `workflow-and-process` ontology family
through a read-only contributor:

- `WORKFLOW_RUN` represents the persisted reporting run and exposes its stable
  `graphNodeId` on the existing REST response.
- `WORK_ITEM_REFERENCE` identifies a GitHub issue from the exact persisted
  `(project, repo, issueNumber)` tuple. Its graph id is a bounded,
  length-framed digest that includes the project UUID. It is not a new JPA
  aggregate and does not reuse the requirements-specific `ARTIFACT_REFERENCE`.
- `RUN_FOR_WORK_ITEM` records the stable association. Each persisted
  `WorkflowPhaseEvent` becomes a separately identified
  `WORKFLOW_PHASE_EVENT` edge from the run to the work-item reference, preserving
  repeated events between the same endpoints.
- A run with incomplete repository/issue identity remains an isolated run node;
  the contributor never fabricates a work item or self-loop.

Only the closed correlation, lifecycle, provenance, and phase-event scalars
needed for traversal are projected. Branches, provider/model economics, local
JSONL telemetry, prompts, issue bodies, reviewer payloads, and credentials stay
out of the graph. Project UUIDs resolve to immutable project identifiers inside
project-scoped repository queries; graph materialization never loads all runs
and filters them in memory.

This amendment does not revive the Temporal execution model removed by issue
#1359 or the derivation, boundary, and architecture-model aggregates retired by
ADR-089/V199. A first-class work-item aggregate, retention policy, or
revision-stable projection-scope policy requires a separate decision.

## Amendment (issue #1435, 2026-07-26): live lifecycle observation

The issue #1359 amendment's statement that issue-thread ingestion is the sole
active write path is superseded. Issue #1435 adopts live `/implement`
lifecycle observation from the MCP tool layer while
`gc_workflow_run_ingest` remains the backfill and reconciliation path. This
does not make the read-model an executor: recording is a consequence of an
already-determined workflow transition and can never authorize, advance,
retry, or fail that transition.

The live path is governed by these invariants:

- Open the existing ADR-061 run, using its
  `(project, repo, issue_number, branch)` natural key, as soon as the canonical
  project/repository/issue/branch identity is available. The initial
  observation carries `started_at` and `final_state=RUNNING`; Phase E re-entry
  on the same issue branch refines the same run rather than creating another
  run identity.
- Emit only stable machine phase ids from the existing workflow/station
  vocabulary. A SKILL step number, display label, MCP tool name, or
  `next_action` string is not a phase id. `cycle_index` is present only when
  the authoritative transition owner knows the attempt order, and duration is
  measured from tool-layer timestamps rather than agent prose or reconstructed
  guesses.
- `READY_FOR_REVIEW` is an open, paused state and has no `ended_at`.
  Successful merge/close, explicit abandonment, supersession, and a
  non-recoverable failed run are terminal observations and carry `ended_at`.
  A failed phase attempt is not automatically a failed run: retryable gate,
  CI, review, or network failures remain phase events while the run stays
  open. Because the existing closed run-state vocabulary does not distinguish
  non-recoverable failure from abandonment or escalation, `FAILED` is added as
  a run state; it must be kept synchronized across the versioned contract,
  backend/MCP enums, REST documentation, and frontend type/badge vocabulary.
- Live observations can race with one another and with reconciliation. The
  `WorkflowTelemetryService` transaction boundary must merge them atomically:
  preserve the earliest `started_at`, reject `ended_at < started_at`, prevent
  an open observation from overwriting a terminal observation, and prevent
  lost updates to correlation/economics fields. A delayed `RUNNING` write or
  stale issue-thread ingest must never reopen a completed run. These are
  projection-consistency rules, not workflow transition authority.
- Live observation is strictly fail-open and happens after the workflow
  operation has determined its own result. Backend unavailability,
  authentication failure, validation failure, conflict, timeout, or malformed
  telemetry response may produce only a bounded diagnostic containing safe
  identifiers and a stable failure class; it must not alter the workflow
  result or its `next_action`. No telemetry payload, credential, raw issue
  body, response body, or stack trace is logged.
- Provenance continues to name the source fact, not merely the delivery time.
  A live write may use `ISSUE_THREAD` only when it is emitted from the same
  successful tool-layer operation that established the canonical durable
  issue record. Backfill retains `ISSUE_THREAD`; `MANUAL_IMPORT` remains
  economics-only and `TEMPORAL_VISIBILITY` remains historical. A tool-local
  fact with no issue-thread source must not be mislabeled and requires a
  separately decided closed provenance value.
- A live producer records the boundary that just occurred; it must not invoke
  the full issue-thread ingest after every boundary. Reconciliation must
  converge with live data rather than append a second copy of the same
  logical phase attempt. The append-only event needs a deterministic source
  identity/idempotency seam that survives retries and lets live emission and
  `gc_workflow_run_ingest` identify the same fact. Provenance, timestamp, or
  `(phase, event_type, cycle_index)` alone is not a safe deduplication key.

The two values this amendment leaves open are decided here:

- The closed provenance vocabulary gains `LIVE_EMISSION` for a tool-local fact
  with no issue-thread source. `ISSUE_THREAD` continues to name a fact carried
  by the durable issue record, so the two remain distinguishable in the store
  rather than only in the emitter's intent.
- The deterministic source identity is `workflow_phase_event.source_id`, unique
  per `(run_id, source_id)` and derived as `phase:eventType:cycleIndex` when the
  emitter cannot attest it. Re-recording an existing identity returns the stored
  event, so live emission and `gc_workflow_run_ingest` converge on one row per
  logical attempt. The service also assigns the attempt ordinal from durable
  history for a `STARTED` event and `0` for any other unordered event, which is
  what makes an unordered backfill land on the first live attempt instead of
  appending a phantom retry.

The terminal transitions the tool layer actually observes are: `MERGED` when
the post-merge phase completes, `CLOSED` with `CLOSED_WITHOUT_MERGE` when the
linked PR is seen closed unmerged, and `SUPERSEDED` when a new live attempt
opens on a different branch of the same work item. That last one is the only
abandonment observable at the moment it happens, because an agent that stops
working emits nothing. `FAILED` is written only from an explicit terminal
observation, never inferred from a retryable phase failure.

This amendment guarantees closure for terminal paths the tool layer can
observe. An abrupt process or host death cannot execute a terminal write;
without a lease/heartbeat, `RUNNING` therefore means "no terminal observation
has been recorded," not proof that a process is currently alive. Strict
liveness and stale-run reaping require a separate lease/heartbeat decision and
must not be simulated with a timer in skill prose or by treating telemetry as
workflow authority.

## Amendment (issue #1436, 2026-07-27): bounded live projection transport

Issue #1435 makes lifecycle changes observable at write time, but the REST
dashboard still observes them by snapshot polling. Issue #1436 adds a
project-scoped Server-Sent Events (SSE) transport over the existing Spring MVC
stack. This is a delivery path for committed ADR-061 facts, not another event
store, workflow engine, liveness lease, or source of truth.

### Transport and event contract

- The endpoint is `GET /api/v1/workflow-runs/stream?project={identifier}` with
  `text/event-stream`. It resolves the project through `ProjectService` before
  registering a connection and falls through the existing authenticated
  `/api/v1/**` rule in `ApiPathMatrix`; it is neither anonymous nor admin-only.
  The bearer and browser/session chains, IP allowlist, and standard pre-response
  401/403 behavior therefore remain the ADR-026/ADR-037 authority.
- Named SSE events are `workflow-run` and `phase-event`. Their `data` values are
  the existing `WorkflowRunResponse` and `PhaseEventResponse` JSON shapes.
  Heartbeats are SSE comments with no product payload. Do not add a parallel
  telemetry envelope, hand-mirrored frontend DTO, or stream-only enum.
- The service publishes an internal identifier-only change notification from
  every committed run mutation (`recordRun`, cost refinement) and phase-event
  append. Reuse the existing `ApplicationEventPublisher` /
  `@TransactionalEventListener` pattern: the transport listener runs only
  after commit, reloads the project-scoped response through
  `WorkflowTelemetryService` in a new read-only transaction, and then offers it
  to the stream hub. It must never expose uncommitted state, import repositories
  into `api/`, or perform socket writes on the mutation/transaction thread.
- Delivery is best-effort and may be duplicated. Entity ids plus the existing
  idempotent persistence rules make cache reconciliation idempotent. A process
  crash can lose an in-memory notification after the database commit, so every
  initial connection and reconnection refetches the current REST snapshots.
  `Last-Event-ID` replay is not promised, and no fake durable cursor or second
  backlog is introduced.

### Resource bounds and failure semantics

`SseEmitter` is a transport primitive, not backpressure. The stream hub must
enforce all of these bounds together:

- a finite global connection cap and a finite per-authenticated-principal cap;
- a finite emitter lifetime/timeout so authorization is re-evaluated on
  reconnect and no connection is immortal;
- a heartbeat interval shorter than that timeout and than any documented proxy
  idle timeout;
- a bounded FIFO per connection, with at most one drain active for that
  connection; and
- a bounded delivery executor. Heartbeat scheduling and mutation threads only
  offer to the FIFO; they never call a possibly blocking socket write.

Queue overflow, executor refusal, send failure, or timeout closes and removes
the connection exactly once. Dropping one data event while continuing to label
the stream live is forbidden: disconnecting forces the client onto the honest
polling path. Connection registration and both caps are atomic, so concurrent
subscribers cannot oversubscribe them. Completion, error, timeout, project
change, application shutdown, and client unmount all release registry counts
and worker resources.

The bounds live under a narrow validated
`groundcontrol.workflow-telemetry.stream.*` `@ConfigurationProperties` object,
registered by the existing application scan. Durations and capacities are
typed, positive, and relation-validated at startup (heartbeat below timeout;
per-principal cap no greater than global cap). Operator-facing environment
bindings must flow through `application.yml`, the production Compose
passthrough, `deploy/docker/env.schema`, `.env.example`, and deployment
documentation as one configuration contract. These values are non-secret and
must not be passed in process argv.

Capacity rejection before the response is committed uses the existing
`GroundControlException` -> `GlobalExceptionHandler` -> `ErrorResponse` path.
After the event-stream headers are committed, an HTTP error envelope is no
longer possible: the hub logs a stable bounded reason and closes the emitter.
Logs may carry project, authenticated principal, safe entity ids, counts, and a
closed disconnect reason; they must not carry cookies, authorization headers,
credentials, event payloads, response bodies, or stack traces from expected
disconnects. Actuator/Micrometer counters and gauges use only bounded reason
tags; project, principal, run id, and branch are not metric labels.

The production topology in ADR-030 is one backend process, so process-local
fan-out is sufficient. A future multi-instance deployment must replace the
internal notification delivery with a broker/outbox or database notification
behind the post-commit change-notification seam; it must not pretend an
in-process hub reaches connections on another node. Any reverse proxy must
disable buffering/compression for this route and keep its read timeout above
the heartbeat interval.

### React Query reconciliation and degraded mode

The browser uses same-origin `EventSource`, so the existing hardened
`GC_SESSION` cookie authenticates the GET without putting a bearer token in a
URL, browser storage, or JavaScript-managed header. The hook owns exactly one
connection for its mounted project and closes it on project change/unmount.

The stream does not create React state that competes with React Query:

- `workflow-run` replaces/inserts by run id in the existing project run-list
  query; `phase-event` reconciles by event id into an existing per-run event
  query when one is present.
- Every committed event invalidates the matching project aggregate queries
  rather than reimplementing database percentile/filter/window logic in the
  browser. Query-key factories are the shared identity for the fetch hooks and
  stream hook.
- The generated OpenAPI response types remain the compile-time contract. The
  stream ingress performs a narrow runtime shape/project check before writing
  to cache; malformed, unknown, or cross-project data closes the stream and
  triggers REST reconciliation rather than poisoning the cache.
- `onopen` marks the view live and invalidates the project snapshots to close
  the subscribe/fetch race. `onerror` marks it degraded and enables the
  existing 30-second `refetchInterval`; a later successful reconnect disables
  interval polling again. Poll success does not claim that push is live.
  The UI exposes at least `Live`, `Reconnecting`, and `Polling` states instead
  of presenting last-reported data as current.

### Testing and non-goals

Controller slice coverage owns the endpoint media type, project resolution,
pre-commit error envelope, and response shapes. Security-enabled tests own
anonymous rejection and bearer/session access. Hub tests use controllable sinks
and schedulers to prove project isolation, atomic caps, heartbeat, exactly once
cleanup, ordering, overflow disconnect, and that one slow/failing client cannot
retain unbounded memory or prevent another client receiving an event. Service
tests pin after-commit publication and no publication on rollback. Frontend
tests pin connection cleanup, cache-key reconciliation, reconnect refetch, the
visible degraded state, and polling only while degraded.

This amendment does not add WebSocket/WebFlux infrastructure, cross-project or
admin streams, durable SSE replay, a message broker, a second telemetry schema
or cache, workflow control/signalling, run leases/stale-run reaping, or
multi-tenant project membership. Reconsider the transport only if measured
event volume, bidirectional control, or multi-instance delivery invalidates the
single-process, low-volume SSE assumptions.

## Amendment (issue #1437, 2026-07-30): bounded Live Activity projection

The console gains a project-scoped Live Activity workspace over the existing
ADR-061 store. It is an operations read model, not workflow control and not a
replacement for the historical Workflow Runs reporting page.

`GET /api/v1/workflow-runs/activity?project={identifier}` returns one bounded,
server-timestamped snapshot. Open rows are runs whose recorded state is
`RUNNING`, `READY_FOR_REVIEW`, or `ESCALATED`; the response includes the total
open count and a truncation flag when the configured row cap is reached. A
second bounded band contains recently terminal runs so a transition does not
make the run disappear, and the complete record remains reachable through
`GET /workflow-runs`.

For every returned open run, the database selects the latest ADR-061 lifecycle
event, the latest ADR-036 routing observation, and the latest event for each
catalogued station in project-scoped batch queries. Observation time followed
by stable event id defines "latest"; cycle index is reported, not used as event
recency. The run-level current cycle comes only from that latest lifecycle
event; station-local attempt cycles are never combined into a synthetic run
cycle. The station catalogue remains the authority for ordering and display
names. A `STARTED` station event is shown as executing only while it is that
station's latest observation. Terminal station rows carry their explicit
`stationResult`, duration, cycle, persisted finding count, and
`findingsDropped`; no browser-side station catalogue or inferred verdict is
introduced. Every station in the current catalogue appears in the strip; one
with no durable attempt is explicitly `UNOBSERVED` with nullable event/time
facts instead of being omitted or fabricated.

The response includes `asOf` and the effective threshold for each open row.
The browser advances one clock from that server timestamp and may flag a row
after no lifecycle transition has been observed for the configured duration.
This is an attention flag only. It does not mutate the run, prove a process is
alive or dead, create a lease, reap stale rows, or turn a paused
`READY_FOR_REVIEW`/`ESCALATED` state into a running-state claim. Missing phase,
route, or timestamp facts render as unobserved.

Bounds live under validated
`groundcontrol.workflow-telemetry.activity.*` configuration:
`stall-threshold`, `max-open-runs`, and `recent-runs`. The existing
project-scoped SSE event shapes are unchanged; either event invalidates the
activity snapshot, while connection/reconnection refetches and the existing
30-second degraded polling path preserve the best-effort delivery semantics.
The route inherits the existing authenticated project-scoped API boundary and
adds no cross-project or anonymous access surface.

## Relationship to other ADRs

- **ADR-028** (Temporal boundary, superseded #1359): originally specified
  Temporal Visibility as the eventual source of truth; per the amendment
  above, this model's `ISSUE_THREAD` provenance is now the permanent path,
  not a projection of a Temporal system that was never built.
- **ADR-029** (issue-thread gate model): issue-thread records remain the durable
  workflow/audit record during the bridge; this surface reads from them, it does not
  replace them.
- **ADR-036** (per-step JSONL telemetry): distinct scope, local bridge economics
  measurement, not the product source of truth.
- **ADR-059** (MCP tool usage telemetry): the persistence/aggregation precedent
  (append-only, DB-side aggregation, no Envers). Distinct scope: one counts MCP tool
  calls, this explains run/phase/gate outcomes and economics.
- **ADR-026** (REST access control): endpoints inherit the bearer/session chain; the
  cross-project rollup is additionally `ROLE_ADMIN` in `ApiPathMatrix`.
- **ADR-035** (MCP tool catalog): the two project-scoped read paths join the
  `gc_query` allowlist + README/ADR drift surfaces.
- **ADR-084** (context-graph authority and time): requires the ontology bindings,
  audited projection sources, and Envers revision semantics adopted by the
  issue #1311 amendment.
