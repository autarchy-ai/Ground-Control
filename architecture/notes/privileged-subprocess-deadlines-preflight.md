# Privileged Subprocess Deadlines Preflight

Issue: #1720
Requirement: none

This note records the boundaries for deadline and process-tree containment in
the privileged Incus and integration paths. It is not an implementation plan.

## Decisions

### One owned-process primitive per runtime, used before a lock is released

The Python Incus surface needs one shared fixed-argv runner used by
`helper.py`, `transfer.py`, `task_environment.py`, and `probe.py`. It must
start a new POSIX session/process group, enforce a finite monotonic wall
deadline, drain or deliberately suppress output as each caller does today,
and terminate the whole group TERM-to-KILL with a bounded grace period. A
`subprocess.run(..., timeout=...)` direct-child timeout is insufficient: it
does not establish or reap a descendant group. Its timeout exception must
carry only bounded, non-secret execution facts.

The existing Node process-group primitive is the incumbent for the other
runtime: `terminateProcessGroup` in `mcp/ground-control/lib/process-group.js`.
Extend the existing gate/integration execution seam to accept a finite timeout
and make timeout, abort (where a caller has an `AbortSignal`), leader exit,
and ordinary failure use that one cleanup path. Do not create a second
integration-only reaper or a completion-shell-specific runner. The
integration `defaultExecFile` boundary and its deliberate `bash -c
<completion_command>` invocation must both receive the same bound; fixed Git
and GitHub argv stay argv-based.

The existing model-specific `execFileWithInput` remains the owner of model
stdin, output buffering, and model environment semantics. This work reuses its
process-group policy, not its model-only input contract.

### Timeouts are host/root policy, not caller or repository policy

Incus operation deadlines and a default must be a closed, versioned,
root-owned `SandboxConfig` policy. The strict parser, root ownership and mode
checks, and upgrade/example/documentation path must evolve together. Accept
only a small fixed operation vocabulary; require positive integer durations,
a finite upper bound, and overrides no larger than that upper bound. Unknown,
zero, negative, boolean, malformed, or excess values fail configuration
validation; they never mean "unlimited." No sandbox CLI, packet, task frame,
or repository declaration can select a deadline.

The integration/completion deadline is server-owned configuration with a
finite validated default and upper bound. It is not a new MCP input and not a
`.ground-control.yaml` workflow field: a repository-authored completion
command may choose what it runs, but not remove the server safety cap. Keep
the current `.ground-control.yaml` parser and its closed workflow vocabulary
unchanged unless an already-existing server-host configuration seam requires a
validated extension.

### Recovery state is domain state, not a PID registry

A timeout is a failed operation. Existing `LifecycleHelper._mutate` rollback
and allocation persistence remain authoritative: a timed-out create restores
the prior allocation and deletes only the instance created by that invocation;
a timeout in a release/stop/delete path must not claim success or erase state
that has not been durably reconciled. Task start records state only after its
guest command succeeds, and its existing compensating stop remains the
recovery behavior if persistence fails. Transfer keeps its `state_lock` and
only records/clears bindings at its existing success boundaries.

The process helper must not introduce a PID file, durable process registry,
new lease schema, or background reaper. Holding `flock`/`state_lock` through a
bounded call is intentional; cleanup completes before the lock is released,
so a competing lifecycle or task request observes either the old durable state
or the completed rollback, never a still-running child tree.

### Preserve redaction and closed event/error vocabularies

`EventWriter` is the Incus observability contract. Add a bounded timeout
outcome/error code only by extending its allowlisted `_ERRORS` and tests; do
not log argv, child output, environment, task frame, source packet, provider
path, or exception text. Keep the existing action, outcome, duration, and
rotation constraints. Duration continues to use `time.monotonic()`.

At the MCP boundary, use `formatCommandFailure`, bounded command diagnostics,
`detectSensitiveBodyContent`, and integration `errorEnvelope`/`safeSummary`.
A timeout may identify a stable code, executable class, elapsed timeout, and
grace period, but never a repository command body, stdout/stderr transcript,
or environment. Preserve existing non-timeout error envelopes rather than
adding a parallel exception hierarchy.

## Cross-Cutting Contracts

- **Incus authorization and input validation:** closed action/name grammar in
  `helper.py`; root-owned `SandboxConfig`; packet and task-frame schemas;
  `state_lock`; no caller-controlled executable or argv. Deadline policy is
  validated after config ownership checks and before execution.
- **Persistence and recovery:** `allocations.json` guarded by `flock`, source
  binding/task-state atomic writes, and the existing rollback/compensation
  paths. No timeout may be converted into a success merely because an outer
  polling loop expired.
- **OS boundary:** POSIX process-group/session ownership is required for
  descendant cleanup. As in the existing Node model primitive, an unsupported
  platform must fail closed or provide a tested equivalent; do not silently
  kill only the leader. Bounded TERM-to-KILL escalation must tolerate an
  already-empty group but surface other cleanup failures in bounded form.
- **Integration configuration and commands:** `parseGroundControlYaml` and
  `normalizeIntegrationManagerConfig` stay responsible for repository
  workflow shape; `defaultExecFile` owns privileged integration execution;
  `runCompletionGate` remains the only shell exception. No untrusted command
  text moves into argv beyond the already-authorized `bash -c` operand.
- **Tests:** existing Python `unittest` runner injection and Node dependency
  injection are the seams. Use real stalled executable/daemon fixtures that
  create a descendant, plus a concurrent lifecycle/task request blocked on
  the same lock. Assert descendant death, elapsed bound, final allocation/task
  state, allowed diagnostic/event content, and a subsequent competing request
  making progress. Retain a defensive fixture cleanup path.

## Extensibility Seam

The Python runner takes a validated policy value selected by a fixed operation
class, rather than each call site embedding a duration. The obvious next
operation can be added to that closed map with parser validation and tests,
without changing public command or packet schemas. Node execution accepts a
server-owned timeout option at the shared execution boundary, allowing future
privileged fixed-argv operations to opt in without duplicating tree cleanup.

CPU/memory quotas, parent-death guarantees, and daemon-side cancellation are
different host/Incus/systemd concerns. They may compose with this wall deadline
later, but must not be implied by or implemented as shell wrappers around it.

## Non-Goals and Anti-Patterns

- No new MCP input, `.ground-control.yaml` deadline key, caller override,
  repository-controlled process policy, PID registry, async job type, or
  workflow/issue-thread marker.
- No direct-child-only timeout, unbounded grace wait, polling deadline that
  leaves the child alive, `unref`, detached process without group reaping, or
  silent cleanup failure.
- No duplicated Python `TimeoutError` hierarchy, ad hoc per-call timeout
  constants, duplicate configuration validator, or a separate completion
  runner.
- No relaxation of fixed argv, task/packet validation, root-owned config,
  secret redaction, event schema, allocation lock, task lock, or integration
  error envelope.
- No change to unrelated guest bootstrap/image/registry operations unless the
  implementation demonstrates that they traverse the same privileged,
  lock/lease-holding execution boundary in this issue's scope.

## Resolution

- **Python.** `tools/incus_sandbox/owned_process.py` (`run_owned`) is the one
  primitive. The lifecycle helper (including rollback and the delete
  reconciliation), transfer, the task runner, the template build (with each
  agent probe bounded by the remaining wait), registry import and export, and
  `probe.py` all use it. The allocation store moved to `allocations.py` so
  `helper.py` stays under the file-size limit. Deadlines are `SandboxConfig.deadlines`, with v4
  `deadline_seconds` overrides. The build and registry calls were included
  because they are the same root-run Incus boundary. A direct-child timeout there
  left a descendant able to hold the pipes indefinitely.
- **Node.** `runGateCommand` requires a finite `timeoutMs`. `lib/bounded-exec.js`
  holds the server-owned `GC_COMMAND_TIMEOUT_MS` and `GC_GATE_TIMEOUT_MS`
  bounds, `execFileBounded` (built on `execFileWithInput`), and
  `runBoundedGateCommand`. Integration's `defaultExecFile` and its completion
  gate (`deps.runGate`) use them. The `/implement` publish lease has the same
  shape of defect: its pre-commit hook, Git commands, base synchronization, and
  recovery ran through unbounded `execFile`. Those defaults now use the bounded
  wrappers, and pre-commit keeps only a bounded output tail.
