# Host-Wide Verification Dispatcher Preflight

Issue #1566 adds host resource admission around existing verification commands.
The dispatcher is an execution wrapper, not a new verification authority: the
configured completion, policy, pre-commit, and targeted-test commands retain
their current meanings, ordering, and failure semantics.

## Boundary decisions

- Install one agent-neutral `gc-test-dispatch` executable as a real host copy
  through a new general Ground Control host installer. The general installer
  delegates skill installation to `bin/install-skills.sh`; that script remains
  supported and does not acquire a second implementation of its overwrite,
  force, dry-run, or target-selection rules. Do not install the dispatcher from
  `scripts/bootstrap-claude-workflow.sh`, which is Claude-specific.
- Keep the dispatcher daemonless. Independent checkouts, repositories, agent
  drivers, and MCP processes owned by one user coordinate through one
  per-user, host-runtime directory. The installed copy must not symlink back to
  a checkout: changing or deleting that checkout must not change a command
  already used by every repository on the host.
- Treat capacity and maximum queue wait as host configuration. Prefer an
  explicit, owner-controlled Ground Control config under the user's standard
  config directory; when it is absent, derive the CPU default from the host's
  effective affinity/cpuset rather than raw machine CPU count. A repository or
  invocation must not be able to replace total capacity or the queue bound.
- Treat profile name, requested CPU demand, minimum acceptable grant, and the
  xdist-environment opt-in as workload declarations. They belong to dispatcher
  arguments inside an existing `workflow.test_command`,
  `workflow.completion_command`, `workflow.policy_command`, or
  `workflow.precommit_command`. No new `.ground-control.yaml` field is needed.
  `parseGroundControlYaml` remains the only YAML parser, and the dispatcher
  must not read repository YAML itself.
- Execute the argv after `--` without shell reconstruction, rewriting, caching,
  or substitution. The child inherits stdin, stdout, and stderr. Dispatcher
  diagnostics use a clearly prefixed, bounded stderr record; stdout remains the
  child's stream. Never persist command argv, cwd, environment, or output.
- Model admission as integer CPU capacity, not a global suite count. A queued
  entry has `minimum <= requested`; strict FIFO admission grants up to the
  request when at least the minimum fits, then admits later work from remaining
  capacity. Grants are not revoked or resized after execution begins. Keep the
  scheduling decision as a pure, tested seam so a future weighted-fair policy
  can replace FIFO without changing installation, state, or command execution.
- Set `PYTEST_XDIST_AUTO_NUM_WORKERS` to the granted integer only when the
  workload explicitly opts in. Do not infer pytest or `-n auto` by inspecting
  command text, and do not alter the environment of non-xdist commands.

## Runtime state and process semantics

The host state is a capacity ledger, not the repository-scoped exclusive lease
implemented by `mcp/ground-control/lib/filesystem-lease.js`. Reuse that module's
principles: canonical directory, interprocess lock, stale recovery, and
idempotent release. Do not stretch `proper-lockfile` into a weighted scheduler or add a
dependency from the installed executable to one checkout's `node_modules`.

Hold an OS advisory lock only while reading, cleaning, scheduling, and
atomically replacing the ledger. Never hold it for the duration of a test run.
Queue and running records need an opaque ticket, sanitized profile, demand,
grant, enqueue timestamp, and a Linux process identity that resists PID reuse
(PID plus `/proc` start token). State contains no repository or command data.
Malformed state must fail closed or be recovered under the lock; silently
resetting live leases can oversubscribe the host.

Eliminate the spawn/lease crash window. A child must not execute until its
running lease is durable. A POSIX fork/pipe handshake is a suitable shape: the
child blocks before `exec`, the parent records the child's PID/start token and
process group, and only then releases the child; parent death before release
causes the child to exit. If the supervisor dies after release, the live child
keeps the lease valid until stale cleanup observes that the process identity is
gone.

The supervisor forwards catchable signals to the child's process group, waits
for descendants, releases the lease in `finally`, and then terminates with the
same exit status or signal as the requested command. Queue cancellation removes
the queued ticket. `SIGKILL` cannot run cleanup, so stale recovery is part of
normal correctness, not a best-effort maintenance path. Tests must cover the
supervisor-crash/live-child case as well as ordinary stale records.

Queue wait is bounded by host policy. On expiry the command is not run and the
wrapper exits distinctly. On every terminal outcome, emit bounded integer
measurements for queue duration, execution duration, requested capacity, and
granted capacity plus the sanitized profile and outcome. These are local
operational diagnostics, not ADR-029 issue-thread records, ADR-036 model-step
telemetry, verification attestations, or a success cache.

## Cross-cutting contracts to reuse

- **Configuration:** existing command fields, `parseGroundControlYaml`,
  `normalizeWorkflowConfig`, strict unknown-key rejection,
  `emptyWorkflowConfig`, `resolveWorkflowPolicyCommand`,
  `resolveWorkflowPrecommitCommand`, and
  `gc_get_repo_ground_control_context`. Consumer documentation wraps commands;
  skill prose does not parse or validate dispatcher configuration.
- **Workflow:** GC-O007, ADR-021, and ADR-027 preserve Step 5 targeted-test
  scope, the meaningful-tree completion/policy boundaries, mandatory local
  pre-commit, and independent CI/Sonar authority. `runImplementCompletionPolicyGates`
  remains the single MCP composition of completion and policy. The dispatcher
  wraps the configured commands; it does not become another gate phase.
- **Process behavior:** use the invariants tested by `runGateCommand` and
  `process-group.js`—stream draining, bounded diagnostics, descendant
  containment, terminating-signal reporting, and bounded escalation. Do not
  directly reuse `runGateCommand`: it intentionally retains only output tails,
  whereas a user-facing dispatcher must inherit the command's stdio.
- **Installation:** preserve `bin/install-skills.sh` as the canonical skill
  installer and its managed-target, `--force`, and `--dry-run` behavior. Follow
  the copied-host-runtime rationale already used for user-level Claude hooks,
  while keeping the new general installer agent-neutral.
- **Errors and observability:** use stable, bounded outcomes and nonzero exit
  statuses; never introduce an exception hierarchy or an MCP/GitHub error
  envelope for this local CLI. `formatCommandFailure` and the MCP async-job
  envelope remain MCP concerns, not dispatcher output schemas.
- **Tests and policy:** executable behavior belongs in focused host-process
  tests under the existing Python `unittest` policy-test surface (or the Node
  MCP suite only if the executable is implemented in Node). Installation tests
  use temporary HOME/XDG directories. The implementation still runs
  `make mcp-test` for its inner loop and `make policy` before completion.

## Security and validation layers

- **CLI shape:** reject unknown options, a missing `--` command, empty or
  control-character profile names, non-integer or out-of-range demand, and
  `minimum > requested` before registering work. Keep one parser and one
  normalized workload shape.
- **Repository config shape:** the existing strict YAML parser validates that
  wrapped workflow commands are non-empty strings. Dispatcher-specific values
  are then validated by the dispatcher's CLI; these are complementary layers,
  not duplicate schemas. Repository command fields remain trusted, reviewed
  code per ADR-027 and must not contain credentials.
- **Host config and state:** accept only regular files/directories owned by the
  current UID; reject unsafe permissions, symlinks, and unexpected types. Use a
  mode-0700 runtime directory and mode-0600 files, no predictable shared path
  without an ownership check, atomic replacement, and an advisory lock. Do not
  expose a repository-controlled `--state-dir` or `--capacity` production flag.
- **OS/process exposure:** pass command arguments as argv with `shell=False` (or
  direct `execve`), never join them into `bash -c`; do not place secrets in
  dispatcher arguments, state, metrics, process titles, or logs. The requested
  command runs with the caller's existing identity and environment—the
  dispatcher is not a privilege boundary or sandbox.
- **Environment:** add only the xdist worker variable on explicit opt-in and
  preserve all other values. This host CLI must not use the MCP server's
  `.env`, `server-env.js`, credential inventory, or review-engine environment
  builders.
- **Error surface:** bound and sanitize dispatcher-owned diagnostics. Child
  stdout/stderr flow directly and are therefore the child command's security
  responsibility; none is copied into shared state or durable workflow
  records.

## Requirement and documentation guardrail

This executable admission gate has a distinct correctness contract: weighted
capacity, fairness, process fidelity, crash recovery, and host installation.
GC-O007 does not state. Before implementation, add a dedicated DRAFT Ground
Control requirement and place it in issue #1566's `## Requirements` scope.
GC-O007 remains the umbrella constraint for gate ordering and semantics; it is
not sufficient traceability for the scheduler's independent contract. This is
required by Step 4's structural-gate rule, not optional documentation polish.

Consumer documentation should show complete wrapper examples, including
demand/minimum and xdist opt-in where applicable, plus the minimal repo-local
`/implement` override for Step 5 behavior that `.ground-control.yaml` cannot
express. Do not encode that override in the canonical skill or add a
Shifter-specific branch to Ground Control.

## Non-goals and anti-patterns

- No daemon, network listener, REST/MCP tool, database, GitHub record, remote
  workflow dispatch, early push, distributed cross-user scheduler, test cache,
  pass reuse, or replacement for completion, policy, pre-commit, CI, or Sonar.
- No repository-defined host capacity, arbitrary state path, or unbounded queue
  wait; no command-text inspection to guess cost or pytest behavior.
- No global "one suite"/"two suites" semaphore, per-checkout lock, in-memory
  MCP queue, or lock held throughout command execution.
- No second YAML parser, profile registry hidden in skill prose, duplicate gate
  runner, duplicate exception family, or profile-specific code branch.
- No `eval`, shell-string reconstruction, captured/unbounded child transcript,
  persisted argv/environment, PID-only stale check, or lease released merely
  because the dispatcher supervisor died while its child is still running.
- No discretionary full-suite execution during Step 5, and no weakening of the
  mandatory publish-time pre-commit command or meaningful-tree verification.
