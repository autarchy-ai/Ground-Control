# Waived Station Completion Preflight

Issue: #1578. Requirement: GC-O007, Gated Agentic Development Loop.
Status: binding design guidance, implemented by issue #1578 (ADR-029 2026-09-13 amendment).

## Decision and boundaries

Keep one execution-obligation ledger on the issue thread. A missing station
observation may terminate through either a verified observation or an explicit,
durable user waiver of that observation. Neither resolution dispositions a
finding. A waiver means **no verdict produced; continuation authorized**. It
never means clean, passed, fixed, not applicable, or reviewer completed.

Use a distinct station-only `waived` resolution with authorization evidence.
Retain `reobserved` for actual observation. Supersession by a later cycle is an
evidence-backed observation resolution, not a third finding disposition or a
blanket exemption for old records. Legacy problem obligations retain their
existing `fix | wontfix | not-applicable` semantics and authorization rules.

Both readiness and Phase E consume the same verified ledger interpretation.
Only the observation blocker is cleared. CI, applicable Sonar gates, finding
dispositions, local verification/policy, merge approval, merged-PR validation,
and requirement-state verification retain their owners and requirements. A
waiver can be recorded while another gate is red; it cannot make completion
succeed while that gate is red. No waiver and no qualifying observation means
the obligation stays open, including after a green PR has merged.

This is a narrow exception to mandatory observation, not another routine human
gate. GC-O007 and ADR-029 must describe the explicit outage waiver when the
behavior ships; neither green CI nor PR merge implicitly grants it. Phase E
remains validation-only for requirement files at the immutable merge revision.
Do not rerun local implementation gates in Phase E to compensate for a waiver.

## Existing gaps that determine the design

- `station-observation-seam.js` carries `observationOpened` only within one
  invocation. Its first attempt receives no pending obligation. A successful
  first attempt after a restart therefore cannot repair the prior outage.
  Recover pending obligations from durable state, not an in-memory flag alone.
- `evaluateExecutionObligations` returns only open IDs and `clear`; completion
  discards successful ledger details. Preserve verified resolution evidence
  through that same read path so the final report can account for waivers.
- `hasVerifiedStationReobservation` currently checks authorship and a distinct
  referenced comment, not that comment's station, cycle, verdict, or coverage.
  That is insufficient evidence for widening resolution to earlier cycles.
- `runPostFinalReport` requires a `codex` review entry for the implement lane,
  but the entry is free text. A fabricated entry or switching to `quickfix`
  cannot be the workaround for a genuinely unavailable Codex station.
- The direct report writer does not currently read the obligation ledger, and
  completion/report reads use `ensureGitRepo` plus `getOwnerRepo`, not the
  pinned-workspace authorization used by the obligation writer. Reuse that
  authorization boundary before adding waiver-bearing reads or writes to either
  entry point; wrapper validation alone does not protect direct callers.
- The old recovery note contains retired backend/REST/measurement guidance.
  ADR-093 and the current MCP-only repository govern; those retired layers
  must not be recreated for this change.

## Authorization and durable evidence

Reuse the structured two-step authorization pattern behind
`runAuthorizeExecutionObligationWontfix`, `parseIssueCommentUrl`,
`readIssueCommentsWithAuthors`, `resolveExecutionObligationTrust`, and
`hasVerifiedStructuredWontfixAuthorization`. Give the station waiver its own
exact authorization action; do not reinterpret an `authorize-wontfix` command.
The durable source must explicitly name the canonical station and target
obligations on this repository's current issue. An authorized repository
writer supplies that source; the MCP writer verifies and references it.

The audit chain must retain source-comment identity, author, repository/issue,
station, obligation identity and logical cycle, authorization-record identity,
and the station-only resolution. Resolve a finite named set of observations,
not all future cycles. Recheck source contents, source permission, and binding
at posting and replay. Missing/deleted/edited evidence, unreadable permissions,
wrong issue/station, and ambiguous scope cannot clear the gate. Chat summaries,
an agent's claim that the user approved, or a caller boolean are not authority.
Prior conversational permission needs durable user-authored evidence through
this contract; the agent must not manufacture the user's source comment.

Reuse the repository's effective `admin | maintain | write` permission check;
organization membership and `author_association` are insufficient. Keep user
authorization separate from the trusted MCP posting identity used for actual
observation. Posting under that identity alone does not prove human consent.

Append records; do not edit/delete old obligations or findings. Authorization
precedes its resolution, and verified resolution precedes the completion
record. Repeated requests and recovery after a partial write must converge on
the same obligation and evidence without rerunning a reviewer to retry a post.
Read back/replay durable state before declaring success. Preserve event order,
including across comment pages and mixed schema versions; a resolution must
not close a later reopening that its authorization never covered.
Bind resolution to the durable opening event as well as its deterministic ID:
the ID is reused when the same station/cycle reopens. The authored-comment reader
currently returns no timestamps or edit metadata; extend its evidence shape if
needed to prove ordering or detect source edits, rather than inferring either
from comment prose. Concurrent/restarted writers must revalidate those event
references. If local serialization is necessary, reuse `filesystem-lease.js`;
a workspace lease cannot serialize another host or make GitHub comments atomic.

## Re-observation and schema compatibility

The target obligation keeps its original identity and cycle. A superseding
observation carries its own cycle and durable record reference. Do not overwrite
the old cycle or merely change equality to `laterCycle >= oldCycle`.
Require the same repository, issue, canonical station and logical delivery
workflow, with evidence that the observation occurred after the missing one
and covers the required review scope. A different PR/run or an unrelated
same-author comment is not proof. Branch names are not durable identity.

Use the existing station-owned findings/outcome writers and coverage validators
to establish a validated verdict; `ok: true`, a cap marker, or a decision
summary alone does not suffice. Codex requires complete reviewer/slice coverage;
test-quality requires its validated findings envelope. A verdict with findings
can resolve missing observation while those findings remain actionable. If
legacy records cannot establish the binding, leave the obligation open for
explicit waiver or a new observation; never infer evidence from prose.

Extend `parseExecutionObligationMarkers` and `evaluateExecutionObligations`,
with `execution-obligation-v2.js` as the existing station codec boundary.
The v2 regex has a closed disposition set and no authorization attribute.
The wire change needs an explicit version/compatibility contract covering old
v2 opens and new resolutions; adding an enum to an MCP schema is insufficient.
Preserve existing open markers so readers that cannot understand a new
resolution keep blocking. Unknown/malformed resolution records never confer
clearance, and schema/kind/ID collisions must not reclassify station obligations
as legacy problems. Test replay with mixed versions and unsupported records.

## Completion and canonical incumbents

`readTrustedExecutionObligationState` remains the trusted read boundary;
`assert-completion.js` owns readiness/completion composition;
`implement/completion.js` owns mechanical readiness/finalize delegation.
`runPostFinalReport`, `validateFinalReportInput`, and `buildFinalReport` remain
the shared report policy, validation, and rendering boundary. Direct
`gc_post_final_report` and composed completion must apply the same waiver
checks. Never add a Phase E-only bypass of the ledger.

The server derives a bounded waiver summary and evidence links from verified
records. Render the named station as unobserved with continuation authorized,
alongside actual later observations where present. Do not accept a caller's
`clean`/`completed` summary for a waived observation or emit a synthetic
findings record, cycle marker, review verdict, or successful station attempt.
A mandatory review evidence check may accept a verified waiver only for that
station; neither an empty reviews array nor prose alone grants the exception.

If a transport field is needed, keep the same bounded shape across
`tools/post-decision-record.js`, `implement/gate-helpers.js`'s `completionShape`,
`implement/publish.js`'s `mapCompletion`, the assertion sub-input, and the report
validator. Prefer evidence references over caller-supplied policy decisions.
Account for snake_case/camelCase mapping and Zod stripping of undeclared fields.
Do not introduce a parallel report DTO or waiver registry.

`implement/publish.js`'s monitor, `sonarGatePassed`, CI/Sonar watchers, and the
existing verification path remain the quality-gate owners. Report status enums
validate supplied statuses; they do not independently establish fresh remote
evidence. Bind the normal monitor evidence to the delivered PR/revision and
retain its failure handling. A station waiver grants no CI or Sonar exception.

The PR-body contract is also in scope if waived runs may advance before merge:
`pr-body-render.js` defaults to `completed` and permits `not_run` only for
`quickfix`; `tools/policy/authz_matrix.py` recognizes those two attestations.
Neither accurately describes an implement run with a waived station. Any such
pre-merge path must carry verified station-specific evidence through the
existing renderer, tool schema, synchronized PR writer, shared checklist
constants, and `tools/render_pr_body_fixture.mjs` parity check. Do not simply
permit `not_run` for implement or weaken the Python policy to accept any prose.
For an already merged delivery, preserve the original records and make the
final report explicitly correct any unsupported earlier review claim.

## Cross-cutting validation and runtime surface

| Layer | Required boundary |
| --- | --- |
| Tool registration and library inputs | Thin Zod handler; reuse bounded-text/ID validators, `review-reattempt.js`'s `REVIEW_STATION_IDS`, and the existing `REVIEW_STATION_BY_REVIEWER` mapping. Validate positive safe integer issue/cycle/comment IDs, finite arrays, and action-specific required/forbidden evidence fields at the semantic boundary too. |
| Repository authorization | `ensureGitRepo`, `authorizeImplementRepoRoot`, and `resolveMcpLaunchWorkspaceAuthorization` before privileged reads/writes. Derive the destination from pinned launch-workspace/common-Git-directory/origin identity. Do not trust caller paths or ambient `GH_REPO`. Retain `assertSafeImplementCheckoutConfiguration` wherever checkout commands run. |
| Thread replay | Paginated authored comments, effective permissions, exact source action, same-issue URL binding, trusted observation provenance, and deterministic codec/evaluator. No fallback from read/parse/auth failure to an empty clear ledger. |
| Publication and OS exposure | Existing `runtime-primitives.js` fixed-argv `execFile` and server-owned `gh api` posting. Apply `rejectReservedMarkerSequence` to caller text, `detectSensitiveBodyContent`, `GITHUB_ISSUE_COMMENT_BODY_MAX`, and `detectDeferralDisposition` where applicable. Comment bodies occupy argv and become public: include only bounded audit fields, never credentials, prompts, engine output, stderr, or local paths. |
| Error envelopes and observability | Reuse `ok/error/message/next_action` and mechanical `failure` propagation; no new exception hierarchy. Preserve actionable stable failure codes and record URLs. Existing raw `err.message`/`extractGhErrorMessage` paths are not guaranteed secret scrubbers: bound/sanitize new failure messages before returning or persisting them. Issue records are the durable audit; no restored backend telemetry and no fabricated review attempt for a waiver. |
| Configuration/environment | No new waiver-enabled setting, secret, environment variable, timeout, or child-process option. Preserve `ground-control-config.js`, normalized repo context, and `index.js`/`server-env.js` launch-time binding. If a setting becomes necessary, it must pass that existing config path, never a second YAML/env reader. |
| Workflow and policy | Update ADR-029's observation-resolution contract and the recovery/review-loop/completion docs when behavior ships. Keep ADR-031's verdict/cap distinction. Reuse `bin/policy`, `tools/policy/execution_contract.py`, shared deferral rules, ESLint/500-line limits, Vale, and the existing Make targets. Prose alone cannot enforce clearance. |

## Extensibility and verification bar

The seam is verified resolution evidence parameterized by station identity,
target obligation, workflow identity, and source authorization or observation
record. Keep station-specific verdict/coverage parsing with its existing owner;
the ledger and report consume normalized verified evidence. This permits the
next reviewer station without another completion exception. Do not build a
generic waiver framework, retry scheduler, authorization hierarchy, or new
cross-cutting abstraction for speculative consumers.

Extend the existing `node:test` ledger suites, fake-`gh` authored-thread tests,
review-cycle retry/posting tests, final-report boundary tests, and mechanical
completion tests. Under GC-O007's shipped-code bug-fix path, reproduce the
completion refusal on the unmodified buggy tree before repair; runtime marker
and policy data do not qualify for the prose-only carve-out. The #378 regression
must span separate invocations: incomplete
Codex observation, later complete cycles with findings repaired, two test-quality
launcher failures, scoped durable user waiver, and green merged delivery. Assert
Phase E succeeds and the report names the missing verdict accurately.

Negative coverage must retain refusal for absent/forged/wrong-scope waivers,
edited or unavailable sources, unrelated/older/incomplete observation evidence,
cross-version/kind collisions, reopened obligations, real unresolved findings,
red or unknown gates, and an unmerged PR. Cover same-cycle restart recovery,
later-cycle supersession, partial posts, duplicate requests, and both direct and
composed report entry points. Run `make mcp-test` and `make policy` on the final
implementation tree; no new test harness or CI workflow is needed.

Non-goals: implementing #1578 in this preflight; altering review caps/retries or
finding dispositions; waiving merge approval, CI, Sonar, or requirement checks;
reclassifying legacy problem prose; new requirement files, backend, database,
REST/controller/service layers, metrics, secrets, or external writes.
