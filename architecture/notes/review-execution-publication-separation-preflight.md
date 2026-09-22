# Review Execution and Publication Separation Preflight

Issue #1632 separates local review execution from publication. This note is
architecture guidance only. It does not implement the review mode, result
store, publication tool, or workflow changes.

## Scope Reconciliation

Issue #1632 predates ADR-099 and names both Codex and test-quality review
cycles. ADR-099 subsequently removed the test-quality stage, tools, runners,
configuration, and marker family without a compatibility period. The current
implementation scope is therefore Codex review only. Do not restore a retired
reviewer to satisfy stale acceptance text. If the issue is still intended to
reverse ADR-099, that requires an explicit architecture decision before coding.

The direct `gc_codex_review` tool and the `gc_codex_review_cycle` wrapper share
one review executor today. The separation must occur below both public tools so
deferred mode cannot accidentally retain one of the direct runner's GitHub
writes. Automatic publication may remain as a compatibility composition of the
same execute and publish operations; it must not remain a separate posting
implementation.

## Binding Contract

### Keep four identities distinct

- An async `job_id` is a short-lived process handle used only to wait for work.
  It expires and is not review evidence.
- A `review_handle` identifies one retained terminal execution. It survives MCP
  restart and async-job expiry and is the only input that selects an original
  result for inspection or publication.
- A review revision identifies the exact server-selected review input. For an
  uncommitted review it must include the immutable HEAD and resolved base object
  ids plus a SHA-256 digest over a canonical, length-delimited representation of
  the authoritative staged and unstaged diff, its manifest, tracked-symlink
  metadata, and explicit unreviewed-untracked-path metadata. The capture must
  prove its own object ids did not move while those fields were read; HEAD alone
  is not a working-tree identity.
- A publication receipt identifies the trusted GitHub records produced from a
  retained review. It carries the original-result digest, sanitized-payload
  digest, review revision digest, reviewer, issue, and cycle without carrying
  confidential prose.

Do not reuse the idempotency key as a review handle, use the async job registry
as persistence, or use a GitHub comment URL as the identity of the retained
original.

### Execute locally, publish explicitly

Deferred execution may perform repository and issue-thread reads, compute the
diff, run the model, parse and validate its output, and write the retained local
artifact. It must perform zero GitHub mutations. This includes inline PR review
comments, issue findings comments, cycle markers, decision records,
station-observation records or resolutions, and failure records.

The retained result contains the validated reviewer envelopes, normalized
findings with server-assigned stable finding ids, merged architectural read,
coverage, revision identity, cap snapshot, terminal failure classification when
applicable, original-result digest, and publication state. It is the provenance
source, not a second decision schema. Existing review-envelope and finding
validators remain authoritative before retention.

Return the `review_handle`, revision identity, coverage, and bounded locally
inspectable findings from the terminal cycle result. A locally complete review
has `publication_status: "unpublished"`; it must not reuse `clean`,
`findings`, or another advancing status in a way a caller can mistake for a
published workflow record.

Publication accepts a closed, bounded structured representation keyed by every
stable original finding id. It may redact or generalize prose and locations,
but it must neither omit nor invent findings. Reviewer, issue, revision,
original finding count, classification, and the caller's disposition for each
finding remain machine-checked provenance fields. The caller may also sanitize
the architectural read and notes, but may not change verdict semantics or turn
a blocking finding into a note. `wontfix` still requires the existing explicit
authorization-evidence field and `not-applicable` still requires a factual
rationale. Redaction is not permission to change a finding's identity or
silently erase its disposition.

Use the existing findings and decision renderers for the public representation.
Do not publish the original artifact, raw reviewer transcript, prompt, diff,
environment, local artifact path, or an automatic redaction guessed by a
credential-pattern filter. `detectSensitiveBodyContent` remains defense in
depth on the explicitly sanitized body, not the confidentiality boundary.

### Retain originals outside the working tree

Persist retained reviews in the authorized checkout's per-worktree Git metadata
directory, never under a tracked or merely gitignored working-tree path. Combine
the closed-schema, no-follow, regular-file, random-temporary-name, and atomic
rename mechanics of `implement-recovery-journal.js` with the pre-rename fsync
pattern in `knowledge-inbox.js`: a fixed server-owned subdirectory, basename
derived only from a bounded opaque random handle, directory mode `0700`, file
mode `0600`, no-follow exclusive temporary create, descriptor-based
`O_NOFOLLOW` reads followed by regular-file checks, and closed schema validation
on every read. Also fsync the file before rename and its parent directory after
rename because this artifact, unlike the publish recovery journal, is the
durable source of a later public record. Bound both the artifact byte size and
finding/note cardinality before writing; model-output bounds are not a
storage-quota policy.

The local store contains confidential model output, so paths and contents must
not enter logs, telemetry, GitHub markers, child argv, or general error
messages. A handle is an identifier, not ambient authorization: every inspect
or publish call re-runs launch-workspace repository authorization before opening
the artifact. A corrupt, symlinked, unknown-version, mismatched-repository, or
mismatched-issue artifact fails closed and is never silently deleted.

Issue #1632 needs a defined lifecycle but not a configurable retention system.
Do not automatically reap unpublished originals, because that can destroy the
only publishable result. Keep published originals for provenance until an
explicit, separately authorized discard contract exists; surface artifact-size
limit violations or filesystem-capacity exhaustion as fail-closed
operational errors rather than deleting an unpublished or unverified record to
make room.
Encryption at rest, cross-host transfer, and backup policy are outside this
issue; document that OS file permissions are the confidentiality control.

### Bind publication to the reviewed revision

Compute the review revision before invoking the model and recompute it after the
model returns. If it changed, retain a non-publishable stale execution and do
not call it a completed review. Publication recomputes the identity again and
rejects any mismatch with `review_revision_stale`. The workflow must therefore
inspect, sanitize, and publish before applying review fixes; a later fixed tree
requires a new review rather than publication against a different revision.

The model currently has read-only access to the live checkout for adjacent
context. Before/after identity checks are the minimum truthful contract without
introducing a snapshot worktree. Do not claim stronger isolation or bind only
to the branch name. Untracked files remain explicitly uncovered under the
existing coverage contract and must participate in the revision metadata as
paths/counts, never by silently hashing or sending their content.

### Preserve cap and gate integrity

Local execution does not consume a review cycle. The async transport and a
filesystem lease prevent concurrent executions for the same
`(repository, issue, reviewer)` while work is in flight, but an unpublished
artifact must not reserve a cycle forever: stale, abandoned, or failed handles
would otherwise deadlock the issue. Every artifact records the cycle it expected
from its pre-run cap snapshot. Publication re-reads the authoritative issue
thread under the repository/issue/reviewer lease, verifies that this cycle is
still next and authorized, and lets the first matching publication win. Any
other retained handle for that slot becomes conflicting or stale; it cannot
publish or consume another cycle.

Preserve the established successful-verdict order: sanitized inline PR comments
when the retained destination is post-push, sanitized issue findings record,
required station re-observation resolution, cycle marker, then canonical
decision record. Add a versioned provenance marker to the owning findings,
cycle, and decision codecs rather than parsing display prose; existing marker
readers must continue to understand pre-change records. A retry reconciles
trusted records carrying the same review provenance and continues from the
first missing write. It never posts a second logical record. Conflicting or
ambiguous remote state fails closed.

An exhausted non-verdict result is a separate retained result kind. Its explicit
publication uses the existing station-observation record functions with only
closed failure classes and attempt ordinals; it does not publish raw errors,
consume a cycle, or write a decision record. A later successful retained result
may resolve that published obligation through the existing re-observation seam.
Coverage failure, model failure, and station-observation publication must not be
folded into the successful-review publisher or its finding schema.

The existing cycle marker may continue to count a partially published cycle,
but it must never be sufficient evidence that the decision gate passed. Any
gate that requires review publication must freshly verify a trusted canonical
decision/publication record for the same issue, reviewer, cycle, original
digest, and revision. In particular, the current final-report input gate trusts
a caller-supplied `reviews[]` summary; implementation must not extend that
self-attestation to deferred results. Both synchronized PR creation (whose body
attests that the pre-push review completed) and completion/readiness must verify
trusted issue-thread publication evidence server-side. The display-only PR body
and `reviews[]` remain summaries, not authority.

Automatic mode is only `execute -> publish` using the same retained artifact
and idempotent publisher. A publication failure returns the durable
`review_handle` and a retry action; it must not rerun the model or manufacture a
new original.

## Canonical Incumbents to Reuse

- **Tool registration:** the strict Zod plus thin-handler pattern in
  `mcp/ground-control/tools/post-decision-record.js`; semantic validation stays
  in `lib/` and the barrel in `mcp/ground-control/lib.js` remains the public
  import surface.
- **Review execution:** `runCodexReview`, `runReviewerOverSlices`,
  `validateReviewEnvelope`, `validateFinding`, `buildReviewCoverage`,
  `reviewCycleFindings`, and `summarizeReviewFindings`. Split side effects from
  this path; do not create a second reviewer or parser.
- **Cycle orchestration:** `runCodexReviewCycle`, `_runReviewCycleShared`,
  `runReviewCycleTransport`, the cap evaluators, and station-observation seam.
  Keep one state machine and parameterize publication mode.
- **Async transport:** `startAsyncJob`, `pollAsyncJob`, fingerprinting,
  idempotency conflict, and single-flight behavior. The terminal job may carry
  a durable review handle, but the registry is not the retained-result store.
- **Local durability:** `readGitIdentity`, per-worktree `gitDir`,
  `implement-recovery-journal.js` safe-file mechanics, `knowledge-inbox.js`
  atomic-write/fsync mechanics, and `filesystem-lease.js`. Extract shared file
  mechanics only if this becomes the third real caller; do not prematurely
  build a generic repository layer.
- **Publication:** `buildCodexReviewFindingsComments`,
  `postCodexReviewFindingsComment`, `postCodexReviewPrePushCycleMarker`,
  `runPostDecisionRecord`, reserved-marker protection, GitHub body caps,
  `detectSensitiveBodyContent`, `extractGhErrorMessage`, and fixed-argv
  `gh api` execution.
- **Repository authority:** `resolveAuthorizedIssueRepository`,
  `authorizeImplementRepoRoot`, launch-workspace identity, and
  `assertSafeImplementCheckoutConfiguration`. Authorization precedes handle
  lookup so artifact existence cannot become an authorization oracle.
- **Workflow evidence:** the existing decision-record marker and trusted
  issue-comment readers, `runCreateSynchronizedImplementPr`, and
  `runAssertCompletion`. Follow `readTrustedImplementSyncRecord` for
  trust/malformed/ambiguity handling and `runReconcileStationObservation` for
  leased post-then-replay idempotency. Extend the owning marker codec and one
  trusted publication-evidence reader; do not add separate parsers in PR
  creation and completion code.

## Security and Cross-Cutting Layers

- **Public schema:** Zod owns the closed publication-mode enum, bounded handle,
  bounded sanitized strings/arrays, positive identifiers, and idempotency key.
  Direct library validators mirror conditional invariants such as complete
  finding-id coverage and `wontfix` authorization.
- **Model-output parser:** existing review-tail, verdict consistency, finding
  path containment, one-off sweep evidence, class-instance, and coverage
  validation all run before an artifact can be publishable.
- **Config shape:** no new `.ground-control.yaml` or environment setting is
  needed. Cap and retry configuration continues through
  `gc_get_repo_ground_control_context`; malformed config still fails closed.
- **Repository/filesystem:** canonical launch-workspace authorization and safe
  Git configuration run before execution, inspection, and publication. The
  artifact store uses the canonical per-worktree Git directory and no
  caller-supplied path. Authorization runs before handle lookup; handle syntax,
  schema version, repository/issue identity, file type, mode, and size all fail
  closed before content is returned.
- **Subprocess/OS exposure:** preserve `codexEngineEnv`,
  `buildCodexReviewExecArgs`, `execFileWithInput`, its stdin prompt transport,
  bounded output, timeout, and process-group cleanup. Tokens remain in the
  launch-environment allowlists and never enter argv or artifacts. Neither the
  original result, handle, local path, nor unsanitized text may be passed to
  `gh`; the existing argv-based GitHub helper receives only prose the caller has
  approved for public release.
- **Publication policy:** reserved-marker rejection, sensitive-content scan,
  GitHub byte caps, reviewer/issue/cycle/revision provenance, and trusted-author
  verification all apply before a result can satisfy a gate.
- **Error envelope:** expected failures return stable bounded
  `{ok:false,error,message,next_action}` shapes. Do not add an exception
  hierarchy or expose raw JSON parse errors, stack traces, model output,
  command output, repository paths, or artifact contents.
- **Observability:** MCP calls and bounded structured results are sufficient.
  Do not restore retired ADR-036 telemetry or add a logger containing handles,
  finding prose, digests paired with prose, or publication bodies.

The no-publication mode protects against GitHub disclosure. Returning findings
to the MCP caller and sending the diff to the configured review model remain
separate egress surfaces; the implementation and documentation must not claim
that this mode makes the review wholly local or suitable for data the model
provider is not authorized to receive.

## Extensibility Seam

The seam required now is a closed publication mode on the existing Codex review
state machine (`automatic` or `deferred`) plus a versioned Codex retained-result
schema. Keep `reviewer: "codex"` explicit in v1. Do not introduce a generic
reviewer adapter/dispatcher for a reviewer ADR-099 removed. If a second real
reviewer is approved later, the versioned artifact's identity, coverage,
revision, and publication-state fields are the points to generalize without
changing handle or retry semantics.

Keep publication destination fixed to the issue/PR already derived by the
review executor. Do not expose arbitrary repository, issue, URL, marker family,
renderer, command, timeout, artifact path, or destination parameters as the
extension mechanism.

## Required Contract Coverage

- Deferred execution proves zero GitHub mutations for clean, findings,
  incomplete coverage, engine failure, sensitive-output failure, and
  station-observation paths.
- Persistence tests cover restart recovery, restrictive modes, atomic write,
  symlink and non-regular-file refusal, corrupt/unknown schema, repository and
  issue mismatch, and no secret-bearing path or content in errors.
- Revision tests cover staged changes, unstaged changes, HEAD/base movement,
  untracked-path metadata, mutation during review, and stale publication.
- Publication tests cover complete redaction with stable finding ids and
  dispositions, omitted/extra/duplicate ids, `wontfix` authorization, reserved
  markers, sensitive content, body caps, and original/sanitized digest binding.
- Retry tests cover a lost publication response and every partial-write
  boundary. A retry must finish the same logical publication without rerunning
  the model, duplicating comments, or double-counting the cycle.
- Gate tests prove an unpublished artifact and a cycle marker without its
  trusted decision/publication record cannot satisfy synchronized PR creation,
  readiness, or completion.
- Concurrency tests prove simultaneous execution is single-flight, simultaneous
  publication has one winner, and a stale or abandoned artifact never blocks a
  later execution for the same expected cycle.
- Compatibility tests prove automatic mode composes the same executor and
  publisher and produces the same cycle accounting and decision semantics.
- Live tool descriptions, MCP README, Step 6.5, review-loop rules,
  `docs/DEVELOPMENT_WORKFLOW.md`, ADR-029, ADR-031, and ADR-036 must agree on
  handle lifetime, publication state, retry, and gate semantics when the
  implementation lands.

## Gotchas and Anti-Patterns

- Do not move only the decision-record post. Inline PR findings, findings
  comments, cycle markers, station records, and failure records are all GitHub
  mutations inside the confidentiality boundary.
- Do not call credential-pattern filtering “redaction.” Confidential project
  names and operational details require caller-supplied sanitization.
- Do not let the sanitizer change cardinality, ids, classification, or
  disposition, or turn a class finding into vague prose with no retained
  mapping.
- Do not let a local result advance the workflow, consume a cycle, authorize an
  over-cap grant, or satisfy a final-report review gate.
- Do not make an unpublished handle a permanent cycle-slot reservation; remote
  trusted publication evidence remains the cycle authority.
- Do not bind publication to HEAD alone, a branch name, file mtimes, a job id,
  or a caller-supplied revision claim.
- Do not persist confidential results in the working tree, `.gc/`, `/tmp`, an
  issue draft, telemetry, git notes, commit objects, or a shared common Git
  directory across worktrees.
- Do not claim transactional GitHub writes or exactly once transport. Provide
  replay-safe reconciliation over trusted provenance markers.
- Do not create duplicate findings, decision, validation, cap, exception,
  GitHub-client, async-job, or workflow-loop abstractions.
- Do not add prompt-only publication rules that the MCP tool layer cannot
  enforce.

## Non-Goals and Implementation Boundaries

- No restoration of test-quality review without a decision superseding
  ADR-099.
- No backend, REST controller, DTO, service, repository, database, migration,
  frontend, external queue, Temporal workflow, worker, or cross-host result
  service.
- No automatic semantic redactor, data-classification engine, encryption/key
  management system, arbitrary publication destination, or comment editor.
- No change to review rubrics, slice planning, finding classification,
  cap defaults, override policy, no-deferral policy, or model provider.
- No guarantee that unpublished artifacts survive checkout deletion, host
  loss, or backup restoration. Durable means restart- and async-expiry-safe
  within the authorized worktree.

## Design Vocabulary That Applies

- **Pattern: Tool registration** - new inspect/publish surfaces use strict Zod
  schemas and thin handlers delegating to `lib/` functions, following
  `mcp/ground-control/tools/query.js`.
- **Pattern: Issue-thread record** - sanitized findings, cycle provenance, and
  the canonical decision remain MCP-rendered GitHub issue comments; retained
  local results are not a second durable workflow record.
- **Canonical helper: gh api argv-based posting in
  `mcp/ground-control/lib.js`** - publication remains an MCP-owned privileged
  side effect and uses the existing fixed-argv boundary.
- **Boundary contract:** the MCP server is the only running service and owns
  every privileged GitHub/Git side effect. Local retained artifacts remain MCP
  operational state, not a backend.
- **Binding ADRs:** ADR-027 for repository configuration and privileged side
  effects; ADR-029 for published issue-thread workflow evidence; ADR-031 for
  structured Codex findings and MCP-owned publication. ADR-099 is the later
  decision that removes test-quality review from this issue's current scope.
- **Anti-recommendations:** do not add abstractions below three real call
  sites; do not add skill prompt text the MCP layer cannot enforce; keep
  comments for non-obvious invariants; do not invoke `gh`, `git`, or `curl`
  from agent sandboxes.
