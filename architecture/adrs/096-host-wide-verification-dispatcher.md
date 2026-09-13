# ADR-096: Admit verification commands against a host-wide CPU budget

- **Status:** Accepted
- **Date:** 2026-09-07
- **Issue:** #1566
- **Supersedes:** none

## Context

Ground Control coordinates verification inside one canonical checkout and one MCP
server process. Nothing coordinates *between* them. Two `/implement` runs in
different repositories, or in linked worktrees of the same repository, both reach
their completion and pre-commit boundaries correctly and independently, and both
launch a full test suite at the same time on the same machine.

Each run is individually compliant. Their combined worker count is not. Shifter is
the first concrete consumer: its completion boundary runs `make test`, its publish
boundary runs `pre-commit run`, and a `shifter_platform` change runs the
package-wide pytest suite under xdist with up to eight workers. Two such runs
saturate an eight-core host, and every suite, agent, and interactive process on it
gets slower.

The contention crosses repository, checkout, agent-driver, and MCP-process
boundaries, so no single one of those can own the fix. A repository knows what its
commands cost. Only the host knows what it can afford.

A naive fix makes this worse rather than better. A global "one suite at a time"
semaphore serializes a two-second lint check behind a twelve-minute suite, which
is why the model has to be capacity, not a count of suites. Anything that caches a
pass, reuses a prior result, or skips work under load would weaken the very gates
this repository refuses to weaken.

## Decision

Ship `gc-test-dispatch`: a daemonless, per-user command wrapper that admits work
against a shared host CPU budget and then runs the exact command it was given.

1. **Demand is declared by the repository, capacity is owned by the host.** A
   consumer wraps the commands it already declares in `.ground-control.yaml`:

   ```yaml
   workflow:
     completion_command: gc-test-dispatch --profile completion --cpu 8 --min-cpu 2 --xdist -- make test
     precommit_command: gc-test-dispatch --profile precommit --cpu 2 -- pre-commit run
   ```

   Profile, requested CPU, minimum acceptable grant, and the xdist opt-in are
   dispatcher arguments. Total capacity, the queue bound, and the stale-lease
   bound live in `${XDG_CONFIG_HOME:-~/.config}/ground-control/dispatch.json`,
   which the machine's owner writes. No flag and no repository setting can raise
   the host budget. The shared ledger lives under `XDG_RUNTIME_DIR`, falling back
   to `XDG_STATE_HOME`, and never in a world-writable directory: a predictable
   path under a shared directory is one another account can pre-create or race.

   This adds no `.ground-control.yaml` field. `parseGroundControlYaml` stays the
   only reader of that file (ADR-027), and the dispatcher never parses repository
   configuration.

2. **Admission is weighted CPU, never a suite count.** Strict first-in-first-out
   over a shared ledger: each queued entry is granted `min(request, remaining)`
   when at least its minimum fits, and later work is backfilled from what the
   entry ahead of it leaves. Cheap checks therefore run beside an expensive suite
   whenever capacity remains, and the walk stops at the first entry that does not
   fit so a large suite is never starved by a stream of small ones. The policy is
   a pure function of capacity and ledger state, isolated in its own module, so a
   weighted-fair successor replaces it without touching persistence or execution.

3. **Liveness is a held lease, not a process id.** Every entry owns a lease file
   held under `flock` for its whole life, and the descriptor is inherited by the
   command the dispatcher launches. The kernel releases that lock only when every
   process sharing the open file description is gone. Three properties follow: the
   lease is durable before the command starts, so a crash between admission and
   execution cannot strand capacity; a supervisor killed mid-run leaves the grant
   held by the still-running command; and reclamation is immune to process-id
   reuse.

   Reclamation asks three questions in a fixed order, and the order is the whole
   safety argument. An unheld lease proves nothing is running behind the entry, so
   its capacity is free. A live supervisor proves the opposite, and holds its grant
   for as long as the work takes; supervisor identity is the process id paired with
   its `/proc` start time, so a recycled id never reads as alive. Only when neither
   holds, meaning a descendant inherited the lease and no supervisor remains, does
   a configurable maximum lease age apply. Without that ordering the age bound
   would evict a healthy long-running suite and issue its capacity twice.

   Release settles the same question rather than assuming it. Waiting on the direct
   child does not prove the work ended, because a descendant can inherit the lease
   and keep running. The dispatcher drops its own descriptor first and then tests
   the lease: unheld means the entry and its lease file are removed, still held
   means the entry stays with its capacity accounted and its supervisor identity
   cleared, which starts the age bound that eventually reclaims it.

4. **The dispatcher adds admission and nothing else.** It runs the argv after
   `--` directly, with no shell reconstruction and no substitution. The command
   keeps its own stdin, stdout, and stderr. Its exit status is returned unchanged,
   and a command killed by a signal terminates the dispatcher the same way, so a
   caller sees the real cause. Catchable signals are forwarded to the command's
   process group. `PYTEST_XDIST_AUTO_NUM_WORKERS` is set to the granted count only
   under `--xdist`; the dispatcher never inspects command text to guess whether
   pytest is involved.

5. **It is not a gate and never substitutes for one.** No result is cached, no
   pass is reused, no test is skipped, and no work is admitted by declaring
   success. The configured completion and policy commands still run at their
   required tree boundaries, the pre-commit command remains mandatory before
   publication, and continuous integration and SonarCloud remain independent
   remote authorities. GC-O007 and the ADR-021 / ADR-027 / ADR-029 gate ordering
   are unchanged. Queue time, execution time, requested capacity, and granted
   capacity are recorded as local operational diagnostics only, never as an
   ADR-029 issue-thread record or ADR-036 step telemetry.

6. **Installation is agent-neutral and checkout-independent.**
   `bin/install-ground-control.sh` becomes the general host entry point. It
   delegates skill installation to `bin/install-skills.sh`, which keeps its
   existing contract, and installs the dispatcher as real copies under
   `~/.local/bin` and `${XDG_DATA_HOME:-~/.local/share}/ground-control`. The copy
   is deliberate: a command every repository on the host runs must not change or
   break when one working tree is switched, moved, or deleted. The Claude-specific
   `scripts/bootstrap-claude-workflow.sh` is untouched and is not on this path.

7. **No environment variable relocates the trust boundary.** Configuration and
   admission state resolve only from the standard XDG locations, and the dispatcher
   package resolves only from the executable's own location or the installed data
   directory. A redirection switch, even one intended for tests, would let a
   wrapped repository command opt out of the owner's capacity and coordinate
   against a ledger no other process shares, or import admission logic from a
   directory the admitted command controls. Tests isolate with real `HOME`,
   `XDG_CONFIG_HOME`, and `XDG_RUNTIME_DIR` values and exercise the same resolution
   path production uses.

The behavior is specified by GC-O016 and covered by tests over the admission
policy, the cross-process ledger, the command contract, and the installer.

## Consequences

### Positive

- Concurrent agents on one machine stop oversubscribing it, without anyone
  serializing work that would have fit.
- A cgroup-confined or `taskset`-confined host is respected, because the default
  capacity is the process's effective CPU affinity rather than the machine's
  CPU count.
- Adoption is a configuration change in a consumer repository. No Ground Control
  code branches on a consumer, and nothing about a command's test semantics
  changes.
- Crash recovery is ordinary correctness rather than a maintenance sweep, so a
  `SIGKILL` at any point returns capacity as soon as the work behind it is gone,
  and not one moment sooner.

### Negative

- A host now has configuration that affects how fast verification runs. A capacity
  set too low makes every suite slower; the recorded queue and execution times
  exist so profiles can be tuned from normal operation.
- Two installers exist during the transition. `bin/install-skills.sh` remains the
  canonical skill installer and the general installer delegates to it, but a fresh
  host has one more command to know about.
- The dispatcher is Python where the MCP server is Node. That is what keeps the
  installed copy free of any dependency on a checkout's `node_modules`.

### Risks

- A wrapped command that is not actually parallel still consumes its declared
  demand. Declaring more than a command uses reserves capacity nothing spends;
  the recorded measurements are how that is found and corrected.
- The strict ordering favors predictability over throughput. A large request at
  the head of the queue holds back smaller work behind it rather than being
  starved by it, which is the intended trade.
- The dispatcher is neither a sandbox nor a privilege boundary. It runs the
  requested command with the caller's own identity and environment, and it makes
  no Git or GitHub side effect of its own.

## Alternatives considered

- **A global one-suite or two-suites lock.** Trivial to build and wrong at the
  first lint check, because it cannot express that a two-core job fits beside a
  six-core one.
- **Per-repository or per-checkout coordination.** Already effectively what
  exists, and it cannot see the contention, which is between repositories.
- **A long-running scheduler daemon.** More moving parts, a lifecycle to own, and
  a new failure mode when it is not running. The evidence does not require it: an
  advisory-locked ledger gives the same admission with no resident process.
- **Reusing `proper-lockfile` through the MCP server.** That is an exclusive lease,
  not a weighted budget, and routing admission through the MCP server would put
  coordination back inside exactly the process boundary the contention crosses.
