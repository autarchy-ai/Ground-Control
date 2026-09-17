---
name: quickfix
description: "Lower-ceremony lane for straightforward, lower-risk fixes (drops preflight/plan/AI-reviews ceremony; keeps every mechanical guardrail). AI-assisted reviews opt-in via --review. Issue numbers only (UID input is invalid; use /implement <uid>). Sibling to /implement; mid-flight upgradeable."
argument-hint: "[--review] <issue-number>"
disable-model-invocation: true
---

# Quickfix: Lower-Ceremony Workflow Lane

Canonical, agent-neutral implementation of the Ground Control `/quickfix` workflow. A purpose-built fast lane for **straightforward, lower-risk fixes** that don't warrant the full `/implement` ceremony (preflight, plan post, AI-assisted reviews, final-report tool, requirement transitions). Drops the ceremony designed for requirement-driven multi-clause work; keeps every mechanical guardrail the repo enforces. Runnable from Claude Code, Codex, or Cursor CLI. On Cursor, run `bin/install-skills.sh` once on the host (hard-copy into `~/.cursor/skills/quickfix/`; symlinks fail discovery). See `docs/DEVELOPMENT_WORKFLOW.md § Cursor CLI`.

**Sibling to `skills/implement/SKILL.md`.** This skill cross-references the canonical full workflow at every step rather than duplicating prose - the contract surfaces (branch shape, in-progress signal, PR-title rules, `gc_render_pr_body`, CI/SonarCloud, no-deferral, user-owns-merge) are identical. The only differences are the dropped ceremony.

The shared successful-path mechanics introduced by issue #1426 also apply
here where the lane contracts match: Q1 uses
`gc_implement_mechanical action="bootstrap"` after issue-only input
validation; Q6 checks acceptance mapping without a local broad suite; Q7
through Q8.5 use `action="publish"`; and Q10 through Q11 use
`action="monitor"`. Quickfix does not use `readiness` or `finalize`, because
its lightweight close record and requirement-free lifecycle intentionally
differ from `/implement`. A mechanical failure hands control to the primary
only for the named repair, after which the same action is retried.
The three long actions use the same background contract as `/implement`: pass
`async=true` plus one bounded `idempotency_key` per logical attempt, poll the
returned handle through `gc_codex_job`, and dispatch on the terminal `result`.
Reuse a key only after a lost start response; create a new key after a repair.

## When to pick `/quickfix` vs `/implement`

Judgment call, gating heuristic:

- **`/quickfix`** when the fix is obvious from the issue description, touches **< ~10 files**, has **no architectural footprint**, and the agent has no open design questions. Examples: parser bug, doc typo, SonarCloud finding cleanup, dependency bump, lint fix, narrow refactor with no behavior change, "the reviewer told me exactly what to do" follow-up.
- **`/implement`** when the issue carries a `## Requirements` section (UIDs in scope), or the diff is wider than ~10 files, or the design is unsettled, or there's any cross-aggregate blast radius. Anything that benefits from a codex production-readiness pass + test-quality review.

The user picks the lane explicitly at invocation time. The issue is the durable anchor - a `/quickfix` run can be upgraded to `/implement` mid-flight by re-invoking `/implement <same-issue>`.

## Per-step model routing (ADR-036)

Routes through the same `gc_resolve_workflow_route` resolver as `/implement` (see ADR-036 + `skills/implement/SKILL.md` § "Per-step model routing"). Stages reused: `issue_branch_resolution`, `codebase_assessment`, `implementation`, `precommit`, `review_cycle_1_consume` (only when `--review`), `review_fix_application`, `git_publish`, `base_sync`, `pr_body`, `ci_monitor`, `sonarcloud`, `test_quality_review` (only when `--review`), `close_issue`. Stages NOT used (because the skill drops them): `architecture_preflight`, `planning`, `clause_mapping`, `transition_reconcile`, `final_report`. Routing and telemetry are opt-in per repo via `.ground-control.yaml` (same `cfg.routing.enabled` and `cfg.telemetry.enabled` knobs). A route is advisory capability selection only; it does not require the driver to delegate a stage or create another execution context.

## Invocation

```
/quickfix <issue-number>           # default: AI-assisted reviews off
/quickfix --review <issue-number>  # opt-in: codex pre-push + test-quality pre-push, cap 1 each
```

The `<issue-number>` argument is a plain GitHub issue number, a `#`-prefixed integer, or `issue:N`. **Requirement UIDs are NOT a valid `/quickfix` input.** `/quickfix` runs are requirement-free by definition, so accepting a UID would be a lane-mismatch that quietly drops the requirement lifecycle. If the user passes a UID, STOP and tell them to use `/implement <uid>` instead.

### Hard precondition: no requirements in scope

After resolving the issue, **fetch its body and reject if it carries a `## Requirements` section with one or more UID bullets** (same parse rule `/implement` Step 1 uses). A requirement-scoped issue must go through `/implement` so the status transitions and traceability reconciliation run; `/quickfix` would intentionally skip them and ship the issue closed with the requirement lifecycle untouched. On a `## Requirements`-bearing issue, STOP and tell the user to re-invoke `/implement <issue-number>`.

An empty `## Requirements` section (heading present, zero UID bullets) is acceptable - it documents intent that the issue is requirement-free.

---

## Phase A: Resolve + Implement

### Step Q1: Resolve the Issue and Branch

**Reuses the issue-anchored mechanics of `skills/implement/SKILL.md` Step 1**, but **NOT** its UID classification / requirement-resolution path. `gc_implement_mechanical action="bootstrap"` loads the repository context, creates or switches the `<issue>-<short-slug>` branch through the same MCP branch boundary (≤ 50 chars, ASCII-only, `[a-z0-9-]`), and applies the in-progress label + pickup comment.

**Post-merge re-entry (issue #1601).** Before bootstrapping, read the issue thread with `gc_get_issue_thread`. When the issue is still open and the thread carries this lane's Step Q19 close comment - its `gc:final-report issue="<n>" pr="<pr>"` marker - for a pull request that has since merged, the run is past Phase D: skip straight to **Step Q20** with that `pr_number` and do not bootstrap again. When that pull request is still open, Phase D is complete and the run stops awaiting the user's merge. A marker for a pull request that was closed without merging, or an issue reopened after that merge, means new work: bootstrap normally.

**Diverges from `/implement` Step 1 on input classification.** `/quickfix` accepts only issue references (plain integer, `#`-prefixed integer, or `issue:N`). If the user passed a requirement UID (anything matching the `<letters>-<letters/digits>` pattern), STOP and tell them to use `/implement <uid>` - the UID lane requires the requirement lifecycle (status transitions, traceability reconciliation) that `/quickfix` intentionally drops. Do NOT invoke the `/implement` UID-to-issue shim from this lane.

After the issue is fetched, run the **hard precondition** from the Invocation section above: parse the issue body's `## Requirements` section; reject if it has one or more UID bullets; an empty section is acceptable.

Do NOT duplicate the rest of the Step 1 prose here - read `skills/implement/SKILL.md` Step 1 for the branch/label/pickup mechanics in full; this skill defers to it verbatim for those.

### Step Q2.5: NO Codex Architecture Preflight

`/quickfix` skips preflight. The user invoked `/quickfix` because the design is settled. If during implementation the agent discovers the design is NOT settled (open architectural question, conflicting ADRs, ambiguous scope), STOP and either ask the user for direction or re-invoke `/implement <same-issue>` to upgrade the run.

### Step Q3: Light Codebase Coverage

Read the issue body + thread (`gh issue view <issue-number> --comments`). Glance at the cross-cutting concerns (`cfg.cross_cutting_concerns.description`) to use existing helpers rather than re-implementing them. Skip the full ADR / coding-standards / knowledge-base walk that `/implement` Step 3 does - for fix-shaped work it's overhead.

If the cross-cutting concerns inventory turns up something non-trivial (a canonical incumbent the fix should build on, an existing helper that does this exact thing already), use it. The "use existing helpers" rule is not optional just because the ceremony is lighter.

### Step Q4: NO Plan Post

No `gc_post_implementation_plan` call. The pickup comment (Step Q1) is the durable record of "this is being worked on"; the PR description (Step Q9) is the durable record of "this is what shipped." A separate plan-comment phase would be ceremony for ceremony's sake when the design is settled.

If during implementation the diff grows unexpectedly large (10+ files) or surfaces design decisions you can't resolve from context, STOP and either ask the user or re-invoke `/implement` to enter the planning lane.

### Step Q4.4: Implement

Apply the fix. TDD is **encouraged** but not policed for `/quickfix` runs - for a one-file parser bug the test that catches it usually drops in alongside the fix without a formal red-green-refactor cycle. Targeted tests and required CI are the safety net.

The full TDD discipline from `skills/implement/SKILL.md` Step 4.4 (write failing test first, watch it fail for the right reason, make it pass with minimum code, refactor with green, repeat per clause) applies whenever the fix introduces new behavior. It's just not enforced as a per-clause invariant for fix-shaped work.

---

## Phase B: Quality Gate

### Step Q5: Proportionate Local Verification

**Identical to `skills/implement/SKILL.md` Step 5.** Run the narrowest tests that exercise the changed behavior, widening only for shared, cross-cutting, or security-sensitive changes. Do not run `pre-commit` here, and do not commit locally: Step Q7's `publish` action owns the single mandatory pre-publish hook boundary (`workflow.precommit_command`), commits behind its sensitive-path screening, and returns a hook failure as repair evidence for up to 5 attempts before escalation (issue #899).

### Step Q6: Acceptance Check

Check the issue's acceptance criteria and any documentation-only carve-out
against the actual diff. CI owns repository-wide completion and policy suites;
there is no mechanical verify action or mandatory local broad test pass.

### Step Q6.5 + Step Q6.6: AI-Assisted Reviews (OFF by default; `--review` to enable)

`/quickfix` skips both pre-push AI-assisted reviews by default. CI and SonarCloud (Steps Q10 / Q11) still run post-push and remain non-negotiable; the codex + test-quality reviewers are the optional add-ons.

When the user invokes `/quickfix --review <issue>`:

- **Step Q6.5 = codex pre-push review.** Run `gc_codex_review` with `uncommitted=true` against the staged + unstaged diff, exactly as `/implement` Step 6.5 describes. Default cap is **1 cycle** (per the same `.ground-control.yaml::workflow.codex_review.pre_push_cap` knob `/implement` uses; per issue #906). Apply the Review loop rules; post `gc_post_decision_record` per cycle; respect the cap; `override_cap=true` + `override_reason` works the same way. The same diff-coverage contract applies (issue #1414): an over-cap diff is reviewed as bounded server-supplied slices within one logical cycle, the envelope carries `diff_mode` + `review_coverage`, and `error: "review_coverage_incomplete"` means re-invoke — nothing durable was written and no cycle was consumed.
- **Step Q6.6 = test-quality pre-push review.** Run `gc_test_quality_review` exactly as `/implement` Step 6.6 describes. Default cap 1 (`workflow.test_quality_review.pre_push_cap`). Same Review loop rules. Same decision-record contract.

When `--review` is absent, both steps skip. The skill still posts no decision records (the issue-thread durable record for a `/quickfix` run is the pickup comment + the open PR + the `gc_post_final_report` close comment in Step Q19; codex/test-quality records exist only when the reviewer actually ran).

---

## Phase C: Stage, Commit, Push, Synchronize

### Step Q7: Stage & Pre-commit Loop

**Identical to `skills/implement/SKILL.md` Step 7.**

### Step Q8: Commit & Push

**Identical to `skills/implement/SKILL.md` Step 8.** Imperative-mood commit message, no agent attribution, `git push -u origin <branch>`.

### Step Q8.5: Synchronize the Remote Integration Branch

**Identical to `skills/implement/SKILL.md` Step 8.5.** Call
`gc_synchronize_implement_branch` from the invocation checkout after the
initial feature push and immediately before Step Q9. The tool fetches the
configured integration branch from `origin` with an explicit remote-tracking
refspec, performs a real merge when needed, verifies the merge graph, pushes
normally, and records the durable synchronization attestation. Run
proportionate targeted checks while resolving integration conflicts; CI owns broad verification of the published merge commit. Do not
substitute a local base branch, worktree, rebase, force-push, or discarded
feature state.

---

## Phase D: Ship

### Step Q9: Create PR

**Identical to `skills/implement/SKILL.md` Step 9** - same
`gc_render_pr_body` call (with `requirement_uids: []` since `/quickfix` runs
are requirement-free), same PR-title validation rules (single conventional-
commit type + lowercase subject + per-repo override via `workflow.pr_title`),
same synchronized-record validation through
`gc_create_synchronized_implement_pr`, and the same `Closes #<issue-number>`
wiring through the renderer. GitHub honors that keyword only when the PR merges
into the repository's default branch, so it is a cross-link, not the close path;
Step Q20 closes the issue after merge on every base.

Pass `lane: "quickfix"` plus the `pre_push_reviews` state this run actually
reached (issue #1551): `"completed"` when the run was invoked with `--review`
and Steps Q6.5/Q6.6 ran, `"not_run"` otherwise. The renderer's Ground Control
Checks section carries a pre-push review attestation on every PR body, and
these inputs decide which of the two accurate statements it carries. Omitting
them renders the `/implement` attestation that both reviewers completed, which
on a default `/quickfix` run claims a verification the run never performed.
`"not_run"` is accepted only with `lane: "quickfix"` - the lane whose contract
makes the reviewers optional. The attestation itself is never omitted.

The renderer's `change_class` is typically `source` for `/quickfix` runs; `doc-only` for pure documentation fixes; `source+migration` is unusual for `/quickfix` and is a signal that the run probably wanted `/implement` instead.

### Step Q10: CI Monitor

**Identical to `skills/implement/SKILL.md` Step 10.** Bounded poll (5-min queued-too-long guard, 45-min in-progress cap), diagnose-and-fix loop on failure.

### Step Q11: SonarCloud

**Identical to `skills/implement/SKILL.md` Step 11.** Quality gate + open-issues sweep + security hotspots. 5-iteration cap on fix → re-analyze cycles. Same `$SONAR_TOKEN`-direct REST fallback.

If `cfg.sonarcloud` is null, skip; proceed to Step Q18.

Step 11's sub-step 2a routing applies unchanged, including its `error`-keyed buckets for an unevaluable gate (issue #1559). In particular, `sonar_watch_analysis_not_produced` means the PR's SonarCloud producer check is already terminal, so `sonar_status: "skipped"` is only honest here when `cfg.sonarcloud` is null - never as a stand-in for a scan the repo declined to run.

### Steps Q15–Q17: NO Requirement Transitions or Traceability Reconciliation

`/quickfix` runs are scoped to fix-shaped work, not requirement-shaped work - no requirement status transitions, no traceability reconciliation against in-scope UIDs. The `in_scope_requirements[]` list is by definition empty for a `/quickfix` run.

**Exception: link maintenance on touched files.** If the diff modifies a file that has an existing IMPLEMENTS / TESTS link to some requirement and the behavior moved, update that link per `skills/implement/SKILL.md` Step 16's deletion-and-renaming rules (edit the requirement file's `## Traceability` section). Default for a typical `/quickfix` run is no link changes; the fix preserves behavior, and the existing links remain valid.

If a `/quickfix` run touches files in a way that warrants requirement transitions, that's a signal the run should have been `/implement`. Surface to the user and re-invoke `/implement <same-issue>` rather than partial-completing the requirement work in the lighter lane.

**Unaffected by `/implement`'s post-merge reconciliation (issue #963).** `/implement` moved its requirement transition, traceability reconciliation, and final report to a new post-merge Phase E. `/quickfix` is **structurally exempt** from that change: it does no transition and no UID reconciliation (this section), so it has nothing to defer past the merge; its closeout posts `gc_post_final_report` with `lane: "quickfix"` directly (not the merge-gated composite `gc_assert_completion`), so the new `completion_pr_not_merged` gate does not apply; and its issue close runs post-merge at Step Q20 through `gc_close_issue_after_merge`. The slim quickfix close comment continues to post pre-merge as the lane's lightweight ready signal.

### Step Q18: Clear In-Progress Label (optional best-effort)

The `in-progress` label removal is **optional best-effort** for `/quickfix` (as it is for `/implement` per issue #1103). After Step Q19 posts the close comment, you MAY run `gh issue edit <issue-number> --remove-label in-progress` and skip on failure. The issue closes after merge at Step Q20. Do NOT run `gh issue close` from the agent: an ungated close decouples the close event from the merge, and a rolled-back PR would leave a closed issue with no shipped code (GitHub does not re-open on revert).

### Step Q19: Lightweight Close Comment (via `gc_post_final_report`)

`/quickfix` calls `gc_post_final_report` with **`lane: "quickfix"`** (issue #906) and a slim payload: empty `requirements: []`, empty (or one-line-per-reviewer) `reviews: []`, no `traceability` block, a one-paragraph `summary`, the open `pr_number`, and `ci_status` / `sonar_status` reflecting the actual Step Q10 / Q11 results. The `/implement`-required `plain_english_outcome` field is optional for `lane: "quickfix"` and is normally omitted; the quickfix `summary` remains the lightweight closeout. The `lane: "quickfix"` flag relaxes the runner's "reviews must be non-empty AND contain a codex entry" gate (which exists for `/implement` Step 19's mandatory pre-push codex review record); `/quickfix` runs default with reviews off, so an empty `reviews[]` is the canonical shape. The `lane: "quickfix"` flag also exempts the run from the `/implement`-side `traceability_reconciled` phase-marker prerequisite added by issue #1058, because `/quickfix` runs are requirement-free by precondition and have no traceability reconciliation to assert. Every other gate stays in force: the tool runs `detectSensitiveBodyContent` and the canonical sensitive-content / no-defer / reserved-marker scrubs before any GitHub post, so the close comment can never carry an accidental token, secret, or raw command transcript onto the public issue thread. A direct `gh issue comment --body "..."` post would bypass those server-side filters, and the `.claude/hooks/*.py` PreToolUse hooks are Claude-Code-only and do not protect Codex or other drivers, so the MCP-tool boundary is the only driver-neutral enforcement layer.

The slim payload should populate:

- `lane`: `"quickfix"` (required to unlock the empty-reviews relaxation).
- `summary`: one-paragraph description of the fix (what broke, what now works). Update length follows the canonical succinctness rule in `skills/implement/steps/_review-loop-rules.md`.
- `plain_english_outcome`: optional for quickfix. Omit unless the lightweight close comment needs a separate outcome line; never use it to bypass the `summary` requirement.
- `reviews`: one entry per reviewer that ran (for example, `{reviewer: "codex", summary: "1 cycle, 0 findings"}`). Empty array when `--review` was not supplied.
- `requirements`: empty array (`/quickfix` is requirement-free by precondition; if link maintenance touched UIDs per the Q15–Q17 exception, mention them in `summary` rather than fabricating a requirement entry).
- `pr_number`: the **open** PR number from Step Q9 - the comment is posted before the user-owned merge, so do NOT wait for the PR to be merged before calling this. The PR URL is rendered into the comment body by the tool.
- `ci_status` / `sonar_status`: `"green"` / `"passed"` for a successful run; `"skipped"` only when `cfg.sonarcloud` is null.

**You MUST NOT merge the PR.** Same rule as `/implement` Step 19. The user reviews and merges. Step Q19 runs **before** the merge; any prose suggesting a "merged PR link" is incorrect - at this point the PR is still open by contract.

### Step Q20: Close the Issue After Merge (via `gc_close_issue_after_merge`)

Runs only after the user merges the PR: in the same session when the user reports the merge, or on the post-merge re-entry that Step Q1 detects. Call `gc_close_issue_after_merge` with `repo_path`, `issue_number`, and the merged `pr_number`. The `Closes #<issue-number>` keyword from Step Q9 does not close the issue when the PR merged into the integration branch rather than the repository's default branch (issue #1601), so this step is the lane's closer on every base.

The tool verifies the PR is merged, then closes an open issue only behind a trusted `gc:final-report` marker for that PR; the Step Q19 close comment is that marker. It is idempotent: `already_closed: true` is success.

- `close_pr_not_merged`: the PR is still open or was closed without merging. Stop and wait for the user; never close around it.
- `close_requirement_state_unverified`: no trusted Step Q19 close comment names this PR. Post it through `gc_post_final_report` with `lane: "quickfix"` and the merged `pr_number`, then retry. A repo-write user's `gc-authorize-merge-state-override pr=<n> <reason>` issue comment is the only other authority.
- Any other `ok: false` envelope: surface the tool's `message` to the user.

After a successful close, the Step Q18 in-progress label removal applies.

---

## What `/quickfix` keeps (non-negotiable)

Every mechanical guardrail the repo enforces. Adding to this list is a `bin/policy` change, not a skill change.

- **Issue-as-entry-point** (ADR-029): every change anchored to a GitHub issue.
- **Branch-name shape** (issue #864 amendment to ADR-021): `<issue>-<slug>`, ≤ 50 chars, ASCII-only, `[a-z0-9-]`. Post-check enforced.
- **In-progress label + pickup comment** (issue #842).
- **No-defer language** in commit messages, PR body, issue comments (issue #830 PreToolUse hook + `bin/policy`).
- **PR-title rules** (issue #901). Single conventional-commit type + lowercase subject; per-repo override via `workflow.pr_title`. Load-bearing under Release Please (GC-P027, issue #1399): CI (`.github/workflows/pr-title.yml`) enforces the same contract, since Release Please derives `CHANGELOG.md` and the version bump from Conventional Commit history rather than a per-PR fragment.
- **`gc_render_pr_body`** for the PR body (ADR-036) so `tools/policy/checks.py::check_pr_body` accepts it.
- **CI + SonarCloud green** before merge handoff.
- **Configured completion + policy commands clean** before commit (Step Q6), and the **single mandatory pre-publish hook boundary** inside Step Q7's `publish` action.
- **Post-merge issue close** through `gc_close_issue_after_merge` (Step Q20), never a `Closes #n` keyword alone or a direct `gh issue close`.
- **User merges, not the agent.**

## What `/quickfix` drops (compared to `/implement`)

Each drop is intentional and reversible mid-flight by re-invoking `/implement <same-issue>`.

- **Codex architecture preflight** (`gc_codex_architecture_preflight`) - the design is settled at intake.
- **Plan post + plan-phase marker** (`gc_post_implementation_plan`) - diff is the plan; PR is the durable record.
- **Pre-push codex review** + **pre-push test-quality review** by default - off unless `--review` is supplied. Both still respect the configured cap (default 1) when enabled.
- **Final-report tool full payload.** `gc_post_final_report` still runs (so its sensitive-content / no-defer / reserved-marker scrubs protect the public close comment on every driver), but with a slim payload: empty `requirements`, empty-or-one-line-per-reviewer `reviews`, no `traceability` block. The structured tool boundary is the only driver-neutral filter; a direct `gh issue comment` would bypass it.
- **Implement-only outcome requirement.** Issue #1156 makes `plain_english_outcome` mandatory for `/implement` Step 19, but quickfix remains exempt because its closeout is intentionally lightweight and requirement-free.
- **Requirement status transitions** (frontmatter `status:` edits) - `/quickfix` runs are requirement-free by definition.
- **Traceability reconciliation** (`## Traceability` edits) - only the touched-file link-maintenance path runs (and even that is rare for a typical `/quickfix` run).

## Deal with what the run surfaces — do not walk past it

Lower *ceremony*, never lower *standards*. A `/quickfix` run routinely surfaces problems beyond the reported bug: a red CI gate, a flaky test, a SonarCloud finding on a pre-existing line the diff pulled into new-code scope, a latent bug in an adjacent code path. Every such problem gets dealt with — you do not route around it.

Narrowing the *fix* to the reported bug is legitimate scoping. Using that narrowing to make a surfaced *problem* disappear from view is not. Reverting an edit to keep the change tight is fine; reverting it so a finding falls out of scope and then saying nothing is walking past the finding.

Prohibited ways to reach green: re-running CI to get past a failure you have not diagnosed; dropping or un-touching a change purely to move a finding out of scope; marking a real finding a false positive; or leaving the fix for later. A finding is a false positive only when it is factually wrong, with a rationale that says why — never "inconvenient" or "out of scope." This mirrors the Review Fix Standards and the repo's never-weaken-a-gate rule.

Two dispositions deal with a surfaced problem; pick by scope:

1. **Fix it in this PR** — the default when it is in scope and straightforward (a gate finding on a line you touched, a flaky test you can make deterministic, a fixable lint/Sonar issue).
2. **Open a tracked issue AND a PR that fixes it now** when it is a genuinely separate concern (unrelated subsystem, wider blast radius, or it would make this PR incoherent). Filing the issue alone is deferral; open the PR and do the work.

If the surfaced problem means the *core* change now warrants full `/implement` discipline, that is the separate judgment in **Upgrading mid-flight** below.

## Upgrading mid-flight

If at any step the agent realizes the work warrants `/implement` discipline (the diff grew, design forks surfaced, requirement transitions are needed, codex/test-quality reviews would have caught something), STOP and ask the user. Two options:

1. Re-invoke `/implement <same-issue>` from where you are. The branch, in-progress signal, and any pushed commits carry over; `/implement` Step 1 will recognize the branch and resume.
2. Continue `/quickfix` with `--review` to add the pre-push AI-assisted reviewers without the full preflight + plan ceremony.

The user picks. Do not silently upgrade.

## References

- `skills/implement/SKILL.md` - canonical full workflow this skill mirrors.
- ADR-021 (Gated Agentic Development Loop) - the lane contract this builds on.
- ADR-029 (Issue-Thread Gate Model) - durable record + decision-record contract.
- ADR-031 (Codex Review Stopping Model) - the cap-1 default + override semantics this skill inherits.
- ADR-036 (Per-Step Routing / Tool Surfaces / Telemetry) - routing tier semantics + MCP-tool surfaces.
- `architecture/notes/quickfix-workflow-lane-preflight.md` - preflight design context for this skill.

## Amendments

**2026-05-19 (issue #931).** When the optional codex pre-push review is
invoked from /quickfix, it returns the same verdict envelope as the
/implement lane (`verdict` + `architectural_read` + `blocking` + capped
`notes`). The /quickfix slim close comment is unchanged;
`gc_post_final_report` with `lane="quickfix"` still drops empty reviews /
traceability sections. The /quickfix lane does NOT consume
`.ground-control.yaml::architecture.vocabulary` itself; that block is
consumed only by the pre-push reviewers and the preflight (when invoked).

**2026-05-21 (issue #937), hardened by issue #943.** When `--review` is
supplied, the optional codex and test-quality pre-push cycle wrappers (Steps
Q6.5 / Q6.6) use the same async-only, idempotent start/poll contract as
`/implement`: pass one bounded `idempotency_key` per logical attempt, reuse it
after a lost start response, and poll `gc_codex_job`. A missing job requires
refreshing the issue thread before selecting a new key; cycle jobs do not
claim cancellation as rollback. The cap-1 default, `override_cap` semantics,
and `gc_post_decision_record` contract are unchanged. See ADR-036
(amendments) for the job model.

**2026-05-26 (issue #989).** A sibling lane, `/integrate`, now exists for preparing queues of approved PRs (GC-O011). The /quickfix and /integrate lanes are disjoint: /quickfix is issue-anchored and accepts the same `gc_post_decision_record` / `gc_post_final_report` contract as /implement; /integrate is repo-scoped and operational-only, with no issue-thread durable record. There is no overlap in trigger conditions or durable-record surfaces.

**2026-05-26 (issue #989 merge carve-out).** The `/integrate` lane at mode=merge may execute the merge for PRs it has prepared and verified (ADR-029 carve-out). The /quickfix lane must not merge; the user-owns-merge rule from ADR-029 applies to /quickfix unchanged.

**2026-06-18 (issue #1181 model-tier refresh).** The high-tier capability model id resolved by the shared `gc_resolve_workflow_route` resolver was bumped from `claude-opus-4-7` to `claude-opus-4-8`. /quickfix routes a high-tier stage only when `--review` is supplied (the `review_cycle_1_consume` consume step), so this changes which Claude model runs that step; the reused stage set, the cap-1 default, and the routing/telemetry opt-in knobs are unchanged.

**2026-07-01 (issue #1264 Sonnet-tier refresh).** The `medium`-tier capability model id resolved by the shared `gc_resolve_workflow_route` resolver (and the `gc_test_quality_review` engine default) was bumped from `claude-sonnet-4-6` to `claude-sonnet-5`. /quickfix routes `medium`-tier stages (e.g. `implementation`, `codebase_assessment`) and, when `--review` is supplied, the `test_quality_review` poll stage, so this changes which Claude model runs those steps; the reused stage set, the cap-1 default, and the routing/telemetry opt-in knobs are unchanged. The routing model-id validator now also accepts single-segment canonical ids such as `claude-sonnet-5`.

**2026-07-25 (issue #1416 `/implement` execution contract).** The canonical
development-principles file, same-checkout branch-preparation MCP boundary, and
execution-obligation marker family are added to `/implement`. `/quickfix`
remains a distinct lower-ceremony lane and does not silently import the
`/implement` orchestration contract; its existing upgrade path to `/implement`
is unchanged.

**2026-07-26 (issue #1421).** The shared routing resolver no longer emits
execution-control fields that force routine work into subagents. Quickfix
drivers execute stages in their primary session unless the user or runtime
explicitly justifies delegation. The lane also adopts the shared mandatory
remote integration-branch synchronization and synchronized PR-creation
boundary between its initial push and PR creation.

**2026-08-11 (issue #1526).** Added the **Deal with what the run surfaces — do
not walk past it** section: a run fixes the problems it surfaces (red gates,
flaky tests, findings its diff pulls into new-code scope) or opens a tracked
issue AND a PR that fixes them now; re-running around an undiagnosed failure, or
reverting an edit to drop a finding out of scope without dealing with it, is
prohibited. Also hardened the flaky `execFileWithInput` maxBuffer test
(`mcp/ground-control/lib.execfilewithinput-process-tree-kill.test.js`) to emit
from an unbounded shell-builtin loop instead of a finite `$(seq …)` burst that
was flaky under the CI suite's fork pressure.

**2026-09-14 (issue #1601).** Added **Step Q20**: after the user merges, the lane
closes its issue through `gc_close_issue_after_merge`, and Step Q1 detects the
post-merge re-entry from the Step Q19 close comment's `gc:final-report` marker.
GitHub honors `Closes #n` only on a default-branch merge, so a PR merged into
the integration branch had left every requirement-free `/quickfix` issue open.
Step Q1 also now names the `bootstrap` action instead of the retired
`gh issue develop` recipe. The `quickfix-post-merge-close-step` and
`workflow-unconditional-auto-close-claim` policy checks guard both.
