# ADR-097: Reserve versioned artifact-release identities in a repository log

- **Status:** Accepted
- **Date:** 2026-09-14
- **Issue:** #1579
- **Requirement:** GC-O017
- **Supersedes:** none
- **Preflight amendment:** 2026-09-14: separate append position from release
  sequence; tighten replay, publication, and transport contracts before implementation.

## Context

Two valid `/implement` runs can start from the same integration-branch state and
both derive the same "next" evidence version and path. The conflict appears only
when the second branch merges the first. A checkout-local lock cannot prevent it:
the contenders may use different worktrees, MCP processes, or hosts. A GitHub
issue comment is durable, but posting and then scanning comments does not provide
an atomic unique claim.

Ground Control has no database or workflow-run service. Its MCP server is the
privileged GitHub/Git actor, `.ground-control.yaml` is the repository configuration
contract, and the issue thread is the durable `/implement` record (ADRs 027 and
029). The reservation facility must fit those boundaries without turning evidence
capture into a server-side file mutation or weakening any delivery gate.

This identity is also distinct from the repository's product version. Release
Please remains the sole owner of `.release-please-manifest.json`, `CHANGELOG.md`,
the `vX.Y.Z` product tag, and GitHub Releases (ADR-063). An evidence release may
look like SemVer, but it is not a product release.

### The compare-and-swap GitHub actually provides

The first draft of this decision kept one linear log per family and advanced it
with `PATCH /git/refs` and `force: false`, expecting GitHub to reject a sibling
commit as a non-fast-forward. A live check against this repository on 2026-09-14
showed that expectation is not a safe foundation. `POST /git/refs` refused an
existing name with `422 Reference already exists`, which is a real
create-if-absent. A `force: false` update of a custom-namespace reference to a
sibling commit, which is not a fast-forward, **succeeded** and silently replaced
the head. Two contenders building on the same head would both "win," and the
second would erase the first reservation. The decision below uses only the
primitive that was observed to be atomic: reference creation.

## Decision

### Configuration and base authority

Add an optional top-level `release_families` mapping to the existing
`.ground-control.yaml` schema. Absence means the facility is disabled. Each named
family declares only the data needed to derive an identity:

```yaml
release_families:
  formal-semantic-validation:
    base_branch: dev
    sequence_floor: 11
    version_template: "{sequence+1}.0.0"
    paths:
      bundle: "docs/research/formal-semantic-validation/bundles/retest-v{sequence}.json"
```

- A family name is a lowercase identifier (`[a-z0-9-]`, at most 40 characters)
  because it becomes a reference-name segment. A path key is a lowercase
  snake-case identifier.
- `base_branch` is optional and defaults to `workflow.base_branch`, then `dev`.
  It must be a safe Git ref name.
- `sequence_floor` is a positive integer: the first allocatable sequence at
  opt-in, not a mutable counter. After the first claim the reservation log is the
  high-water mark.
- `version_template` contains exactly one sequence token. A sequence token is
  `{sequence}` or `{sequence+K}` / `{sequence-K}` for an integer `K` from 1 to
  9999, so a family whose version and file numbers differ by a fixed offset (the
  RAE formal-semantic-validation bundles, where `retest-v9` preserves release
  `10.0.0`) is expressible without a template language. Literal characters are
  limited to `[A-Za-z0-9._+-]`.
- `paths` maps between one and sixteen keys to repo-relative path templates. Each
  contains at least one sequence token or `{version}`, uses only
  `[A-Za-z0-9._/-]` literals, and has no empty, `.`, or `..` segment. A rendered
  path is checked again with the existing lexical and realpath containment rules
  against the checkout before a new reservation is returned. Git metadata paths
  (`.git` segments, including case variants) are forbidden.

`parseGroundControlYaml` and `gc_get_repo_ground_control_context` remain the only
configuration parser and context surface. The new block has strict unknown-key
rejection and one normalizer imported by the canonical parser.

The normalizer owns template grammar, bounds, rendering, and canonical digest
input; transport and stored-event validation reuse that contract. Reject unsafe
integer arithmetic, non-positive rendered sequence terms, unmatched tokens,
duplicate rendered paths, and file/directory prefix conflicts. Bound mapping
sizes, template lengths, rendered lengths, and decoded YAML bytes. Treat mappings
as own-key records, including keys such as `constructor`; never merge untrusted
YAML into prototypes. Hash a deterministic serialization of the normalized
definition, including effective defaults and sorted path keys, not YAML spelling
or insertion order. These templates are data, never executable expressions.
Normalizer diagnostics use bounded field labels without echoing submitted values,
since the context tool also returns parser errors directly.

The caller never supplies a repository, base branch, base revision, version, or
path. The server resolves the family's `base_branch` head through the authorized
repository's REST API and pins that commit for the operation. The family
definition used for allocation is read from `.ground-control.yaml` **at that
commit**, so a feature branch cannot redefine a family it is about to reserve
from. A family present only locally, or whose base definition names a different
base branch, is refused. Each reservation records the base commit and a SHA-256
digest of the normalized family definition, so later base advancement cannot
rewrite its meaning.

The local context is only a branch-discovery hint. Resolve an exact `heads/`
reference, then read the configuration as a bounded regular-file blob at the
resolved commit and pass its text through the canonical parser. Do not inline
remote plan-rule paths against the host filesystem. Assert any `github_repo`
declaration against the authorized repository. Refuse a base-definition mismatch
instead of following a chain of branch redirects. This trusts repository writers'
remote family definitions; self-consistency is not proof of branch protection.
Replay and terminal transitions use the stored claim even if current configuration
has removed or changed the family.

### Atomic repository log

Each repository/family owns a reference namespace outside branches and tags:

```text
refs/gc/release-identities/<family>/claims/<slot>
refs/gc/release-identities/<family>/outcomes/<slot>
```

A custom namespace, rather than `refs/heads/...`, keeps the log out of branch
lists, branch rulesets, stale-branch cleanup, and `push`-triggered workflows in
consumer repositories.

- **Append position.** Slots are internal log positions, contiguous from `1`;
  they are not public release sequences and are never caller-selected. All
  contenders for the next append compete on the same slot, even if they resolved
  different base commits or sequence floors. Naming references by the configured
  sequence is unsafe: a delayed floor-11 call can create `claims/11` after a
  floor-20 call creates `claims/20`, violating monotonic allocation. Slots remove
  that race without a second lock or authority.
- **Claim.** Reserving sequence `N` at slot `S` creates `claims/S` pointing at a claim commit
  whose tree is the base commit's tree, whose only parent is the base commit, and
  whose message carries the server-rendered `reserved` event and the preceding
  slot's claim SHA (null only at slot 1). Two contenders race on one create;
  the loser refolds the winning prefix, checks idempotency again, and only then
  considers the next slot, within a bounded number of attempts.
- **Outcome.** A terminal transition creates `outcomes/S` pointing at an outcome
  commit whose only parent is the claim commit. Because the outcome is also a
  create-only reference, `published` and `abandoned` cannot both succeed for one
  identity, and a repeated identical transition is recognized rather than
  duplicated.
- **Allocation.** The next sequence is `max(sequence_floor, highest claimed
  sequence + 1)` (the floor at slot 1). A complete validated prefix precedes
  every append; stale prefixes can only race on an already occupied slot, never
  fill a lower sequence after a higher one wins. Every claim remains in the
  high-water mark whatever its outcome, so an identity is never recycled. Claims
  are never updated or deleted; exhaustion is a refusal, not numeric wraparound.
- **Validation.** Folding the log verifies every commit: a parseable event of the
  supported schema naming this repository, family, slot, and sequence; the
  predecessor SHA and increasing sequence; the documented parent; the parent's
  tree; the normalized definition and digest; and an outcome that agrees with
  its claim's identity. A malformed event, duplicate idempotency identity, slot
  gap, outcome without a claim, or unexpected reference fails closed. Nothing
  repairs, rewrites, or reinitializes the log. Store the normalized definition
  with the claim so rendering and digest validation do not depend on live config.

An unsuccessful create is not necessarily contention. GitHub documents `422`
for validation and abuse failures too. Read the exact reference after a conflict,
timeout, or lost response: a validated matching winner resolves success or
contention; absence or an unreadable result does not authorize advancing to a new
slot. Retry the same undecided create or return a bounded recovery envelope.
Unreferenced commit objects are not claims. This applies equally to outcomes.
See the [Git references API](https://docs.github.com/en/rest/git/refs).

Event commits change coordination metadata only, never project or evidence files.
Parsed commits may be cached by commit SHA with a bounded cache. Mutable ref
inventories, absent outcomes, and issue-comment absence are never durable cached
truth. Read complete inventories from the exact family namespace, sort positions
numerically, and reject malformed or incomplete responses. A public `status`
page or a truncated listing is never an allocation prefix.

A repository writer can delete any reference with ordinary Git permissions; this
facility does not claim to defend against the repository's own writers. The
server does refuse to claim an identity whose derived paths already exist at the
base commit, so a deleted claim or an unreserved publication cannot silently
produce a second artifact at the same path.

Also refuse a version or path already owned by another claim in this family,
including abandoned claims: a template change must not recreate an older output
that has not reached the base branch. A collision is a configuration/ownership
failure, not permission to probe for another free version. Family owners must
keep different families' output namespaces disjoint, including across definition
changes. Per-family sequencing does not provide cross-family path exclusivity;
do not imply that it does or add a repository-wide allocation lock.

### Idempotency and lifecycle

Expose one action-multiplexed MCP operation, `gc_release_identity`, with
`reserve`, `publish`, `abandon`, and a read-only `status`. The mutating actions
take `repo_path`, a positive `issue_number`, `family`, and a bounded
`idempotency_key`; `abandon` also takes a closed reason code
(`capture_not_needed`, `generation_failed`, `superseded`, `run_abandoned`). The
registration follows the zod-schema plus thin-handler pattern; the library
function independently validates its inputs.

The durable idempotency identity is
`(authorized repository, family, issue_number, sha256(idempotency_key))`. Only the
hash is persisted, so caller text never enters public Git metadata. `reserve`
folds the log first; a claim with that identity returns its stored sequence,
version, paths, base commit, and family digest without claiming again, and
without recomputing anything from newer configuration. This lookup precedes
new-claim checks such as an open issue, enabled family, or absence of output
files. It returns terminal reservations too. The contiguous-slot protocol must
prevent duplicate claims before returning an identity; choosing the lowest
duplicate later could invalidate an identity already returned or published.
`duplicate_claim` is therefore not an automatic abandonment reason. The in-memory
async-job registry is not reservation persistence, and the key is not a credential
or authorization capability.

**Run authority.** The issue, family, and key are caller-supplied and predictable:
plans name the key, and the issue record publishes its hash. They identify a
reservation; they do not authorize a mutation that asserts something about a run.
The run is the issue branch checked out in the launch workspace and its durable
`/implement` pickup association on the issue thread. The server reads the active
branch itself (`git symbolic-ref HEAD`), never from the caller, and accepts the
association only from a pickup record authored by its authenticated GitHub
identity. `reserve` requires the trusted pickup branch to be
`<issue_number>-<slug>` and records it in the claim; merely creating a local
issue-shaped branch grants no authority. `abandon` burns an identity on a claim
about a run's intent, so it requires the active branch to equal both the recorded
claim branch and the trusted pickup branch. A run working another issue in the
same workspace therefore cannot reserve for, or abandon, this issue's
reservation. `publish` records only facts the server verifies at the base head,
and it runs after merge, when the issue branch is often gone, so any run may
record it. Replay is read-only apart from posting missing records. A reservation
whose branch was deleted is abandoned by restoring its trusted pickup record and
checking the recorded branch out again.

**Self-validated writes.** Every event is rendered, then parsed back by the same
validator the fold uses, before its commit is created. A template whose rendering
grows past a bound (a version over 64 characters, a path over 480, or an event
message over 16,384 bytes) is refused as `release_identity_identity_unrepresentable`
and never becomes a permanent reference the log would later reject. The normalizer
applies the same version and path bounds at the sequence floor, so most such
templates are refused at configuration time.

The state machine is monotonic:

```text
reserved -> published
         -> abandoned
```

Publication takes no caller-selected artifact path or revision. The server
resolves the head of the base branch recorded in the claim, verifies every stored
path exists there as a file, and records that commit and each blob SHA in the
outcome. Walk Git trees at that immutable revision: only `blob` entries with mode
`100644` or `100755` qualify, not symlinks, submodules, or directories. Do not use
a Contents response that follows a symlink, a truncated recursive tree, a local
checkout, or different branch resolutions for different paths. At reservation,
any existing target entry or non-directory ancestor is a collision. At publication,
missing artifacts leave the reservation `reserved`. This proves linkage and
existence, not the semantic quality of artifact contents for a family (an LFS
pointer is a Git blob, not proof that an LFS object was fetched).
The publication revision is the branch-head observation made during this call;
GitHub cannot atomically combine that observation with the outcome create. Check
for observed advancement before claiming the outcome and reverify if necessary,
but do not promise that the branch can never advance immediately afterward.
See the [Git trees API](https://docs.github.com/en/rest/git/trees).
Abandonment burns the sequence and records its reason code; there is no
timeout-based recycling.

An existing identical terminal action returns the stored outcome before reading
today's branch or files. A conflicting action, or a different abandonment reason,
refuses and returns the authoritative state. Concurrent publications that observe
different valid heads converge on the winning publication record; the loser does
not replace its revision. Closed issues must still permit recovery and terminal
recording. `status` is read-only and uses bounded output with explicit completeness.

### Issue-thread record and partial failure

After an event wins its reference create, the MCP server posts a server-rendered
`Issue-thread record` to the bound issue. The record carries the
`gc:release-identity` marker and links the repository, family, sequence, version,
derived paths, event commit, base commit, idempotency hash, state, and, for
publication, the artifact revision and blob identities.

The reference log is the allocation and lifecycle authority; the issue thread is
the durable workflow projection required by ADR-029. Comments are never scanned
to choose a sequence. If the event lands and the comment fails, the operation
returns a partial-failure envelope naming the committed reservation. Retrying with
the same key recovers it from the log and reconciles missing records, detected
by the exact event SHA marker and server-rendered content authored by the MCP
server's authenticated GitHub identity. Reconcile the reservation record as well
as the terminal record, even when the first retry is `publish` or `abandon`.
Identity lookup failure never falls back to trusting arbitrary authors. A comment
failure never triggers a second allocation or removes the winning reference.

GitHub comments have no conditional create: concurrent retries or a lost POST
response can duplicate a projection. Promise recoverable, at-least-once projection,
not exactly once comments; duplicates carry the same event identity and do not
create new lifecycle events. Report committed state separately from projection
failure, and expose outstanding projection work for an explicit mutating retry.
`status` does not secretly repair comments, and no background delivery is promised.

### Security and operational boundaries

- Resolve and authorize `repo_path` through `resolveAuthorizedIssueRepository`
  before any GitHub read or write. Validate its pinned owner/name with the existing
  `GITHUB_REPO_RE`; use only that identity in REST paths.
- Reuse `ghRestJson`/argv-based `gh api` execution: no shell, no token in argv,
  no new credential variable, no raw GitHub response in a result.
- Validate the issue in that repository before a claim, and require it to be open
  for a new reservation; reject a PR returned through the issues endpoint.
  Family, action, identifiers, templates, event shapes, Git object
  IDs, and state transitions are closed schemas with bounded values. Dynamic
  reference and URL segments are encoded.
- Return structured `{ok, error, message, next_action}` envelopes with fixed
  messages. Never echo `gh` stderr, argv, configuration bodies, or remote
  payloads.

### Cross-cutting contracts the implementation must pass

| Layer | Canonical incumbent and guardrail |
| --- | --- |
| MCP schema and dispatch | `tools/*.js`, `tools/respond.js`, `server-runtime.js`, and the `lib.js` barrel. One thin registration; independent library validation uses the same constants and action rules. Reject forbidden destination/identity arguments and fields belonging to another action. Reuse `ASYNC_JOB_IDEMPOTENCY_KEY_RE/MAX` for key syntax, without using that registry as storage. No new DTO or exception hierarchy. |
| Workspace and auth | `resolveAuthorizedIssueRepository` and `authorizeImplementRepoRoot` pin launch root, Git common directory, origin, and owner/name before any remote call, including `status`. Retargeted origins and another clone/worktree are refusals; each legitimate worktree runs its own bound server. Use the authenticated host `gh` identity with Contents write and issue-comment permission. |
| Configuration and filesystem | `parseGroundControlYaml` in `lib/ground-control-config.js` owns the strict top-level allowlist; `getRepoGroundControlContext` in `lib/repo-vocabulary-2.js` must return the normalized optional block. Reuse `isSafeGitRefName`, `resolveRepoRelativePath`, and `assertRealpathInRepo`. Local containment is a check of this workspace, not artifact existence at the base SHA or a guarantee for a later caller write; unresolved/dangling symlink components must fail closed. No new YAML reader or requirement-file adapter. |
| Host, environment, and transport | `lib/github-rest.js` and `lib/runtime-primitives.js` own REST/argv execution. Pin the API hostname to the authorized GitHub host; owner/name alone does not defeat `GH_HOST`. No caller URL, executable, shell expansion, hooks, filters, or signing program. Retain `index.js` → `lib/server-env.js` startup ordering, the owned-key inventory, and the repo-root `.env.example` parity; no release credential or per-call dotenv reader. |
| Remote shape, bounds, and errors | Validate every ref/object/issue/JSON response before use. `ghRestJson` currently stringifies `fields` and has no timeout option: Git commit `parents` must be an actual array (the CLI supports `parents[]`), with bounded calls and retries at this transport seam. Extend the incumbent only as needed. Neither `extractGhErrorMessage` nor `tools/respond.err` sanitizes arbitrary stderr; catch and map failures to fixed messages before reaching them. Bound and allowlist nested result fields too. |
| Records and observability | Reuse `detectSensitiveBodyContent`, `GITHUB_ISSUE_COMMENT_BODY_MAX`, and `invalidateIssueThreadCacheEntry`. The comment listing and the authenticated login use the same REST endpoints as `readIssueCommentsWithAuthors` and `getAuthenticatedGitHubLogin`, but through the ledger adapter (`lib/release-identity-github.js`), because those helpers neither pin the API host nor accept the injected transport the concurrency tests drive. The marker is rendered only from ledger-validated values, so it cannot carry a caller's `<!-- gc:` sequence. Validate and scrub metadata before creating public Git objects, render the reserved marker only on the server, and invalidate thread caches after writes or uncertain POSTs. No raw idempotency key, YAML, artifact content, argv, or stderr in records/results/logs. MCP stdout remains protocol-only; bounded outcomes and event SHAs provide observability without a telemetry service. |

Paths in this table are relative to `mcp/ground-control/`. The GitHub CLI's
[API argument rules](https://cli.github.com/manual/gh_api) and
[environment rules](https://cli.github.com/manual/gh_help_environment) are part
of the host boundary. Reusing a helper does not make its string coercion, ambient
host selection, unbounded duration, or raw error forwarding safe for this operation.

### Workflow and gates

A configured versioned-artifact producer reserves before capture generation and
uses only the returned identity and paths. It never derives "next" from its
checkout. A retry or restart reuses the same non-secret workflow key, not a new
timestamp, process ID, or branch-head SHA. If the run will not publish, it
abandons the reservation with a reason code; after the artifact reaches the base
branch, it records publication. `status` lists a family's reservations for audit.

These instructions live in the canonical agent-neutral `/implement` guidance, with
registration/prose parity covered by the existing skill-tool contract. The MCP
boundary enforces allocation, idempotency, repository binding, and lifecycle; the
prose only sequences it. Completion, policy, reviews, pre-commit, CI, SonarCloud,
base synchronization, the human merge gate, and final reporting are unchanged.
The facility neither generates nor edits an evidence artifact.

Do not name an unregistered tool in executable skill prose during preflight.
When implementation adds the operation, the affected contract surfaces are
`server-runtime.js`, `tools/*.js`, `lib.js`, `skill-tool-registration-contract.test.js`,
`tool-descriptions.test.js`, and the packaged skills built by
`scripts/bundle-skills.mjs` (paths relative to `mcp/ground-control/`). Configuration
also reaches the CLI setup/doctor through the existing context parser. Keep
`docs/DEVELOPMENT_WORKFLOW.md`, `docs/WORKFLOW.md`, the MCP README, and public
configuration docs aligned with canonical `skills/implement/` guidance. The
coupling rules live in `architecture/policies/adr-policy.json` and
`lib/doc-coverage.js`; do not create a parallel workflow or policy gate.

The verification bar is behavior at these boundaries: same-key and different-key
contenders sharing a fake atomic GitHub store across independent server instances;
different floors at first allocation; delayed and incomplete reads; lost create
responses and restarts; conflicting terminal calls; changed/removed config and
closed-issue replay; malformed refs/events/remote responses; path/template and
symlink attacks; pagination and bounds; partial/duplicate comment projection;
and zero remote calls on repository-binding failure. Use the existing `node:test`
runner, injected `execFile` seam, `workspace-authorization.test-helpers.js`, and
`lib.issue-record-repo-authorization.test.js` patterns. In-process mutex tests
cannot prove cross-host allocation. Run `make mcp-test` and `make policy`, retaining
the 500-line source limit, pre-commit, CI, SonarCloud, and human merge gates.

## Consequences

- Concurrent same-family runs race only on the next append slot, and
  receive distinct identities, each above every claim present when it landed.
  Separate families use separate namespaces and never contend.
- A server crash after a claim is recoverable because the idempotency record is
  already in Git, not in process memory or a checkout lock.
- The references require Contents write permission and are visible through the Git
  references API. They are not PR bases, release branches, or evidence branches.
  Ordinary branch/tag clones and backups must not be assumed to retain custom
  refs; operational retention must include this namespace. No cleanup job may
  prune claims or outcomes, and missing history is never reconstructed from files
  or comments. Repository-writer tampering remains outside the stated guarantee.
- Abandoned identities leave intentional, recorded gaps. Those gaps are preferable
  to reusing an identity whose prior owner or generated artifact may still exist.
- Folding reads one commit per event the process has not already cached. Complete
  reads and bounded failure are required from the first release, not deferred
  until a family grows. Follow actual endpoint pagination/completeness semantics;
  an exceeded cap refuses allocation rather than treating a partial log as empty.
- Template evolution remains possible per family. Existing reservations keep their
  stored version and paths; new reservations use the definition at their own base
  commit. A future formatting scheme extends the template normalizer and the event
  schema version, not the allocation protocol. The extension seams are normalized
  per-family data, versioned event decoding, and bounded transport options. Old
  events retain their original rendering semantics; unknown event versions fail
  closed. Family renames or reuse must not silently reset reservation history.

## Alternatives considered

- **One linear log per family advanced by fast-forward updates.** Rejected after
  the live check above: GitHub accepted a non-fast-forward `force: false` update
  of a custom-namespace reference, so the log offers no compare-and-swap.
- **`proper-lockfile` or another checkout lock.** Rejected because it cannot
  coordinate separate clones, hosts, or MCP processes.
- **Issue comments as the allocator.** Rejected because comments are durable but
  offer no conditional unique append over a family sequence.
- **Derive next from the local or remote evidence tree.** Rejected because two
  readers can observe the same tree before either publication lands.
- **A database, daemon, or workflow-run service.** Rejected because it creates a
  second running authority for a repository-scoped coordination problem.
- **One global repository lock.** Rejected because unrelated release families
  must proceed concurrently.
- **Reuse an abandoned number.** Rejected because an unmerged branch or external
  copy may still carry an artifact with that identity.

## Non-goals

- Generating, editing, validating the semantics of, or merging evidence files.
- Replacing Release Please or reserving the Ground Control product version.
- Reserving requirement UIDs, issue numbers, PR numbers, or Git tags.
- Adding a generic distributed-lock service, database, queue, or workflow engine.
- Allowing callers to choose a repository, base revision, version, or output path.
- Weakening or bypassing any existing `/implement`, policy, review, CI, SonarCloud,
  or merge gate.

## Design Vocabulary That Applies

- **Patterns:** `Tool registration` for the zod schema and thin handler;
  `Issue-thread record` for the durable workflow projection.
- **Canonical helper:** argv-based `gh api` execution through `ghRestJson` and
  the pinned-repository helpers, for every remote read and write.
- **Boundary contract:** the MCP server remains the only running service and owns
  every privileged GitHub/Git side effect. ADRs and workflow guidance remain
  repo-local reviewed files; evidence files remain caller-owned working-tree
  changes.
- **Binding ADRs:** ADR-027 for the single configuration parser and the privileged
  side-effect boundary, and ADR-029 for the issue thread as the durable workflow
  record.
- **Anti-recommendations:** no generic lock, repository, or template abstraction
  below three call sites; no duplicated configuration, validation, error-envelope,
  or issue-record logic; no prompt-only controls; comments only for non-obvious
  invariants; no `gh`, `git`, or `curl` from agent sandboxes.
