# Ground Control workflow: where to look

Ground Control is the MCP server for the `/implement` workflow over repo-local files
(issue #1500). This page is navigation only. Each reference below owns its subject, so
a contract is stated once and read in one place.

| Question | Reference |
|----------|-----------|
| How do I install Ground Control and set up a repository? | [`docs/public/`](public/index.md) (published on Read the Docs): `npm install -g grndctl`, `grndctl init`, `grndctl doctor` |
| How do I run the gated `/implement` loop, and what does each phase gate? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) |
| Does the Codex review need a clean terminal verdict, and where did the test-quality stage go? | [ADR-099](../architecture/adrs/099-bounded-codex-review-and-test-quality-retirement.md) and [`skills/implement/steps/_review-loop-rules.md`](../skills/implement/steps/_review-loop-rules.md) - the cap bounds review iterations; declining another cycle advances after known findings are resolved, and the separate test-quality stage and tools are removed |
| How can a Codex review run without publishing its original prose? | [ADR-029](../architecture/adrs/029-issue-thread-gate-model.md) and [`skills/implement/steps/_review-loop-rules.md`](../skills/implement/steps/_review-loop-rules.md) - deferred execution retains an exact-revision local result, then a separate idempotent operation publishes a validated sanitized mapping |
| What runs, and where is the trust boundary? | [`docs/architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) |
| Which gates survived the MCP-only re-platform, where are they enforced, and which shadow checks were retired? | [`docs/architecture/SURVIVING_GATES.md`](architecture/SURVIVING_GATES.md) |
| Which MCP tools exist, and how is the server set up? | [`mcp/ground-control/README.md`](../mcp/ground-control/README.md) |
| Where does the MCP server read its configuration - the launch directory's `.env`, and nowhere else - and what happens when a gate cannot be evaluated? | [`mcp/ground-control/README.md`](../mcp/ground-control/README.md) and [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) |
| Why did the CI watcher report `queued_too_long`, and which run does its envelope name? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) and [`skills/implement/steps/step-10-ci-monitor.md`](../skills/implement/steps/step-10-ci-monitor.md) - the queued cap is a per-run wait for a first runner, not the watch's elapsed time |
| Which commit does the CI gate answer for, and why did it refuse with `ci_watch_no_run_for_head_sha`? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) and [`skills/implement/steps/step-10-ci-monitor.md`](../skills/implement/steps/step-10-ci-monitor.md) - the watch binds to one full 40-character head SHA and keeps discovering that commit's runs for the whole registration window; an earlier commit's green run is never evidence for this one |
| Is PR merge still the only time the workflow stops for me? | [ADR-029](../architecture/adrs/029-issue-thread-gate-model.md) § Touchpoints and [`skills/implement/_development-principles.md`](../skills/implement/_development-principles.md) - merge is the only *scheduled* gate; a run also escalates on a documented pause class, which is an exception rather than a second gate |
| What stops a clean review from authorizing code nobody reviewed? | [ADR-031](../architecture/adrs/031-codex-review-stopping-model.md) - a publication names the candidate tree it read; a zero-finding cycle authorizes exactly that tree, a finding-bearing one records the repaired tree without claiming it was reviewed |
| Why did the SonarCloud watcher stop before its window, and what is the difference between an analysis that has not arrived and one that will never exist? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) § Step 11 and [`skills/implement/steps/step-11-sonarcloud.md`](../skills/implement/steps/step-11-sonarcloud.md) |
| How are requirements written and traced? | [`docs/requirements/`](requirements/) and [ADR-093](../architecture/adrs/093-requirements-specs-as-code.md) |
| How does a requirement introduced mid-run become in-scope for the run that introduced it? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) and [ADR-029](../architecture/adrs/029-issue-thread-gate-model.md) - `gc_update_issue_requirements` is the only supported writer for an issue's `## Requirements` section |
| A review station first rendered no verdict and a later run posted its findings, but readiness still refuses the station-observation obligation. How is it resolved? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) § Unobserved review stations and [ADR-029](../architecture/adrs/029-issue-thread-gate-model.md) - `gc_reconcile_station_observation` is the only recovery writer, and `gc_record_execution_obligation` cannot close the obligation |
| Two runs produced the same evidence-release version. How does a run get a version no other run will use? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) § Versioned artifact releases and [ADR-097](../architecture/adrs/097-versioned-artifact-release-reservations.md) - declare the family under `release_families` and reserve with `gc_release_identity` before generating the capture |
| Where does `pre-commit` run in `/implement` and `/quickfix`, and why doesn't the agent run it by hand or commit before publishing? | [`skills/implement/steps/step-07-stage-precommit.md`](../skills/implement/steps/step-07-stage-precommit.md) and [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) - the `publish` action owns the single `workflow.precommit_command` invocation and the commit |
| How do I wait on a long preflight, review cycle, or CI/Sonar monitor without paying a model turn per poll tick? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) § Async execution and [ADR-036](../architecture/adrs/036-per-step-routing-tool-surfaces-telemetry.md) - `gc_codex_job action="await"` holds one request until the job is terminal; a bounded expiry returns the running envelope, never a pass |
| Where do broad tests run, and when should failure remediation begin? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) - CI owns broad verification; act on each actionable failure while other checks continue |
| May an agent change another repository or worktree during a run? | [`AGENTS.md`](../AGENTS.md) and [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) - the starting worktree is the mutation boundary; another named repository or worktree requires explicit user authorization, while read-only inspection remains allowed |
| When does post-merge Phase E begin, and who runs it? | [`skills/implement/steps/step-17-completion.md`](../skills/implement/steps/step-17-completion.md), [ADR-102](../architecture/adrs/102-automated-post-merge-delivery-finalization.md), and [ADR-029](../architecture/adrs/029-issue-thread-gate-model.md) - immediately after the linked PR is observed as merged, without waiting for target-branch workflows or other additional actions. The merged-PR workflow runs it with no agent session; an agent that re-enters after a merge is the fallback |
| Why did the monitor return `monitor_pr_conflicted` instead of watching CI? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) and [ADR-102](../architecture/adrs/102-automated-post-merge-delivery-finalization.md) - a PR that conflicts with its base never builds a merge ref, so its checks cannot run; merge the base in, resolve, and push rather than waiting |
| Does watching a PR burn the shared GitHub rate limit? | [ADR-102](../architecture/adrs/102-automated-post-merge-delivery-finalization.md) - the monitor's snapshot reads are conditional, so unchanged ticks answer `304` and cost no primary rate limit, and the loop backs off while the head is quiet |
| I merged the PR and the agent is gone. What finishes the issue? | [ADR-102](../architecture/adrs/102-automated-post-merge-delivery-finalization.md) and [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) § Automated Phase E - `.github/workflows/ground-control-phase-e.yml` replays the trusted Phase D delivery-readiness record through the unchanged finalizer |
| The Phase E job left a `gc:delivery-finalization-failed` comment. What now? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) § Automated Phase E - the issue is deliberately left open; fix the named cause, then re-run the workflow for that PR or call `gc_finalize_merged_pr` |
| Who handles a GitGuardian finding? | GitGuardian findings are user-owned. Agents report only the GitHub check name, status, and check URL, then wait; see [`AGENTS.md`](../AGENTS.md) and [`skills/implement/steps/step-10-ci-monitor.md`](../skills/implement/steps/step-10-ci-monitor.md). |
| A PR with `Closes #n` merged but the issue is still open. What closes it? | [`skills/quickfix/SKILL.md`](../skills/quickfix/SKILL.md) Q7 and [`skills/implement/steps/step-20-close-issue-on-merge.md`](../skills/implement/steps/step-20-close-issue-on-merge.md) - GitHub honors `Closes #n` only on a default-branch merge, so each lane's shared post-merge finalizer verifies the trusted final record and closes the issue after an integration-branch merge |
| Who removes the `in-progress` label, and when? | [ADR-021](../architecture/adrs/021-gated-agentic-development-loop.md) § 2026-09-21 and [`skills/implement/steps/step-17-completion.md`](../skills/implement/steps/step-17-completion.md) - `gc_close_issue_after_merge` drops it at the shared close boundary once the issue is actually closed, best-effort, so a failed removal never changes the close outcome. No agent step removes it: Step 17 is reached before the merge as well, where the label is still accurate |
| Why is a decision the way it is? | [`architecture/adrs/`](../architecture/adrs/) |
| What does CI verify? | [`docs/ci/CI_PIPELINE.md`](ci/CI_PIPELINE.md) |
| What pull request title shape do the Step 9 check and the synchronized PR-creation boundary accept, including the breaking-change `!`? | [`skills/implement/steps/step-09-pr-body.md`](../skills/implement/steps/step-09-pr-body.md) and [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) § Release model |
| How do I set up a clone and open a pull request? | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| What are the style and testing rules? | [`docs/CODING_STANDARDS.md`](CODING_STANDARDS.md) and [`docs/DOC_STYLE.md`](DOC_STYLE.md) |

## The shape of a change

Requirements live at `docs/requirements/<UID>/requirement.md` and ADRs at
`architecture/adrs/*.md`. Both are ordinary files: the agent edits them in the working
tree and they are reviewed in the pull request like any other diff. There is no backend,
database, or graph.

The GitHub issue thread is the durable workflow record ([ADR-029](../architecture/adrs/029-issue-thread-gate-model.md)).
The plan, review findings, decisions on those findings, execution obligations, and the
final report are posted there, so the record survives the pull request being merged or
closed. The user's only delivery-approval touchpoint is merging the pull request; a
bounded review may still ask whether to spend an optional over-cap cycle.

Skill lanes are agent-neutral and run from Claude Code, Codex, or Cursor CLI
([ADR-027](../architecture/adrs/027-agent-neutral-implement-workflow-packaging.md)):
`/implement` authors a change end to end, `/quickfix` is its lower-ceremony sibling,
`/integrate` prepares a queue of approved pull requests, and `/review` reviews one
contributor pull request. `docs/DEVELOPMENT_WORKFLOW.md` describes each lane and the
boundaries between them.

Every lane reaches GitHub through the MCP server over REST. GitHub's GraphQL budget is
shared by every agent on the same token and can run out without warning, so GraphQL is
used only where REST has no equivalent: review-thread ids and resolution for
`gc_codex_verify_finding`, and the `/review` lane's unresolved-thread summary. That summary
is optional and reports itself unavailable instead of failing the review.
