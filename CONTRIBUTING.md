# Contributing to Ground Control

Ground Control is the MCP server for the `/implement` workflow over repo-local files
(issue #1500). There is no backend, database, or frontend; if a doc still tells you to
start PostgreSQL or run Gradle, it is stale (see the
[architecture overview](docs/architecture/ARCHITECTURE.md)).

## Getting started

### Prerequisites

- Node.js 20+
- `gh` CLI, authenticated (`gh auth status`)
- `git`
- Python 3 (for the repo policy tooling)

### Local setup

```bash
# 1. Clone and branch from dev
git clone https://github.com/autarchy-ai/Ground-Control.git
cd Ground-Control
git checkout -b <issue-number>-short-slug dev

# 2. Activate commit-time hooks for THIS clone (once per clone, ADR-079)
make hooks

# 3. Install the MCP server dependencies
make ground-control-mcp-install   # npm ci in mcp/ground-control

# 4. Run the test and policy gates
make mcp-test                     # node --test suite (primary gate)
make policy                       # repo-native guardrails + MCP lint + Vale
```

### Makefile targets

| Target | Description |
|--------|-------------|
| `make ground-control-mcp-install` | `npm ci` in `mcp/ground-control` |
| `make mcp-test` | Run the MCP `node --test` suite (primary test gate) |
| `make mcp-lint` | ESLint on the MCP server |
| `make policy` | Repo-native ADR/workflow/spec guardrails + MCP lint + Vale |
| `make policy-tests` | Python unit tests for the policy tooling |
| `make vale-lint` | Prose lint on changed docs |
| `make hooks` | Activate + verify commit-time hooks for this clone |
| `make graphify` | (Optional) rebuild the disposable Graphify index |
| `make help` | List all targets |

Run `make mcp-test` for the inner loop. Run `make policy` as well when you touch
workflow, ADR, MCP, policy, or requirement-spec surfaces.

## Branch strategy

- `main` is production-ready and protected.
- `dev` is the integration branch; all PRs target it.
- Work on a branch cut from `dev`, named `<issue-number>-short-slug`.

## Coding standards

Read [`docs/CODING_STANDARDS.md`](docs/CODING_STANDARDS.md) for the full reference. In
short: Node.js ES modules with `zod` tool schemas and thin handlers delegating to
`lib/`; one `node --test` test per significant behavior; no abstraction below three call
sites; comments for non-obvious rationale only; and the 500-line file-size limit is
enforced by policy.

## Commit messages

- Imperative subject: `Add repository-map gate`, not `Added repository-map gate`.
- Do not edit `CHANGELOG.md`. Release Please owns the changelog and product version
  (GC-P027): it derives both from Conventional Commit history on `main` and opens a
  release PR that regenerates `CHANGELOG.md`. Feature PRs do not file a fragment.

## Pull requests

- Target `dev`, not `main`.
- **The PR title must be a Conventional Commit** (`type(optional-scope): lowercase
  subject`), enforced by repository policy and the MCP PR boundary; the
  `.github/workflows/pr-title.yml` job supplies advisory early feedback. Release
  Please parses merged commit history to compute the next version and changelog,
  so the title is load-bearing, not cosmetic.
- CI must pass: the `node --test` suite, `make policy` (guardrails, MCP lint, Vale), and
  the SonarCloud gate.
- Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md).

## Testing

- **`node --test`** is the primary gate (`make mcp-test`); suites are `*.test.js` under
  `mcp/ground-control/`. Property tests use `fast-check`.
- **Python `unittest`** covers the policy tooling (`make policy-tests`,
  `tools/tests/test_*.py`).
- Write one test per significant behavior, and drive new behavior test-first. Test names
  describe behavior, not implementation.

## The `/implement` workflow

This repository is developed through its own gated `/implement` loop (plan, TDD, review,
CI, requirement transition, traceability reconciliation), specified in
[`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md). Requirements and ADRs are
repo-local files reviewed in the PR like any other change.
