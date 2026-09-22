Always use the package manager to install dependencies.
Always follow the coding standards.
Keep docs and ADRs up to date.
Always do the right thing, not the easy thing.

## Build

Ground Control is the MCP server for the `/implement` workflow over repo-local files (issue #1500):
there is no backend, database, or frontend. The server is Node.js ES modules under `mcp/ground-control`.

- Install: `make ground-control-mcp-install` (npm ci in `mcp/ground-control`)
- Test: `make mcp-test` (the MCP `node --test` suite, the primary test gate)
- Policy: `make policy` (repo-native ADR/workflow/spec guardrails shared by Claude and Codex, runs the Python policy tests, `bin/policy`, and Vale)
- Prose lint: `make vale-lint`

Do not run `make mcp-test` or `make policy` locally as a pre-push step: CI owns both repository-wide suites. While working, run only the targeted suites for the surface you touched (`node --test <files>` under `mcp/ground-control`). Inside `/implement` and `/quickfix` this is the workflow contract (Step 5, development principle 8); outside them, run a full suite only to diagnose a specific failure.

## Development Philosophy (Pre-Alpha)

Ship features, not ceremony. One test per significant behavior. See docs/CODING_STANDARDS.md.

Requirements, ADRs, and use cases live as files in the repo (`docs/requirements/<UID>/requirement.md`, `architecture/adrs/`), read and edit them there; there is no backend or graph. Graphify is **available if you want** a code+docs comprehension index (`graphify query/path/explain`, or `make graphify`; see `docs/GRAPHIFY.md`), it is not required.

## Code Review

Don't surface nitpicks about PR titles or descriptions unless they are grossly misleading.

## Implementation

Always check your work against the requirement you are implementing to be sure you have implemented all the functionality described in the requirement.

## Answer Questions

If you are asked a question that you don't know the answer to but you have the means to find the facts, go find the facts and answer the question. This is especially important for questions about the codebase, requirements, or the project. You have all the tools at your disposal to answer any of thess questions, so use them.
