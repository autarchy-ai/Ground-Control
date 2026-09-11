---
id: GC-P027
title: "Release Please Versioning and Release/Changelog Ownership"
status: ACTIVE
type: NON_FUNCTIONAL
priority: SHOULD
created_at: 2026-07-15T05:49:00.174210Z
updated_at: 2026-09-11T00:00:00Z
---

# GC-P027 — Release Please Versioning and Release/Changelog Ownership

## Statement

Ground Control's release, version, and changelog lifecycle shall be owned by a
Release Please manifest workflow and enforced by repository-native policy:

(a) Single version ownership. `.release-please-manifest.json` shall record the
last released root-product version and `release-please-config.json` shall be the
only declarative inventory of root-product version mirrors. Every configured
mirror shall resolve inside the checkout and contain strict SemVer equal to the
manifest. The MCP server and citation packages keep independent package
versions and shall not be swept into the root release.

(b) Conventional Commits and changelog ownership. The PR-title vocabulary in
`.ground-control.yaml`, policy, the PR-title workflow, and the MCP PR-creation
boundary shall remain compatible. The hosted title workflow is advisory early
feedback; repository policy mechanically rejects vocabulary drift. Release
Please is the sole writer of `CHANGELOG.md`; feature PRs shall not edit release
artifacts or restore Towncrier as a second changelog authority.

(c) Release scope. A successful Release Please run may create the immutable
`vX.Y.Z` tag and GitHub Release. This MCP-only repository has no product image
or deployment target, so the release workflow shall not invent a build,
publication, promotion, or rollback lane. Every external GitHub Action shall be
pinned to a full commit SHA.

(d) Main-to-dev synchronization. A push to `main` or an explicit dispatch shall
compare the committed `main` and `dev` trees and exit when equal. Otherwise it
shall update one automation-owned branch and PR targeting `dev`. It shall run
only from the `main` ref, refuse a branch/PR ownership or head-OID mismatch, use
an exact `--force-with-lease`, and leave the merge to a human.

(e) One current contract. ADR-063, policy, skill prose, and workflow
documentation shall describe this repository's current release surface. Version
configuration, path containment, SemVer, title-contract parity, Action pins, and
sync-workflow safety shall be executable policy rather than prose-only claims.

## Rationale

Issue #1399 replaced the operator-assembled Towncrier procedure with Release
Please. Issue #1303 reconciles that design after the #1500 MCP-only re-platform:
the surviving product artifacts are the root manifest/config, generated
changelog, tag, and GitHub Release. Backend/frontend version mirrors, GHCR
publication, and deployment gates no longer have a product surface to protect.
Removing those stale obligations keeps release ownership singular while the
repository-native checks preserve the parts that still prevent drift.

## Traceability

- DOCUMENTS → ADR `architecture/adrs/063-release-deployment-model.md` (current MCP-only Release Please ownership contract)
- IMPLEMENTS → CONFIG `release-please-config.json` (root component and declarative mirror inventory)
- IMPLEMENTS → CONFIG `.release-please-manifest.json` (released root-product version)
- IMPLEMENTS → CONFIG `.github/workflows/release-please.yml` (release PR, tag, and GitHub Release workflow)
- IMPLEMENTS → CONFIG `.github/workflows/sync-main-to-dev.yml` (bounded main-to-dev synchronization)
- IMPLEMENTS → CONFIG `.github/workflows/pr-title.yml` (advisory Conventional Commit title feedback)
- IMPLEMENTS → CODE_FILE `tools/policy/version_mirror.py` (fail-closed mirror, path, and SemVer validation)
- IMPLEMENTS → CODE_FILE `tools/policy/ci_strictness.py` (PR-title parity and immutable Action-pin contracts)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/pr-body.js` (repository-derived Release Please changelog mode)
- TESTS → TEST `tools/tests/test_version_mirror_consistency_checks.py` (manifest/config/path/SemVer coverage)
- TESTS → TEST `tools/tests/test_policy_ci_gate_placement.py` (title, Action-pin, and sync-workflow structural coverage)
- TESTS → TEST `mcp/ground-control/lib.requirement-uid-and-pr-body-policy.test.js` (renderer changelog-mode boundary)
- IMPLEMENTS → GITHUB_ISSUE `1303` (surviving gate inventory and placement reconciliation)
