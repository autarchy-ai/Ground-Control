# /implement In-Progress Issue Flag Preflight

Historical guidance for issue #842. For issue #1686, the removal owner and
failure semantics below are superseded as design guidance by
[Post-merge label cleanup preflight](post-merge-label-cleanup-preflight.md).

Issue #842 asks the `/implement` workflow to mark the resolved GitHub issue as
in progress immediately after `gh issue develop --checkout`, post a durable
pickup comment, and remove the label when the workflow closes the issue.

This note is preflight guidance for the implementation. It does not implement
the workflow change by itself; the canonical behavior still belongs in
`skills/implement/SKILL.md`, with synchronized workflow docs and ADR-021.

## Architecture Boundaries

- Keep this as issue lifecycle signaling, not Ground Control requirement state.
  The label is a human-visible GitHub issue-list affordance; it must not be
  conflated with requirement status, traceability link type, review-cycle state,
  or phase markers.
- Preserve ADR-029's issue-thread-as-record model. The pickup comment is a
  durable operational record beside plans, findings, and decisions; it is not a
  substitute for the plan comment, phase markers, traceability reconciliation,
  or the final report.
- Keep the canonical workflow surface agent-neutral per ADR-027. Update
  `skills/implement/SKILL.md`, `docs/DEVELOPMENT_WORKFLOW.md`,
  `docs/WORKFLOW.md`, and ADR-021 together; do not add Claude-only or
  Codex-only branches of the instructions.
- Treat label persistence on escalation as intentional. A paused run remains
  "picked up"; only Step 18 issue closure removes the label.
- Do not add new persistence. The GitHub label and issue comment are the
  persistence surfaces.

## Cross-Cutting Concerns to Reuse

- **Repo/workflow config:** Step 1 must still resolve `.ground-control.yaml`
  through `gc_get_repo_ground_control_context` before any repo-specific workflow
  side effect. Do not hardcode project ids, base branches, or requirement UID
  prefixes.
- **GitHub issue authority:** reuse the issue number resolved in Step 1. Do not
  derive the target issue from the branch name, PR closing references, or a
  requirement UID after branch checkout.
- **Existing GitHub command boundary:** if implemented in skill prose, use `gh`
  subcommands bound to the current repo checkout. If this later moves into MCP
  host-side code, build on `ensureGitRepo`, `getOwnerRepo`,
  `readIssueCommentBodies`, `postPhaseMarker` / issue-comment POST patterns,
  `getCurrentBranchName`, `detectSensitiveBodyContent`, and structured refusal
  envelopes in `mcp/ground-control/lib.js`.
- **Issue-thread conventions:** comments should be short, factual, and
  non-secret: driver/runtime, branch name, and an ISO-8601 UTC timestamp. Avoid
  environment dumps, tokens, local paths that reveal secrets, or full command
  output.
- **Policy sync:** `architecture/policies/adr-policy.json` already requires
  changes to `skills/implement/SKILL.md` to update both workflow docs and
  ADR-021. Let that existing `workflow-guardrail-sync` rule remain the guardrail
  instead of adding a duplicate policy.

## Security and Runtime Guardrails

- Use `gh` arguments as argv, not shell-interpolated strings. The label name,
  issue number, branch name, and comment body must not be assembled into an
  eval-able shell command.
- Do not pass secrets in `gh` argv or issue comments. This workflow only needs
  public metadata: driver, branch, and timestamp.
- Label creation must be idempotent. A missing label should be created once
  with a stable name, description, and color; an existing label should not make
  the run fail.
- Label application/removal must target the resolved issue only. Do not bulk
  edit repository labels or remove the label from other issues.
- If the pickup label/comment fails after checkout, surface the failure before
  coding starts. Silent failure defeats the duplicate-work prevention goal.
- If label removal fails during Step 18, the close/report path should surface
  the cleanup failure rather than claiming the issue was fully closed cleanly.

## Extensibility

Parameterize the signal as a named workflow constant in the skill prose: label
name `in-progress`, label description, label color, and pickup-comment fields.
The next likely variation is a repo choosing a different visible label such as
`status: in progress` or adding an assignee/milestone signal. Keeping those
values together avoids scattering literals through multiple workflow steps.

## Gotchas and Anti-Patterns

- Do not remove the label on every error path. Escalation means work was picked
  up and paused, so the label should remain.
- Do not infer branch name from issue number. Capture the current branch after
  `gh issue develop --checkout` using git/gh's actual result.
- Do not create a Ground Control requirement, status, traceability link, ADR, or
  audit event just to represent "in progress." The issue thread and label are
  enough.
- Do not create a second GitHub client abstraction or a local label registry.
- Do not make the pickup comment a machine-enforced marker unless a later issue
  explicitly needs ordering/cap enforcement. The existing phase-marker family is
  for workflow gates; this change is operational visibility.

## Non-Goals

- No repo-wide cleanup of stale `in-progress` labels on old issues.
- No assignment, locking, concurrency lease, or hard duplicate-work prevention.
  This is a visible signal, not a distributed lock.
- No change to requirement status transitions, traceability reconciliation,
  Codex review caps, or the PR merge boundary.
- No new policy rule unless the existing `workflow-guardrail-sync` rule proves
  insufficient.

## Implementation Outcome

Implemented in issue #842 and recorded as an amendment to ADR-021:

- `skills/implement/SKILL.md` Step 1 gains sub-step 12 - after `gh issue develop
  --checkout` (and `git branch --show-current` to capture the actual branch), it
  creates the `in-progress` label if the repo lacks it
  (`gh label create in-progress --color FBCA04 --description "…" 2>/dev/null || true`
 - no `--force`, so an existing label's color/description is left untouched),
  applies it (`gh issue edit <n> --add-label in-progress`), and posts a short
  pickup comment (driver, the captured branch, ISO-8601 UTC timestamp). Failures
  are surfaced before Step 2; the label persists on escalation.
- `skills/implement/SKILL.md` Step 18 removes the label after closing the issue
  (`gh issue edit <n> --remove-label in-progress`); a failed removal is surfaced
  in the Step 19 report rather than reported as a clean close.
- `docs/DEVELOPMENT_WORKFLOW.md` and `docs/WORKFLOW.md` describe the flag in
  their workflow walkthroughs; ADR-021 carries the amendment blockquote. No new
  policy rule was added - the existing `workflow-guardrail-sync` rule already
  enforces the SKILL ↔ docs ↔ ADR-021 sync.
- The label name / color / description and pickup-comment fields are stated
  together as one convention block in the SKILL prose - the seam for a repo that
  wants a different visible label.
