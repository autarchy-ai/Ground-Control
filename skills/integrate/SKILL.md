---
name: integrate
description: "approved-PR integration manager: prepares approved PRs against the latest base branch in a target repo. Default mode is prepare-only; mode=merge executes the merge per-PR after verification (ADR-029 carve-out, 2026-05-26). enqueue mode remains reserved."
argument-hint: "[--mode prepare|merge] <target-repo-path-or-slug>"
disable-model-invocation: true
---

# Integrate: Approved PR Integration Manager

Canonical, agent-neutral implementation of the Ground Control `/integrate` workflow. A mechanical lane for preparing approved pull requests against the latest base branch, satisfying GC-O011 and the contracts in ADR-029 (single-merge-touchpoint and its 2026-05-26 merge carve-out) and ADR-027 (config surface).

**Sibling to `skills/implement/SKILL.md` and `skills/quickfix/SKILL.md`.** This skill does not duplicate prose from those lanes; it cross-references them where the contracts are identical. The key distinction: `/integrate` is repo-scoped and mechanical, not requirement-driven. It holds no issue anchor, calls no plan-post tool, and runs no AI-assisted reviews. The MCP tool (`gc_integration_manager`) does the work; this skill drives the three phases and surfaces output to the maintainer.

## When to use `/integrate`

Use it when:

- Multiple approved PRs need rebasing after the base branch moved and you want the readiness ledger before handing off to the maintainer.
- A single approved PR needs CI and Sonar gates run in isolation before the maintainer merges.
- You want the lock-protected prepare loop to prevent concurrent prepare runs from stomping each other.
- You want the lane to execute the merge as well as the prepare step (pass `--mode merge`; requires `workflow.integration_manager.merge_strategy` in `.ground-control.yaml`).

Do NOT use it as a replacement for `/implement`. The `/integrate` lane is mechanical: it rebases, runs the completion gate, watches CI and Sonar, and reports (and, with `--mode merge`, merges). It does not resolve requirements, post plans, run codex reviews, or transition requirement statuses. If the work is requirement-driven, use `/implement <uid>` or `/implement <issue>`.

Do NOT use it on unapproved PRs. The discovery step filters by the configured approval label; PRs without it are ignored silently by the MCP tool.

## Invocation

```
/integrate <repo-path>               # default: --mode prepare
/integrate --mode prepare <repo-path>
/integrate --mode merge <repo-path>  # prepare + execute merge per-PR
```

`<repo-path>` is an absolute path to the repository root, or an `owner/repo` slug (the MCP tool resolves the slug to a local path via the git remote). It must name the checkout the MCP server was launched against: the lane rebases, force-with-lease pushes, and in merge mode merges, so `gc_integration_manager` refuses a path naming any other checkout the server process can reach (GC-O011 clause (a)). The mode flag is optional; `prepare` is the default.

`--mode merge` enables the merge carve-out from the ADR-029 (2026-05-26) amendment. For each PR that the prepare step marks outcome=ready, the MCP tool executes `gh pr merge <n> --<strategy> --delete-branch --repo <owner>/<repo>`. The strategy comes from `workflow.integration_manager.merge_strategy` in the target repo's `.ground-control.yaml` (closed enum: `merge`, `squash`, `rebase`; default `merge` when the key is absent). A single merge failure marks that PR blocked:merge_failed and continues to the next PR; it does not halt the queue.

Passing `--mode enqueue` causes the MCP tool to return an error before any side effect:

```
error: mode_disabled
next_action: file_adr_amendment
```

Enqueue mode remains reserved and requires a further ADR-029 amendment to unlock.

## Maintainer approval signal

The discovery step finds PRs carrying the approval label. The default label is `approved-for-integration`. Repos can override it via `.ground-control.yaml` (ADR-027):

```yaml
workflow:
  integration_manager:
    approval_label: your-custom-label   # default: approved-for-integration
    ordering: pr_number_asc             # closed enum: pr_number_asc, pr_number_desc, approved_at_asc
    max_queue_size: 20                  # int [1, 100]
```

The config parser rejects unknown keys, out-of-range values, and label names that contain control characters or exceed 50 characters. Repos that omit the `integration_manager` block entirely get the defaults.

## Phase A: Discover (Step 01)

Step 01 (`steps/step-01-discover.md`) calls `gc_integration_manager` with `action: "plan"` and `mode: "prepare"`. The tool discovers every PR carrying the approval label, validates that the lock is acquirable (without acquiring it), and returns an ordered plan envelope. No branch is mutated. The skill renders the plan as a table to the invoking interface (terminal output). The plan is NOT posted to an issue thread; integration runs are repo-scoped, not issue-anchored.

## Phase B: Prepare (Step 02)

Step 02 (`steps/step-02-prepare.md`) calls `gc_integration_manager` with `action: "prepare"` and the caller's mode (`prepare` or `merge`). The tool acquires the integration lock for the duration of the run, then for each PR in order: creates an isolated git worktree, rebases the PR head onto the current base branch, runs the configured completion gate, watches CI and Sonar (reusing `gc_watch_ci_run` and `gc_watch_sonar_analysis`), and pushes the rebased head with `--force-with-lease`. With `mode: "merge"`, after each PR reaches outcome=ready the tool also executes `gh pr merge` with the configured strategy. On every exit path (success or failure) the tool releases the lock. The skill surfaces lock contention, queue-wide halts, and consultation halts to the maintainer.

## Phase C: Report (Step 03)

Step 03 (`steps/step-03-report.md`) formats the readiness ledger returned by the prepare phase. It calls no MCP tools and produces no side effects. The output is a per-PR table showing outcome, summary, and (where relevant) failure class and next action. The maintainer reviews the ledger and decides which PRs to merge.

## Halt semantics

The prepare loop recognizes three outcome classes:

- `blocked`: a mechanical failure scoped to one PR (rebase conflict, completion gate red, CI red, Sonar red). The queue continues to the next PR.
- `queue_wide_halt`: an unrecoverable condition across the whole run (base branch missing, credentials failure, lock expired mid-run). The queue stops; the skill surfaces the reason and recommends the maintainer fix the condition and re-run.
- `consultation_halt`: a condition requiring maintainer judgment before the run can continue. The queue stops and the skill surfaces the reason and candidate resolutions through the invoking interface. The clause (h) consultation triggers are:

  > Ambiguity in the authoritative input; conflicting authoritative input; apparent error or oversight in the authoritative input; or a branch where the correct resolution would silence a test, remove a documentation requirement, or violate a coding standard.

  After the maintainer responds, they re-invoke `/integrate` if they want to proceed. The skill does NOT continue the queue automatically after a consultation halt.

## What `/integrate` does NOT do

Each non-behavior is intentional. The lane is mechanical and narrow by design.

- **No automatic merge in default mode.** With `--mode prepare` (the default) the user (maintainer) reviews the readiness ledger and merges. Same single-merge-touchpoint rule as `/implement` (ADR-029). Use `--mode merge` when you want the lane to execute the merge.
- **No enqueue mode.** Enqueue returns a refusal envelope before any side effect. A further ADR-029 amendment is required to unlock it.
- **No requirement transitions.** The PRs the lane prepares retain their own `/implement` lifecycle on their own issues. `/integrate` does not transition any requirement's status.
- **No traceability reconciliation.** this lane does not edit any requirement's `## Traceability` section. Traceability is the responsibility of the `/implement` run that produced each PR.
- **No issue-thread plan post.** There is no `gc_post_implementation_plan` call. Integration runs are repo-scoped; the readiness ledger is surfaced to the maintainer at the terminal, not on a GitHub issue thread.
- **No AI-assisted reviews.** No `gc_codex_review` or `gc_codex_architecture_preflight`. The lane is mechanical; model judgment is not in the loop.
- **No source authoring.** The lane rebases using `git rebase`. It never edits test files, never removes documentation, never uses `-X theirs` or `-X ours`, and never modifies the completion gate command to force a pass.

## References

- `skills/implement/SKILL.md`: canonical full workflow.
- ADR-029 (Issue-Thread Gate Model): single-merge-touchpoint contract and decision-record obligations.
- ADR-027 (Ground Control YAML Context Contract): `.ground-control.yaml` schema and config surface.
- ADR-036 (Per-Step Routing / Tool Surfaces / Telemetry): sibling lane declaration; `/integrate` steps run on the parent session.
- `architecture/notes/integration-manager-workflow-preflight.md`: preflight design context for this lane.
- GC-O011: the requirement this lane satisfies.
