# Incus VM Ledger Recovery Preflight

- Issue: #1721
- Requirement: none
- Prerequisite: #1720's bounded `run_owned` calls are present in the current head.

This note fixes the ownership, capacity, and durability boundaries for the
local Incus sandbox. It is design guidance, not an implementation plan.

## Current-head evidence

A fake-runner probe against `LifecycleHelper` accepted three create/stop cycles
with 16 GiB disks, a 48 GiB aggregate bound, and 16 GiB overhead. It retained
all three stopped records (64 GiB including overhead) while `_headroom()`
reported 32 GiB free. A launch-success/config-failure/delete-failure probe
retained the allocation in the current head, so the original audit's lost-owner
claim is partially repaired by #1720. The record has no cleanup-pending state,
however, and the event stream contains only the initial `command_failed` code.
`allocations.py` and `events.py` still truncate their durable files before one
unchecked `os.write`.

## Decisions and invariants

- **One lifecycle authority.** The root-side `LifecycleHelper` and
  `allocations.py` own the ledger. Every project VM that may still exist retains
  its owner and persistent disk charge, whether running, stopped, starting,
  deleting, or awaiting cleanup. CPU and RAM can be released on a confirmed
  stop; disk and owner can be removed only after a successful delete or a
  bounded, positive Incus absence observation. A failed, timed-out, or
  ambiguous daemon call is never evidence of absence. Preserve the reservation
  before launch and across an interrupted compensation. Represent cleanup
  pending explicitly in the existing allocation record; keep the legacy
  `active` meaning distinct from disk existence and define how old records are
  read without silently resetting them. A launch error can also follow daemon
  side effects; release its reservation only after positive absence evidence.
- **One capacity calculation.** `_aggregate_fits()` and `_headroom()` must use
  the same accounting rule: active CPU/RAM, every retained disk, and the fixed
  host overhead once. The `config.pool` observation must measure the configured
  Incus storage pool, not `/` or guest root usage. Bound and validate the
  daemon's response; unavailable, malformed, stale, or wrong-pool facts deny
  new admission. Compare actual pool availability and configured aggregate
  ceiling conservatively, without double subtracting already allocated disk.
  The example policy permits 512 GiB aggregate disk while setup creates a
  64 GiB pool; document or correct that mismatch in the implementation so the
  configured ceiling cannot masquerade as physical headroom.
- **Reconcile through the ordinary command boundary.** An operator must be
  able to inspect and retry cleanup of an owned pending VM through `grndctl
  sandbox`, with the existing exact-name delete confirmation. Recovery after
  a missing or malformed ledger must fail closed on new admission and require
  positive Incus inventory plus the configured project/profile/pool identity
  before restoring ownership; never infer that an arbitrary same-name VM is
  owned or delete it. A successful reconciliation persists the owner/capacity
  result before reporting success. A failed cleanup retains the record and
  reports both primary and cleanup outcomes in bounded, redacted form.
- **Atomic state under stable locks.** Both allocation and retained JSONL event
  writes need a complete-write loop, file `fsync`, same-directory atomic
  replacement, and parent-directory `fsync`. Lock a separate stable file for
  each read/modify/write sequence; locking the replaced inode is insufficient.
  Preserve root-owned, no-follow, regular-file, and restrictive-mode checks on
  state, lock, temporary, and event paths. An interrupted write leaves the last
  complete state/log visible; malformed state/log never becomes an empty
  ledger/history. Event retention may discard only complete oldest records
  under the configured bound, not truncate a partial line silently. The ledger
  and event log are two files, not one transaction: if audit publication fails
  after an Incus side effect, retain the truthful ledger state and surface the
  audit failure instead of compensating from stale assumptions.

## Repository boundaries to reuse

- **Authorization and schema gates:** `client.mjs` and
  `mcp/ground-control/lib/sandbox-cli.js` expose the closed CLI vocabulary;
  `helper.py` validates action, name, `SUDO_UID`, owner, and delete confirmation;
  `config.py` validates the root-owned versioned policy and its `pool`, resource
  limits, paths, and deadlines; `allocations.py` validates ledger records;
  `events.py` allowlists the audit schema. Keep these as the only validators
  for their respective data, rather than adding a second DTO or parser.
- **Privileged execution and secret boundary:** `setup.sh` installs the fixed
  sudo rule and a dedicated project/profile/pool; `owned_process.run_owned`
  owns bounded fixed-argv Incus calls. Do not add shell interpolation,
  caller-selected Incus paths, raw daemon JSON, argv/output/environment, task
  frames, provider locators, or exception text to status or events. Keep pool
  queries and absence checks on the bounded query operation. Use existing
  `AdmissionError`/`UsageError` and the allowlisted event codes; extend the
  bounded vocabulary only where the two failure stages need distinct facts.
- **Persistence and observability:** `task_environment._atomic_json` and
  `config.upgrade_config` show same-directory replacement and `fsync`; use
  their pattern while sharing a complete-write primitive for the two ledger
  writers. `task_environment.state_lock` and `events.EventWriter._exclusive`
  show separate stable locks. Preserve `EventWriter`'s byte cap, rotation,
  normalized status output (moved to `gc.incus-sandbox.status/v3` for the pool
  facts), and redacted task observation.
  Source bindings and task state are cleared only after confirmed VM deletion.
  If a shared persistence module is added, `setup.sh` must install it beside
  both root-side imports before either helper can use it.
- **Host/runtime surface:** `setup.sh` fixes pool/profile/project identity and
  quota probing; `config.example.json` and `docs/operations/incus-sandbox.md`
  describe operator capacity and recovery. Update their semantics together if
  policy defaults or CLI verbs change. `tools/tests/test_incus_sandbox.py` and
  `test_incus_deadlines.py` already inject fake runners and stalled commands;
  extend those focused behavior tests for partial success, ambiguous absence,
  short/interrupted writes, malformed records, and concurrent writers.

## Extensibility seam

Keep the capacity calculation and pool observation behind the existing
`LifecycleHelper` observer/admission seam, with the configured pool as an
explicit input to the observation. A later pool choice or storage backend
should change that adapter and host policy, not duplicate admission logic or
teach the unprivileged CLI about Incus resource JSON. Keep recovery as a
state transition of an owned allocation, not a second orphan registry.

## Non-goals and anti-patterns

- No new MCP tool, requirement schema, issue-thread workflow, background
  reconciler, database, or Graphify dependency. ADR-027 and ADR-029 govern
  delivery records, not VM runtime state.
- No release of disk on stop, unknown delete result, failed compensation, or
  malformed ledger; no reset-to-empty recovery, unconfirmed owner claim,
  silent audit reset, or success report before persistence.
- No duplicate capacity formula, ledger schema, exception hierarchy, event
  writer, or policy validator; no policy text added only to a skill when the
  helper and setup boundary must enforce it.
- No broad changes to transfer, task, image, registry, or workflow machinery
  beyond preserving their existing ownership and audit contracts when a VM is
  reconciled or deleted.
