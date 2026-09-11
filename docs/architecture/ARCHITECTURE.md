# Ground Control - Architecture

## Mission

Ground Control is the **MCP server for the `/implement` workflow**: a gated, agentic
development loop that gives coding agents full codebase context, from requirement to
implementation, while keeping the coding agent separated from its reviewers. It
operates over repo-local files and the GitHub issue thread. There is no backend,
database, or web console.

> **Re-platform (issue #1500, [ADR-089](../../architecture/adrs/089-retire-grc-product-and-next-issue-recommendation.md)).**
> Ground Control was previously a graph-native GRC/requirements product built on Java,
> Spring Boot, PostgreSQL, and a React console. That product surface was retired and the
> repository stripped to the MCP server alone. If you find a document that still
> describes controllers, JPA entities, Flyway migrations, or a frontend, it is stale;
> this file is the current picture.

## What runs

The MCP server (`mcp/ground-control/`) is the only running service. It is a
Node.js ES-module process that speaks the Model Context Protocol to a driver
(Claude Code, Codex, or Cursor per [ADR-027](../../architecture/adrs/027-agent-neutral-implement-workflow-packaging.md)),
and it owns the privileged `gh` and `git` side effects: branches, the GitHub issue
thread, pull requests, and CI/Sonar reads. Coding-agent and reviewer sandboxes never
call `gh`, `git`, or `curl` directly; they ask the server, which performs those
operations through a pinned repository identity and a single error boundary
(ADR-027, [ADR-031](../../architecture/adrs/031-codex-review-stopping-model.md)).
Editing repo-local files (requirements, ADRs, docs) is not privileged: the agent
changes them directly in the working tree, and they are reviewed in the PR like any
other diff.

### Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20+, ES modules |
| Protocol | `@modelcontextprotocol/sdk` |
| Tool input schemas | `zod` |
| YAML / locking | `js-yaml`, `proper-lockfile` |
| Tests | `node --test` (`*.test.js`), property tests with `fast-check` |
| Lint | ESLint 9 + `eslint-plugin-security` |
| Repo policy | Python (`tools/policy/`), run by `make policy` and `bin/policy` |
| Prose lint | Vale (`make vale-lint`) |
| External CLIs | `gh` (authenticated), `git` |

## Repository-local records

Ground Control keeps its durable state as files in the repository and on the GitHub
issue thread, not in a database:

- **Requirements** live at `docs/requirements/<UID>/requirement.md` with a small
  versioned YAML frontmatter contract, read through
  `mcp/ground-control/lib/requirement-files.js`
  ([ADR-093](../../architecture/adrs/093-requirements-specs-as-code.md)). There is no
  requirement graph or backend record.
- **Architecture Decision Records** live at `architecture/adrs/*.md`, governed by the
  machine-readable `architecture/policies/adr-policy.json` guardrails.
- **The GitHub issue thread is the durable workflow record**
  ([ADR-029](../../architecture/adrs/029-issue-thread-gate-model.md)): the plan,
  decision records, phase markers, execution obligations, and the final report all
  post there, so the record survives PR merge or close.

## Boundary contract

```
driver (Claude Code / Codex / Cursor)
  ├─ edits repo-local files directly (requirements, ADRs, docs) → reviewed in the PR
  └─ asks the MCP server for every privileged operation
        MCP server (mcp/ground-control)  ← the only privileged actor
          → gh / git: branches, the GitHub issue thread, pull requests, CI/Sonar reads
```

The trust boundary is the tool layer: workflow prose that the MCP tools cannot enforce
is not a control. The privileged actor is the MCP server, and it is privileged only for
`gh` / `git` operations. Reviewer engines (codex) return structured findings; the server
performs the GitHub writes (ADR-031). Requirements, ADRs, and docs are edited by the
agent as ordinary working-tree changes and reviewed in the PR like any other diff.

## Package structure

```
mcp/ground-control/
├── index.js              # environment bootstrap
├── server-runtime.js     # server construction and tool registration
├── lib/                  # implementation modules (thin tools delegate here)
│   ├── requirement-files.js   # repo-local requirement reader (ADR-093)
│   ├── ...                     # git/GitHub mechanics, review, CI/Sonar, records
├── tools/                # MCP tool registrations (zod schema + thin handler)
├── implement/            # /implement mechanical orchestration helpers
├── knowledge_ingest.js   # repo-local knowledge ingest engine (ADR-025)
└── *.test.js             # node --test suites (the primary test gate)
```

The registration pattern is a `zod` input schema plus a thin handler that delegates to
a `lib/` function; `mcp/ground-control/tools/query.js` is the canonical example. New
abstractions are not introduced below three call sites, and comments are reserved for
non-obvious rationale rather than restating the code.

## The tool surface

The surviving 32 tools (down from 215 before the re-platform) are exactly what
the `/implement` workflow needs, each operating over `gh` / `git` / files:

- **Orchestration.** `gc_implement_mechanical` drives the mechanical bands (bootstrap,
  verify, publish, monitor, readiness, finalize); `gc_codex_job` carries the long async
  actions; `gc_get_repo_ground_control_context` reads `.ground-control.yaml`.
- **Git / GitHub mechanics.** Branch prep, issue pickup, issue-thread reads, base sync,
  synchronized PR creation, PR-body rendering, issue close, and issue creation from a
  requirement file.
- **CI / quality signals.** `gc_watch_ci_run` and `gc_watch_sonar_analysis` read live.
- **Reviewer separation.** The codex review, architecture-preflight, verify, and
  test-quality tools plus the review-cap disposition; the coding agent never reviews
  its own work.
- **Durable records.** Plan, decision records, execution obligations, and the final
  report all post to the GitHub issue thread.

The complete per-tool inventory and the placement doctrine for policy, hooks,
CI, protection, skills, and retired surfaces is
[`SURVIVING_GATES.md`](SURVIVING_GATES.md). File presence and historical ADR
text do not establish a supported gate; that inventory names the current owner.

## The `/implement` workflow

The gated loop (plan, TDD, verify, review, publish, CI, Sonar, requirement transition,
traceability reconciliation) is specified in
[`docs/DEVELOPMENT_WORKFLOW.md`](../DEVELOPMENT_WORKFLOW.md) and the agent-neutral skill
under `skills/implement/`. The user's only synchronous touchpoint is PR merge (ADR-029).

## Verification surface

There is no Gradle, JaCoCo, Testcontainers, or ArchUnit. Verification is:

- `make mcp-test` runs the `node --test` suites; this is the primary test gate.
- `make policy` runs the repo-native Python guardrails (`tools/policy/`, `bin/policy`),
  the MCP ESLint gate, and Vale. It covers ADR synchronization, requirement-spec
  frontmatter, the `/implement` execution and workflow contracts, reviewer-separation
  decision records, repo identity, version mirrors, required-context topology,
  PR-title parity, immutable Action pins, the file-size limit, and the
  repository-map freshness gate. See
  [ADR-091](../../architecture/adrs/091-ci-verification-topology.md) for the CI
  verification topology.

## Optional comprehension index

[Graphify](../../architecture/adrs/094-graphify-comprehension-index.md) is an optional,
disposable code-plus-docs index an agent may build (`make graphify`, see
[docs/GRAPHIFY.md](../GRAPHIFY.md)). It is not required and is not part of the
repository's architecture of record.

## Knowledge ingest engine

A repository that uses Ground Control can declare an agent-maintained knowledge base
under `docs/knowledge/` via the `knowledge` section of its `.ground-control.yaml`. The
`gc_remember` tool captures an observation into that repo's inbox; a detached ingest
subprocess decides update-versus-create, writes the wiki page, and commits under a
per-repo lock. The engine lives at `mcp/ground-control/knowledge_ingest.js` with a thin
CLI at `mcp/ground-control/knowledge_ingest_cli.js`
([ADR-025](../../architecture/adrs/025-knowledge-ingest-engine.md)).

## Binding ADRs

| ADR | One-liner |
|-----|-----------|
| [ADR-025](../../architecture/adrs/025-knowledge-ingest-engine.md) | Repo-local knowledge ingest engine co-located with the MCP server |
| [ADR-027](../../architecture/adrs/027-agent-neutral-implement-workflow-packaging.md) | `.ground-control.yaml` + `gc_get_repo_ground_control_context` are the agent-neutral context contract |
| [ADR-029](../../architecture/adrs/029-issue-thread-gate-model.md) | The GitHub issue thread is the durable workflow record |
| [ADR-031](../../architecture/adrs/031-codex-review-stopping-model.md) | Codex returns structured findings; the MCP server performs the GitHub writes |
| [ADR-089](../../architecture/adrs/089-retire-grc-product-and-next-issue-recommendation.md) | Retire the graph-native GRC product surface |
| [ADR-091](../../architecture/adrs/091-ci-verification-topology.md) | CI verification topology |
| [ADR-092](../../architecture/adrs/092-file-size-limit-gate.md) | Enforce the 500-LOC file-size limit in repo policy |
| [ADR-093](../../architecture/adrs/093-requirements-specs-as-code.md) | Requirements are repo-local files, not a backend/graph record |
| [ADR-094](../../architecture/adrs/094-graphify-comprehension-index.md) | Graphify is an optional, not-required comprehension index |
