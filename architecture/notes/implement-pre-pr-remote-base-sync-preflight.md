# `/implement` Pre-PR Remote-Base Synchronization Preflight

Issue #1421 adds a synchronization boundary between `/implement` Step 8 and
Step 9. The boundary proves that the published feature branch incorporates the
fetched integration branch before the workflow creates a pull request.

This note is architecture preflight guidance. It does not change the workflow,
MCP tools, policy checks, or Git behavior.

## Architecture Decisions

### Keep synchronization inside the `/implement` checkout

Extend the same-checkout MCP mutation boundary established by
`gc_prepare_implement_branch`. The synchronization operation must revalidate
the MCP launch workspace, canonical invocation root, Git directory, origin
identity, active issue branch, and checkout mode before it fetches or merges.
It must operate in the checkout where `/implement` started.

Do not route this operation through `gc_integration_manager`. That tool owns a
different lifecycle: maintainer-approved pull request preparation in isolated
worktrees, with rebase and force-with-lease semantics. `/implement`
synchronization is base-to-feature maintenance in the current feature
checkout. The two operations must not share state, locks, worktrees, or merge
strategies.

Keep Step 8's commit and initial push unchanged. The new boundary follows that
push. A merge commit created by the boundary receives one later ordinary push
before Step 9.

### Fetch the configured remote branch and merge its exact commit

Resolve the integration branch from the existing validated
`workflow.base_branch` value, with `dev` as the existing default. Derive the
source as `refs/remotes/origin/<base>`. Never accept a caller-supplied remote
name, a local `<base>` branch, a tag, `FETCH_HEAD`, or a raw object ID as a
substitute for that source identity.

Fetch with a fixed, explicit refspec from
`refs/heads/<base>` to `refs/remotes/origin/<base>`. Capture the fetched commit
ID immediately after the fetch, and use the full remote-tracking ref for the
merge. A pre-existing `origin/<base>` ref is not freshness evidence. Fetch
failure is a hard, structured refusal.

The operation has three outcomes:

- `already_current`: the fetched commit is already an ancestor of the feature
  head. No commit or second push is necessary.
- `merged_clean`: a real `--no-ff` merge is ready without conflicts.
- `merged_conflicts_resolved`: the merge initially conflicted and the final
  merge commit records the resolution.

Use `--no-commit` for a non-current merge. This leaves both clean and
conflicting merges in the same reviewable state, with `MERGE_HEAD` naming the
fetched commit. The agent can run proportionate checks before it creates the
merge commit. Do not expose a caller-controlled merge option, strategy, or
message seam.

Conflict completion must prove all of the following from Git state, not from a
caller assertion:

- no unmerged index entries remain;
- the active issue branch and checkout identity are unchanged;
- the merge commit's parent set contains the fetched integration commit;
- the pre-synchronization feature head remains in the merge ancestry;
- the resulting feature head is the exact head published to the remote feature
  branch; and
- no rebase, squash, reset, force-push, unrelated-history merge, or
  single-parent replacement satisfies the check.

An unexpected merge failure must preserve inspectable state and return a
structured failure. The tool must not reset, abort, discard, or choose a side
automatically.

### Use one typed synchronization record

Add one versioned issue-thread marker family for the synchronization
attestation. Reuse the existing issue-comment pagination, deterministic
renderer, reserved-marker rejection, sensitive-content screening, body-size
limit, repository identity, and argv-based `gh api` posting helpers.

The record carries at least:

- issue number and feature branch;
- configured integration branch and exact remote-tracking source;
- pre-synchronization feature SHA;
- fetched integration SHA;
- outcome from the closed outcome set;
- resulting feature SHA; and
- an opaque synchronization record ID.

The successful step envelope carries the same values in
`cached_for_next_step`, plus the durable comment URL or ID. Cached state is
handoff data, not proof. The issue-thread record is the durable workflow
artifact under ADR-029. Telemetry JSONL, the issue-thread content cache, a
local state file, Git notes, and a database row must not become alternate
sources of truth.

The parser must accept Git object IDs in the repository's active object format
without weakening equality checks. Use exact lowercase hexadecimal object IDs
and support the Git SHA-1 and SHA-256 lengths. Derive SHAs from Git wherever
possible; never trust a caller-supplied resulting SHA.

Only a completed synchronization receives a durable success record. An
in-progress conflict may return compact cached state, but it must not post a
success marker that could authorize Step 9.

### Put the refusal at the PR side-effect boundary

`gc_render_pr_body` remains the single PR-body renderer. Do not add
synchronization fields to its body schema or make rendering imply permission
to create a pull request.

Route Step 9's PR creation through a repository-bound MCP operation. That
operation consumes the existing rendered body, applies the existing PR body
and title validation, and performs the GitHub write. Immediately before
creation it must:

- fetch the configured integration branch again;
- compare the newly fetched SHA with the trusted synchronization record;
- verify the local feature head and remote feature head both equal the
  recorded resulting SHA;
- verify the record belongs to this issue, branch, repository, and
  synchronization ID; and
- refuse with a stable `next_action` that returns the workflow to the
  synchronization boundary when any identity or SHA differs.

The second fetch closes the race between synchronization and PR creation. If
`origin/<base>` advances after synchronization, the correct result is another
synchronization pass, not a PR against stale evidence. Replaying an older
record is harmless only when its issue, branch, fetched base, local head, and
remote head still match exactly; otherwise the PR operation refuses.

Do not leave a direct `gh pr create` path in the canonical `/implement`
workflow. Skill prose alone cannot enforce the boundary.

### Preserve the final-tree verification boundary

Reuse Step 6's `verified_tree_state` identity. If synchronization returns
`already_current` and the tree identity is unchanged, the successful
completion and policy evidence already applies to the final tree and must not
be repeated.

If synchronization changes the tree, invalidate the earlier Step 6 evidence.
Run targeted tests while resolving or correcting the merge. The synchronization
completion tool then runs the configured completion command and the configured
policy command (`workflow.policy_command`, default `make policy`, issue #1429)
once on the final merged tree before creating the merge commit and publishing
it. It refuses if either broad gate changes the index or checkout and binds the
verified tree ID to the commit and durable record. Do not run the broad gates
after every conflict edit.

The existing Step 7 pre-commit boundary still covers the feature work before
the initial Step 8 publication. Do not silently duplicate the entire Step 7
loop. The final completion and policy gates own integration-interaction
verification for the merge result.

### Bound publish execution and make interrupted state attributable

Issue #1495 extends this design after an async composite pushed its feature
commit, entered base synchronization, and then remained `running` with
`MERGE_HEAD` present after every child process had exited. Process-local
single-flight prevents two retained jobs from starting together, but it is not
a checkout lease, a wall-clock bound, or recovery evidence.

Keep the same-checkout decision above, but hold a dedicated lease for the
authorized per-worktree Git directory across the whole publish action: initial
state check, staging, pre-commit, feature commit and push, base fetch and merge,
final-tree gates, merge commit and push, attestation, and terminal
reconciliation. The lease is distinct from `/integrate`'s repo-wide lock and
must not serialize independent linked-worktree indexes. Reuse the repository's
heartbeat-backed filesystem-lock primitive, promoted out of its current
knowledge/integration-specific home now that publish is its third real caller;
do not copy lock acquisition, stale detection, or release handling into the
mechanical tool. In-process `executionScope` remains a fast contention check,
while the filesystem lease is the cross-process enforcement boundary.

Before the first checkout mutation, create a small versioned recovery journal
under the authorized per-worktree Git metadata, outside the working tree. Write
it atomically and update it before and after each mutating phase. Its closed
shape carries only:

- opaque synchronization attempt/record ID and issue/branch/base identity;
- pre-publish `HEAD`, the successfully published pre-sync feature head, and the
  freshly fetched base SHA when each becomes known;
- the expected merge head and a closed phase name;
- timestamps needed to diagnose staleness; and
- the last terminal/recovery classification.

Do not store an idempotency key, command, output, environment value, credential,
origin URL, diff, file content, or arbitrary error prose. The journal is
operational recovery state, not an ADR-029 workflow record and not PR authority.
Only a completed, trusted issue-thread synchronization attestation satisfies
Step 9. Remove the journal only after the feature head is verified published,
the success attestation is settled or idempotently recovered, and Git reports
no operation head or unexpected checkout residue.

Thread one internal execution context (`AbortSignal`, server-owned deadline,
and bounded progress reporter) through the existing publish, Git, verification,
and posting seams. Every reachable subprocess must honor it end to end and must
settle only after its process group is empty. Extend the canonical streaming
gate runner with the existing process-group termination behavior rather than
creating another subprocess wrapper or exception shape. The deadline belongs
in the generic async-job options as a validated server-provided duration, with
the publish action selecting a finite constant; do not expose a timeout MCP
input or add a `.ground-control.yaml` key. That options seam lets another
mechanical action adopt a different server-owned bound later without editing
the registry contract.

Cancellation and timeout mean “stop safely and reconcile,” never “roll back.”
After the abort signal, wait for child cleanup while retaining the lease, then
inspect the active branch, `HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD` and other Git
operation heads, unmerged index entries, staged/unstaged state, the journal,
and the remote feature head. Return the ordinary terminal mechanical envelope:

- clean, fully verified/published state is an idempotent success;
- a journal-matching merge is `agent_required: true` with the existing
  base-sync `retry_input` plus bounded exact state; and
- missing, mismatched, unrelated, or ambiguous operation state is
  `agent_required: true` with a refusal that preserves the checkout for
  inspection.

The same inspection runs when a new publish invocation finds an operation head
or recovery journal, so MCP process loss cannot make a later run blindly stage,
commit, abort, or misattribute the preserved merge. A caller-supplied
`synchronization` object still passes the existing Zod shape and base-sync
semantic checks; journal state cannot weaken SHA, issue, branch, repository, or
merge-parent validation. An internal unforgeable lease capability lets the
composite call the directly callable base-sync primitive without reacquiring
its own lock; no public boolean or token may bypass lease acquisition.

Polling stays a generic transport surface. Expand its closed progress phase
vocabulary only for stable publish phases and keep repository reconciliation in
the publish service, not in `pollAsyncJob`. A poll is not allowed to infer
liveness merely from `status: running`; the registry deadline and the publish
cleanup/reconciliation promise determine termination. Timeout and cancellation
remain `not_evaluable` station attempts, not gate failures, and add no station,
workflow state, marker family, exception hierarchy, or telemetry schema.

**Delivered scope (issue #1495).** The cancellation and server-owned-deadline
guidance above is the target end state, not what shipped. Making cancellation
honest requires the abort context to reach every Git/gate/GitHub subprocess;
partial coverage (abort reaching only the final-tree gates) would let a
cancellation keep mutating before the next gate and report a terminal status
without proving reconciliation, so review kept `publish` `job_not_cancellable`
and dropped the signal-driven deadline. What shipped closes the reported hang
structurally: the shared gate runner runs each gate as its own process-group
leader and reaps the group when the leader exits (so a leaked descendant can no
longer hold the stdout pipe after every visible child exits); `publish` holds a
per-worktree heartbeat lease across its mutations; a required, versioned
write-ahead recovery journal (secure-temp write) records the attempt; the
base-sync completion re-reads `HEAD`/`MERGE_HEAD` immediately before the merge
commit (compare-and-swap); and a fresh authorized `publish` reconciles a
leftover journal, resuming a journal-matching merge through the base-sync
`retry_input`, clearing a stale journal on an ordinary dirty tree, and refusing
mismatched/foreign/corrupt state without mutating. Full-graph abort, and only
then a genuine deadline and cancellation, are prerequisites this change does not
claim. See ADR-036's 2026-08-13 amendment.

## Cross-Cutting Concerns to Reuse

- **Configuration:** `gc_get_repo_ground_control_context`, the strict
  `.ground-control.yaml` parser, `workflow.base_branch`, and
  `isSafeGitRefName`. Harden the canonical safe-ref validator if it does not
  reject option-shaped names; do not add a synchronization-only ref validator.
- **Repository authorization:** `ensureGitRepo`, launch-time workspace
  authorization, `authorizeImplementRepoRoot`, `readGitIdentity`,
  `getOwnerRepo({allowGhFallback:false})`, realpath equality, origin equality,
  and the existing issue-branch validator.
- **Git execution:** `execFile` with fixed argv elements and an explicit
  `cwd`, `assertSafeImplementCheckoutConfiguration`, disabled hooks and
  external merge configuration, and non-interactive credential behavior.
  Keep network authentication in the host Git or `gh` credential boundary;
  never place a token in argv.
- **Async execution and process cleanup:** `startAsyncJob`, `gc_codex_job`, the
  existing idempotency/fingerprint/execution-scope options, `process-group.js`,
  the model-subprocess TERM-to-KILL cleanup contract, and the shared streaming
  gate runner. Cancellation must reach these incumbents rather than creating a
  publish-only child-process abstraction.
- **Filesystem coordination:** the existing `proper-lockfile`-backed primitive,
  canonical realpath identity, heartbeat/stale handling, and idempotent release
  handle. Give publish its own per-worktree lock namespace; do not reuse the
  integration-manager lock or rely on the in-memory job map across processes.
- **Durable records:** paginated issue-comment reads,
  deterministic marker rendering, trusted-author or effective-permission
  checks, reserved-marker rejection, sensitive-content screening, bounded
  fields, and stable structured refusal envelopes.
- **PR contract:** `runRenderPrBody`, `validatePrBodyInput`,
  `checkPrBodyShape`, the existing `workflow.pr_title` configuration, and the
  canonical GitHub-repository identity derived from origin.
- **Verification:** proportionate narrow tests, Step 6's exact tree identity,
  the configured completion command, and the configured policy command.
- **Observability:** existing MCP tool-call telemetry and the durable issue
  record. Do not add SLF4J, a local audit log, or another telemetry schema.

The Java `api/ -> domain/ <- infrastructure/` boundary is not crossed. No
controller, command DTO, service, aggregate, repository, database migration,
Spring validation, Zod schema, `ErrorResponse`, `GlobalExceptionHandler`,
ActorHolder, or frontend change belongs in this work.

## Security and Validation Layers

- **MCP input shape:** use positive issue numbers, the existing branch and
  base-ref constraints, an absolute invocation root, a closed action and
  outcome vocabulary, bounded title/body fields, and an opaque record ID.
  Apply Zod at registration and semantic validation in the library runner.
- **Configuration shape:** obtain the base branch only through the canonical
  context parser. The safe-ref rule must reject control characters, ref
  ambiguity, traversal-like components, and leading option syntax. Do not
  parse YAML in a skill, hook, or new module.
- **Repository and authorization:** bind every mutation and GitHub write to
  the MCP launch checkout and origin. `GH_REPO` is not a fallback or alternate
  destination. Detached HEAD, the wrong issue branch, another worktree, origin
  drift, an active unrelated merge, or a dirty pre-boundary tree must fail
  closed.
- **Git ref and graph validation:** use full ref names and exact object-ID
  equality. Check ancestry and merge parents with fixed Git argv. Never infer
  freshness from local `dev`, the presence of `origin/dev`, equal branch
  names, or a caller claim.
- **Git process execution:** do not use a shell, command interpolation, Git
  aliases, caller-provided merge flags, hooks, custom merge drivers, editors,
  checkout-selected signing programs, or interactive prompts. Allow only the
  host-controlled credential path needed for fetch and push, and the host's own
  commit-signing configuration (issue #1580). Scrub command failures before
  returning them.
- **Secret and OS exposure:** authentication remains in the host environment
  or credential store. Do not return the raw origin URL, environment, Git
  configuration, credential-helper output, or full command failure. Validate
  and screen PR and issue bodies before passing them through `gh` argv.
- **Durable marker trust:** a marker grants PR-creation authority, so raw
  marker text from an arbitrary commenter is insufficient. Reuse the
  authenticated-poster or effective repository-permission checks used by
  authorization-bearing issue records. Reject malformed, duplicate-conflict,
  wrong-issue, wrong-branch, and unknown-schema records.
- **Error surface:** expected fetch, identity, conflict, stale-base,
  unpushed-head, and missing-record conditions return stable
  `{ok, error, message, next_action}` envelopes. This is an MCP host boundary,
  not an HTTP boundary, so the Java exception hierarchy and web error envelope
  do not apply.
- **Recovery persistence:** derive the per-worktree Git metadata directory only
  after repository authorization; reject symlink/path escape, use restrictive
  permissions and atomic replacement, validate the versioned journal on every
  read, and expose no host path. Corrupt or mismatched state fails closed and is
  never silently deleted.
- **Async error envelope:** preserve the generic job/result layering and the
  mechanical `failure()` bounds plus sensitive-content screening. Cancellation
  becomes terminal only after cleanup and returns exact bounded Git facts under
  the mechanical result; raw command errors and journal/lock paths stay out of
  both progress and terminal responses.

The MCP tool is still not an OS sandbox. Host filesystem permissions, trusted
Git installation, credential-store ownership, and process isolation remain the
controls against binary replacement, credential-helper tampering, or a process
racing the worktree. Do not claim that argv validation closes those host-level
threats.

## Policy and Test Contract

- Add focused MCP unit tests with injected process and GitHub dependencies for
  the exact argv sequence, structured errors, record parsing, trust checks,
  and PR refusal behavior.
- Add temporary-repository Git tests for already-current, clean divergent,
  conflict-resolution, wrong-parent, dirty-tree, detached-head, and remote-head
  mismatch behavior. Mocked SHA strings alone cannot prove the merge graph.
- Pin fetch failure and stale-local-ref cases. A local `dev` that points at the
  desired commit must not satisfy the boundary when the fetch fails or
  `origin/dev` differs.
- Pin the race in which the integration branch advances after synchronization
  but before PR creation. The PR operation must return to synchronization.
- Pin cancellation and timeout in every publish phase, including a child that
  spawns descendants. Prove the process group is empty before the lease is
  released or the job becomes terminal.
- Use temporary Git repositories to pin clean interruption, matching lingering
  `MERGE_HEAD`, unresolved conflicts, committed-but-not-pushed merge, pushed but
  unattested merge, stale/corrupt journal, unrelated operation head, lock
  contention, stale-lock takeover, and restart-time reconciliation. Assert that
  no case stages, commits, pushes, posts, aborts, or deletes ambiguous state.
- Extend repo policy so the canonical step order, cached fields, durable
  record, MCP PR-creation call, and absence of direct `gh pr create` cannot
  drift independently.
- Synchronize `skills/implement/SKILL.md`, the new step file, workflow docs,
  ADR-021, ADR-027, ADR-029, ADR-036, MCP README and tool descriptions, policy
  checks, and their tests in the implementation. Preserve explicit
  `/quickfix` and `/integrate` behavior.

These are MCP and host-Git tests. `@WebMvcTest`, `@SpringBootTest`,
Testcontainers, backend repository tests, and frontend tests do not apply.

## Gotchas and Anti-Patterns

- Do not use `git fetch origin <base>` without an explicit destination and
  then assume it updated `refs/remotes/origin/<base>`.
- Do not compare against local `dev`, accept same-OID aliases, or merge a raw
  SHA while claiming the source identity was `origin/dev`.
- Do not post a generic `gc:phase` marker that drops the required SHAs and
  outcome, or create a second cache as durable state.
- Do not treat `gc_render_pr_body` success as synchronization evidence.
- Do not let caller-provided cached state authorize PR creation without
  re-reading a trusted issue record and current Git state.
- Do not auto-resolve conflicts with `ours` or `theirs`, abort an unexpected
  merge, rebase, squash, reset, force-push, or discard feature work.
- Do not broaden the integration-manager abstraction or reuse its worktree,
  rebase, lock, or force-with-lease model.
- Do not treat async-registry single-flight as a filesystem lease, release the
  lease before child-tree cleanup and reconciliation, or make a fixed sleep/poll
  count stand in for a deadline.
- Do not mark a job cancelled merely because an abort signal was sent, and do
  not report `running` indefinitely after the deadline or after every child has
  exited.
- Do not auto-run `git merge --abort`, delete a corrupt journal, adopt a merge
  whose recorded SHAs do not match Git, or allow public input to claim an
  internal lease.
- Do not persist commands, output, diffs, credentials, environment values,
  idempotency keys, raw origin URLs, or free-form exception text in recovery
  state, progress, telemetry, or issue markers.
- Do not duplicate base-branch, PR-body, title, sensitive-content, repository,
  or error-envelope validation in a new module.
- Do not run completion and policy repeatedly during conflict editing, and do
  not reuse pre-merge evidence after the tree changes.

## Non-Goals

- No pull request merge, approval, auto-merge, queueing, or protected-branch
  write.
- No change to `/integrate` worktrees, rebases, locks, modes, or merge
  authority.
- No new `.ground-control.yaml` key, remote selector, merge-strategy option, or
  per-repository synchronization/timeout mode.
- No backend REST endpoint, database persistence, frontend surface, workflow
  engine, or generic Git abstraction.
- No automatic conflict choice, history rewrite, destructive recovery, or
  host bootstrap change.
- No promise of transactional Git/GitHub atomicity across host or network
  failure. The guarantee is bounded execution, exclusive checkout mutation,
  attributable phase state, and safe deterministic reconciliation.
