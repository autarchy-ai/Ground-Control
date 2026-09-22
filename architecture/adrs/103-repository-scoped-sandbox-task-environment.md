# ADR-103: Repository-scoped environment for sandbox task processes

- **Status:** Accepted
- **Date:** 2026-09-21
- **Issue:** #1691
- **Requirement:** none
- **Supersedes:** none
- **Amends:** ADR-101

## Context

ADR-101 deliberately gives an Incus guest no host environment, credential
store, or arbitrary host lookup. Some coding tasks nevertheless need declared
non-secret settings and narrowly scoped secrets. A repository-controlled file
cannot itself be a secret authority: a malicious checkout could name another
repository's secret, and putting resolved values in Incus configuration, a
source or migration packet, argv, logs, or guest files would outlive or expose
the task that requested them.

The current sandbox also has VM lifecycle operations but no distinct task
process lifecycle. `start` boots a VM and `attach` joins its `coding` tmux
session. Secret rotation, restart, and revocation cannot be defined safely by
pretending either operation starts a task.

## Decision

### Repository declarations and host authority remain separate

Add one repository-root JSON document with a versioned, closed schema. It
contains an asserted canonical `owner/repository` identity and a unique list of
environment declarations. Each declaration has exactly one of these forms:

- a bounded UTF-8 non-secret literal; or
- a bounded logical `secret_ref` alias with no value or provider locator.

The schema rejects unknown fields, duplicate or invalid names, duplicate
aliases, NULs, oversized values, and a declaration containing both or neither
source forms. Environment names use one portable identifier grammar. A closed
reserved-name and reserved-prefix policy rejects variables that can redirect
the launcher, dynamic loader, executable search, user/runtime homes, Git
execution, credential lookup, or the GitHub publication broker. In particular,
repository configuration cannot set `PATH`, `HOME`, `SHELL`, dynamic-loader
variables, interpreter startup/injection options, `GIT_*`, `SSH_*`,
`DOCKER_HOST`, Ground Control/Codex homes or authentication variables, or
reusable GitHub credentials. The same authoritative parser owns this shape and
policy; callers must not add a looser dotenv, YAML, shell-expansion, or
per-command parser.

This document is not added to `.ground-control.yaml`. ADR-027 keeps that file
as the agent-neutral workflow context read through
`gc_get_repo_ground_control_context`; sandbox runtime declarations are a
different contract.

The existing root-owned `gc.incus-sandbox` host policy advances by one schema
version and remains parsed only by `config.py`. It maps an exact normalized
repository identity and logical alias to a provider-owned locator. The initial
provider is a root-owned file provider: every mapped value is read from a
root-owned, non-symlinked regular file that is not writable by group or other.
The path exists only in host policy. Repository content, guest input, task
input, and command arguments can never select a provider, path, environment
variable, or other backend identifier.

The resolver interface is the extensibility seam. Its input is the already
authorized `(repository, sandbox, task, operator, alias)` binding and its output
is either opaque bytes plus provider revision metadata, or a closed unavailable,
expired, or revoked result. Provider selection remains a closed host-policy
choice; this is not a plugin API, general secrets platform, or ambient-host-
environment adapter.

### Bind resolution to preparation and an explicit task start

The fixed unprivileged sandbox client derives the checkout root and normalized
origin with the existing `source.mjs` sanitized, fixed-argv Git environment. It
reads only the fixed repository-root declaration and sends its bytes, the
derived identity, and the named sandbox through a bounded standard-input
request to a fixed root helper endpoint. No repository path or value is an
argument to the privileged endpoint.

The root helper re-parses the declaration, requires its asserted identity to
match the derived identity, authenticates `SUDO_UID` as the configured operator,
requires the sandbox to be active and owned by that operator, and requires the
sandbox's source-preparation binding to name the same repository. It then
authorizes every secret alias against the exact repository entry in host
policy. A missing binding, identity drift, undeclared alias, alias belonging to
another repository, or guest-originated request fails before any provider read.
Repository identity, declaration digest, sandbox id, root-generated task id,
and operator uid form one immutable task-start binding.

Source preparation and dirty migration extend their existing discriminated
packet metadata only with the normalized repository identity and declaration
digest needed to establish that binding. They never carry a resolved value,
provider locator, or provider response. The existing transfer framing,
`transfer.py`, and guest bootstrap remain the only host-to-guest source path;
task-environment delivery uses a separate ephemeral channel, not another
source packet or arbitrary file-push facility.

The guest has no resolve command. It cannot choose or refresh an alias, and a
repository process cannot turn a different checkout, changed guest file, or
ad-hoc request into host-provider access. Changing declarations requires a new
operator-authorized source binding.

### A task process, not the VM or reusable session, receives values

Add a task-process lifecycle below the existing VM lifecycle. VM `start` only
boots the guest; it does not restore or resolve task environment. An explicit
task start creates a fresh task id, resolves all required aliases, and starts
one fixed guest task launcher. `attach` only joins that task's terminal/session
and never resolves or forwards values.

The root helper frames names and values in memory and writes them over standard
input to the fixed root-side guest launcher. That launcher starts a transient
systemd service with a fresh dynamic uid, a private `0700` runtime directory,
and complete cgroup termination, then passes the same bounded frame through a
one-use Unix socket in that directory. It must not use `incus exec --env`, process
arguments, Incus instance/profile configuration, the Incus guest API, a source
or migration packet, an image, or a host/guest persistent file. The guest
launcher validates the frame again, builds a new environment from a minimal
fixed OS-runtime allowlist plus the declared entries, closes the input, clears
its buffers where the runtime permits, and `execve`s the fixed task entrypoint.
There is no fallback to the guest's ambient environment.

The task-owned tmux server and its intentional descendants are the only
non-root guest processes that receive the values. Each task start gets a new
dynamic uid; the fixed `sandbox` account cannot access its private tmux socket
or `/proc` environment. Attachments are proxied by guest root to that socket,
and stopping the unit kills its complete cgroup before its private runtime
directory disappears. Guest root remains able to inspect
guest memory and processes, and the task can use or exfiltrate its own values;
neither is represented as a protection this mechanism can provide.

No injected value is persisted. Host task state contains only binding digests,
provider revision identifiers that reveal no locator or value, variable names,
source kind, and closed redacted status. Guest runtime state may contain only a
task id and process identity. A stopped or deleted VM has no task process and
therefore retains no injected value.

### Restart, recovery, rotation, and revocation are fail-closed

Every new task process, including an explicit task restart after a crash or VM
restart, resolves every secret reference again. Resolution is all-or-nothing:
an unavailable, empty-when-required, expired, revoked, malformed, or oversized
value starts no process and leaves no partial delivery. There is no automatic
task restart after VM boot and no reuse of a previous resolved set.

Stopping a task terminates its entire process group before reporting success.
VM stop first terminates the task process group; VM deletion removes only
redacted task metadata after the existing exact-name confirmation. Interrupted
delivery is recoverable by starting a new task, which gets a new task id and a
new resolution. It is never recoverable from retained bytes.

Atomic provider replacement rotates a value for the next task process. An
already running task keeps the value already in its memory until it is stopped;
rotation does not claim remote memory erasure. Revocation through the sandbox
operator path first disables future resolution and then terminates active task
bindings that used the revoked repository/alias. Removing or changing provider
state outside that path still blocks the next resolution, but operators must
stop already running tasks explicitly. Documentation must state both cases.

GitHub publication credentials are excluded from this mechanism. They remain
on the broker path owned by #1646; neither a `GH_TOKEN`/`GITHUB_TOKEN` alias nor
another reusable GitHub credential may be injected into a guest task.

### Extend the existing redacted status and event contracts

`status` and `diagnose` remain the single normalized observation surface. Their
next schema version may list configured variable names, literal/secret source
kind, and a closed state such as `not_started`, `available`, `unavailable`,
`expired`, or `revoked`. They never include literals, secret aliases, provider
types/locators, revisions, value lengths, hashes, or child/provider output.
Absence and failure remain distinct from available.

The existing lifecycle event stream advances through its versioned action and
error-code vocabulary for task start, stop, restart, and revocation. Events may
carry counts and opaque task correlation ids, but not variable names, aliases,
values, declaration content, repository paths, raw argv, environment, or
provider/guest output. Errors cross the CLI boundary as stable bounded codes and
operator actions. Reuse `ConfigError` for host policy, `UsageError` for invalid
or mismatched requests, `AdmissionError` for a task that cannot safely start,
and the existing event writer; do not add a parallel lifecycle log, status DTO,
or exception hierarchy.

## Required security and regression boundaries

- Exercise every parser and policy gate: repository shape and reserved names;
  sanitized Git identity; source-binding digest; root-owned host policy and
  provider file ownership; operator/sandbox/task authorization; provider result
  bounds; guest frame revalidation; minimal environment construction; and
  redacted error/status/event rendering.
- Prove two repository identities using the same variable name and alias receive
  different values, while cross-repository aliases, copied configuration,
  identity drift, guest-selected references, and malicious names are denied.
- Prove missing, empty, expired, and revoked references start no process; a new
  task and task restart re-resolve; VM restart does not resurrect a task; stop,
  deletion, interrupted delivery, and failed delivery retain no injected value.
- Use canaries to prove values are absent from argv and `/proc` command lines,
  host and guest persistent files, Incus configuration/export, images, source
  and migration packets, Git history/diffs, bootstrap logs, lifecycle events,
  normalized status/diagnostics, errors, and handoff/issue records.
- Preserve tests showing that ambient host and guest variables do not appear in
  the task unless declared and allowed. Provider and guest subprocess failures
  must not echo their stdout/stderr.

## Consequences

### Positive

- Repository intent is reviewable while secret authority stays root-owned and
  exactly repository-scoped.
- Values exist in the guest only for a named task process and are refreshed at
  every process start.
- Provider replacement can be added behind one resolver contract without
  changing repository configuration or guest protocol.

### Negative

- VM start and task start are separate operator actions, and crash recovery
  requires a new explicit task start.
- The host needs root-owned repository/alias mappings and secret files, plus a
  guest launcher/process-isolation setup.
- Rotation is immediate for new tasks but cannot erase a value from an already
  running process without terminating it.

### Risks

- The task necessarily can read and transmit its own environment over allowed
  HTTPS; repository scoping is not a data-loss-prevention boundary.
- Any task/session manager that retains its launch environment would turn an
  ephemeral delivery into task-lifetime shared state, so it must remain inside
  the stopped process group rather than the reusable attach session.
- Provider-specific error text, status metadata, and revision identifiers can
  become side channels unless reduced to the closed redacted vocabulary.

## Non-Goals

No general secrets platform, provider plugin API, arbitrary host-environment
passthrough, guest lookup API, per-command environment override, shell
evaluation, secret file mount, persistent Incus environment, automatic task
restart, host daemon, MCP tool, database, or GitHub credential injection. This
does not change the source/migration custody rules, network egress policy,
Ground Control server `.env` authority, or the #1646 publication broker.

## Design Vocabulary That Applies

- **Boundary contract:** the MCP server remains the only running Ground Control
  service and owns Git/GitHub side effects. The fixed Incus helper remains a
  separate host privilege boundary and gains no GitHub publication authority.
- **ADR-027:** `.ground-control.yaml` and
  `gc_get_repo_ground_control_context` remain the workflow-context contract;
  sandbox task environment uses its own closed repository schema.
- **ADR-029:** the Issue-thread record never stores environment declarations,
  aliases, provider details, resolved values, or task diagnostics.
- **ADR-031:** Codex returns structured findings and the MCP server performs
  GitHub writes; task environment delivery creates no agent-side publication
  shortcut.
- **Anti-recommendations:** extend the canonical sandbox config, transfer
  binding, status, event, and exception families rather than duplicating them;
  do not rely on prompt text for enforcement; do not introduce a provider
  framework below the single resolver seam; reserve comments for the identity,
  lifetime, and non-persistence invariants; and do not invoke `gh`, `git`, or
  `curl` from agent sandboxes.
