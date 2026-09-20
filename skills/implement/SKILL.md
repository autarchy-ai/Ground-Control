---
name: implement
description: End-to-end issue implementation - from plan through merged PR. Agent-neutral (Claude Code, Codex, Cursor CLI). Parameterized by .ground-control.yaml. Primary-session orchestrator with structurally enforced MCP gates.
argument-hint: <issue-number | requirement-uid>
disable-model-invocation: true
---

# Implement (orchestrator): $ARGUMENTS

## Development principles — load before every other action

The parent's first executable action is to read
[`_development-principles.md`](./_development-principles.md) in full. This
happens before configuration lookup, route resolution, issue resolution,
branch handling, or workflow execution.

Capture the canonical invocation root at the same time and create the
parent-owned immutable execution contract:

```json
{
  "schema": "gc.implement.execution-contract/v1",
  "principles_source": "skills/implement/_development-principles.md",
  "principles_sha256": "<sha256 of the exact UTF-8 file bytes>",
  "invocation_root": "<canonical absolute checkout root>",
  "checkout_mode": "same_checkout"
}
```

Cache this object as `execution_contract` and the full file contents as
`development_principles_verbatim`. The parent validates both before every
step. Returned step state may add fields but must never replace
`execution_contract`, `development_principles_verbatim`, `invocation_root`, or
`checkout_mode`; discard an attempted replacement and fail the step with
`execution_contract_mutation_attempt`.

This skill is the canonical, agent-neutral implementation of the Ground Control `/implement` workflow. It runs from Claude Code, Codex, or Cursor CLI against the same content, with repo-specific values supplied by `gc_get_repo_ground_control_context` (per ADR-027).

The workflow handles the entire lifecycle: plan, implement, verify, commit, push, PR, CI, reviews, fix, requirement transitions, traceability reconciliation. **The user's only synchronous touchpoint is PR merge** (per ADR-029). Plans, review findings, and decisions on findings are recorded as comments on the GitHub issue thread so the durable record survives PR merge/close.

`$ARGUMENTS` may be either a GitHub issue number OR a Ground Control requirement UID; in the UID case Step 1 finds or creates the matching issue and runs against it. Bug fixes, refactors, dependency updates, and other requirement-free work enter the same workflow via an issue with zero requirements in scope.

**Templating convention.** Where the prose below references a path or value with `{cfg.X|default Y}`, the agent reads `cfg` from `gc_get_repo_ground_control_context`'s response (Step 1) and substitutes `cfg.X` if non-null, else `Y`.

---

## Step contract

This SKILL is a thin primary-session orchestrator. Step instructions live one
file per step under `skills/implement/steps/step-NN-<id>.md`. The canonical
review-loop rules live at `skills/implement/steps/_review-loop-rules.md`
(Step 6.5 references it; do not restate elsewhere).

The orchestrator dispatches the execution bands below. Mechanical bands are
one `gc_implement_mechanical` call on the successful path; their constituent
step files remain the detailed contract and recovery reference, but they are
not separate model turns. Agent work is reserved for interpretation,
architecture, implementation, review findings, conflict resolution, and
traceability decisions.

For each agent or script/agent band:

1. Revalidate the immutable execution contract and principles digest.
2. Read the applicable step files and execute them in the primary invocation
   session. Resolve advisory stage metadata through
   `gc_resolve_workflow_route` only when a model will actually perform work;
   successful script-only bands do not need a route-resolution model turn.
   Ground Control does not manufacture subagents for routine development,
   review, polling, or context containment. A driver may delegate when the user
   explicitly requests it or runtime circumstances independently justify it,
   but delegation is outside this routing contract.
3. Reject a successful envelope that reports only instruction reading,
   inspection, planning, acknowledgment, or partial progress. Validate the
   primary-owned execution contract, then merge the remaining cached state.

Keep raw CI/Sonar payloads server-side. Keep original deferred-review findings
in protected local MCP artifacts and publish only the validated sanitized
rendering. The primary consumes compact structured envelopes.

## Execution bands

| Steps | Execution | Successful-path action |
|---|---|---|
| 1–2 | script/agent | Resolve issue/branch naming inputs, then `gc_implement_mechanical action=bootstrap`; interpret the returned discussion in the next semantic band |
| 2.5–5 | agent | Architecture preflight, code assessment, plan, TDD implementation, clause mapping, and proportionate targeted tests |
| 6.5 | script/agent | The bounded Codex review-cycle tool runs; the primary acts only on returned findings or the cap decision |
| 7–8.5 | script | Start `gc_implement_mechanical action=publish` with `async=true`, then await the job; an agent enters only for a returned merge conflict or failed hook |
| 9 | script/agent | The primary supplies semantic PR inputs; existing render and synchronized-create tools enforce and publish them |
| 10–11 | script | Start `gc_implement_mechanical action=monitor` with `async=true`, then await the job; an agent enters only when CI or Sonar returns an actionable failure |
| 15–16 | agent | Pre-publish requirement `DRAFT→ACTIVE` transition and semantic traceability reconciliation, committed in the delivery diff (run after implementation, before publish) |
| 17 pre-merge | script | `gc_implement_mechanical action=readiness` |
| 17 post-merge and 20 | script | `gc_implement_mechanical action=finalize` (verifies merged requirement state at the immutable merge revision, then the merge-gated report + close) |

Every mechanical action is resumable or idempotent at its existing durable
boundary. A successful envelope advances to the named next band. An
`agent_required: true` envelope preserves the stage evidence and names the
bounded repair; repair that condition and retry the same action. For a
`publish` merge conflict, pass the returned `retry_input` as
`synchronization` after resolving every conflict. Never replace a failed
mechanical gate with an agent assertion.

The two long actions (`publish` and `monitor`) use the shared
background-job transport. Create one bounded `idempotency_key` for each logical
attempt, call `gc_implement_mechanical` with `async=true`, and await the returned
`job_id` through `gc_codex_job` (`action="await"`) until `status="done"`. The
server holds that one call until the job is terminal, so waiting costs one call
rather than a model turn per tick; a bounded wait that expires returns the
ordinary running envelope, and you simply await again. Use `action="poll"` only
when you want an immediate non-blocking snapshot. Consume `result` exactly
as the synchronous mechanical envelope; a completed job may correctly contain
`result.ok=false` for an actionable gate failure. Reuse the same key only when
retrying the start because the transport response was lost. After repairing the
reported condition, create a new key for the new logical attempt. `bootstrap`,
`readiness`, and `finalize` remain synchronous. Mechanical jobs do not claim
cancellation; `gc_codex_job action=cancel` returns `job_not_cancellable` while
their command and polling call graph lacks end-to-end abort support. The
`publish` hang this issue reports is closed not by cancellation but by the gate
runner reaping its process tree on exit, a per-worktree mutation lease, a
write-ahead recovery journal, a pre-commit compare-and-swap, and restart-time
reconciliation (issue #1495).

## Step list (in order)

| # | Stage id | File |
|---|----------|------|
| 1 | `issue_branch_resolution` | `steps/step-01-issue-branch-resolution.md` |
| 2 | `read_issue_context` | `steps/step-02-read-issue-context.md` |
| 2.5 | `architecture_preflight` | `steps/step-02.5-architecture-preflight.md` |
| 3 | `codebase_assessment` | `steps/step-03-codebase-assessment.md` |
| 4 | `planning` | `steps/step-04-planning.md` |
| 4.4 | `implementation` | `steps/step-04.4-tdd.md` |
| 4.5 | `clause_mapping` | `steps/step-04.5-clause-mapping.md` |
| 5 | `precommit` | `steps/step-05-quality-assurance.md` |
| 6.5 | `review_cycle_1_consume` | `steps/step-06.5-codex-review.md` |
| 7 | `git_publish` | `steps/step-07-stage-precommit.md` |
| 8 | `git_publish` | `steps/step-08-commit-push.md` |
| 8.5 | `base_sync` | `steps/step-08.5-sync-base.md` |
| 9 | `pr_body` | `steps/step-09-pr-body.md` |
| 10 | `ci_monitor` | `steps/step-10-ci-monitor.md` |
| 11 | `sonarcloud` | `steps/step-11-sonarcloud.md` |
| 15 | `transition_reconcile` | `steps/step-15-transition.md` |
| 16 | `transition_reconcile` | `steps/step-16-reconcile.md` |
| 17 | `final_report` | `steps/step-17-completion.md` |
| 20 | `close_issue_after_merge` | `steps/step-20-close-issue-on-merge.md` |

Steps 3.5, 6, 6.6, 12, 13, 14, 18, 19 are intentional tombstones (Step 3.5 GRC screening retired by ADR-089/#1346; Step 6.6 and the test-quality reviewer were retired by ADR-099; post-push Codex review collapsed into pre-push Step 6.5 by #804; final CI re-verify collapsed into Step 10's existing CI watch; Steps 18 and 19 collapsed into the consolidated Step 17 completion tool by #1103). The numbering is preserved so external references (ADR text, policy rules, docs) don't need to track a moving target.

## Phase boundaries (control flow)

- **Phase A** (Steps 1 → 4.5), **Phase B** (the requirement `DRAFT→ACTIVE` transition (Step 15) and traceability reconciliation (Step 16) — made in the delivery diff after implementation — then targeted checks and Step 6.5), **Phase C** (Steps 7 → 8.5), **Phase D** (Steps 9 → 11, then Step 17 with `phase="pre_merge"`), and **Phase E** (Step 17 with `phase="post_merge"` → Step 20) run in fixed order. Phase D ends at a pre-merge **readiness** record and STOPS for the user to review and merge. Once the linked PR is observed as merged, enter Phase E immediately. Do not wait for post-merge GitHub Actions or other additional actions to complete; target-branch workflows, release jobs, security scans, and sibling-agent work are not Phase E prerequisites. **Since issue #1541 (superseding the #963 post-merge mutation ordering), the requirement transition and traceability edits happen BEFORE publish and merge in the delivery PR; Phase E is validation-only** — it verifies the merged requirement files at the immutable merge revision, posts the final report, and closes the issue, never editing a requirement file after merge. This keeps requirement state reviewed in the PR and prevents a final report from claiming a state absent from the merged target branch. See "Specs-as-code transition ordering" and "Issue close mechanism" below.
- **Step 4 work-already-complete branch**: when Step 4's envelope returns `work_already_complete: true`, the code it documents already shipped under an earlier merge. This branch may skip a delivery PR **only when an immutable target-branch commit already carries the expected requirement status and traceability** — verify that (via the requirement files on the base branch) and record state via Step 4's completion comment. If the requirement files still need any `status:` or `## Traceability` change, that change is a real edit that must land on the target branch, so it **requires a reviewed PR** (run Steps 15–16 in the diff, then the normal publish → Phase D → Phase E path); do not edit-and-record without one, because a repo-local file edited outside a merged PR never reaches the target branch (issue #1541).
- **Step 10 CI failure**: on `ci_conclusion != "success"`, fix locally,
  return to Step 7 (re-stage), Step 8 (commit + push), Step 8.5
  (re-synchronize), then Step 10 again.
- **Step 11 SonarCloud findings**: same loop - fix, push, re-run Step 8.5,
  Step 10, then Step 11. Cap: 5 SonarCloud iterations.
- **Step 6.5 at the cap**: fix and verify every known finding, then ask whether to spend one additional Codex cycle. If the user declines, advance to Phase C; the cap limits reviewer iterations and does not require a clean terminal verdict. Record only genuinely unresolved findings as execution obligations. The label set in Step 1 stays until the issue is closed at Phase E.
- **Specs-as-code transition ordering (issue #1541)**: the requirement status transition (Step 15) and traceability reconciliation (Step 16) are **requirement-file edits made in the delivery diff, before publish and publish** — so they are reviewed in, and become authoritative through, the merged PR. This supersedes the #963 post-merge mutation ordering, which was coherent when requirement state lived in the retired backend but strands post-merge edits off the target branch now that requirements are repo-local files. Phase D's terminal signal is Step 17 with `phase="pre_merge"`: a **readiness** record (carrying a `ready_for_review` phase marker - *not* a `gc:final-report` marker) that names the requirement state as **proposed** (authoritative only after merge) and does not verify against a merge revision. `gc_assert_completion` with `phase="post_merge"` is **merge-gated** - it refuses with `completion_pr_not_merged` unless the linked PR is merged (`merged_at` non-null AND state `MERGED`) - then re-derives the in-scope UID set from the issue, **verifies every requirement at the linked PR's immutable merge revision** (exact UID path, frontmatter id, expected status, required traceability), and refuses (`completion_requirement_state_unverified` / `completion_scope_mismatch`) before posting anything on any mismatch, rendering the **observed merged values**. An explicit `override` + `override_reason` is the recorded escape hatch. Do not surface any earlier user-facing "complete" message - Phase D's readiness record is "ready to merge," not "done"; escalations before Phase E are because input is needed, not because the workflow is finished.
- **Phase E is validation-only — no repository edits, no implementation verification (issues #1541, #1543)**: since the requirement transition and traceability edits now merge with the delivery PR, Phase E makes **zero** repository edits. It reads the merged requirement files at the immutable merge revision, posts the final report, and closes the issue. Do **not** edit a requirement file after merge, do **not** manufacture a placeholder edit to create something to commit, and do **not** run `cfg.workflow.completion_command`, the policy suite, the pre-push reviews, or any other implementation / code-change verification for Phase E. Phase E's sole mechanical gate is `gc_implement_mechanical action="finalize"` (merge-gated merged-state verification + final report + idempotent issue close). The frontmatter `status:` / `## Traceability` edits themselves are made pre-publish (Steps 15–16) and checked by pre-commit locally and the documentation guardrails in CI.
- **Plain-English outcome (issue #1156)**: both Step 17 invocations pass `plain_english_outcome` to `gc_assert_completion`. The tool renders it as the outcome section before the structured evidence, so both the pre-merge readiness record and the post-merge final report explain what the change means in product/operator terms without weakening CI, SonarCloud, or traceability gates.
- **Issue close mechanism (issues #1058 + #1156 + #1541)**: the GitHub issue is closed at **Phase E (Step 20)** by `gc_close_issue_after_merge`, which verifies the linked PR is merged (`merged_at` non-null AND state `MERGED`) and — for an OPEN issue — requires a trusted `gc:final-report` marker (proof that Phase E's merged-requirement-state validation succeeded) before closing, refusing with `close_requirement_state_unverified` otherwise (`override` + `override_reason` is the recorded escape hatch). For a **requirement-backed** run the PR body uses a non-closing `Refs #<issue-number>` (Step 9), so GitHub does NOT auto-close at merge — the validated close tool is the sole closer, and the issue stays open until Phase E's report is posted. For a **requirement-free** run the body keeps `Closes #<issue-number>`, which GitHub honors only when the PR merges into the repository's default branch: there Step 20 reaches its idempotent `already_closed` no-op, and on a PR merged into the integration branch Step 20 closes the still-open issue through the same marker gate (issue #1601). The `in-progress` label is operational-only; its removal is optional best-effort and no longer a mandatory step gate (#1103). Phase E is invoked by re-running `/implement <issue>` after the merge; Step 1's orchestrator detects the Phase-D-complete state - the `ready_for_review` marker present + a merged linked PR + Phase E not yet recorded (no `gc:final-report` marker) - and short-circuits to **Step 17 `phase="post_merge"`** (verify merged requirement state → report → close), not back into Phase A–D. The detection keys on the `gc:final-report` marker being absent, NOT on the issue being open. If the PR exists but is not yet merged, Phase D is complete and the run STOPS awaiting the user's merge; it does not redo Phase A–D. `gc_close_issue_after_merge` performs only linked-PR resolution, merge-state verification, the requirement-state marker gate, and the idempotent close (ADR-089); it does not list open issues, rank candidates, or return a next-issue recommendation.
- **Single human touchpoint**: PR merge (between Phase D and Phase E). The orchestrator never runs `gh pr merge`. Phase E runs autonomously when the user re-invokes `/implement` after the merge - there is no synchronous user gate inside Phase E.

## Per-step model routing (ADR-036)

Routing is opt-in per repo via `routing.enabled` in `.ground-control.yaml`
(default `false`) and advisory in every mode. The `tier` annotation on each
step file is the provider-neutral capability hint; the resolver maps it to a
model identifier for cost planning and future runtime selection, but it does not
choose an executor.

**Claude tier mapping** (canonical): `low` → `claude-haiku-4-5`, `medium` → `claude-sonnet-5`, `high` → `claude-opus-4-8`.

Every driver runs routine steps in the invocation session. A future runtime may
consume the same stage/tier hint without changing the workflow contract, but
Ground Control does not use it to force delegation.

**Cursor CLI** (issue #1189): invoke from the repo root in Agent chat:
`/implement <issue-number | requirement-uid>`; in CLI:
`agent "/implement <issue-number | requirement-uid>"`. Skill discovery uses
`bin/install-skills.sh`; Ground-Control repos also ship a project wrapper at
`.cursor/skills/implement/SKILL.md`.
