---
id: GC-O016
title: "Host-Wide Verification Resource Dispatcher"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 2
created_at: 2026-09-07T00:00:00Z
updated_at: 2026-09-07T00:00:00Z
---

# GC-O016 — Host-Wide Verification Resource Dispatcher

## Statement

The system shall provide a host-wide verification resource dispatcher that admits repository verification commands against a shared per-user CPU budget and then executes those commands unchanged, so that independently compliant workflow runs on one machine cannot oversubscribe it, while preserving every gate contract defined by GC-O007 and ADR-021/027/029.

(a) Agent-neutral host installation. The dispatcher shall be one executable installed through a supported Ground Control host installation path that does not depend on the Claude-specific bootstrap. Installation shall be idempotent, shall support dry-run behavior, shall refuse to overwrite a host target it does not own unless explicitly forced, and shall install the executable and its implementation as real copies rather than links into a repository checkout, so that switching, moving, or deleting a working tree cannot change or break a command every repository on the host invokes. The general installer shall delegate skill installation to the existing skill installer rather than reimplement its target-selection, overwrite, force, or dry-run rules.

(b) One host-wide admission state. Independent processes, MCP server processes, repositories, and linked worktrees owned by the same user shall coordinate through a single per-user admission state protected by an operating-system advisory lock. That state shall live in a private, owner-validated per-user directory and never in a world-writable location. The lock shall be held only while that state is read, recovered, scheduled against, and atomically replaced, and never for the duration of a command. The dispatcher shall require no long-running daemon.

(c) Weighted capacity admission. Admission shall use an integer CPU capacity model. It shall not encode a global fixed-suite-count rule. Each workload declares a requested demand and a minimum acceptable grant, where the minimum does not exceed the request. Queued work shall be admitted in first-in-first-out order; an entry shall be granted the lesser of its request and the remaining capacity whenever at least its effective minimum fits, and later work shall be admitted from the capacity earlier entries leave, so inexpensive checks run alongside an expensive suite while capacity remains. The walk shall stop at the first entry that does not fit, so a large request is never starved by a stream of smaller ones. A demand larger than the host's total capacity shall be clamped to that capacity rather than deadlocking. A grant shall not be revoked or resized after execution begins, and the scheduling decision shall be a pure function of capacity and admission state so an alternative policy can replace it without changing installation, persistence, or command execution.

(d) Host-owned capacity, repository-declared demand. Total capacity, the maximum queue wait, and the maximum lease age shall be host-owned configuration read from the host owner's configuration directory, validated for current-user ownership and safe permissions, and rejected on an unknown key or an out-of-range value. When that configuration is absent, capacity shall default to the invoking process's effective CPU affinity rather than the machine's raw processor count. Repository configuration shall supply only workload demand and profile identity, expressed as dispatcher arguments inside the repository's existing workflow command fields; no repository setting, command-line flag, or invocation shall be able to redefine the host's capacity or queue bound, and the dispatcher shall not parse repository configuration files.

(e) Faithful command execution. The dispatcher shall execute the exact requested argument vector directly, without shell reconstruction, rewriting, or substitution. The command shall inherit the dispatcher's standard input, standard output, and standard error. The dispatcher shall return the command's exit status unchanged, shall terminate by the same signal when the command is terminated by a signal, and shall forward catchable termination signals to the command's process group. It shall not skip a test, reuse or cache a prior result, weaken a pre-commit invocation, or substitute for a completion, policy, continuous-integration, or static-analysis gate.

(f) Lease durability and crash recovery. A workload's grant shall be represented by a lease held under an operating-system advisory lock for the entire life of the work, acquired before the command is executed so no command can run without a durable grant, and inherited by the command so the grant remains held if the supervising dispatcher process dies while the command is still running. Reclamation shall be based on the lease actually being unheld rather than on a recorded process identifier, so that process-identifier reuse cannot free live capacity. A grant whose supervising process is still alive shall never be reclaimed on elapsed time, however long the command runs; supervisor liveness shall be established by a process identity that resists identifier reuse. A maximum lease age shall apply only to a lease that is still held while no supervisor remains, which is the surviving-descendant case. Releasing a grant shall likewise establish that no process still holds the inherited lease before the entry is removed; while one does, the entry shall retain its capacity accounting and become subject to the maximum lease age. Leases shall be released on normal exit and on interruption, release shall be idempotent, and unreadable or malformed admission state shall fail closed rather than be silently reset.

(g) Declared parallelism. A workload that explicitly opts in shall have the pytest xdist automatic worker count set to its granted capacity, so a command using automatic worker selection consumes the parallelism it was actually granted. The dispatcher shall not infer parallelism by inspecting command text, and shall alter no other environment value. Commands that are not pytest-based shall remain fully supported.

(h) Bounded measurement. Every terminal outcome shall record bounded queue duration, execution duration, requested capacity, granted capacity, host capacity, the workload profile, and the outcome, so demand profiles can be tuned from normal multi-agent operation without a dedicated benchmark host. Those measurements are local operational diagnostics: they shall not be an issue-thread record, model-step telemetry, a verification attestation, or a result any gate may read back as evidence. No command argument vector, working directory, environment, or command output shall be persisted.

(i) Verification. The dispatcher and its installer shall carry tests covering concurrent admission across independent processes, inexpensive work admitted alongside expensive work, capacity exhaustion, first-in-first-out fairness, exact command-failure propagation, signal propagation in both directions, stale-lease recovery after an uncatchable kill, and installer idempotence and refusal to clobber unmanaged host content.

(j) Documentation. The development workflow reference shall document how a consumer repository wraps its existing configured commands, how host capacity is configured, and how a minimal repository-local `/implement` addendum supplies invocation behavior that the configuration schema cannot express.

## Rationale

Ground Control coordinates verification within one canonical checkout and one MCP server process, so nothing bounds the combined cost of separate `/implement` runs on the same machine. Each run reaches its completion and pre-commit boundaries correctly and independently, and their combined worker count can saturate the host, slowing every suite, agent, and interactive process on it. The contention crosses repository, checkout, agent-driver, and MCP-process boundaries, which is why admission belongs to the host rather than to any repository or process.

Capacity rather than a suite count is the model because a fixed "one suite at a time" rule serializes a two-second lint check behind a twelve-minute suite, which trades one form of waste for another. Splitting authority so that the machine's owner declares capacity while a repository declares demand keeps a consumer from redefining the machine, and keeps Ground Control free of consumer-specific branches. Basing liveness on a held, inherited lease rather than a recorded process identifier is what makes recovery exact under an uncatchable kill and safe when a supervisor dies while real work continues, which is the condition under which a naive scheduler double-issues capacity. The dispatcher deliberately adds admission and nothing else: it is not a gate, and a wrapper that could cache a pass or skip work under load would weaken the gates GC-O007 exists to enforce. GC-O007 remains the umbrella workflow constraint for gate ordering and semantics; it states nothing about weighted admission, fairness, process fidelity, crash recovery, or host installation, which is why this contract is its own requirement.

## Traceability

- IMPLEMENTS → CODE_FILE `bin/gc-test-dispatch` (Dispatcher entry point; checkout-independent package resolution — GC-O016 clause (a))
- IMPLEMENTS → CODE_FILE `bin/install-ground-control.sh` (General Ground Control host installer; delegates skills to bin/install-skills.sh — GC-O016 clause (a))
- IMPLEMENTS → CODE_FILE `tools/gc_dispatch/admission.py` (Pure weighted-capacity FIFO admission policy — GC-O016 clause (c))
- IMPLEMENTS → CODE_FILE `tools/gc_dispatch/ledger.py` (Per-user advisory-locked capacity ledger, inherited leases, stale recovery — GC-O016 clauses (b), (f))
- IMPLEMENTS → CODE_FILE `tools/gc_dispatch/records.py` (Ledger record schema validation, reuse-safe process identity, lease primitives — GC-O016 clause (f))
- IMPLEMENTS → CODE_FILE `tools/gc_dispatch/hostconfig.py` (Host-owned capacity and queue bounds; effective CPU affinity default — GC-O016 clause (d))
- IMPLEMENTS → CODE_FILE `tools/gc_dispatch/supervisor.py` (Direct argv execution, inherited stdio, exit-status and signal propagation — GC-O016 clause (e))
- IMPLEMENTS → CODE_FILE `tools/gc_dispatch/cli.py` (Argument contract, admission wait, xdist opt-in, bounded measurement — GC-O016 clauses (c), (g), (h))
- IMPLEMENTS → GITHUB_ISSUE `1566` (Issue #1566 — install a host-wide verification resource dispatcher)
- DOCUMENTS → ADR `architecture/adrs/096-host-wide-verification-dispatcher.md` (ADR-096: admit verification commands against a host-wide CPU budget)
- DOCUMENTS → DOCUMENTATION `architecture/notes/host-wide-verification-dispatcher-preflight.md` (Issue #1566 codex architecture preflight binding-guardrails note)
- DOCUMENTS → DOCUMENTATION `docs/DEVELOPMENT_WORKFLOW.md` (Host-wide verification dispatch: wrapping recipe, host configuration, repo-local addendum — GC-O016 clause (j))
- CONSTRAINS → REQUIREMENT `docs/requirements/GC-O007/requirement.md` (GC-O007 remains the umbrella gate-ordering constraint the dispatcher must not alter)
- TESTS → TEST `tools/tests/test_dispatch_admission.py` (Admission policy: capacity exhaustion, backfill, FIFO fairness, elastic grants, clamping)
- TESTS → TEST `tools/tests/test_dispatch_ledger.py` (Cross-process admission, kill recovery, inherited-lease survival, fail-closed state)
- TESTS → TEST `tools/tests/test_dispatch_cli.py` (Command fidelity, signal propagation, xdist opt-in, queue bound, argument validation, measurement)
- TESTS → TEST `tools/tests/test_dispatch_units.py` (In-process argument, host-configuration, process-identity, and supervision tests)
- TESTS → TEST `tools/tests/test_install_ground_control.py` (Installer idempotence, dry run, unmanaged-target refusal, checkout-independent copy)
