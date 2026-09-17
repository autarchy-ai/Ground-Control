# Tiered Publish Verification Preflight

> Superseded by #1629: CI owns broad verification; local attestations, fingerprints, and phase caches are retired.

Issue #1497 reduces repeated repository-wide verification without reducing the
coverage of the final published tree. This note is architecture guidance only.
It does not implement an attestation, configuration key, command runner,
progress reporter, or workflow change.

## Architecture Decisions

### Keep the verification layers distinct

The workflow has four different verification roles. Do not collapse them into
one generic cache or gate result.

- Step 5 targeted checks give fast edit feedback. They are proportionate to the
  changed behavior and do not authorize publication.
- The configured completion and policy commands are the authoritative local
  full verification. Their successful result may be reused only through the
  content-bound attestation below.
- `workflow.precommit_command` is the publish-time, mutation-sensitive layer.
  It still runs on every publish attempt. A repository may keep a full
  all-files hook here, but a repository that wants the tiered fast path should
  configure this command to contain the hygiene, secret, formatting, and other
  mutation-sensitive checks not already owned by full verification.
- CI and SonarCloud remain independent remote gates. A local attestation never
  suppresses or satisfies them.

The existing `completion_command`, `policy_command`, and `precommit_command`
fields already name these phases. Do not add a second command taxonomy or infer
overlap by comparing command text. Two different command strings can run the
same broad suite, and identical strings can observe different inputs.

### Add one verification-attestation record

Use a new versioned issue-thread marker family for successful full
verification. It is a different fact from
`gc.implement.remote-base-sync/v1`: verification says that specific inputs
passed specific gates, while base synchronization says that the published
feature branch incorporates a freshly fetched base. Do not add verification
fields to the synchronization schema or treat its current `verifiedTreeSha`
field as proof that the gates ran.

The attestation identifier is the SHA-256 digest of one canonical, versioned
record. The record binds at least:

- the canonical `owner/repository` identity, issue number, and issue branch;
- the freshly fetched configured base commit;
- the exact Git tree object that passed the gates;
- a digest of the authorized requirement context, including an explicit
  requirement-free sentinel;
- a digest of the normalized completion command, policy command, relevant
  normalized configuration, and attestation schema version; and
- a repository-supplied toolchain-input digest.

Only digests and safe Git or workflow identities belong in the durable marker.
Do not publish configured commands, raw environment values, tool versions,
child output, or the requested requirement UID. The UID continues to reach
repository gates only through `ACES_REQUIREMENT_UID`; its digest binds the
attestation without moving the raw value into argv, telemetry, or GitHub text.

Post only successful attestations. Before posting, reuse the existing
repository authorization, issue-comment pagination, trusted-author checks,
reserved-marker handling, sensitive-content screening, body-size bound, and
argv-based `gh api` helper. A repeated identical content identifier is an
idempotent hit, not a second gate attempt. A malformed, conflicting, untrusted,
or ambiguous record never authorizes reuse.

The issue thread is the durable workflow record under ADR-029. The async job
registry and issue-thread content cache remain bounded process-local transport
state; neither may become verification authority. Do not introduce a local
state file, Git note, database, backend service, or telemetry row as a second
attestation store.

### Attest the publish candidate, not an approximate working-tree status

`git status` text, `HEAD`, a diff pathname list, and the async input fingerprint
are not content identities for an uncommitted candidate. Before full
verification, screen sensitive paths with the existing publish predicate, stage
the complete candidate, require no unstaged or untracked content, and derive the
tree object from the Git index. This reuses the same tree identity that
`runImplementFinalTreeGates` already compares with a merge commit.

The completion and policy commands must observe that staged candidate. After
each gate, prove that the index, worktree, untracked set, base binding, and
toolchain-input digest remain unchanged. A formatter or generator that changes
the checkout invalidates the attempt; it does not produce an attestation for
the pre-mutation tree.

Ignored or host-level inputs are not represented by the Git tree. Safe reuse
therefore needs one narrow extension under the canonical config parser:
`workflow.verification.toolchain_fingerprint_command`. The command must emit
exactly one lowercase SHA-256 value for every non-tree input that can change a
gate result, such as interpreter/compiler versions, lock-resolved environments,
containers, generated schemas, or ignored build inputs. Its configured command
text is included in the config digest, while only its validated digest output is
stored. Reuse is disabled when the command is absent, fails, emits any other
shape, or omits an input the repository cannot otherwise prove immutable. This
single command is the extensibility seam for different language toolchains; do
not add language, package-manager, or build-system fields to Ground Control.

The new nested config must preserve the current strict parser behavior:
unknown keys, scalars in place of mappings, empty commands, and unsupported
types fail closed. Repositories without the block retain current behavior and
receive no reuse claim.

### Revalidate at every mutation boundary

Publish receives an attestation identifier as handoff data, not as proof. The
MCP server re-reads a trusted record and recomputes every bound input from the
authorized checkout before it can skip full verification.

The configured precommit command still runs after a hit. Publish then recomputes
the staged tree and checkout state. If the hook formatted, generated, staged,
unstaged, added, or removed anything, publish stops with a structured stale-
attestation result. It must not commit first and verify later. After commit,
`HEAD^{tree}` must equal the attested tree before push.

Base synchronization performs the same comparison after its fresh fetch. An
`already_current` result may reuse the attestation only when the fetched base
and every other binding still match. A merge or conflict resolution changes the
tree and therefore runs the shared full-verification path once on the final
staged merge tree, producing a new attestation before the merge commit and
ordinary push. Do not retain a second implementation of completion/policy
execution inside the synchronization module.

Any base, tree, requirement context, normalized config, command, schema, or
toolchain-input change is a cache miss. Missing evidence is also a miss. The
fallback is full verification, never an agent assertion or a relaxed comparison.

### Extend the existing async progress surface

`gc_codex_job` is the polling surface for long mechanical work. Extend its
bounded running envelope with one closed progress snapshot rather than creating
a telemetry service or reviving the retired ADR-061 backend model. The snapshot
may identify the current phase, phase start, elapsed time, last child-output
activity, and bounded byte counts. It must not include command strings, raw
stdout/stderr, paths from failure output, environment values, process IDs, or
credentials.

Use the existing size-safe `runGateCommand` stream-draining boundary for long
repository commands and give it a progress callback. The terminal mechanical
envelope should carry one timing list with stable phase names, duration, and
outcome, plus the dominant completed gate. The running snapshot and terminal
timings are two views of the same measurements, not separate schemas.

A periodic snapshot proves only what it states: the MCP process is reporting a
phase and the last observed child activity. It is not a lease, cancellation
proof, or evidence that a silent child is healthy. Mechanical jobs remain
non-cancellable until the entire shell, Git, GitHub, polling, and child-process
tree honors an abort signal.

## Cross-Cutting Concerns to Reuse

- **Configuration:** `parseGroundControlYaml`, `normalizeWorkflowConfig`,
  `emptyWorkflowConfig`, strict unknown-key rejection, and
  `gc_get_repo_ground_control_context`. Do not parse YAML in a skill or a gate.
- **Repository and Git safety:** `ensureGitRepo`, realpath-based launch-workspace
  authorization, `authorizeImplementRepoRoot`,
  `assertSafeImplementCheckoutConfiguration`, the issue-branch validator,
  explicit fetch refspecs, exact SHA-1/SHA-256 object equality, and index-tree
  comparison.
- **Gate execution:** `implementGateEnvironment`,
  `resolveWorkflowPolicyCommand`, `resolveWorkflowPrecommitCommand`,
  `runGateCommand`, the no-tree-change guards, and the existing structured gate
  artifact readers. Completion, policy, precommit, and final-tree verification
  must not grow separate runners or error formats.
- **Durable records:** the synchronization marker renderer/parser and trusted
  issue-comment reader are the shape to follow, together with
  `detectSensitiveBodyContent`, the GitHub comment size limit, and argv-based
  posting. The verification schema remains distinct from base synchronization.
- **Async execution and errors:** `startAsyncJob`, single-flight checkout scope,
  idempotency fingerprints, bounded process-local retention, `failure`,
  `commandFailure`, and stable `{ok, error, message, next_action}` envelopes.
  Do not add an exception hierarchy for expected misses or gate failures.
- **Workflow contracts:** the shared mechanical actions used by `/implement` and
  `/quickfix`, the Step 5/6/7 ownership split, and
  `run_implement_execution_contract`. Skill prose follows MCP enforcement; it
  is not the cache trust boundary.

## Security and Validation Layers

- **Tool input:** Zod continues to bound action, repository path, issue, branch,
  requirement UID, idempotency key, and any attestation identifier. Semantic
  checks rebind those values to the canonical checkout and issue before reads,
  commands, or GitHub writes.
- **Config shape:** the canonical YAML parser alone admits the fingerprint
  command. The command is repository-authored, never caller-interpolated, and
  must not contain credentials because `bash -c` makes configured command text
  visible in process argv.
- **Secret handling:** do not hash the inherited environment wholesale. A hash
  of a low-entropy secret is still disclosure material. The repository's
  fingerprint command owns an explicit non-secret input set and returns only a
  digest. Gate credentials remain in the host environment or credential store.
- **OS exposure:** Git and GitHub side effects keep fixed argv, explicit `cwd`,
  non-interactive behavior, safe Git configuration, and host-owned credential
  resolution. Raw commands and child transcripts never enter the attestation,
  progress envelope, timing envelope, or issue comment.
- **Error leakage:** expected invalidation and command failure use the existing
  bounded, sensitive-content-aware mechanical envelope. Do not return the full
  environment, command, fingerprint input, origin URL, or unbounded child tail.
- **Host boundary:** an attestation does not sandbox the host. Binary
  replacement, credential-helper tampering, and concurrent out-of-process
  worktree mutation remain host controls; exact before/after checks only make
  detected mutation fail closed.

## Whole-Repository Guardrails

The implementation will intersect the config parser and context response, the
mechanical verify/publish actions, the shared gate runner, async job polling,
base synchronization, trusted issue-thread records, MCP tool descriptions, both
workflow lanes, workflow documentation, and the repo-native execution-contract
policy. Keep those surfaces synchronized and protect them with the existing
Node tests, temporary-repository Git tests, parser tests, tool-description tests,
and Python policy tests.

Do not use the historical backend, database, REST, Spring security, frontend,
ADR-061 telemetry, or ADR-090 measurement surfaces as incumbents. The
architecture ADR index marks those layers as removed by issue #1500. The current
runtime is the MCP server over repo-local files, Git, and the GitHub issue
thread.

## Gotchas and Anti-Patterns

- Do not call a boolean such as `completion_passed` an attestation.
- Do not attest `HEAD` while the candidate contains staged, unstaged, or
  untracked differences that the commit tree does not represent.
- Do not trust a caller-returned attestation object without re-reading its
  trusted durable record and recomputing current inputs.
- Do not skip the configured precommit layer on a cache hit or accept a hook
  mutation under the old digest.
- Do not reuse Step 6 evidence after a review fix, formatter change, base fetch,
  merge, config edit, requirement-context change, or toolchain change.
- Do not infer toolchain identity from Node alone when the repository gate can
  invoke Python, Java, containers, or another runtime.
- Do not put cache logic only in `skills/implement`; `/quickfix` shares the same
  mechanical boundary, and the MCP server owns enforcement.
- Do not turn progress ticks into a liveness or cancellation claim.
- Do not run completion and policy through separate implementations in Step 6
  and base synchronization.

## Non-Goals

- No reduction of the final local verification coverage and no change to CI or
  SonarCloud authority.
- No automatic dependency graph, language detector, package-manager registry,
  or interpretation of arbitrary precommit configuration.
- No cache shared across repositories, branches, issues, base commits,
  requirement contexts, configurations, or toolchains.
- No workflow engine, backend service, database, local attestation file, Git
  note, or restored telemetry projection.
- No cancellation claim for mechanical jobs and no automatic recovery from an
  unresponsive external command.
- No changes to `/integrate`, PR merge authority, or protected-branch policy.

## 2026-09-17 implementation extension (issue #1626)

The original design optimized only publish/base-sync reuse. Issue #1626 extends
the same content identity to repeated `verify` calls and committed-merge
recovery. A trusted full attestation skips both local broad gates. Successful
individual phases are retained in a bounded process-local cache under the same
candidate identity, allowing a policy retry to reuse completion without
claiming durable cross-process evidence. Each phase rechecks tree, status, and
toolchain identity before it becomes reusable. A process restart or any input
change is a miss.

The result envelope now identifies whether verification executed or was reused,
why, and how many broad gates actually ran. Ground Control opts into the feature
with `tools/verification-fingerprint.mjs`, which binds the Node and Python
versions plus the repository files that determine dependencies and lint/hook
behavior. Publish continues to run one explicit configured pre-commit boundary;
the following mechanical Git commit has hooks disabled so it cannot repeat that
boundary.
