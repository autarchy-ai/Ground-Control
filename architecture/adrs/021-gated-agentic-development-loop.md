# ADR-021: Gated Agentic Development Loop

## Status

Accepted

## Date

2026-04-05

> **Documentation sync for issues #650 and #1303 (2026-09-11):** The ADR-061
> projection went with the backend (#1500), and #1303 removes the surviving
> emitters and the active `telemetry` configuration surface. Legacy consumer
> configs may still carry that key, but it is ignored. Telemetry never gated a
> phase, so no gate changes. The same audit deletes the unregistered completion
> verifier, backend-only implementation rule, and duplicated hook copies; the
> configured mechanical, policy, review, and readiness gates remain. The workflow
> documents are reconciled in the same change: `docs/DEVELOPMENT_WORKFLOW.md` drops the contract
> surface, rollback, and Java-era sections whose subjects were deleted, and `docs/WORKFLOW.md`
> becomes a navigation page rather than a second, contradictory workflow definition. This ADR's
> gate contract stays the same.

> **Style sync for issue #751 (2026-06-14):** Repository-wide Vale cleanup normalized punctuation in workflow prose. This ADR's gate contract stays the same.

## Context

Ground Control is built by AI agents using the `/implement` skill, which orchestrates the full lifecycle from requirement to merged PR. The skill has evolved to include multiple quality gates, automated reviewers, and human checkpoints, but the gate structure is defined only in the skill's markdown instructions. It is not captured as a requirement, not traceable, and not self-documenting within Ground Control's own graph.

If the skill is modified, gates can be weakened or removed without any formal record of what was lost. Additionally, the existing GC-O series requirements (GC-O001 Self-Managed Requirements, GC-O004 Agent Workflow Traceability Standards, GC-O005 Requirement-Before-Code Policy) establish individual constraints but do not specify how those constraints compose into a coherent end-to-end workflow with enforced sequencing.

## Decision

Codify the gated agentic development loop as a first-class requirement (GC-O007) with five mandatory phases:

> **Amended by ADR-029 (2026-05-03; further amended 2026-05-09 per issue #804):** the human-touchpoint count drops from two to one (PR merge only). Plan approval is no longer a synchronous gate; the plan is posted as a comment on the GitHub issue thread and the workflow proceeds directly to TDD. Decisions on review findings are also recorded as issue comments. Phase B's traceability and status-transition requirements move to Phase D (after reviews). Codex review now runs as a single pre-push pass (Step 6.5), hard-capped at three cycles; the post-push codex review (former Step 12) is removed from the SKILL but remains as tool-layer defense-in-depth. Every successful cycle posts a verbatim findings record to the resolved issue thread. The phase structure (A/B/C/D) and gate ordering below are otherwise preserved. Read ADR-029 for the full new gate model.
>
> **Amended by issue #801 (2026-05-05):** Phase A's TDD step gains a narrow documentation-only carve-out (no executable behavior in the diff + every clause/criterion protected by a named structural gate; declared in the plan and re-stated on the issue thread; substring/snapshot tests are not gates). The Phase B completion gate re-validates the carve-out against the *actual* diff with a two-check sweep over the union of committed (`<base-ref>...HEAD`), staged, unstaged, and untracked paths. Both path (every changed path in the documentation set) and content (every diff hunk free of executable behavior) must pass, because a path check alone can miss executable behavior carried in an otherwise-doc-named file, and an `<base-ref>...HEAD`-only check would miss uncommitted changes still in the working tree. Phase D's traceability reconciliation gains a backfill rule for runs whose diff finalizes a requirement whose structural implementation lives in pre-existing files shipped under a sibling requirement; IMPLEMENTS links are backfilled onto those artifacts of record, bounded by the requirement's concrete subject matter. See `skills/implement/SKILL.md` Step 4.4, Step 6, and Step 16 for the operative prose, and `architecture/notes/implement-docs-only-preexisting-traceability-guardrails.md` for the preflight design context.

> **Amended by issue #871 (2026-08-14):** Phase A now names four TDD paths per requirement clause or acceptance criterion: new requirement/feature; shipped-code bug fix; reviewer-finding fix; and prose-only/static contract narrowing. Issue-level `implementation_intent` (`feature`, `bug-fix`, or `mixed`) is informational only; the plan's per-clause `tdd_path` is authoritative. A bug fix must first reproduce the reported defect on the unmodified buggy tree and cannot use the documentation-only carve-out, including when the changed artifact is runtime-consumed configuration, schema, grammar, fixture, or policy data. An accepted review fix to executable code or a runtime-consumed data contract must lock itself with proportionate regression evidence that fails when the defect is reintroduced. Because review-cycle decision records are auto-posted before fixes, post-fix test evidence is carried by self-verification rather than falsely attributed to the earlier record. The existing documentation carve-out, phase count, review placement/caps, durable marker model, and single human merge touchpoint are unchanged. Operative rules live in `skills/implement/steps/step-04.4-tdd.md` and `_review-loop-rules.md`; repo policy pins their semantic anchors. No `/bugfix` lane or MCP record schema is added.
>
> **Amended by issue #842 (2026-05-10):** Phase A's issue-resolution step (Step 1) now flags the resolved GitHub issue **in-progress** immediately after checking out the feature branch. It applies an `in-progress` label (created on demand if the repo lacks it, without overwriting an existing label's metadata; no `gh label create --force`) and posts a pickup comment on the thread recording the driver, the checked-out branch (`git branch --show-current`), and an ISO-8601 timestamp, so a maintainer scanning the issue list, or another agent, can see at a glance that the issue is in flight. This is operational visibility only: the pickup comment is not a phase marker, the plan comment, a findings record, or the final report, and it gates nothing. Phase D's issue-closure step (Step 18) removes the label; a run that escalates to the user without reaching Step 18 intentionally leaves it set (the issue *was* picked up and the work is paused, not finished). No new policy rule is added; the existing `workflow-guardrail-sync` rule already keeps `skills/implement/SKILL.md` in sync with the workflow docs and this ADR. See `skills/implement/SKILL.md` Step 1 and Step 18 for the operative prose, and `architecture/notes/in-progress-issue-flag-preflight.md` for the preflight design context.
>
> **Amended by issue #864 (2026-05-11):** Phase A's branch-creation step (Step 1 sub-step 11) now requires `gh issue develop --name <issue-number>-<short-slug>` instead of letting `gh` auto-derive the branch name from the full issue title. Total branch name is bounded at ≤ 50 characters and ASCII-only (no `→`, no `/`, no `=`). The unbounded form produced 100+ character branch names (real example: `825-verify-gc-t004-risk-treatment-plans-clause-by-clause-audit-transition-draft→active-reconcile-traceability` from PR #854) that broke terminal display, copy-paste, CI breadcrumbs, and downstream shell quoting, and were preserved permanently in pickup comments and issue threads. The `--name` flag only governs first-time pickups; `gh` reuses existing branches and ignores `--name` on a re-pickup. The SKILL therefore adds a **post-check after `git branch --show-current`** that validates the actual checked-out branch against the same rule. The post-check is the dispositive enforcement: it fetches the configured base and compares against `origin/<base>` (local base may be stale, which would either falsely fail or pass the safety predicate); when the actual branch is non-compliant AND has no commits relative to the remote base AND no PR exists, the skill renames in place AND repairs the issue's `LinkedBranch` so the GitHub Development sidebar matches: `git branch -m`, push the new ref + retire the old remote, then `gh api graphql` calls to `deleteLinkedBranch` (any stale link pointing at the old ref) and `createLinkedBranch` (the new ref against the issue's node id and current HEAD oid). The LinkedBranch repair is mandatory: a dangling sidebar entry would feed a subsequent `gh issue develop` re-pickup the stale metadata and reproduce the original failure mode the post-check exists to prevent. When the actual branch is non-compliant AND commits exist OR a PR exists, the skill applies the in-progress signal (label + pickup comment) BEFORE stopping, so a paused picked-up issue is still visibly flagged, then escalates to the user, because renaming a published branch is a force-push that breaks the PR head ref and any inline review threads. Issue #864's Out-of-scope explicitly excludes a `make policy` enforcement of branch-name shape; the SKILL post-check is the enforcement until empirical drift demonstrates a need for a repo-native check, at which point a separate issue would land it. The existing `workflow-guardrail-sync` rule keeps `skills/implement/SKILL.md`, `docs/WORKFLOW.md`, `docs/DEVELOPMENT_WORKFLOW.md`, and this ADR in sync but cannot detect an invalid branch name. See `skills/implement/SKILL.md` Step 1 sub-step 11 for the operative slug-derivation rule, the validation predicate, and worked examples.
>
> **Amended by ADR-036 (2026-05-11 per issue #868; refined by issue #891):** GC-O007's gate model is **unchanged** (one human touchpoint, ADR-029's three-cycle Codex cap, zero deferral, phase structure A/B/C/D), but the `/implement` skill gains three cost-reduction surfaces that ride on top of the same contract. (1) **Per-step model routing**: the SKILL declares a provider-neutral capability tier per step (`low` / `medium` / `high`) and stable stage/purpose names; `gc_resolve_workflow_route` reads `.ground-control.yaml` and resolves a stage to provider, agent, canonical model id, tier, and fallback policy. Claude Code drivers use canonical Claude ids (`claude-haiku-4-5` / `claude-sonnet-5` / `claude-opus-4-8`) and spawn an `Agent` subagent for routed subagent stages; parent-only high-tier stages stay on the parent. Codex drivers ignore delegation today unless they explicitly call the resolver and an external runner. (2) **Durable-record MCP tools**: `gc_post_decision_record` (Step 6.5 review-cycle decision records), `gc_post_final_report` (Step 19 final summary), and `gc_render_pr_body` (Step 9 PR-body composition satisfying `check_pr_body`) replace agent-authored free prose with deterministic structured-input renderers. Each tool reuses the existing `ensureGitRepo` / `getOwnerRepo` / `detectSensitiveBodyContent` / `gh api` boundary; each one returns a stable JSON envelope; each one is Temporal-shaped for GC-O009. (3) **Per-step telemetry**: `gc_log_step_telemetry` appends one JSONL record per routed step to `.gc/telemetry/<issue>-<sanitized-branch>.jsonl` (gitignored, repo-relative, containment-validated). This is operational measurement only: never workflow state, never a counter, never compliance evidence; the issue thread and Ground Control traceability remain the audit record. Both routing and telemetry are opt-in per repo via `.ground-control.yaml` knobs (`routing.enabled` and `telemetry.enabled`, both default `false`); existing repos see no behavior change until they flip them. Optional `routing.stages.<stage>` entries override the built-in `/implement` defaults. The `workflow-guardrail-sync` policy rule adds ADR-036 to its `requireAll` list so future SKILL edits keep this ADR in sync. See `skills/implement/SKILL.md` for the routing matrix and the Step 6.5 / 9 / 19 tool wiring, and `architecture/notes/implement-cost-routing-tool-surfaces-preflight.md` for the preflight design context.
>
> **Amended by issue #906 (2026-05-13):** The pre-push Codex review (Step 6.5) and the test-quality review both default to **cap 1 cycle** rather than cap 3, and the test-quality review **moves pre-push** to a new Step 6.6 in the same local-iteration band as the codex review (former Step 13 is merged out; former Step 14 collapses into Step 10's existing CI watch). Per-repo overrides via `.ground-control.yaml::workflow.codex_review.pre_push_cap` and `workflow.test_quality_review.pre_push_cap` (bounds `[1, 10]`); when unset, the MCP-side module defaults apply. The `override_cap=true` + `override_reason=<authorization quote>` escape is unchanged: a single over-cap cycle is always authorizable on demand regardless of the configured default. The rationale for the cap default drop is empirical: multi-cycle loops historically compounded the agent's own fix-introduced bugs more than they caught net-new bugs (PR #903's 4-cycle run was illustrative: cycles 2 and 3 each added ~15 min of agent time and ~$1 of API spend to surface defects the agent introduced while fixing cycle 1's findings, and CI / SonarCloud / the human reviewer caught the residual risk regardless). The test-quality-pre-push move means the PR opens with **both** AI-assisted reviewers clean rather than presenting reviewers with a stale codex-clean / test-quality-pending picture, and removes the extra commit + push + CI re-run + SonarCloud re-analyze loop that post-PR test-quality fixes used to require. Step numbering for Steps 15 / 18 / 19 (transitions, close, final report) is intentionally preserved so external references (ADR cross-links, policy rules, prose) do not track a moving target; old Steps 13 / 14 are tombstones in SKILL.md. The existing `workflow-guardrail-sync` policy rule keeps `skills/implement/SKILL.md`, `docs/DEVELOPMENT_WORKFLOW.md`, `docs/WORKFLOW.md`, this ADR, ADR-036, ADR-029, and ADR-031 in lock-step (the latter two added by #906 because the cap-contract changes touch them). See `skills/implement/SKILL.md` Step 6.5 / 6.6 for the operative loop prose, and `architecture/notes/quickfix-workflow-lane-preflight.md` for the preflight design context (the same issue also introduces `/quickfix` as a sibling skill).
>
> **Amended by issue #901 (2026-05-13):** Phase D's PR-creation step (Step 9) now validates the PR title locally before `gh pr create`, against two stable conventional-commit rules that downstream Ground-Control-aware repos enforce via `amannn/action-semantic-pull-request` or equivalent. (1) **Single conventional-commit type with optional scope**: format is `<type>(<optional-scope>): <subject>`. Compound prefixes such as `security/docs:` or `fix/refactor:` are rejected; bundled PRs pick the dominant type. (2) **Lowercase-leading subject**: matches `^[a-z].*$`. Uppercase acronyms (NGFW, GCP, MCP) must be reshaped (lowercase, relocate into a slash-prefixed path, or front with a verb). Per-repo override via `.ground-control.yaml::workflow.pr_title.types` / `subject_pattern`; otherwise the conventional-commits canonical allow-list applies. The skill performs the validation locally; invalid titles are reshaped before push so the agent does not eat an edit-cycle-per-failure after every `gh pr create`. The existing `workflow-guardrail-sync` policy rule already keeps `skills/implement/SKILL.md`, `docs/WORKFLOW.md`, `docs/DEVELOPMENT_WORKFLOW.md`, and this ADR in sync. See `skills/implement/SKILL.md` Step 9 for the operative rule + reshape examples.
>
> **Amended by issue #848 (2026-05-10):** Phase B's "CHANGELOG update" artifact is replaced by a **changelog fragment** convention. Per-PR release notes ship as files under `changelog.d/<issue>.<type>.md` (or `+<slug>.<type>.md` for issue-free entries), where `<type>` is one of the six Keep-a-Changelog categories (`security`, `added`, `changed`, `deprecated`, `removed`, `fixed`). CI-only and docs-only diffs may ship without a fragment; there is no "pure refactor" carve-out because the enforcement is path-based and cannot distinguish a behavior-preserving refactor from a feature change, so refactors under application source still file a fragment. A direct `CHANGELOG.md` edit does NOT satisfy a source-changing diff (it would re-open the rebase-storm pathology this change exists to prevent); direct edits are reserved for release-collation commits whose diff is `CHANGELOG.md` plus the consumed fragments. Release-time `uvx towncrier build` collates fragments into `CHANGELOG.md` at the `<!-- towncrier release notes start -->` marker. The change exists so concurrent PRs cannot conflict on the same `CHANGELOG.md` line range, eliminating a structural rebase-storm pathology that costs CI capacity and engineering time with no behavioural benefit. Enforcement is repo-native: `tools/policy/checks.py::run_changelog_fragment_check` (codes `changelog-signal-missing`, `changelog-fragment-invalid-name`, `changelog-fragment-infrastructure`) covers the completion gate; `.claude/hooks/verify-implementation.sh` mirrors the same vocabulary as a host-local Stop hook, and the `hook-matches-policy-vocabulary` policy test keeps the two layers in sync. The convention itself is the template for other Ground-Control-aware repos. These files are copied/adapted, not generated: `towncrier.toml`, `changelog.d/_template.md.jinja`, `changelog.d/README.md`, the `CHANGELOG.md` marker, the `.gitattributes` `CHANGELOG.md merge=union` belt-and-suspenders rule, and the `.gc/plan-rules.md` fragment rule. Issue-thread planning (ADR-029), Codex review routing (ADR-029 + #804), traceability semantics (Step 16), and release automation triggers (per-repo) are unchanged. See `skills/implement/SKILL.md` Step 4 / Step 6 / Step 4.4 / Step 15 / Step 16 for the operative prose, `changelog.d/README.md` for the convention, and `architecture/notes/changelog-fragments-preflight.md` for the preflight design context.

1. **Phase A: Plan and Implement**: Fetch the requirement and issue context, run architecture preflight, explore the codebase, post the plan to the issue thread, implement with the clause-level TDD path, and verify clause-by-clause.
2. **Phase B: Quality Gate and Pre-Push Review**: Run the configured completion and policy commands, satisfy quality gates, and complete the bounded pre-push Codex review cycles (the dedicated test-quality reviewer was removed by ADR-099). Release Please owns changelog and product-version artifacts.
3. **Phase C: Publish and Synchronize**: Run the configured pre-commit boundary, commit and push the feature branch, merge the latest integration branch into it, and verify the synchronized tree before PR creation.
4. **Phase D: Ship Pipeline**: Create the synchronized PR, monitor CI and SonarCloud, then post the pre-merge readiness record and present the PR for human merge.
5. **Phase E: Post-Merge Reconciliation**: After merge, transition in-scope requirements, reconcile repo-local traceability against the shipped diff, post the reconciled final report, and close the issue idempotently.

**Human touchpoints**: ~~Exactly two (plan approval in Phase A and PR merge in Phase D)~~ *Per ADR-029, exactly one: PR merge (Phase D). Plan, review findings, and decisions on findings are recorded as comments on the GitHub issue thread.*

**Zero-deferral policy**: All reviewer findings are fixed before the PR is presented. No findings are deferred to follow-up work.

> **Amended by ADR-029 (2026-05-10 per issue #830):** the zero-deferral policy is now mechanically enforced. A `PreToolUse` hook (`.claude/hooks/block-defer-language.py`) blocks `gh issue/pr {create,edit,comment,close}` calls carrying deferral-disposition language, and `bin/policy` flags the same language in the PR body at completion gate. Filing a tracking issue does not convert a deferral into a valid disposition; the only valid dispositions are `fix`, `wontfix` (with explicit user authorization), or `not-applicable` (with rationale). Codex review additionally classifies each finding `one-off` or `class`; a `class` finding must be fixed at the category level (one structural point of repair applied to every instance), not whack-a-mole'd to the reviewer-named site. See ADR-029 § "`defer` is not a valid disposition" for the full contract.

The workflow is implemented by:
- `/implement` skill (`.claude/skills/implement/SKILL.md`)
- Repo-native policy guardrails (`architecture/policies/adr-policy.json`, `bin/policy`, `make policy`)
- Development workflow docs (`docs/DEVELOPMENT_WORKFLOW.md`, `docs/WORKFLOW.md`)
- Repo-local workflow config at `.ground-control.yaml` (with larger rule files under `.gc/`), resolved by `gc_get_repo_ground_control_context`. `AGENTS.md` carries a brief pointer to this config rather than the full workflow definition inline.

The requirement:
- **Depends on** GC-O004 (agent traceability standards) and GC-O005 (requirement-before-code policy), which supply the constraints the quality gate enforces.
- **Related to** GC-O006 (SDD workflow tracking) and GC-C010 (configurable quality gates), which are future automation surfaces.
- **Refines** GC-O001 (self-managed requirements), specifying how the development process itself is governed.

## Consequences

### Positive

- Gate structure is traceable and protected from silent regression
- Self-referential traceability links dogfood GC's own traceability system
- Changes to `/implement` can be evaluated against the requirement to detect gate weakening
- Foundation for automating gate evaluation via GC-C010 quality gates
- Workflow conformance no longer depends only on Claude-specific user hooks; the repo itself now enforces the critical guardrails in pre-commit and CI

### Negative

- Requirement must be kept in sync with the `/implement` skill, creating a maintenance obligation

### Risks

- Over-specification could make the skill rigid; the requirement intentionally specifies gate structure (what must be checked) rather than implementation details (how to check it), preserving flexibility in tooling choices

## Amendments

**2026-05-19 (issue #931).** *Superseded in part by ADR-099 (2026-09-17): Step
6.6 and the test-quality reviewer no longer exist, and a clean terminal verdict
is no longer required before push. The verdict-envelope shape described here is
still what Step 6.5 consumes.* The pre-push review gate (Step 6.5 codex + Step
6.6 test-quality) now consumes a verdict envelope (`verdict` +
`architectural_read` + `blocking` + capped `notes`) rather than a
findings-only payload. The gate contract is unchanged: both reviewers must
return clean before push, but a clean cycle now emits `verdict: ship` as a
first-class outcome instead of an empty findings array. See ADR-029
(amendments) and ADR-031 (amendments) for the envelope shape; see
`skills/implement/SKILL.md` Step 6.5 / 6.6 for the operative loop prose.

**2026-05-21 (issue #937).** The codex/claude-backed review and preflight
gates (`gc_codex_architecture_preflight` at Step 2.5, `gc_codex_review` /
`gc_codex_review_cycle` at Step 6.5, and `gc_test_quality_review` /
`gc_test_quality_review_cycle` at Step 6.6) gain an opt-in async execution
mode. Each spawns a child process (`codex exec` / `claude --print`) that
legitimately runs for several minutes; run synchronously, a single MCP
tool-call blocked past the MCP client's per-call timeout, the client
abandoned the call, and the orphaned child left the workflow with no result
handle (issue #893). With `async: true` the tool starts a background job and
returns a `job_id` immediately; the workflow polls the new `gc_codex_job`
tool for the result envelope, or cancels a stuck job (the cancel aborts an
`AbortController` whose signal kills the child, so nothing is orphaned). The
GC-O007 gate contract is **unchanged**: the same gates run, the same caps
apply, the same durable records post to the issue thread; async changes only
how the agent waits for a result. Client-side, `.claude/settings.json` now
sets `MCP_TOOL_TIMEOUT` / `MCP_TIMEOUT` explicitly so long-running MCP tools
have headroom. See ADR-036 (amendments) for the async job model and
`skills/implement/steps/step-02.5 / 06.5 / 06.6` plus `_review-loop-rules.md`
for the operative start-then-poll loop prose.

**2026-07-30 (issue #943).** The two public review-cycle wrappers strengthen
that transport into an async-only, idempotent gate. Each logical attempt uses
one bounded key; retained identical retries return one job, changed input
conflicts, and distinct attempts are serialized per authorized canonical
repository, issue, and reviewer. Cycle jobs do not advertise cancellation as
rollback, and a missing job handle requires refreshing the durable issue
thread before another attempt. The GC-O007 phases, cap policy, durable record
order, and terminal review envelope are unchanged.

**Amendment: renderer summary byte caps (#964).** `gc_render_pr_body` and `gc_post_final_report` now enforce reject-not-truncate byte caps on their caller-controlled summary fields (`PR_BODY_SUMMARY_MAX = 1200`, `FINAL_REPORT_SUMMARY_MAX = 800`, `FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX = 600`, `FINAL_REPORT_REVIEW_SUMMARY_MAX = 240` for `reviews[].summary`). `gc_post_decision_record`'s schema is unchanged; its caller-controlled prose fields already carry per-field caps via `REVIEW_NOTES_MAX` / `REVIEW_NOTE_TEXT_MAX` / `FINDING_*_MAX`. The canonical succinctness rule is in `skills/implement/steps/_review-loop-rules.md § Update succinctness (canonical)` and is referenced from all three renderer tool descriptions. `buildFinalReport` omits the In-scope requirements and Reviews sections entirely when their inputs are empty (no placeholder lines).

**Amendment: issue close mechanism (#862 typed-action-items PR).** The /implement Step 18 no longer runs `gh issue close`. The GitHub issue closes via `Closes #<issue-number>` in the PR body (rendered by `gc_render_pr_body` in Step 9) when the user merges the PR. Step 18 only removes the `in-progress` label set in Step 1. Closing from the agent decoupled the close event from the merge: an unmerged or rolled-back PR would leave a closed issue with no shipped code (GitHub does not re-open issues on revert). Step 19 (final report) is correspondingly tightened: traceability reconciliation (Steps 15 through 17) is an explicit precondition, and no earlier step surfaces a user-facing "complete" signal (prior escalations are for input, not for "done"). The /quickfix sibling lane is updated in lockstep.

**2026-05-26 (issue #989).** A new workflow lane, `/integrate` (GC-O011), prepares maintainer-approved pull requests for merge without automating the merge itself. The lane operates outside the issue-anchored four-phase structure (A/B/C/D) of this ADR: it is repo-scoped, not issue-scoped, and its records surface through the invoking interface rather than through GitHub issue thread comments. The single-merge-touchpoint contract is unchanged. See ADR-029 (2026-05-26 amendment) and `docs/DEVELOPMENT_WORKFLOW.md § /integrate`.

**2026-05-26 (issue #989 merge carve-out).** The `/integrate` lane at mode=merge may now execute the merge for PRs that the same run has prepared and verified. This carve-out applies at the `/integrate` lane only; `/implement` and `/quickfix` must not merge. The full gate contract is in ADR-029 (2026-05-26 merge carve-out amendment). The issue-anchored phases A/B/C/D of this ADR are unaffected.

**2026-05-30 (issue #1058 Phase E added).** A new Phase E (`/implement` Step 20) handles post-merge issue close via `gc_close_issue_after_merge`, which verifies the linked PR's `merged_at` non-null AND state `MERGED` before running `gh issue close`. The single-human-touchpoint contract is unchanged: PR merge remains the only synchronous user gate; Phase E runs autonomously when the user re-invokes `/implement` after the merge. The traceability-reconciliation precondition for Step 19 is now mechanically enforced by `gc_post_final_report` (refuses without the `traceability_reconciled` phase marker written by Step 17's `gc_assert_traceability_reconciled` call). The full contract is in ADR-029 (2026-05-30 amendment). The issue-anchored phases A/B/C/D of this ADR are unchanged in scope; Phase E is additive.

**2026-06-13 (issue #1156 Phase D outcome and Phase E recommendation).** Step 19's MCP final report now requires a bounded `plain_english_outcome` for `/implement`, rendered before the structured evidence so the user sees the Phase D result in product or operator terms. Step 20's merge-verified close envelope now includes a best-effort `next_issue_recommendation`, or an explicit no-recommendation/failure reason. Recommendation lookup is advisory; the one-human-touchpoint contract and merge-verified close gate remain unchanged.

**2026-06-10 (issue #1099 threat/risk screening gate).** A new Phase A gate, Step 3.5 (GRC screening), runs between codebase assessment (Step 3) and planning (Step 4). The step reads the project's existing threat-model and risk-scenario workspaces and classifies the planned change surface against them, recording one of three verdicts (`security_relevant`, `not_security_relevant`, `no_baseline`) as a durable screening record on the GitHub issue thread via the new `gc_post_grc_screening` MCP tool per ADR-057. This gate operationalizes GC-O012 (GRC-in-the-loop requirement): prose-only instructions carry no enforcement weight; the gate is enforced at the tool layer. The gate adds one MCP tool call per run (two for `security_relevant` runs that need GRC writes); the step is routed at tier medium. The single-human-touchpoint contract (PR merge) is unchanged. The phase boundaries A/B/C/D are structurally unchanged; Step 3.5 is a new step within Phase A, and downstream step numbering is preserved. See ADR-057 for the full decision, `skills/implement/SKILL.md` for the step routing, and `skills/implement/steps/step-03.5-grc-screening.md` for the operative prose.

**2026-06-14 (issue #1103 Phase D consolidation).** The former Steps 17 (verify), 18 (label removal), and 19 (final report) are collapsed into a single Step 17. The new consolidated step calls `gc_assert_completion`, which sequences `gc_assert_traceability_reconciled`, `gc_assert_grc_reconciled`, and `gc_post_final_report` in one deterministic MCP tool call. The `in-progress` label removal is now optional best-effort, not a mandatory step gate; the label lifecycle is operational-only and the issue is closed at Phase E. Phase D boundary is now Steps 9 → 17. The single-human-touchpoint contract is unchanged.

**2026-09-21 (issue #1686 pickup-label lifecycle owner).** The `in-progress` label is now
dropped by `gc_close_issue_after_merge`, at the shared close boundary, once the issue is
actually closed. The #1103 amendment above made its removal an optional best-effort agent
step after Step 17, which held while an agent still ran Phase E; ADR-102 (#1671) moved Phase
E into a merged-pull-request workflow and let the agent terminate permanently at Phase D, so
the step kept its place in the contract and lost its executor and every delivery closed still
flagged in progress. Placing it at the close boundary gives it an owner every caller reaches:
the merged-pull-request workflow, `gc_finalize_merged_pr`, an agent re-invoked after a merge,
and `/quickfix` Q7. It is best-effort there, and only the removal is: a cleanup failure never
changes the close outcome, the returned envelope, or whether finalization is reported as
successful, because a stale label is a cheaper outcome than a completed delivery reported as
failed. It removes the single issue-label association rather than replacing the label set or
deleting the repository label, and it runs strictly after a successful close, including the
idempotent `already_closed` path so a replay converges. A refused or failed close removes
nothing: an issue left open really is still in progress. The label still confers no authority
and gates nothing. Step 17's own optional-removal recipe is retired: that step is reached
before the merge as well, where the label is accurate and removing it would invert the signal
on the one issue most in need of it.

**2026-06-19 (issue #1189 Cursor CLI driver).** The agent-neutral `/implement` skill is invocable from Cursor CLI via `bin/install-skills.sh` (hard-copy into `~/.cursor/skills/<name>`) and, in Ground-Control repos, a project wrapper at `.cursor/skills/implement/SKILL.md` (real file pointing at `skills/implement/SKILL.md`; symlinked skill folders fail Cursor discovery). The GC-O007 gate model is unchanged: Cursor CLI is a third orchestrator driver alongside Claude Code and Codex; Codex remains reviewer-of-record; poll-loop stages stay on the parent session. See `docs/DEVELOPMENT_WORKFLOW.md § Cursor CLI`.

**2026-06-22 (issue #963 post-merge reconciliation ordering).** A new **Phase E** is added to the gated loop's phase structure. The requirement `DRAFT→ACTIVE` transition (Step 15), traceability reconciliation (Step 16), and the reconciled final report (Step 17) move from Phase D (pre-merge) to Phase E (post-merge), so Ground Control state never runs ahead of shipped code: a reviewed-but-abandoned PR no longer leaves a requirement flipped ACTIVE with links to code that never merged. Phase D's terminal step becomes a pre-merge **readiness** record (`gc_assert_completion phase="pre_merge"`, carrying a `ready_for_review` marker); the Phase E completion (`gc_assert_completion phase="post_merge"`, the default) is merge-gated and refuses with `completion_pr_not_merged` unless the linked PR is merged, mirroring the #1058 close gate. The single-human-touchpoint contract (PR merge) is unchanged - Phase E runs autonomously when the user re-invokes `/implement <issue>` after merge. The A/B/C structure is unchanged. GC-O007 statement (B)/(D) are amended and a clause (E) added in lockstep (see ADR-029 §2026-06-22 for the full mechanism).

**2026-07-03 (issue #1271, ADR-081 program).** ADR-081 adopts the Temporal dev workflow and console program (milestone 17) and defines the **skill-lane cutover model**: ownership of a workflow phase transfers from this skill lane to the GC-O009 Temporal workflow only when the per-phase parity harness is green, the issue-thread marker enforcement stays authoritative up to the transfer, and the transfer is recorded as a dated amendment to this ADR and ADR-029 naming the phase and the enforcement that moved server-side. Until such an amendment exists for a phase, this ADR's gate contract for that phase is unchanged and must not be weakened by bridge or engine work. The gate model itself (one human touchpoint, phase structure A-E, zero deferral, cycle caps) is not modified by ADR-081.

**2026-07-11 (issue #1346, ADR-089 reversal of the Phase E recommendation clause).** The 2026-06-13 (#1156) amendment above bundled two unrelated changes. Its `plain_english_outcome` clause remains in force unchanged. Its `next_issue_recommendation` clause is reversed: `gc_close_issue_after_merge`'s Phase E close envelope no longer performs a best-effort next-issue lookup or returns `next_issue_recommendation` / `next_issue_recommendation_reason` / `next_issue_recommendation_error` in any form, including `null`. Step 20 now returns only the linked-PR resolution, merge-state verification, and idempotent close result. The one-human-touchpoint contract, the merge-verification gate, and every other Phase E decision in this ADR are unaffected. See ADR-089 for the full retirement decision.

**2026-09-21 (issue #1679, scheduled gates versus exception pauses).** "One
human touchpoint" in this ADR, in ADR-029 and in GC-O007 counts the human gates
the workflow **schedules**: PR merge, and nothing else. It never meant that a run
may not escalate. A bounded exception-path pause on a documented pause class from
`skills/implement/_development-principles.md` - an enforced cycle cap, an
unresolved ambiguity, a significant architecture or security decision,
unexpectedly material scope expansion, destructive or externally consequential
authority, a hard external dependency - is not a scheduled gate and does not
change the count. This resolves the conflict reported in issue #1679 between
ADR-099 §1's review-cap question and the sole-touchpoint statement here: the cap
question is an exception pause, not a second gate. No mechanism changes; ADR-099,
the review-cycle dispatch vocabulary, `_review-loop-rules.md`, and the optional
auto-disposition surface are unaffected.

**2026-07-15 (issue #1399, GC-P027 Release Please adoption).** The issue-#848 changelog-fragment convention (the Phase B amendment above) is **retired**: Release Please now owns `CHANGELOG.md` and the product version, feature PRs no longer file `changelog.d/` fragments or edit `CHANGELOG.md`, and the Towncrier machinery (`changelog.d/`, `towncrier.toml`, `run_changelog_fragment_check`, the `.gitattributes` `merge=union` rule, and the Stop-hook fragment vocabulary) is removed. The changelog is generated from Conventional Commit history on `main`. The #901 conventional-commit PR-title rule (blockquote above) is now enforced **authoritatively in CI** by `.github/workflows/pr-title.yml` (`amannn/action-semantic-pull-request`), in addition to the skill's local check, using the same canonical type vocabulary and lowercase-subject rule. `run_changelog_fragment_check` is replaced by `run_version_mirror_consistency_check` (code `version-mirror-drift`), and `gc_render_pr_body` gains a `changelog_mode` input (`fragments` default | `release-please`), which the workflow passes for any repo that ships a root `release-please-config.json`, so Release Please repos require no fragment (#1336). The gate model (one human touchpoint, phase structure A–E, zero deferral, cycle caps) is unchanged; only the changelog artifact and its ownership move. See ADR-063 (2026-07-15 amendment) and `architecture/notes/release-please-preflight.md`; the `workflow-guardrail-sync` rule keeps `skills/implement`, `docs/DEVELOPMENT_WORKFLOW.md`, `docs/WORKFLOW.md`, ADR-021/029/031/036, and the /quickfix lane in lockstep.

**2026-07-25 (issue #1416, execution principles and persistence).** `/implement`
now loads `skills/implement/_development-principles.md` before configuration,
routing, issue resolution, branch preparation, or delegation and propagates its
immutable execution contract to every delegated step. Branch preparation is a
same-checkout operation through `gc_prepare_implement_branch`; the workflow does
not create or switch to another worktree. Discovered defects, failing checks,
security concerns, workflow failures, and quality problems remain execution
obligations regardless of provenance or the initial anticipated diff. A run may
pause only for a required user decision, a hard external dependency, or an
architectural/security decision that cannot safely be made under existing
authority; workload and file count are not pause reasons. Open obligations are
durable issue-thread state and block both pre-merge readiness and post-merge
completion. The one-human-touchpoint contract and existing review caps are
unchanged: a cap can pause a run but cannot erase the remaining obligations.
The same canonical principles make local verification risk-proportionate:
implementation and review-fix loops batch related edits and use the narrowest
behavioral tests, widening for shared, cross-cutting, security-sensitive, or
observably wider risk. Repository-wide completion and policy gates run once at
their meaningful final-tree boundary rather than after every small fix, and
Step 7 owns one mandatory pre-publish pre-commit boundary. No mandatory
completion, review, CI, SonarCloud, or final policy gate is removed.

**2026-07-26 (issue #1421, primary execution and pre-PR synchronization).**
Phase C now ends with mandatory Step 8.5 after the initial commit/push:
`gc_synchronize_implement_branch` fetches the configured integration branch
into its exact `refs/remotes/origin/<base>` ref, merges it in the invocation
checkout, mechanically runs the completion and policy gates on the exact
merged tree, verifies/publishes the resulting graph, and posts an idempotent
trusted issue-thread attestation. Step 9 creates a PR only through
`gc_create_synchronized_implement_pr`, which re-fetches the base and requires
the attestation, verified tree, authorized repository, existing PR identity,
and local/remote feature heads to remain exact. The same
amendment retires Ground Control's forced-delegation contract: routine steps
run in the primary invocation session, while routing retains advisory
stage/tier/model metadata only. Explicit user/runtime delegation remains
possible outside that contract. `/integrate` is unchanged.

**2026-07-26 (issue #1426, deterministic phase composition).** The existing
gate sequence is now composed into coarse successful-path calls by
`gc_implement_mechanical`: bootstrap (Steps 1 and 2), verification (Step 6),
publish and base synchronization (Steps 7 through 8.5), CI/Sonar monitoring
(Steps 10 and 11), pre-merge readiness, and post-merge completion plus close. The
composite invokes no model and cannot waive or replace a constituent gate. It
returns control to the primary only for a bounded actionable failure or
semantic work. Phase ordering, review caps, zero-deferral behavior, the
single-human merge touchpoint, and post-merge reconciliation are unchanged.

**2026-07-26 (issue #1414, pre-push review reads the whole diff).** Phase C's
pre-push Codex review gate is unchanged in position, cap, and stopping
behavior, but its evidence contract is tightened: an over-cap diff is now split
server-side into bounded inline slices that both reviewers read as one logical
cycle, instead of being replaced by a file manifest the reviewer was asked to
expand itself. A cycle that does not achieve complete coverage fails closed
without writing durable state and without consuming a cycle. The gate sequence,
the single human touchpoint at PR merge, the zero-deferral rule, and post-merge
reconciliation are unchanged.

**2026-07-26 (issue #1429, configuration-derived policy gate).** The repository
policy gate keeps its position and blocking behavior in Phase B (Step 6) and at
the Phase C base-synchronization boundary (Step 8.5), but the command it runs
is no longer hardcoded to `make policy`. It comes from
`workflow.policy_command` in `.ground-control.yaml`, normalized to `make policy`
when omitted, so repositories whose policy gate is named differently can satisfy
the boundary at all. Completion and policy remain two separate mandatory gates;
neither substitutes for the other, and an absent target fails loudly rather than
causing the gate to be skipped. Phase structure A-E, the single human touchpoint
at PR merge, the zero-deferral rule, cycle caps, and post-merge reconciliation
are unchanged. Phase C's single mandatory pre-publish hook boundary (Step 7)
gains the same treatment through `workflow.precommit_command`, normalized to
`pre-commit run --all-files`: the boundary stays mandatory and non-skippable,
while the tool that satisfies it becomes repo-native. See ADR-027
(2026-07-26 amendment) for the configuration contract.

### 2026-07-26 amendment: workflow-guardrail-sync requires one gate record, not all

The `workflow-guardrail-sync` rule in `architecture/policies/adr-policy.json`
required every one of ADR-021, ADR-029, ADR-031, ADR-036, and the `/quickfix`
sibling lane in the same diff as any workflow-guardrail change. The intent is
that guardrail prose must not drift away from the gate record. Requiring all of
them at once did not serve that intent: a change to one topic had to write into
ADRs it did not touch, which produces contentless amendments and degrades the
ADR record it was meant to protect. Issue #1434 hit this - a requirement-identity
fix in the mechanical tool was asked to amend ADR-031, the codex review stopping
model.

The workflow documents (`docs/DEVELOPMENT_WORKFLOW.md`, `docs/WORKFLOW.md`)
remain unconditionally required, because a guardrail change is always visible in
the workflow narrative. The four gate-model ADRs and the `/quickfix` lane move
to `requireAny`: the change must be recorded in at least one of them, and the
author picks the one the change actually concerns. The rule does not become a
no-op - a guardrail change that records itself nowhere in the gate model still
fails - and no gate is skipped, weakened, or made non-blocking.

**2026-09-03 (issue #1543, Phase E is bookkeeping-only).** A post-merge Phase E
resume on already-shipped work whose requirement is already ACTIVE with
complete, consistent traceability finds Steps 15 and 16 to be idempotent no-ops
that produce no edits. That empty diff is the expected terminal state, not a gap
to fill: Phase E must not manufacture a placeholder requirement-file edit to
create something to commit, and must not run the completion command, the policy
suite, the pre-push reviews, or any other implementation / code-change
verification for bookkeeping. Phase E's only mechanical gate is
`gc_implement_mechanical action="finalize"` (the merge-gated final report plus
idempotent issue close), which runs no `verify`; when Steps 15/16 do produce
edits, those are frontmatter / traceability documentation edits gated by the
pre-commit and policy boundaries, not by the completion / test suite. No
mandatory pre-commit, completion, review, CI, SonarCloud, or final policy gate
is removed; the change only stops a no-change bookkeeping phase from
manufacturing work. The phase structure A-E, the single human touchpoint at PR
merge, the zero-deferral rule, cycle caps, and post-merge reconciliation are
unchanged. Enforced by the `implement-phase-e-noop-contract` policy check
(`tools/policy/implement_scope_contract.py`) against `skills/implement/steps/step-17-completion.md`.

**2026-09-14 (issue #1593, breaking-change title marker).** The PR-title rule
from the issue #901 amendment accepts the Conventional Commits breaking-change
marker: `<type>(<optional-scope>)!: <subject>`, for example `feat!:` or
`feat(api)!:`. Release Please reads that `!` from the squash-merge title to cut
a major release, so the MCP PR-creation boundary (`validateImplementPrTitle`)
must let it through rather than force a retitle outside the tool. At most one
`!` is allowed, and only between the type or scope and the colon. The configured
`workflow.pr_title.types`, `subject_pattern`, and `require_scope` rules apply
unchanged.

**2026-09-14 (issue #899, no manual pre-commit outside publish).** Phase C's
single mandatory pre-publish hook boundary stays where issue #1429 put it:
`gc_implement_mechanical action="publish"` runs `workflow.precommit_command`
explicitly and then commits. The boundary does not move to the commit-time
hook, because hook installation is per clone and a repository may not use the
pre-commit framework at all. What changes is the prose around it. Step 4.4 and
`/quickfix` Step Q5 now tell the agent not to run `pre-commit` by hand and not
to commit before `publish`, since a local commit bypasses publish's
sensitive-path screening and commit-message validation. The
`implement-manual-precommit-instruction` policy check
(`tools/policy/verification_boundary_contract.py`) fails when `/implement` or
`/quickfix` prose names a `pre-commit run` invocation outside Step 7, and the
existing `implement-verification-boundary-drift` check, now in the same module,
requires the matching Step 4.4 and Step Q5 tokens. No mandatory gate is added,
removed, or reordered.

**2026-09-17 (issue #1626, exact-input verification reuse).** Phase B and the
Phase C base-synchronization boundary retain both mandatory broad gates, but the
MCP tool now owns their execution count. A successful verification attestation
may satisfy a retry only when the repository, candidate content tree, base SHA,
configured completion and policy commands, and toolchain fingerprint are
identical. A process-local phase result may likewise be reused when a later gate
fails and the caller retries the unchanged candidate. Any mismatch, unavailable
fingerprint, process restart, or untrusted attestation fails closed to normal
gate execution. The result envelope reports whether broad gates executed or
trusted evidence was reused. Step 7 still runs the configured pre-commit command
once; its following mechanical commit disables hooks so the same check cannot
run a second time. Gate order and blocking behavior are unchanged.

## 2026-09-17 amendment: CI-owned verification and progressive remediation

Issues #1628 and #1629 retire the mandatory local mechanical verification phase
and completion/policy execution during base synchronization. CI owns broad
verification of the published head. Targeted local tests and the single publish
pre-commit boundary remain. The exact-input verification attestations, toolchain
fingerprints, and phase caches from #1497/#1626 are removed; synchronization
records continue to bind Git identity, not test results.

Monitoring observes CI and Sonar concurrently and returns actionable failures
before unrelated checks finish, preserving child job handles for ongoing
observation. Readiness reads required hosted checks for the current head SHA and
refuses missing, pending, failed, or unavailable evidence. A later push invalidates
old-head completion claims. Review and human merge gates remain in place.

## 2026-09-20 amendment: the CI gate's evidence is bound to a commit

The 2026-09-17 amendment above put broad verification in CI and made readiness
read required hosted checks for the current head SHA. The CI watch that feeds it
carried no such binding. `gc_watch_ci_run` grouped runs by the head SHA of the
newest run `gh run list` reported, and a push's own runs register seconds to
minutes after the push, so the newest run during that window is the previous
commit's. The gate could therefore be satisfied by a commit nobody had built
(issue #1365).

The watch now binds to one commit before selecting any run: the caller's
expected head, or the branch tip read from GitHub. An unregistered run set is a
bounded wait and then a refusal, never a pass, and the terminal envelope names
the head SHA and workflow it reports on. `/implement` monitoring supplies the
pull request head, and `/integrate` supplies the commit it force-pushed. The
loop's gates are otherwise unchanged; the mechanics live in the ADR-027
2026-09-20 amendment.

**2026-09-20 (issue #1669).** The start-then-poll wait the #937 amendment
introduced now has a terminal-wait form: `gc_codex_job action="await"` holds one
request until the job is terminal, so waiting on architecture preflight, a
review cycle, or the CI/Sonar monitor costs roughly one model turn instead of
one per tick. The GC-O007 gate contract is unchanged: the same gates run, the
same caps apply, the same durable records post to the issue thread, and a bounded
wait's expiry returns the running envelope rather than any kind of pass. Only how
the agent waits changes. See ADR-036 (2026-09-20) for the transport model and
`skills/implement/SKILL.md` plus the step files for the operative prose.

## 2026-09-20 amendment: Phase E finishes without an agent (issue #1671)

Phase E has been deterministic since #1541 made it validation-only, but it still
needed a model or agent session to re-enter the workflow after the merge and call
the finalizer. A delivered issue therefore stayed open until somebody remembered
to finish it.

Phase D now records a trusted delivery handoff: the exact completion payload,
digest-bound to the issue, the pull request, and the head whose hosted checks
readiness verified. The agent may then terminate permanently at a ready pull
request. A merged-pull-request GitHub Actions job replays that payload through
the unchanged `gc_implement_mechanical action="finalize"`.

The phase structure A–E and the single human touchpoint are unchanged; the
touchpoint simply becomes the end of human and agent involvement rather than a
pause in it. Re-invoking `/implement` after a merge remains supported as the
fallback. `readiness` becomes lane-discriminated so `/quickfix` records the same
neutral handoff without gaining implement-only gates. See ADR-102.
