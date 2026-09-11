# Ground Control workflow: where to look

Ground Control is the MCP server for the `/implement` workflow over repo-local files
(issue #1500). This page is navigation only. Each reference below owns its subject, so
a contract is stated once and read in one place.

| Question | Reference |
|----------|-----------|
| How do I run the gated `/implement` loop, and what does each phase gate? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) |
| What runs, and where is the trust boundary? | [`docs/architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) |
| Which gates survived the MCP-only re-platform, where are they enforced, and which shadow checks were retired? | [`docs/architecture/SURVIVING_GATES.md`](architecture/SURVIVING_GATES.md) |
| Which MCP tools exist, and how is the server set up? | [`mcp/ground-control/README.md`](../mcp/ground-control/README.md) |
| Where does the MCP server read its configuration - the launch directory's `.env`, and nowhere else - and what happens when a gate cannot be evaluated? | [`mcp/ground-control/README.md`](../mcp/ground-control/README.md) and [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) |
| Why did the SonarCloud watcher stop before its window, and what is the difference between an analysis that has not arrived and one that will never exist? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) § Step 11 and [`skills/implement/steps/step-11-sonarcloud.md`](../skills/implement/steps/step-11-sonarcloud.md) |
| How are requirements written and traced? | [`docs/requirements/`](requirements/) and [ADR-093](../architecture/adrs/093-requirements-specs-as-code.md) |
| How does a requirement introduced mid-run become in-scope for the run that introduced it? | [`docs/DEVELOPMENT_WORKFLOW.md`](DEVELOPMENT_WORKFLOW.md) and [ADR-029](../architecture/adrs/029-issue-thread-gate-model.md) - `gc_update_issue_requirements` is the only supported writer for an issue's `## Requirements` section |
| Why is a decision the way it is? | [`architecture/adrs/`](../architecture/adrs/) |
| What does CI verify? | [`docs/ci/CI_PIPELINE.md`](ci/CI_PIPELINE.md) |
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
closed. The user's only synchronous touchpoint is merging the pull request.

Skill lanes are agent-neutral and run from Claude Code, Codex, or Cursor CLI
([ADR-027](../architecture/adrs/027-agent-neutral-implement-workflow-packaging.md)):
`/implement` authors a change end to end, `/quickfix` is its lower-ceremony sibling,
`/integrate` prepares a queue of approved pull requests, and `/review` reviews one
contributor pull request. `docs/DEVELOPMENT_WORKFLOW.md` describes each lane and the
boundaries between them.
