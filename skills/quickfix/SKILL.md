---
name: quickfix
description: "Thin issue-based lane for straightforward, lower-risk fixes. Reuses shared mechanical bootstrap, publish, monitor, PR, and finalize boundaries. AI review is off unless --review is supplied. Issue numbers only; use /implement for requirement-backed work."
argument-hint: "[--review] <issue-number>"
disable-model-invocation: true
---

# Quickfix

`/quickfix` is a thin policy layer over the same mechanical modules used by
`/implement`. It exists for a small, settled fix where planning, architecture
preflight, requirement transitions, and default AI review would add ceremony
without changing the implementation.

The primary session owns the work. Routing metadata is advisory and never
requires delegation.

## Intake

Accept an issue number only: `123`, `#123`, or `issue:123`. A requirement UID is
not valid quickfix input.

Use this lane when the change is understood, has no architectural decision, and
is expected to remain under roughly ten files. Use `/implement` when the issue
has requirements in scope, the design is unsettled, or the change grows beyond
that boundary. Never silently upgrade; tell the user what changed and ask them
to invoke `/implement <issue>`.

## Successful path

### Q1. Bootstrap

Call `gc_implement_mechanical` once with:

- `action: "bootstrap"`
- `lane: "quickfix"`
- the repository path, invocation root, issue number, driver, and a valid
  `<issue>-<short-slug>` branch name

Bootstrap reads the issue before mutating the checkout. It rejects an issue
whose `## Requirements` section contains a UID with
`quickfix_requirements_in_scope`, prepares the issue branch, and records the
lane-specific pickup signal. On that refusal, use `/implement`; do not recreate
the checks in agent prose or continue on the quickfix branch.

On post-merge re-entry, if the issue already links a merged quickfix PR and has
no final quickfix record, skip to Q7 with that PR number.

### Q2. Implement and verify

Read the issue context returned by bootstrap, inspect the directly relevant
code, implement the bounded fix, and run the narrowest tests that exercise it.
Check the issue acceptance criteria against the actual diff.

Fix defects caused by this change and failures that directly block this change.
An unrelated concern is reported to the user with evidence; it does not
recursively create another issue, pull request, or implementation run.

Do not run broad completion or policy suites locally. CI owns them.
Do not run `pre-commit` here, commit, or push by hand; Q4 owns that boundary.

### Q3. Optional Codex review

The default lane skips AI review. With `--review`, run exactly one pre-push Codex
cycle through `gc_codex_review_cycle`, using its async start-and-await contract.
Fix or explicitly disposition every finding and run proportionate targeted
tests. Then continue as `accepted_at_cap`; quickfix does not request or run a
second review cycle, and a clean terminal verdict is not required.

### Q4. Publish

Call `gc_implement_mechanical` once with `action: "publish"`,
`lane: "quickfix"`, `async: true`, one idempotency key for the attempt, and the
commit message. Await the returned job through `gc_codex_job`
(`action="await"`), which holds one call until the job is terminal instead of
costing a model turn per poll tick.

This one action stages the change, refuses protected sensitive paths, runs the
repository's configured pre-commit boundary, commits, pushes, fetches the
integration branch, performs a real merge when needed, and records the trusted
synchronization result. Never call `gc_synchronize_implement_branch` separately.

The pre-commit boundary and its secret scanning are non-negotiable and run
before commit and push. A local secret-scan finding blocks publication; remove
the sensitive material without printing or publishing its value, then retry
`publish` with a new idempotency key. Never weaken or skip the scanner.

If `publish` returns a merge conflict, resolve every conflict in the preserved
merge, run targeted tests, and retry `publish` with its returned
`synchronization` input and a new key. For any other failure, repair only the
named condition and retry the same action.

### Q5. Create the pull request

Render the body with `gc_render_pr_body`, passing `lane: "quickfix"`, no
requirement UIDs, and `pre_push_reviews: "completed"` only when `--review` ran;
otherwise pass `"not_run"`. Create the PR with
`gc_create_synchronized_implement_pr`, passing `lane: "quickfix"` and the
synchronization record returned by `publish`. The lane input is an assertion, not
authority (issue #1679): the server reads the branch's lane from the newest
pickup record it wrote, which Q1 created, and refuses a lane that disagrees with
`implement_pr_lane_mismatch`. Readiness and finalize apply the same rule.

To take an in-progress `/implement` branch onto this lane - for example when the
maintainer says to move on without a review - run Q1 on that same branch. The
server records the switch on the issue, and every later gate reads the new lane
from there. Nothing else is needed. The waiver covers the
review-publication tuple and nothing else, and it is refused for a
requirement-backed issue. The body links the issue with `Closes #<issue>`; on an integration
branch that is a cross-reference, not the close mechanism.

### Q6. Monitor once per published head

Call `gc_implement_mechanical` once with `action: "monitor"`,
`lane: "quickfix"`, `async: true`, the PR number, and one idempotency key for
that head. The action observes CI and Sonar concurrently. Never invoke
`gc_watch_ci_run` or `gc_watch_sonar_analysis` separately.

On success, hand the open PR to the user for merge. The agent never merges it.

For a code or test failure caused by, or directly blocking, this quickfix,
repair it, run targeted tests, then return through Q4 and monitor the new head.
For Sonar findings, quickfix permits one automatic repair and re-analysis round.
If Sonar still fails after that round, report the remaining blocker and stop;
do not enter another repair loop. Unrelated findings are reported without
expanding this run.

`GitGuardian Security Checks` is user-owned. Agents must never investigate,
remediate, dismiss, suppress, bypass, or work around a GitGuardian finding. In
all cases, the user owns every GitGuardian investigation and resolution. Report only its
GitHub check name, status, and check URL, then stop and wait. Never access its
dashboard; handle suspected secret values; rotate credentials; rewrite history;
or change code, configuration, and allowlists in response. After the user
reports resolution, re-read only the GitHub check status.

### Q6.5. Record the delivery handoff

Call `gc_implement_mechanical` once with `action: "readiness"`, `lane: "quickfix"`,
the issue and PR numbers, and the completion payload from this run. The action
re-reads the required hosted checks for the current PR head and records a trusted
delivery handoff on the issue thread, plus a pointer comment on the PR.

This lane still gets no pre-merge report and none of `/implement`'s requirement or
review gates; the handoff is a machine record, not an outcome. What it buys is that
`.github/workflows/ground-control-phase-e.yml` can finalize the merged PR with no
model or agent session (issue #1671, ADR-102), so **this run may end here**. Nothing
in this lane polls for or waits on the merge.

If the head changes after this call, re-run it before the merge: the handoff is bound
to the head whose checks were verified, and a stale one is refused post-merge.

### Q7. Finalize after merge

On the normal path the merged-PR workflow has already done this, with no agent
session; re-entering `/quickfix` after a merge is the fallback and reaches the same
tool with the same result. After the user merges, call `gc_implement_mechanical` once with
`action: "finalize"`, `lane: "quickfix"`, the issue and PR numbers, and the
completion payload returned from this run: empty `requirements`, changed files,
optional Codex summary, `ci_status`, `sonar_status`, and one concise outcome
summary.

The shared finalizer verifies that the linked PR merged, verifies the issue is
still requirement-free, posts the scrubbed slim quickfix outcome carrying the
trusted final marker, and closes the issue idempotently. It performs no
repository edits or implementation verification. Do not post a separate
pre-merge close comment and do not call `gc_close_issue_after_merge` separately.

If the PR is not merged, stop and wait for the user. Re-entering `/quickfix` for
the same issue after merge resumes at this finalizer rather than repeating the
implementation path.

## Guardrails retained

- Issue-anchored branch and pickup record.
- Requirement-backed issue refusal.
- Sensitive-path refusal and pre-commit secret scanning before commit or push.
- Conventional commit and PR-title policy.
- Fresh integration-branch synchronization and synchronized PR creation.
- Required CI, Sonar, dependency, and hosted security checks.
- Sensitive-content and reserved-marker scrubs on public records.
- User-owned GitGuardian handling and user-owned merge.
- Merge verification before the final record and issue close.
