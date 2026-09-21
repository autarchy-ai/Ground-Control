# Existing Coding Session VM Migration Preflight

Issue: #1645

Requirement: none

This note defines the boundaries for moving an existing coding task into an
ADR-101 Incus guest without losing unpublished work. It is design guidance,
not an implementation plan. Issue #1644 remains the prerequisite for the
private-repository guest workflow.

## Decisions

### Migrate one explicit, quiesced checkout into one named guest

One invocation names one source checkout and one destination sandbox. It may
also name selected untracked paths and either one supported native-session
export or one operator-reviewed handoff. It must not discover work by scraping
tmux panes, process lists, terminals, shell history, environments, provider
homes, credential stores, or every checkout on the host. The same command and
result shape is repeated for the other operator-identified sessions; there is
no host session catalog or scheduler.

Only the source checkout and bounded sandbox name belong in process arguments.
Selected-path manifests, handoff text, native-history exports, and packet bytes
travel through permission-restricted files or standard input, never argv or
environment variables.

The operator pauses the old agent at a chosen checkpoint, obtains its explicit
checkpoint acknowledgement, and stops that agent before capture. Capture binds
the source realpath, Git checkout identity, HEAD, branch state, index state,
tracked-worktree state, and selected-untracked state to one migration id and
digest. It rechecks that digest before declaring capture complete. A changed
source is a failed checkpoint, not a best-effort snapshot.

The original checkout is never deleted, cleaned, reset, stashed, committed,
published, made to run a hook, or used as an import staging area. Successful
guest verification is the switch-over gate. The result names the destination
sandbox as the task owner, records that the old agent was stopped, and states
what remains unfinished. This is an operator-visible ownership handoff, not a
claim that a live tmux process or process memory moved. Migration neither
cleans the source nor revokes its credentials.

### Extend the existing source-packet path, not create a second transfer engine

`tools/incus_sandbox/source.mjs`, `transfer.py`, and `guest_bootstrap.py` are the
canonical host-to-guest path. The committed-source
`gc.incus-sandbox.source/v1` contract remains valid. Dirty migration needs one
new versioned, closed packet variant in that same framing and parser family;
it must not add an archive copier, arbitrary root file-push command, mount, or
parallel sudo endpoint.

The packet contains only a fresh Git object bundle for the selected revision,
the active branch/detached identity, a canonical representation of the index,
changed tracked file payloads, explicitly selected untracked payloads, and the
optional bounded handoff or supported native-session export. It never copies
the source `.git` directory. The guest constructs new private Git metadata and
restores the branch, index, and worktree from the validated packet. Host Git
configuration, hooks, remotes containing credentials, reflogs, locks,
worktree pointers, credential helpers, and provider state consequently do not
cross the boundary.

Capture and import are replayable by migration id and content digest. A packet
is permission-restricted, size-bounded, and integrity-bound. Guest import first
validates and materializes into a private staging directory, then makes a
complete checkout visible without overwriting an existing different workspace.
Repeating a completed import with the same id is a verified no-op. An
interruption leaves the source and any previously complete guest workspace
intact; retrying the same packet is the recovery action.

Do not extend `gc.agent-connection/v1` to carry workspace files. That contract
normalizes optional live dashboard capabilities and observations. A migration
packet is a local, finite custody transfer with different retention, integrity,
and confidentiality rules.

### Preserve Git state without executing repository behavior

Host-side discovery reuses the fixed-argv, sanitized Git environment already
used by `source.mjs` and `sanitizedImplementGitEnvironment`: no system/global
configuration, hooks, fsmonitor, credential helpers, prompts, SSH, or shell.
Use Git plumbing to identify the checkout, object store, HEAD, index entries,
tracked changes, and untracked status. Read only the paths Git identified plus
the operator's exact untracked selection. Do not recursively crawl the
checkout, ignored files, a home directory, or an agent configuration directory.

Every payload path is NUL-safe, relative, normalized, and distinct. Reject an
absolute path, `..`, `.git`, duplicate/case-colliding entry, unsafe file type,
or parent component replaced by a link. A symlink may be preserved as link text
only when its complete resolution stays inside the source checkout; never
dereference it to collect an outside target. Reject sockets, devices, FIFOs,
and other special files. Enforce packet, file-count, per-file, and handoff/history
bounds before privileged transfer and again in the guest.

Linked Git worktrees are not generic path exceptions. If supported, the
exporter may obtain their Git directory and common object store only through
validated `git rev-parse` results and fixed Git commands; those external paths
never become packet entries. Otherwise it must stop with an explicit linked-
worktree recovery instruction. It must not follow a caller-supplied `.git` link.

Ordinary stage-zero index entries, staged changes, unstaged tracked changes,
deletions, mode changes, renames, binary data, and explicitly selected
untracked regular files are in scope. An unresolved merge, rebase/cherry-pick
control state, sparse/index extension the importer cannot reproduce, or
intent-to-add entry must either have exact round-trip support and a fixture or
stop before capture with a specific recovery instruction. It must never be
silently flattened into an ordinary worktree.

Submodules and Git LFS are explicit capability gates. Detect gitlinks,
`.gitmodules`, and LFS-managed selected paths without initializing a submodule,
running a filter, or fetching an object on the host. Unless the delivered path
can prove the required commits/LFS objects are present and restore them inside
the guest, fail with a bounded `unsupported_submodule` or `unsupported_lfs`
result and the next guest-local/operator step. Omission is not success.

Selected untracked files are opt-in and exclude ignored files by default.
Known credential/config homes, `.env` and credential material, runtime and
agent sockets, provider state, package/build caches, large generated trees, and
unrelated files are never eligible merely because they are below the checkout.
This is structural exclusion, not a claim that arbitrary source content can be
proven secret-free. Secret canaries must be absent from packet metadata,
events, errors, diagnostics, and results.

If a changed tracked path is a known credential/config path, stop without
reading or classifying its value and give a redacted/manual recovery action.
Preserving tracked state does not override the no-credential boundary.

### Session continuity is provider-owned and capability-gated

A workspace checkpoint and a conversation are separate assets. Resume a
conversation only through a qualified provider-native export/resume surface,
bound to the selected native session and destination guest profile. Never copy
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, provider databases, OAuth caches, raw native
history directories, or a whole agent home. Never infer a session from tmux or
terminal text.

When native continuation is unsupported, unqualified, secret-bearing, or
incomplete, carry only a short operator-reviewed handoff containing the task,
checkpoint, relevant decisions, verification already run, unfinished work, and
recovery note. The handoff is private migration content, not lifecycle
telemetry or a GitHub issue record. The guest starts a new native session from
that handoff. `gc.agent-connection/v1` capability names and absence semantics
are useful precedent, but its wire payload is not reused as storage.

### Lifecycle and deletion remain fail-closed and non-destructive

Creation and start continue through `LifecycleHelper`, so stale isolation
facts, failed capacity admission, and insufficient CPU/RAM/disk reject the
guest operation. No failure path runs a build, test, agent, or publication on
the host. Disconnect, command timeout, failed import, failed verification, and
failed probes leave the VM and source checkout in place. `stop`, `start`, and
`attach` retain their ADR-101 meaning. Detaching keeps the current tmux process
running. A VM stop preserves disk and workspace state but ends guest processes;
after a later start, attach opens or joins the `coding` session available in
that boot. This is workspace reattachment, not process continuity across
power-off.

Deletion must remain a root-helper decision and become deliberately
confirming. Because the helper must not inspect or export private workspace
content to decide whether it is valuable, the conservative rule is to require
an exact named-sandbox confirmation for every deletion. Thus unpublished or
unknown work is always covered. Confirmation is a closed argument bound to the
same sandbox, never an arbitrary command, and non-interactive deletion without
it is refused. Migration does not authorize deletion, cleanup, credential
revocation, or rollback of the original checkout.

### Verification has a private result and bounded telemetry

Before switch-over, the guest recomputes the canonical workspace-state digest
and compares HEAD, branch, index, tracked worktree, and selected untracked
entries with the captured manifest. The operator-visible result can name the
private paths selected, source and destination identities, preserved state
classes, resume/handoff mode, task owner, verification outcome, and unfinished
work. It stays in the guest or operator-selected permission-restricted output;
it is not written to the lifecycle log or issue thread.

ADR-101's single `gc.incus-sandbox.event/v1` stream remains the telemetry
surface. Extend its closed action/error vocabulary only as needed for bounded
capture/import/verification outcomes. Events may include opaque migration id,
counts, duration, outcome, and stable reason, but no paths, filenames, branch,
remote, commit message, task text, handoff, transcript, diff, file content,
child output, or credential. Reuse `UsageError`, `AdmissionError`,
`TransferError`, and `PacketError`; add stable reason codes rather than a
parallel exception hierarchy or raw subprocess errors.

The release evidence must cover a real migration, an interrupted import, and a
denied resource/isolation check, proving the original survives each case and
naming the next recovery action. Two separate guests must run real builds/tests,
including two tasks from one repository. Reuse ADR-101's sibling, host,
private-address, IPv4/IPv6, resource-bound, and host-responsiveness probes.
These are guest-run workload checks plus host-boundary probes, not a new test
executor or host fallback.

Issue #1654 timing records and diagnostic bundles may link to this exercise,
but they are supplemental. The bounded migration result itself must remain
understandable without those records and must not absorb their raw diagnostics.

## Canonical Incumbents And Cross-Cutting Boundaries

- **VM authority and admission:** ADR-101, `client.mjs`, `helper.py`,
  `config.py`, `observations.py`, `gc-incus-sandbox.nft`, and the allocation
  ledger own lifecycle, operator identity, capacity, network freshness, and
  fixed Incus argv.
- **Host verification admission:** `gc-test-dispatch` remains a separate
  CPU-only host command dispatcher and is not a VM resource or execution
  fallback. Guest builds/tests run in admitted guests; use ADR-101's measured
  host/guest probes for this evidence.
- **Transfer and persistence:** `source.mjs`, `transfer.py`, and
  `guest_bootstrap.py` own bounded packets, root-side temporary custody,
  fixed guest paths, guest-private Git metadata, idempotent materialization,
  and guest-local diagnostics. Extend this path once.
- **Configuration:** `gc.incus-sandbox/v1` is strict, root-owned, non-symlinked,
  and closed. Any host-owned migration size/count policy belongs in a versioned
  successor of this config, not environment variables, `.ground-control.yaml`,
  repository config, or caller flags that bypass the root policy.
- **Safe Git:** reuse the `source.mjs` minimum environment and
  `sanitizedImplementGitEnvironment` invariants. Do not add a looser Git runner,
  invoke repository aliases/hooks/filters, or publish merely to make transfer
  easy.
- **Session identity and continuation:** ADR-098 and
  `gc.agent-connection/v1` keep machine, checkout, profile, harness, and native
  session identity distinct and advertise `resume` as a capability. They do
  not become the migration packet, VM controller, or workspace record.
- **Credentials and MCP:** ADR-027, `server-env.js`, `codexEngineEnv`, and the
  issue #1644 guest workflow keep credentials guest-local and child
  environments allowlisted. `.ground-control.yaml` remains non-secret workflow
  context. A migration must not copy or widen any of these surfaces.
- **Workflow records:** ADR-029's Issue-thread record and the ordinary guest
  `/implement` lane remain authoritative for decisions and delivery. A local
  migration result is not a gate, phase marker, plan, or final report.
- **Packaging and operations:** `setup.sh`, the package sandbox payload,
  `grndctl sandbox`, `docs/operations/incus-sandbox.md`, and the existing Node
  and Python sandbox tests must stay in parity with every installed migration
  program and command.

## Security And Validation Layers

| Layer | Required control |
| --- | --- |
| Operator input | One explicit checkout, one bounded sandbox name, exact selected-untracked paths, and one supported history/handoff choice. No discovery or arbitrary guest path/command. |
| Source checkout | Canonical Git identity plus before/after state digest; fixed Git argv and sanitized environment; no source mutation, hook, filter, credential helper, fetch, or publish. |
| Filesystem | NUL-safe relative paths, component-wise no-follow containment, inside-only symlink resolution, regular-file/type checks, duplicate checks, and byte/count caps. No recursive host/home scrape. |
| Packet shape | One closed versioned schema, exact fields, integrity digest, bounded sections, no host paths/remotes with credentials/config homes/sockets/caches, and fail-closed submodule/LFS capability. |
| Privileged transfer | Existing sudo operator check, root-owned config, bounded standard input, fixed Incus file-push/exec argv, private temporary files, and no child output forwarded to host diagnostics. |
| Guest import | Parse and validate again before writes; fixed private staging/workspace paths; new guest Git metadata; no overwrite of a different workspace; idempotence by migration id/digest. |
| Session history | Provider-native qualified export/resume only, otherwise a bounded reviewed handoff. Never copy provider homes, credential caches, raw history stores, or terminal output. |
| VM isolation/admission | Existing project/profile/device restrictions, firewall freshness, allocation ownership, quotas, and `create`/`start` admission. Unknown or insufficient capacity is an error with no host execution. |
| Credentials/MCP | Guest-local login and MCP launch-root binding; no credential in packet, argv, environment inheritance, logs, results, or issue records. |
| Error envelope | Existing exception families plus stable bounded reason codes. Do not return packet content, paths beyond the explicitly named source, diffs, transcripts, raw argv, environment, or subprocess output. |
| Observability | Extend the one allowlisted lifecycle event vocabulary; keep the detailed migration result private and separate. Unknown, interrupted, unsupported, and failed remain distinct from verified. |
| Destruction | No automatic delete on disconnect, timeout, import failure, or verification failure; exact-name confirmation for every VM delete; source cleanup and credential revocation remain operator actions. |

## Extensibility Seam

The seam is the versioned source-packet variant plus its closed section table,
with root-owned limits for total bytes, file count, per-file bytes, and selected
history bytes. A later qualified native-session exporter or supported
submodule/LFS section adds one discriminated capability/section and matching
guest validator; it does not add another transfer endpoint or relax filesystem
containment. The destination stays a named sandbox with a fixed guest workspace,
so supporting more tasks means more explicit mappings, not arbitrary root paths
or automatic scheduling.

## Non-Goals And Anti-Patterns

- No live process, PTY, tmux server, memory image, open file descriptor, or
  network connection migration.
- No terminal/process/environment/provider-home scraping and no automatic host
  session inventory.
- No raw `.git`, whole home, provider config, credential, `.env`, socket,
  Docker context, package cache, build cache, ignored tree, or arbitrary archive
  transfer.
- No host checkout mount, host Docker socket, arbitrary Incus command, public
  API, new daemon, MCP VM tool, dashboard controller, scheduler, or database.
- No source stash/commit/reset/clean, forced publication, history rewrite,
  automatic conflict resolution, or running repository hooks/scripts on the
  host.
- No silent omission or flattening of unsupported submodules, LFS objects,
  unmerged indexes, special files, escaping links, native history, or failed
  verification.
- No duplicate packet parser, path validator, config parser, lifecycle/status
  DTO, event log, exception hierarchy, workflow lane, or Issue-thread record.
- No deletion on disconnect/timeout/failure and no migration-implied cleanup or
  credential revocation.

ADR-101 must be amended with the implementation so its current “no dirty-
worktree migration” non-goal points to this bounded successor instead of
remaining contradictory. ADR-098's dashboard/session boundaries remain intact.

## Design Vocabulary That Applies

- **Issue-thread record:** the ordinary guest workflow continues to post
  decisions and delivery records through the existing MCP GitHub boundary;
  migration state and private results do not become issue comments.
- **Canonical helper:** reuse argv-based GitHub posting in
  `mcp/ground-control/lib.js` for workflow records only. Neither the migration
  client nor the Incus root helper gains GitHub authority.
- **Boundary contract:** the MCP server remains the only Ground Control service
  with privileged Git/GitHub side effects. The Incus helper remains a separate
  local fixed-command OS boundary.
- **ADR-027:** `.ground-control.yaml` remains the agent-neutral workflow context;
  VM migration policy, packets, host paths, and credentials do not enter it.
- **ADR-029:** the GitHub issue thread remains the durable workflow record, not
  a migration packet, session store, VM state database, or diagnostic sink.
- **ADR-031:** agent findings remain structured and MCP performs GitHub writes;
  migration adds no agent-side publication path.
- **Anti-recommendations:** do not introduce an abstraction below three call
  sites; do not put unenforceable migration or isolation claims in skill text;
  use comments only for non-obvious authority, containment, and recovery
  invariants; and do not invoke `gh`, `git`, or `curl` from an agent sandbox for
  privileged publication.
