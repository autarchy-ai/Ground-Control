# Terminal Wait for Shared Async Jobs Preflight

Issue #1669 removes model-turn polling from the existing shared async-job
transport. This note is architecture guidance only; it neither implements the
wait nor changes workflow behavior by itself.

## Binding Contract

- Extend the existing `gc_codex_job` / `async-job-registry.js` transport. Add a
  terminal-wait operation beside the current immediate `poll` and `cancel`
  operations; do not add a caller-specific watcher, registry, job kind, queue,
  worker, or durable job record.
- A terminal wait observes the same bounded opaque `job_id` and returns the
  same terminal envelope that `poll` would return. It must preserve the
  distinction between a completed job whose unchanged `result.ok` is `false`
  and a transport-level `failed` or `cancelled` job. It must not translate,
  flatten, re-run, or publish the originating action.
- The registry, not a workflow skill, owns the wait. It must resolve an
  outstanding wait when that in-memory job reaches any terminal state, and
  return immediately for an already-terminal or unknown handle. Do not replace
  agent polling with another server-side status-poll loop; use the job's
  terminal-completion notification so waiters do no repeated work.
- Keep `poll` as the immediate observability operation and `cancel` exactly as
  it is. A terminal wait neither grants cancellation nor changes the current
  truthful `job_not_cancellable` response for mechanical/review-cycle jobs.
- Bound every wait. The one public timing seam, if one is needed for transport
  recovery or clients with shorter request limits, is a Zod-validated bounded
  wait duration with a server-owned default and maximum. Its expiry returns the
  ordinary running envelope while the job continues; it is not an action
  deadline, job TTL extension, retry, cancellation, or success result. The
  default must cover the existing bounded Codex and remote-gate job durations
  under the supported MCP client timeout without a new `.ground-control.yaml`
  or environment setting.
- Jobs remain process-local operational state: process restart and terminal-TTL
  expiry still yield `job_not_found`, with the existing originating-tool
  recovery contract. A waiting request must not make a job restart-durable or
  keep a terminal result beyond the 30-minute retention policy.

## Cross-Cutting Guardrails

- Reuse `ASYNC_JOB_ID_MAX`, `ASYNC_JOB_ID_RE`, `_asyncJobEnvelope`, terminal
  reaping, `detectSensitiveBodyContent`, `boundFailureMessage`, and
  `boundFailureDiagnostics`. The wait input receives the same bounded,
  shape-checked handle as poll/cancel and exposes no raw output, stack, argv,
  environment, token, or arbitrary caller text.
- The MCP registration remains a Zod schema plus a thin handler. Keep the
  registry's options and originator-specific validation authoritative; waiting
  must not bypass repository authorization, idempotency, single-flight,
  requirement binding, issue-thread reconciliation, or action dispatch.
- Preserve handler-level MCP telemetry for a terminal-wait call, but do not add
  a station, lifecycle marker, workflow phase, telemetry schema, or issue-thread
  record. Waiting is transport observation, not a new execution event.
- Update every user-facing contract that currently prescribes repeated
  `gc_codex_job` polling: the live tool description/schema test, MCP README,
  `/implement` and `/quickfix` workflow prose, `docs/DEVELOPMENT_WORKFLOW.md`,
  and the ADR-036/ADR-021/ADR-054/ADR-090 documentation cluster. Retire the
  cadence wording, not the async start/idempotency/recovery rules.

## Required Coverage

- Registry tests must prove immediate terminal return, wait through each
  terminal state, bounded wait expiry while the job remains running, race-safe
  completion at wait registration, multiple waiters, unknown/expired handles,
  and no retention or cancellation semantic change.
- Live MCP-schema/description tests must prove the new operation and any timing
  field are bounded and documented. Existing preflight, review-cycle, and
  mechanical transport tests must prove their exact result envelopes and
  idempotency behavior survive a terminal wait.
- Workflow/documentation checks must prove all standard long-job consumers use
  the terminal-wait operation; no prescribed fixed-cadence model polling may
  remain.

## Non-Goals and Anti-Patterns

- No longer general MCP client timeout, no unbounded request, and no caller- or
  repository-controlled job execution timeout.
- No backend/database/DTO/controller/service/repository, external queue,
  Temporal activity, local state file, WebSocket/SSE channel, progress stream,
  callback URL, or new persistence model.
- No duplicate result schema, validation layer, exception hierarchy, remote-gate
  watcher, or workflow loop; no busy polling hidden inside the MCP server.
- No changes to Codex subprocess caps, CI/Sonar watcher semantics, workflow
  gates, review caps, durable GitHub records, or cancellation guarantees.
