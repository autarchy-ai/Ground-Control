# Automated Phase E Preflight

Issue #1671 may automate Phase E only as deterministic delivery of evidence
that Phase D already recorded. This note is architecture guidance; it does not
add a workflow implementation.

## Decision and guardrails

- Keep `gc_implement_mechanical action="finalize"` as the sole Phase E
  composition boundary. It must continue to call the existing merge-gated
  completion assertion and `gc_close_issue_after_merge`; automation adds a
  trigger and trusted evidence loader, not another finalizer.
- Phase D must write one versioned **delivery-readiness record** to the Ground
  Control issue. The record is bound to repository identity, issue, PR, lane,
  and the exact PR head OID whose hosted checks passed. It contains a canonical
  `completionShape` payload plus its SHA-256 digest under a reserved marker.
  The human-readable readiness report remains reviewable Markdown; neither it
  nor arbitrary PR text is parsed back into the payload.
- Phase D must also write a small, trusted discovery pointer on the PR thread.
  The pointer carries only the issue number, readiness comment/record identity,
  head OID, lane, and payload digest. It is an index into the authoritative
  issue-thread record, not a second authority. This makes merge delivery an
  exact PR-keyed lookup rather than an unbounded repository comment search or
  an inference from title, body, labels, branch name, or closing keywords.
  Readiness succeeds only after both records exist. Give both records stable
  logical ids so a lost POST response or retry reconciles instead of duplicating
  them; conflicting records for one PR head fail closed.
- `/quickfix` needs this neutral Phase D handoff after Q6 even though it retains
  no `/implement` readiness report, requirement checks, or default AI review.
  The handoff carries the existing slim, requirement-free completion payload;
  it is not a quickfix final report and must not fabricate a `gc:final-report`
  marker.
- Add one narrow automation-facing MCP tool whose only external identity input
  is a positive PR number. It resolves the launch-workspace repository, reads
  the trusted PR pointer and issue readiness record, validates their exact
  agreement, then invokes the shared finalizer. A one-shot `grndctl` adapter may
  launch the MCP server and call that tool, but it must not import a parallel
  finalization stack or run `gh`/`git` itself. GitHub Actions YAML remains a
  transport adapter, not a marker parser or workflow controller.
- Use a repository-local `pull_request` `closed` workflow, gated on
  `merged == true`, with `workflow_dispatch` accepting the same PR number for a
  maintainer replay. Never use `pull_request_target`. The server re-fetches the
  live PR and verifies same-repository identity, configured target branch,
  linked issue, head OID, state `MERGED`, `merged_at`, and merge revision; event
  fields are routing hints, not authority. A merge with no trusted pointer is an
  ineligible no-op, while a trusted but invalid handoff is a failure.
- Run the workflow from the merged revision, never the untrusted PR head. Pin
  every action by immutable SHA, set checkout `persist-credentials: false`, and
  install dependencies without lifecycle scripts or a write token. Expose the
  ephemeral `GITHUB_TOKEN` only to the one-shot finalizer process as `GH_TOKEN`,
  with only `contents: read`, `pull-requests: read`, and `issues: write`. The
  token never enters argv, an output, a comment, or an error envelope.
- Extend the shared issue-record trust resolver for the exact GitHub Actions
  service identity/provenance used by this job. Do not add a finalizer-local
  login allow-list. Today `resolveExecutionObligationTrust` proves effective
  repository permission for human/service commenters; automated final reports
  and failure records must pass one central equivalent trust policy or the
  existing close-marker gate will correctly refuse them.
- Treat duplicate events, reruns, a lost response after comment POST, and an
  interruption between report and close as normal. Serialize action runs by PR
  with `cancel-in-progress: false`. Final-report publication must recognize an
  existing trusted marker for the same issue, PR, readiness record, and digest
  before posting, and `gc_close_issue_after_merge` keeps its existing
  already-closed success. Put marker parsing and lookup in one helper used by
  final-report publication and close rather than copying substring scans.
- Failure is never a close path. Once a trusted pointer safely binds the issue,
  a validation, finalizer, or transport failure writes one bounded, scrubbed,
  idempotently keyed `gc:delivery-finalization-failed` issue-thread record with
  PR, readiness identity, stable error code, failed stage, and retry guidance.
  It leaves the issue open and fails the Actions job. An identical replay reuses
  that record; a changed failure may append a new one. An untrusted pointer must
  not be allowed to select an issue for a failure comment.

## Cross-cutting implementation constraints

Reuse `completionShape` and `mapCompletion` as the payload contract, then pass
the decoded value through `validateFinalReportInput`; do not create an
automation-only completion DTO or weaker validator. The envelope around that
payload is a strict, size-bounded schema with an explicit version and lane.
Decode only after bounding the encoded bytes, recompute the digest over the
canonical normalized bytes, reject unknown fields/versions/lanes, and require
the PR pointer and issue record to agree exactly. Run the existing reserved
marker, no-deferral, sensitive-content, and GitHub comment-size checks before
encoding so base64 cannot hide content that would be refused in rendered text.

The Phase D producer must keep `readRemoteGateSnapshot` as the source of the
head-bound hosted-check result it records. The Phase E loader and finalizer must
reuse `resolveAuthorizedIssueRepository`, `readIssueCommentsWithAuthors`,
`resolveExecutionObligationTrust`, `runFinalize`, `runAssertCompletion`,
`runCloseIssueAfterMerge`, `resolvePrForClose`,
`readTrustedExecutionObligationState`,
`readTrustedReviewPublicationEvidence`, `verifyMergedRequirementState`, and the
`requirement-files.js` immutable-revision reader. Requirement-backed delivery
still re-derives scope from the issue and verifies the merged tree;
requirement-free delivery still skips only that requirement assertion.
CI/Sonar/review/obligation checks remain in their incumbent readiness and
finalizer runners and must not be reimplemented in the action or record parser.
Phase E does not wait for, rerun, or reinterpret post-merge CI, Sonar, policy,
security, review, or release jobs.

Follow the normal tool-registration pattern: zod input schema, thin handler,
library function. All server-owned GitHub and Git calls use fixed argv arrays
and the authorized checkout as `cwd`. The one-shot adapter emits one bounded
structured result and exit status. Durable observability is the issue-thread
success/failure record plus the Actions conclusion; raw `gh` stderr, event JSON,
decoded payloads, credentials, and arbitrary exception objects do not reach job
output or comments. Reuse the existing failure-message bounds and sensitive
content detector rather than adding another exception hierarchy or logger.

The checkout must be pinned to the event's immutable merge SHA. It is read-only
input for the existing merge-revision verification; Phase E makes no repository
edits. The server is launched with that checkout as its working directory so
the launch-workspace authorization and origin identity checks remain the trust
boundary.

The trigger must be distributable with Ground Control, not work only in this
repository. Keep the reusable runner in the published `grndctl` package and the
repo-local workflow as a thin, version-pinned adapter. The existing package
template bundling plus `grndctl init`/`doctor` are the repository setup and
drift-detection surfaces; do not invent a second installer or silently fetch
`latest`. Producer/consumer version skew is handled by the readiness envelope
version, with unknown versions failing closed.

## Contract surfaces and tests

The implementation changes the executor, not the Phase E semantics. Amend the
existing ADR-021, ADR-029, and ADR-100 records and the `/implement`, `/quickfix`,
development-workflow, setup, and policy-contract surfaces in the delivery diff;
a new ADR is unnecessary unless implementation chooses a materially different
trust or persistence boundary. Do not leave agent-reentry prose as a fallback:
after a successful Phase D handoff the agent may terminate permanently.

Use the existing Node `node:test` dependency-injection and `gh`-shim patterns
for record parsing, trust, merge-state, finalizer, lost-response, and replay
tests. Extend the Python repository-policy tests for workflow shape and mirrored
workflow prose. Required cases include merged, unmerged, ordinary ineligible
PR, duplicate and concurrent delivery, missing/conflicting pointer, invalid or
oversized readiness payload, untrusted author, stale head, failed finalizer,
report-posted/close-not-yet-run recovery, and both `implement` and `quickfix`
lanes.

## Extensibility and boundaries

The seam for the next lane or payload revision is the versioned readiness
envelope and a closed lane dispatch table. The seam for another deterministic
trigger is the single PR-number MCP operation. Unknown versions and lanes fail
closed; they never default to `/implement`. Target-branch policy remains in the
existing `.ground-control.yaml` parser/context contract and one server-side
eligibility check. A YAML branch filter is only an optimization and must not
become a second base-branch authority.

Non-goals: a database, queue, poller/daemon, Temporal workflow, new GitHub
client, generated prose after merge, agent re-entry, post-merge requirement
edits, automatic PR merge, recursive retry loop, or any change to Phase D/E
quality semantics. Do not use the process-local async-job registry as durable
delivery state, parse rendered Markdown, scrape arbitrary PR text, trust
caller-supplied issue/payload/merge status, or place finalization logic in
Actions shell. The GitHub issue thread remains the restart-safe record.
