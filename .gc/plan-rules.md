# Ground-Control plan rules

Mandatory constraints the `/implement` skill applies during plan phase.

- Plans that add or change an MCP tool MUST keep the tool thin: a `zod` input
  schema plus a handler that delegates to a function in
  `mcp/ground-control/lib/`, where it is unit-testable without the protocol
  layer. `mcp/ground-control/tools/query.js` is the canonical example.
- Plans that add a repo-native policy check in `tools/policy/` MUST ship a
  matching `tools/tests/test_*.py` unit test, and MUST record the surface
  addition as an amendment to the ADR that owns the guarded surface.
- Plans that add a source file MUST respect the 500-line file-size limit
  (ADR-092); the gate is two-sided, so the grandfather list can only shrink.
- Release Please owns `CHANGELOG.md` and the product version (GC-P027, ADR-063
  2026-07-15 amendment). Feature PRs do NOT edit `CHANGELOG.md` or file changelog
  fragments - the Towncrier `changelog.d/` convention was retired in #1399. The
  changelog is generated from Conventional Commit history on `main`, so PR titles
  MUST follow Conventional Commits (`<type>(<optional-scope>): <lowercase
  subject>`), enforced in CI by `.github/workflows/pr-title.yml`.
- Plans MUST NOT hand-edit a product-version literal. Any mirror declared in
  `release-please-config.json`'s `extra-files` is updated mechanically by the
  release PR, and its consistency with `.release-please-manifest.json` is
  enforced by `run_version_mirror_consistency_check` (code
  `version-mirror-drift`). The mirrors are the `grndctl` npm package version in
  `mcp/ground-control/package.json` and its `package-lock.json` (issue #1587).
  Citation and dependency versions are independent and are not product mirrors.
