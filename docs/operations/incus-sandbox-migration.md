# Move an existing coding task into an Incus VM

This runbook moves one explicitly named Git checkout into one explicitly named
ADR-101 sandbox without publishing, stashing, committing, cleaning, or running
repository code on the host. It reconstructs new private Git metadata in the
guest and preserves HEAD, branch/detached state, staged changes, unstaged
changes, deletions, executable bits, inside-only symlinks, and only the
untracked files the operator lists.

It restarts work in a guest. It does not move a live process, PTY, tmux server,
terminal, environment, credential store, provider home, or Docker socket.

## Before the first migration

Install or upgrade the reviewed sandbox programs and create the destination:

```sh
grndctl sandbox setup upgrade
gc-incus-sandbox create issue-1645
```

The upgrade preserves existing guests and changes the root-owned policy to
`gc.incus-sandbox/v2`. Its migration limits cap the packet, individual files,
file count, and handoff. A v1 installation refuses dirty migration.

Inventory tasks yourself. Write down only the source checkout and destination
VM for each task. Do not discover sessions from process lists, tmux panes,
terminals, shell history, environments, home directories, or credential files.

## Checkpoint and capture

1. Ask the old agent to reach an operator-chosen stable checkpoint and report
   the task, decisions, verification already run, and unfinished work.
2. Stop that agent. Detaching a tmux pane is not proof that it stopped.
3. Review `git status --short --branch` yourself. Choose exact non-ignored
   untracked files that belong to the task. Do not choose `.env`, credentials,
   provider configuration, sockets, caches, generated trees, or unrelated
   files.
4. Create a mode-0600 request outside the checkout. The handoff is the selected
   non-secret history; do not paste a transcript or provider database.

```json
{
  "schema": "gc.incus-sandbox.migration-request/v1",
  "checkpoint_acknowledged": true,
  "source_agent_stopped": true,
  "selected_untracked": ["notes/task-handoff.md"],
  "handoff": {
    "task": "Implement issue 1645 on branch 1645-migrate-coding-sessions.",
    "unfinished": "Run the focused sandbox tests, review the diff, then continue /implement."
  }
}
```

Save an export when retry or offline custody matters:

```sh
umask 077
gc-incus-sandbox export /absolute/source/checkout \
  < /private/path/migration-request.json \
  > /private/path/task.gcs
gc-incus-sandbox import issue-1645 < /private/path/task.gcs
```

For a one-shot transfer:

```sh
gc-incus-sandbox migrate issue-1645 /absolute/source/checkout \
  < /private/path/migration-request.json
```

Only the checkout and sandbox are command arguments. The request and packet use
standard input/output. Host Git runs with hooks, fsmonitor, external diffs,
system/global configuration, prompts, and credential helpers disabled. Active
clean/process filter attributes are rejected before status or diff inspection.
A before/after state digest rejects a checkout that changes during capture.

## Fail-closed cases

Migration stops before cutover when it finds an unfinished merge/rebase or
sequencer operation; an unmerged, intent-to-add, assume-unchanged,
skip-worktree, sparse, or split index; an active clean/process filter; a Git
submodule; a selected LFS-managed path; an ignored or unselected untracked
path; a credential/config path; a special file; an oversize section; an unsafe
duplicate; a parent link; or a link resolving outside the checkout. It names a
bounded recovery reason without reading or logging secret values.

For `unsupported_submodule` or `unsupported_lfs`, keep the original checkout,
prepare the base repository in the guest, and restore or fetch that dependency
from inside the guest with guest-local credentials. Do not omit it from the
result or publish the host work merely to transfer it.

## Verify and cut over

Attach and inspect the guest-private result before switching ownership:

```sh
gc-incus-sandbox attach issue-1645
cat ~/.gc-transfer/migration-result.json
cat ~/.gc-transfer/handoff.md
git -C ~/workspace status --short --branch
git -C ~/workspace diff --cached --stat
git -C ~/workspace diff --stat
```

The importer validates every section and path before writing, rebuilds into a
private staging directory, verifies HEAD, branch, index, worktree, and selected
untracked state, then atomically exposes `~/workspace`. The result names the
migration, state digest, preserved state-class counts, destination task owner,
verification outcome, stopped-source acknowledgement, and unfinished work. It
is mode 0600 and stays in the guest; lifecycle telemetry contains none of that
content.

If import is interrupted, leave the guest and source in place and repeat the
same `import`. Incomplete staging is replaced. Replaying the same completed
packet is a verified no-op. A different packet never overwrites an existing
workspace.

After a verified result, record the destination VM as the sole task owner and
start a new guest agent from `handoff.md`. No qualified provider-native
conversation exporter is currently installed, so this is a new conversation,
not a resumed process. If one is added later, it must be a bounded, explicit
packet section; copying `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, OAuth caches, raw
histories, or provider databases remains forbidden.

Keep the original checkout unchanged as recovery evidence, but do not restart
its agent or publish from both copies. Cleanup and credential revocation remain
separate operator decisions.

## Daily use and recovery

```sh
gc-incus-sandbox attach issue-1645       # direct guest terminal and installed CLIs
gc-incus-sandbox stop issue-1645         # disk and workspace state persist
gc-incus-sandbox start issue-1645
gc-incus-sandbox attach issue-1645
gc-incus-sandbox delete issue-1645 --confirm issue-1645
```

Never delete on disconnect, timeout, failed import, or failed verification.
Before deletion, inspect `git status` and the private result. The exact-name
confirmation is required even when the helper cannot determine whether private
unpublished work remains.

Detaching keeps the current tmux process running. Powering the VM off ends its
processes; after `start`, `attach` creates or joins the guest's `coding` tmux
session and the same on-disk workspace is still present.

Repeat the same explicit mapping for remaining sessions; do not automate
discovery:

| Source checkout | Destination VM | Old agent stopped | Guest verified | Task owner |
| --- | --- | --- | --- | --- |
| `/absolute/checkout-a` | `task-a` | yes/no | yes/no | source/task-a |
| `/absolute/checkout-b` | `task-b` | yes/no | yes/no | source/task-b |

## Rehearsal protocol

For release evidence, use two disposable guests and two explicit checkouts of
one test repository. Give each checkout a different staged, unstaged, and
untracked task; migrate both; and run the repository's real focused build and
tests inside each guest. Then:

1. Interrupt the first import before guest staging is renamed; repeat the same
   import and verify the source plus completed guest workspace survive.
2. Attempt a create or start with deliberately insufficient configured
   headroom, and run #1643's sibling, host, private-address, and IPv6 probe.
   Both must fail closed; no build, test, or agent may run on the host.
3. Observe host responsiveness and the configured CPU, RAM, and disk limits
   while both guest workloads run.
4. Save only the private migration results and the bounded pass/fail summary.
   Do not save prompts, code, diffs, terminal output, filenames, arguments,
   environments, or credentials in lifecycle logs.

The result is adequate only when both task owners, preserved state, test/build
outcomes, original-source survival, interrupted-import recovery action, and
isolation/resource verdicts are explicit.

### 2026-09-21 implementation rehearsal

- A stale network-policy observation denied two initial creates before any
  guest or host workload ran. Refreshing the setup-owned policy restored
  admission.
- `issue-1645-a` and `issue-1645-b` received two different dirty tasks from two
  checkouts of one repository. Each private result verified one unpublished
  commit, one index entry, one worktree entry, and one selected untracked file,
  with the destination guest named as task owner. Both original checkouts kept
  the same HEAD and dirty state.
- Both guests passed their real Node syntax build and test, then passed 30 test
  iterations concurrently. Each remained within 2 vCPU, 4096 MiB RAM, and a
  16 GiB disk allocation while the host returned status immediately.
- The #1643 metadata, host-bridge, private-address, sibling, and IPv6 canaries
  were unreachable from `issue-1645-a`, as required.
- `issue-1645-interrupt` began with an incomplete private staging directory.
  Import removed only that staging directory, verified and exposed the
  workspace, and a second import was an idempotent success. The source survived.
- Stopping, starting, and attaching `issue-1645-a` preserved the verified
  workspace and produced a usable new tmux session.
- Codex was installed guest-locally and device-authenticated by the operator in
  both task guests. Two coding agents then ran concurrently on different
  resumed tasks. One verified the distinct staged and unstaged source states;
  the other verified the unpublished commit, selected task note, and handoff
  context. Each independently passed the real build and test without changing
  the migrated state. No host credential was copied or read.
