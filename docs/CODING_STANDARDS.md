# Ground Control - Coding Standards

These are mandatory rules. Follow them exactly when writing or modifying code.

## Development philosophy (pre-alpha)

Ship features, not ceremony. Ground Control is the MCP server for the `/implement`
workflow over repo-local files (issue #1500); there is no backend, database, or
frontend. The bar is working code plus one test per significant behavior. See
`CLAUDE.md` for the short version and [ADR-089](../architecture/adrs/089-retire-grc-product-and-next-issue-recommendation.md)
for what the re-platform removed.

## Languages and tooling

| Surface | Language | How it runs |
|---------|----------|-------------|
| MCP server | Node.js 20+ ES modules (`mcp/ground-control/`) | `node --test`, `make mcp-test` |
| Tool input schemas | `zod` | validated at the tool boundary |
| Repo policy checks | Python 3 (`tools/policy/`) | `python3 bin/policy`, `make policy` |
| Policy tests | Python `unittest` (`tools/tests/`) | `make policy-tests` |
| Prose | Markdown | Vale (`make vale-lint`) |

Always install dependencies through the package manager (`make ground-control-mcp-install`
runs `npm ci` in `mcp/ground-control`). Do not hand-edit `package-lock.json`.

## MCP server (Node.js) rules

- **Tool registration pattern.** A tool is a `zod` input schema plus a thin handler
  that delegates to a function in `lib/`. Keep handlers thin; put logic in `lib/` where
  it is unit-testable without the protocol layer. `mcp/ground-control/tools/query.js` is
  the canonical example.
- **The server owns privileged side effects.** All `gh`, `git`, and `curl` calls happen
  from the MCP server through its pinned repository identity and single error boundary.
  Never invoke `gh` / `git` / `curl` from a codex or claude sandbox
  ([ADR-027](../architecture/adrs/027-agent-neutral-implement-workflow-packaging.md),
  [ADR-031](../architecture/adrs/031-codex-review-stopping-model.md)).
- **No abstraction below three call sites.** Three similar lines beat a premature
  helper. Extract when the third caller appears, not before.
- **Comments explain WHY, not WHAT.** Reserve comments for non-obvious constraints,
  invariants, or workaround context. Do not restate what the code plainly does.
- **Lint is a gate.** `make mcp-lint` runs ESLint 9 with `eslint-plugin-security`.
  It is part of `make policy` and CI. No `console.log` left in committed code paths.

## Testing

- **`node --test` is the primary gate.** Behaviors are covered by `*.test.js` suites in
  `mcp/ground-control/`, run by `make mcp-test`. Property tests use `fast-check`.
- **One test per significant behavior.** Skip trivial pass-throughs. Edge cases,
  failure modes, and security-enforcing behavior get a test that goes red if the
  behavior is removed, not one that only asserts a value exists.
- **TDD in `/implement`.** New behavior is driven red-green-refactor: write the failing
  test first and see it fail for the right reason before writing the code.
- **Policy tooling has Python tests.** New or changed `tools/policy/` checks ship with a
  `tools/tests/test_*.py` unit test, run by `make policy-tests`.
- Test names describe behavior, not implementation.

## Repo policy guardrails

`make policy` runs the repo-native guardrails shared by Claude and Codex:

- `python3 bin/policy` enforces changed-file and structural policies: ADR
  synchronization (`architecture/policies/adr-policy.json`), requirement-spec
  frontmatter, the `/implement` execution and workflow contracts, reviewer-separation
  decision records, repo identity, version mirrors, the file-size limit, the
  repository-map freshness gate, and the PR-body contract.
- `make mcp-lint` (ESLint) and `make vale-lint` (prose) run in the same target.

Run `make policy` before completion whenever you touch workflow, ADR, MCP, policy, or
requirement-spec surfaces.

## File-size limit (enforced in policy)

`docs/CODING_STANDARDS.md` caps source files at 500 lines (Sonar `python:S104`), and
`make policy` enforces it (`tools/policy/file_size.py`, issue #1467,
[ADR-092](../architecture/adrs/092-file-size-limit-gate.md)). The gate is two-sided: an
oversized file that is not grandfathered fails the build, and a grandfather entry that
is no longer oversized or no longer present also fails, so the list can only shrink. It
applies to `.java`, `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.py`, and `.kts`; generated
trees (`contracts/gen/`) are excluded because only their generator can change them.

When you split a file:

- Split along real seams: the dependency graph, not section comments.
- Keep the public surface. Leave the original path as a barrel that re-exports the
  modules, so callers and tests are untouched and the split is verifiable as
  behavior-neutral by the existing suite.
- Export a name only if it was public before, or a sibling now needs it.
- If a single declaration is over the limit on its own, decompose the declaration; a
  file-level split alone cannot fix it.
- Use a comment-aware scanner: splitting on delimiters inside comments and string
  literals breaks the rejoin.

## Static analysis thresholds (SonarCloud)

Ground Control runs SonarCloud with a tightened profile, since the built-in "Sonar way"
leaves size and complexity rules too loose to catch real god-class and god-method
problems. Rule IDs vary across analyzers; the IDs below are the canonical reference,
and porting to a new analyzer should prefer the nearest concept (file LOC, function
length, nesting, cognitive complexity) over an exact rule-ID match.

| Bound | Threshold | Reference rule |
|-------|-----------|----------------|
| File size (LOC) | 500 | `python:S104` |
| Function or method length (LOC) | 100 | `python:S138` |
| Function parameter count | 7 (Java), 13 (Python) | `S107` |
| Nested control-flow depth | 4 | `python:S134` |
| Return statements per function | 3 | `python:S1142` |
| Cognitive complexity per function | 15 | `S3776` |
| String literal duplication | 3 occurrences | `S1192` |
| Regex complexity | 20 | `S5843` |

Captured quality-profile XML lives in [`tools/sonar/`](../tools/sonar/); each export is
date-stamped and prior snapshots stay in place so profile drift is auditable.

## Git and CI

- All code goes through a PR targeting `dev`. No direct push to `main` or `dev`.
- Activate commit-time hooks once per clone with `make hooks`
  ([ADR-079](../architecture/adrs/079-commit-time-pre-commit-hook-activation.md)); they run
  private-key detection and gitleaks. Do not bypass with `--no-verify`.
- Commit subjects are imperative: `Add repository-map gate`, not `Added ...`.
- **PR titles must be Conventional Commits** (`type(optional-scope): lowercase subject`,
  with `!` before the colon for a breaking change),
  enforced by `.github/workflows/pr-title.yml`. Release Please parses merged commit
  history to compute the version and `CHANGELOG.md`, so the title is load-bearing.
- **Do not edit `CHANGELOG.md`** or file a changelog fragment. Release Please owns the
  changelog and the product version (GC-P027,
  [ADR-063](../architecture/adrs/063-release-deployment-model.md)); feature PRs only need
  a valid Conventional Commit title.

## Documentation

Keep docs and ADRs current with the code in the same change. Requirements live at
`docs/requirements/<UID>/requirement.md` and ADRs at `architecture/adrs/*.md`; both are
edited as ordinary file changes and reviewed in the PR
([ADR-093](../architecture/adrs/093-requirements-specs-as-code.md)). Prose is linted by
Vale; keep em-dash density low (at most one per paragraph) so `make vale-lint` passes.
