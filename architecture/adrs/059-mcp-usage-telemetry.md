# ADR-059: MCP Tool Usage Telemetry

## Status

Superseded (issue #1303)

## Date

2026-06-14

> **Supersession (2026-09-11):** The backend persistence and aggregation
> authority was removed by #1500. Issue #1303 deletes the remaining MCP handler
> wrapper and backend adapter instead of preserving a fail-open write with no
> live owner. There is no replacement measurement surface, and no workflow gate
> consumes this historical telemetry contract.

## Context

Operators of Ground Control's MCP adapter have no way to observe which tools
are called, how often they succeed or fail, or how long they take. Without
this signal it is hard to prioritise catalog improvements, catch regressions
in specific tools, or validate that the fail-open capture path is working
correctly.

ADR-035 established the MCP tool catalog. ADR-036 covers per-step workflow
telemetry (`.gc/telemetry/*.ndjson` JSONL for cost accounting). This ADR
addresses a separate problem: operational product telemetry for the
deployed MCP adapter; one counter per tool call, not one counter per
workflow step.

## Decision

### 1. Capture at the handler boundary, not inside `request()`

Instrumentation belongs in the wrapper installed by `installToolTelemetry`
in `mcp/ground-control/telemetry.js`, called once immediately after
`const server = new McpServer(...)` and before any tool registration.
Capturing inside `lib.js request()` would count backend calls (which can be
many per tool call) and would risk telemetry-write recursion. Exactly one
event per MCP tool call is the invariant; the handler wrapper enforces it.

### 2. Backend is the persistence and aggregation authority

The MCP server POSTs a closed event DTO through the existing REST/auth/error
path (`buildUrl` + `addAuthorizationHeader` + `parseErrorBody` from
`lib.js`). The backend owns the database row, indexes, and the aggregation
query. The MCP server never writes local JSONL for this purpose and never
performs client-side aggregation. The two new endpoints are:

- `POST /api/v1/mcp-tool-usage/events`: capture one event (201 on success);
  reachable by any authenticated session so every tool call can record.
- `GET /api/v1/mcp-tool-usage`: read aggregated statistics for a window;
  ROLE_ADMIN only, because the aggregate is cross-project operational
  telemetry an ordinary authenticated caller must not read.

### 3. Closed event shape

The event carries exactly `{tool, action, outcome, duration_ms, project, ts}`
and nothing else. Prompts, request bodies, response bodies, exception
messages, bearer tokens, stack traces, paths, headers, and any
secret-shaped values are excluded at the MCP layer before the POST and
rejected by the backend DTO validation layer.

- `tool`: registered MCP tool name
- `action`: stable action discriminator for consolidated tools (null for
  single-action tools)
- `outcome`: `"ok"` or a stable error code sourced from
  `result._meta["groundcontrol/outcomeCode"]` when `result.isError === true`
- `duration_ms`: wall-clock latency around the original handler only;
  non-negative; telemetry write latency excluded
- `project`: top-level declared `args.project` (string or null; never
  inferred from nested payloads)
- `ts`: ISO 8601 capture timestamp

### 4. Fail-open

A telemetry write failure (network down, auth rejected, schema error) must
never change or suppress the original tool result. `recordToolEvent` wraps
the POST in a try/catch and returns without throwing. Warning logs emit only
`tool`, `outcome`, and a failure class string; no payload, no bearer
material, no stack traces.

### 5. Append-only table, no Envers audit

The `mcp_tool_event` table is operational telemetry that is never mutated
after insert. Adding an Envers `_audit` shadow would be misleading (audit
history of immutable rows is vacuous) and wastes storage. The migration
(V135) creates only the live table plus indexes optimised for the aggregation
access pattern: `(event_ts)` and `(event_ts, tool)`.

### 6. Aggregation runs in the database, window policy in the service

Counting, error counting, and percentile computation run in the repository
query (`McpToolEventRepository.aggregateByEventTsBetween`): a single
`GROUP BY tool` over the window with `COUNT(*) FILTER` and `percentile_disc`,
returning one already-aggregated row per tool. The service maps those rows and
derives the error rate; it never materializes the raw event window in JVM
memory, so the read scales with the `(event_ts, tool)` index even as the table
grows. The default aggregation window (24 hours) and maximum allowed window (31
days) are named constants in `McpTelemetryService`, and the percentile set
(p50/p95/p99) is fixed in the query. MCP caller code and documentation
reference the endpoint contract; they do not duplicate these policy values.

### 7. `gc_query` allowlist and drift surfaces

The aggregation GET path (`/api/v1/mcp-tool-usage`) is added to
`GC_QUERY_PATH_ALLOWLIST` in `gc-query.js`, the drift-check README block,
and this ADR's prose so the `gc-query.test.js` drift tests stay green. The
POST capture path is intentionally NOT in the allowlist; it is an internal
write operation, not an agent read.

## Consequences

**Positive:**
- Operators gain per-tool call counts, error rates, and p50/p95/p99 latency
  over any window up to 31 days via a single read endpoint.
- Capture is transparent to callers: no API surface change, no tool
  signatures changed, fail-open so availability is unaffected.
- The closed event shape is an explicit information-disclosure boundary;
  leaking prompts or payloads into telemetry requires a deliberate code
  change that can be detected in review.

**Negative / risks:**
- `installToolTelemetry` monkey-patches `server.tool` and
  `server.registerTool`. A future MCP SDK change that adds new registration
  methods would require a patch to the wrapper.
- Append-only rows grow without bound. Operators must plan a retention or
  partition strategy if long-term history accumulates at high call volume.
  This is deferred to a follow-on issue.

**Out of scope:**
- OpenTelemetry or Prometheus scrape integration.
- Change to ADR-036 JSONL step telemetry.
- Client-side (agent-host) local telemetry replacement.
- Catalog weight analysis or drift detection consuming the aggregate.

## Relationship to other ADRs

- ADR-035: tool catalog curation; this ADR adds the `/api/v1/mcp-tool-usage`
  read prefix to the gc_query allowlist.
- ADR-036: per-step step telemetry JSONL; distinct scope (workflow economics
  versus operational product telemetry).
- ADR-026: REST API access control; telemetry endpoints live under
  `/api/v1/**` and inherit the existing auth chain; the aggregate read
  (`GET /api/v1/mcp-tool-usage`) is additionally gated to ROLE_ADMIN in the
  shared `ApiPathMatrix`, with the MCP admin-token routing updated to match.
