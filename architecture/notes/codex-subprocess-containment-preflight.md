# Codex Subprocess Containment Preflight

Issue: #1518
Requirement: none

This note records the architecture boundaries for repository-scoped Codex
execution and descendant cleanup. It is not an implementation plan.

## Decisions

### Keep working-directory selection, read scope, and OS isolation distinct

The canonical repository root returned by `ensureGitRepo` is the only search
scope for architecture preflight. `buildCodexArchitecturePreflightPrompt` must
state that repository-wide inspection means the current repository only: use
the working directory or repo-relative paths, and never recursively search
`/`, a parent directory, a home directory, `/proc`, or another checkout.
Tests must pin that contract.

`codex exec -C <repo> --sandbox workspace-write` does not enforce that read
scope. `-C` selects a working directory, and `workspace-write` constrains
writes; neither prevents a model-issued read from traversing the host. The
prompt rule is therefore a guard against accidental unscoped inspection, not a
host confidentiality boundary. Do not describe it as a sandbox guarantee or
add a second path validator that cannot see model-generated command arguments.
Strong read confinement would require a separately operated OS/container
permission profile that exposes the repository plus the minimum Codex runtime
and authentication material. That is a future hardening boundary, not a claim
this maintenance fix can make through prompt text.

Preflight retains `workspace-write` because it may update ADRs or design notes.
Read-only Codex review and finding verification retain their existing
`read-only` mode. Sandbox mode and repository search scope are separate
concepts even though all three entry points share the same process-lifecycle
rules.

### The MCP server owns the complete model subprocess tree

`execFileWithInput` is the canonical bounded model-process primitive. A timed
or cancellable model invocation must run in a dedicated POSIX process group
that does not include the MCP server. Timeout, `AbortSignal`, direct-child
failure, and direct-child success must all leave no descendants owned by that
invocation. Graceful termination signals the group once, waits the existing
bounded grace period, and escalates the same group to `SIGKILL` if anything
remains. An already-empty group is success; any other signalling failure must
remain visible in bounded diagnostics rather than being silently treated as
cleanup.

Do not pass cancellation only to Node's direct-child `execFile` handling and do
not implement separate timeout, abort, and Codex-specific kill functions.
Those paths are one lifecycle state machine in `execFileWithInput`. Preserve
the existing error distinction: timeouts remain `ETIMEDOUT`, aborts remain
cancellations, and ordinary command failures remain ordinary failures. The
async job registry uses that distinction but does not own OS processes.

Process-group isolation is not async-job detachment. The child remains awaited
and must not be `unref()`'d. The intentionally detached knowledge-ingest
launcher in `defaultSpawnIngest` is a different ownership model and must not be
folded into this change. Likewise, ordinary fixed-argv `execFile` calls for
bounded Git/GitHub reads and writes do not acquire model-runner semantics.

Ground Control and its CI run on Linux, and POSIX group signalling is the
supported contract for this boundary. A platform that cannot provide
equivalent tree termination must fail closed for group-owned model execution
or supply a tested native equivalent; it must not silently fall back to killing
only the leader.

### Treat stdin closure and output limits as one subprocess lifecycle

For issue #1719, `execFileWithInput` also owns errors from the child's stdin.
Attach the stdin error listener before sending the prompt, and retain it until
the stream is closed; an early `EPIPE` must not become an unhandled event in the
MCP server. A synchronous prompt-write failure belongs to the same cleanup
path. A failed prompt delivery cannot report success. Preserve an already
established timeout, abort, overflow, or nonzero child exit as the primary
failure instead of replacing it with a secondary pipe error. Settle once, after
the existing child/stream completion and process-group cleanup boundary; do not
create a second stdin-specific reaper or error hierarchy.

`maxBuffer` is a per-stream byte limit for stdout and stderr. Filling a limit
exactly is allowed, including with a zero-byte limit; the next byte must take
the existing `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` path. Count bytes from the
pipe before UTF-8 decoding and bound retained bytes, rather than slicing a
decoded JavaScript string by character count. Keep the surfaced output as
strings and avoid exposing a partial UTF-8 character at a truncated boundary.
Continue draining both pipes while termination and cleanup complete. Preserve
the first terminal cause when a later stream event, abort, or timer fires.

### Keep a finite host-owned wall cap

`DEFAULT_CODEX_TIMEOUT_MS` and the per-call `timeoutMs` option are the existing
wall-time seam. Once they terminate the process group, the cap applies to the
work that consumed the host rather than only to the `codex` leader. The timeout
is execution-layer safety, distinct from the MCP client request timeout, async
job terminal-retention TTL, review-cycle cap, and non-verdict retry limit.

`GC_CODEX_TIMEOUT_MS` is host configuration, not repository policy. Its parser
must not let zero, a negative value, malformed input, or an excessive value
disable the safety cap; invalid values fall back to the finite default, and a
finite upper bound remains enforced. Do not add an MCP input or
`.ground-control.yaml` field that lets an untrusted repository or caller raise
or disable this host limit.

A process group does not impose an aggregate CPU quota and cannot clean up if
the MCP server itself is killed before it can signal the group. A cgroup,
service manager, or external watchdog can add those guarantees later at the
host launcher boundary. Do not approximate them with shell interpolation,
per-command `ulimit`, a repository-supplied wrapper, or a claim that the
JavaScript timer survives its own process.

## Canonical Incumbents

- **Process lifecycle:** `execFileWithInput`, `DEFAULT_CODEX_TIMEOUT_MS`, its
  existing TERM-to-KILL grace period, and `formatCommandFailure` in
  `mcp/ground-control/lib/runtime-primitives.js`. Extend this seam; do not add a
  preflight-only process runner.
- **Codex launch surfaces:** `runCodexArchitecturePreflight` and
  `runCodexVerifyFinding` in `mcp/ground-control/lib/codex-verify.js`, plus
  `runSingleCodexReview` in
  `mcp/ground-control/lib/grc-legacy-compat-4.js`. Their fixed argv builders,
  prompt-on-stdin behavior, bounded buffers, temp-output cleanup, and sandbox
  modes remain authoritative.
- **Repository and configuration validation:** the preflight tool's Zod input
  shape, `ensureGitRepo`, `getRepoGroundControlContext`, the strict
  `.ground-control.yaml` parser, repo-relative path/realpath guards, and the
  untrusted-vocabulary delimiters. The canonicalized root, not the caller's raw
  string, is the scope named to Codex.
- **Cancellation:** `startAsyncJob`, `cancelAsyncJob`, and the existing
  `AbortSignal` path in `mcp/ground-control/lib/async-job-registry.js`.
  Cancellation is not complete until the model process tree is gone; the
  registry must not duplicate child ownership.
- **Errors and secret handling:** existing MCP `ok`/`err` envelopes,
  `formatCommandFailure`, async-job error bounding/scrubbing, and
  `detectSensitiveBodyContent`. Process diagnostics may include a stable
  failure code, executable label, timeout, signal, and grace duration, but not
  prompts, model output, repository contents, raw environment, or tokens.
- **Observability and workflow record:** the async job's bounded elapsed time,
  existing tool telemetry, and the preflight issue-thread phase marker. A
  timeout or cancellation writes no successful preflight marker. Process
  groups are runtime machinery, not a new workflow station, persistence
  record, marker family, or telemetry schema.

## Security and Validation Layers

- Zod continues to shape `repo_path`, positive `issue_number`, optional
  requirement/repository identity, and `async`. This issue adds no public
  timeout, command, signal, path allowlist, or environment override.
- `ensureGitRepo` continues to resolve the canonical Git top level before any
  issue lookup, config read, working-tree snapshot, prompt construction, or
  Codex launch. Existing repository-identity checks continue to bind GitHub
  reads and phase-marker writes to that checkout.
- `.ground-control.yaml` remains the only repository context schema. Its strict
  parser and path containment checks remain authoritative, and architecture
  vocabulary remains explicitly untrusted prompt data. No process-safety
  setting belongs in that repository-controlled file.
- Codex argv remains a fixed array containing only CLI options plus the
  canonical repository and server-created temporary output paths. The prompt,
  issue body, vocabulary, and repository content remain on stdin or on disk;
  no shell command or secret is interpolated into argv.
- The Codex child environment must be built once for all Codex launch sites and
  must not forward unrelated host credentials such as GitHub, Sonar, deploy,
  cloud, or Claude secrets. Preserve only the minimum runtime and Codex
  authentication/configuration inputs required by the supported launcher.
  This is a shared engine-environment concern, not three caller-local delete
  lists. Environment minimization reduces direct exposure but does not turn
  `workspace-write` into host read confinement.
- Timeout, abort, and cleanup failures must pass through a bounded error
  envelope. Raw stdout/stderr from a model-controlled process must not be
  concatenated into a tool or async-job error without the existing sensitive
  content and size protections. No new exception hierarchy is needed.

## Extensibility Seam

The reusable seam is model-process ownership in `execFileWithInput`: a finite
wall timeout, graceful signal, grace duration, abort signal, and process-group
cleanup. The next model engine can use the same seam without changing MCP tool
schemas or the async registry. Engine-specific sandbox mode, prompt, output
parser, and minimal environment remain at the engine launch boundary; do not
collapse them into a generic "agent sandbox" configuration object.

An independent CPU/memory quota or parent-death guarantee belongs at a future
host launcher/cgroup seam. It must compose with, not replace, process-group
cleanup and the wall timeout.

## Required Regression Coverage

- A hermetic Node fixture spawns a descendant that outlives or ignores its
  leader. Timeout must terminate the group, exercise TERM-to-KILL escalation,
  return `ETIMEDOUT`, and leave the recorded descendant PID dead.
- The same fixture under `AbortController` must prove async cancellation kills
  the group and reaches the registry's terminal `cancelled` envelope.
- A leader that exits after starting a background descendant must not let that
  descendant survive an otherwise successful or failed invocation.
- Existing success, stdout/stderr capture, omitted-timeout, grace-period, and
  temp-directory cleanup behavior remains covered. Tests must clean up their
  fixtures defensively if the assertion fails so the regression suite cannot
  reproduce the production orphan.
- Real executable fixtures must cover a child exiting before a large stdin
  prompt is consumed, exact-cap output followed by another chunk on each
  stream, and multibyte UTF-8 at the cap. The early-exit case must survive as
  a structured failure with the child's primary cause; overflow must reject
  without returning a successful truncated response. The existing `spawnImpl`
  seam can supplement these fixtures for deterministic event-order assertions.
- Timeout environment parsing covers unset, valid, malformed, zero, negative,
  and excessive values and proves none of the invalid forms disables the cap.
- Prompt and argv tests pin repo-only search guidance, stdin prompt transport,
  canonical `-C`, preflight `workspace-write`, and review/verify `read-only`.
- Environment and error-envelope tests prove unrelated credential variables,
  raw model output, and oversized diagnostics do not reach the child command
  environment or caller-visible failure.

## Non-Goals and Anti-Patterns

- No backend controller, DTO, service, repository, database record, external
  queue, Temporal workflow, process registry, PID file, or new GitHub marker.
- No new MCP field, `.ground-control.yaml` key, timeout schema, polling tool,
  async job kind, review-cycle rule, or persistence contract.
- No prompt-only claim of security confinement, no assumption that `cwd`
  confines reads, and no assertion that `workspace-write` is repo-read-only.
- No direct-child-only kill, silent signal failure, unbounded grace timer,
  `unref()` for awaited model work, or use of `detached: true` without group
  cleanup semantics.
- No shell wrapper, interpolated command, repository-provided resource limit,
  or per-caller clone of timeout/abort/kill logic.
- No broad cleanup of stale MCP server processes. The operational housekeeping
  noted in issue #1518 is separate from the model child-tree defect.
