# ADR-063: Release & Deployment Model

## Status

Accepted

## Date

2026-06-25

## Context

[ADR-030](./030-on-prem-hetzner-deployment.md) defined how Ground Control is
*deployed*: `red-dragon` (Hetzner, tailnet-only), a GHCR image, and the
forced-command `deploy.sh` path with drift checks, env validation, health
gating, and rollback. It deliberately did **not** define a *release* model.

The gap is that "deploy" and "release" are currently the same uncontrolled
event. Every push to `main` runs the CI `docker` job, which publishes the
floating tag `ghcr.io/autarchy-ai/ground-control:main`, and production pulls
that floating tag. There is no named version, no release notes tied to a
version, and no immutable artifact that "production" maps to. The result:

- **No single version source of truth.** Three places disagree today:
  `backend/build.gradle` says `0.20.1`, the top of `CHANGELOG.md` says
  `0.116.3`, and the git tags are `v1.0.0` / `v1.0.1`. None of them is what
  production runs (production runs `:main`).
- **No immutable release artifact.** `:main` is a rolling pointer; whatever
  main last built *is* production. There is no version-pinned image a release
  maps to, and therefore no precise "redeploy the previous known-good version."
- **Undefined promotion semantics.** It is unstated what `dev` and `main`
  mean for releasing, and how a specific build becomes "the release in prod."

The infrastructure for a real release model already exists and is unused at the
policy level: the CI `docker` job is gated on `refs/tags/v*` and already emits
`type=semver` image tags (`.github/workflows/ci.yml`), and `towncrier build
--version <X.Y.Z>` is already passed an explicit version at release time
(`towncrier.toml`). What is missing is the *decision and the procedure*, not new
machinery.

This ADR records that decision. It is the umbrella design for the Deployment &
Release Engineering milestone. The mechanism change that switches production off
the floating `:main` tag onto a versioned/digest-pinned artifact is a companion
implementation issue ("deploy immutable versioned images"), not part of this
decision record. The architecture preflight for this work is captured in
[`architecture/notes/release-deployment-model-preflight.md`](../notes/release-deployment-model-preflight.md)
and its guardrails are binding on the companion mechanism work.

## 2026-07-15 Amendment: Release Please Ownership (issue #1399)

Issue #1399 replaces the operator-assembled release procedure below with a
Release Please manifest workflow. This amendment is the current contract where
it conflicts with the original decision; the original text remains as the
historical rationale for artifact identity, promotion, and rollback.

- Release Please owns the product SemVer, `CHANGELOG.md`, release PR, immutable
  `vX.Y.Z` tag, and GitHub Release. A release PR is the only normal writer of
  product-version mirrors and `CHANGELOG.md`; feature and promotion PRs do not
  edit either surface.
- There is one root Ground Control component. The manifest records its current
  released version, while `backend/build.gradle.kts`, `frontend/package.json`,
  and `frontend/package-lock.json` are mechanically updated mirrors. Spring
  Boot build info and `/actuator/info` remain the supported runtime lookup; no
  release API, database entity, or second version registry is introduced.
- The one-time manifest baseline is `1.0.1`. This is a deliberate continuity
  decision, not an inference from the disagreeing literals: ADR-063 selected
  the git-tag lineage and abandoned the `0.116.3` changelog and `0.20.1` backend
  lineages. The `v1.0.0` and `v1.0.1` tags predate the current Java/React
  application and describe the repository's former Python/Jira application;
  preserving that lineage avoids reusing published SemVer coordinates. The
  bootstrap/dry-run record must make this history visible before the first
  maintained release is merged.
- Conventional Commit signals determine the next bump and generated changelog.
  The PR-title gate and the repository's actual merge topology must preserve
  those signals across feature PRs into `dev` and the `dev` to `main`
  promotion. A title-only check that produces unparseable commits is not a
  release contract.
- Towncrier fragments cease to be a second changelog authority. The fragment
  requirement, fragment infrastructure, renderer fields, hooks, templates,
  policy checks, and workflow prose must be retired together, coordinated with
  issue #1336. A partially retained hybrid requires a separate explicit
  decision and a mechanical ownership rule.
- Publication stays in the Release Please run (or an explicitly invoked
  reusable workflow) and is gated by `release_created == 'true'`. A tag or
  release created with `GITHUB_TOKEN` must not be expected to trigger a second
  workflow. Release publication preserves the existing build, test,
  integration, contract, Sonar, Docker, and smoke gates and records the exact
  image digest and source commit in the GitHub Release.
- The immutable binding remains unchanged:
  `vX.Y.Z` maps to image tag `X.Y.Z`, one manifest digest, and one source
  commit. Reruns may fill in missing artifact metadata but must refuse to move
  an existing SemVer tag or image coordinate to different content.
- A push to `main` also runs a content-aware `main` to `dev` sync. It exits
  cleanly when the trees already match; otherwise it updates one dedicated
  automation branch and one human-merged PR targeting `dev`. Force updates are
  confined to that branch and never rewrite `main` or `dev`.
- Release creation still does not deploy production. Promotion and rollback
  remain operator-driven through `make deploy` and the ADR-030 validated,
  health-gated, auto-rollback path. `:main`, `:latest`, and build-coordinate
  tags remain non-release coordinates and never become the production pin.

The repo-wide guardrails and concept boundaries for this amendment are in
[`architecture/notes/release-please-preflight.md`](../notes/release-please-preflight.md).

## 2026-09-13 Amendment: npm Distribution as `grndctl` (issue #1587)

Hosts ran the MCP server and symlinked skills straight out of a Ground Control
checkout, so every agent ran whatever branch or uncommitted edits that checkout
held when its server started. A release is now also the deployable artifact:
merging the release PR publishes `mcp/ground-control` to npm as `grndctl`, with
the repository's workflow skills bundled at pack time. Hosts install it with
`npm install -g grndctl`, configure `grndctl mcp` as the MCP command, copy the
skills with `grndctl install-skills`, and upgrade with `npm update -g grndctl`.
Upgrading is the host operator's decision. `grndctl init` sets up one
repository at a time: it proposes detected values with their evidence, requires
the operator to confirm or edit each one and then the previewed file changes, and
writes only that repository's `.ground-control.yaml` (never rewriting an existing
one), its `ground-control` `.mcp.json` entry, a missing `.env` from the template,
and the `.env` ignore rule. A non-interactive run requires every value as an
explicit flag and never falls back to detection. `grndctl doctor` checks the host
and the repository without writing anything.

Release Please owns the package version: `mcp/ground-control/package.json` and
its lockfile are declared `extra-files` mirrors, so the independent MCP-server
coordinate in the 2026-09-11 amendment is superseded. The `publish-npm` job
publishes the exact release commit with provenance through npm trusted
publishing (GitHub OIDC). A one-time `NPM_TOKEN` secret bootstraps the first
publish only, because npm cannot configure a trusted publisher before the
package exists; it is deleted once trusted publishing is configured.

The Ground Control source repository does not track a `ground-control` entry in
its own `.mcp.json`. Running the product while developing the product is
optional maintainer tooling, configured in the maintainer's local or user-level
agent settings. Contributors can build, test, and submit changes without an
installed `grndctl` or a running Ground Control MCP server.

## 2026-09-11 Amendment: MCP-only Release Surface (issue #1303)

The #1500 re-platform removed the backend, frontend, container publication, and
deployment surfaces. Release Please still owns the root manifest,
`release-please-config.json`, generated `CHANGELOG.md`, immutable tag, and GitHub
Release; there are currently no configured root-product mirror files. The MCP
server and citation-package versions remain independent package coordinates.

The release workflow therefore creates repository releases only. It does not
build an image, publish to GHCR, or deploy. Repository policy validates strict
SemVer, exact mirror equality, config/path containment, PR-title vocabulary
parity, and full-SHA Action pins. The PR-title workflow is early feedback rather
than a separate authority: policy keeps it aligned with `.ground-control.yaml`
and the MCP PR boundary.

The main-to-dev workflow keeps the human-merged back-sync decision, but its
automation branch is now guarded by the `main` ref, automation ownership, the
observed remote head OID, and exact `--force-with-lease`. The backend/image and
deployment clauses in the 2026-07-15 amendment are historical and superseded.
The complete current placement rationale is recorded in
[`docs/architecture/SURVIVING_GATES.md`](../../docs/architecture/SURVIVING_GATES.md).

## Original Decision (superseded where the amendment conflicts)

Release and deployment are **separate lifecycle events**. Deployment is the
ADR-030 mechanism (push an image to the host and bring it up). A release is a
named, immutable artifact that an operator deliberately *promotes* to
production. The model has five parts.

### 1. Versioning

Ground Control follows [Semantic Versioning 2.0.0](https://semver.org/) (the
`CHANGELOG.md` header already declares this). The **annotated git tag `vX.Y.Z`
is the single source of truth** for "what version is this." Bump rules:

- **MAJOR**: an incompatible contract change. REST API, MCP tool contract, or a
  non-backward-compatible persisted-schema / Flyway migration.
- **MINOR**: a backward-compatible capability addition (new endpoint, new MCP
  tool, new feature). Most `added` / `changed` changelog fragments.
- **PATCH**: a backward-compatible bug fix (`fixed`, and `security` fixes that
  do not change a contract).

The version derives from the `changelog.d/` fragments accumulated since the
previous tag: the highest-impact fragment type present sets the bump. There is
exactly one set of bump rules (this section), read alongside the existing
towncrier/changelog convention rather than duplicated into CI or scripts.

The legacy `0.116.3` (CHANGELOG) and `0.20.1` (`build.gradle`) numbers are
abandoned as a non-release lineage. The cut-a-release procedure (§4) realigns
`backend/build.gradle`'s `version` and the `CHANGELOG.md` header to the git tag.
That realignment happens at the next release cut under this model; this ADR is
the decision, not the realignment commit.

### 2. Release artifact

The release artifact is the GHCR image built from the tagged commit. It has two
coordinates:

- The **digest** `@sha256:…` is the immutable audit and rollback identity. It is
  already captured in `/opt/gc/deploy-state.json` and the GitHub Deployment.
- The **semver image tag** is the human-readable coordinate.

Be precise about the tag string: `docker/metadata-action`'s
`type=semver,pattern={{version}}` strips the leading `v`. A git tag `v1.4.0`
therefore publishes the **image** tags `1.4.0`, `1.4`, and `sha-<short>`, not a
literal `v1.4.0` image tag. So a release binds four identifiers:

```
git tag  vX.Y.Z   <->   image tag  X.Y.Z   <->   digest @sha256:…   <->   source commit SHA
```

The floating `:main` tag is explicitly **not** a release. It is a rolling
integration/build coordinate and must not be the production pin in the target
model. GHCR tags are mutable by default, so immutability is anchored on the
**digest**, and the semver tag is treated as write-once **by convention**: a
`vX.Y.Z` is cut once and never re-pointed. Enforcing retag-prevention via a
GHCR immutable-tag / retention policy is a noted follow-up, not claimed here.

### 3. Promotion path

- **`dev`** is the integration branch. CI runs on it and publishes `:dev` and
  `:sha-<short>` images. `dev` is **not** a deployed staging environment,
  because there is a single production host and no separate stage (consistent
  with ADR-030's single-host non-goals). It becomes a stage only if a real
  deployed target is ever added, at which point the deploy-target seam
  (§ Extensibility) covers it.
- **`main`** is the protected release baseline. Merges to `main` publish
  `:main`, `:latest`, and `:sha-<short>` images. A `main` commit is *releasable*
  but is not itself a release.
- **Cutting a release** is the act of tagging a `main` commit `vX.Y.Z`. That tag
  triggers the CI `docker` job's `refs/tags/v*` path, producing the versioned
  image.
- **Promotion to production** is deploying a chosen released version (by digest)
  to `red-dragon` through the canonical deploy path. Production runs a promoted
  version, not "whatever `main` last built."

The decoupling of production from the floating `:main` tag (switching `GC_IMAGE`
from `...:main` to a versioned/digest reference) is the companion mechanism
issue. Until that lands, production continues to follow `:main` (the interim
risk in Consequences).

### 4. Cut-a-release procedure

The exact operator/CI steps to produce a release:

1. Confirm `main` is green (CI passed) at the commit being released.
2. Choose `X.Y.Z` by applying the §1 bump rules to the `changelog.d/` fragments
   accumulated since the previous release tag.
3. Collate the changelog: `towncrier build --version X.Y.Z` (consumes the
   fragments into `CHANGELOG.md`). Commit on `main`.
4. Set `backend/build.gradle`'s `version` to `X.Y.Z` (and the frontend version
   if applicable). Commit on `main`.
5. Create an annotated git tag `vX.Y.Z` on that commit (sign if the operator's
   key is configured) and push it.
6. CI's `docker` job (already gated on `refs/tags/v*`) builds and pushes the
   `X.Y.Z` / `X.Y` images to GHCR. Record the published digest.
7. The CI `release` job (gated on `refs/tags/v*`, after the `docker` job)
   automatically creates the GitHub Release for `vX.Y.Z`: it extracts the
   collated `CHANGELOG.md` section for that version as the release notes and
   names the artifact built in step 6 (image tag `X.Y.Z` plus the resolved
   digest and source commit). It is idempotent on re-run and uses the built-in
   `GITHUB_TOKEN` with `contents: write` scoped to that job. Release notes carry
   no secrets. The operator no longer hand-creates the release (issue #1224).
8. Promote to production via the canonical deploy path (`make deploy` /
   `scripts/deploy.sh`), which records the rolled-out digest and source commit
   in `/opt/gc/deploy-state.json` and a GitHub Deployment (queryable via
   `make deploy-status`).

The version to promote is selected through the host-local `/opt/gc/.env`
`GC_IMAGE` value (operator/CI-controlled). It is **not** smuggled through the
forced-command SSH argv, which the forced command ignores by design (ADR-030).

### 5. Rollback

Rollback is the deliberate promotion of an older known-good release, performed
**through the same canonical deploy path**, never an ad-hoc `docker compose`
invocation that bypasses env validation, health checks, or deploy-state
publication. Set `GC_IMAGE` to the previous version's digest; the deploy path's
env validation (`deploy/docker/validate-env.sh`, invoked by `deploy.sh`) already
permits a controlled, deliberate digest pin via `GC_ALLOW_IMAGE_PIN=1` (it
otherwise rejects long-lived digest pins because they freeze the deploy, per
#953 / GC-P022), and `deploy.sh` already auto-restores the previously running
image if a candidate fails its health window. A rollback is recorded like any
other promotion (digest + source commit in deploy-state and a GitHub
Deployment).

### Scope boundary

This model lives in ADRs, the changelog convention, CI, deploy scripts, and
operator tooling. It introduces **no** backend domain entity, service,
repository, controller, API schema, or database table for release state, and it
keeps release/deploy concerns outside the `api/ -> domain/ <- infrastructure/`
boundary. "What is running?" is answered by `deploy-state.json` + GitHub
Deployments, not by Ground Control domain state.

## Consequences

### Positive

- Release and deploy are distinct: production maps to a named, immutable
  version, not to a mutable branch tag.
- One version source of truth (the git tag), with explicit bump rules tied to
  the existing changelog fragments, ending the three-way disagreement.
- Reproducible rollback: redeploy a prior release by its digest through the
  validated deploy path.
- GitHub Releases give every version human-readable, versioned release notes
  collated from the changelog fragments already required per PR.
- Reuses existing machinery (CI semver tags, towncrier, the hardened deploy
  contract); adds process and a decision, not new infrastructure.

### Negative

- Cutting a release is now a deliberate, multi-step act (tag + changelog build +
  version bump + GitHub Release + promote) rather than an implicit consequence
  of merging to `main`.
- The three disagreeing version sources must be reconciled at the first cut
  under this model.
- Full value is not realized until the companion mechanism issue switches
  production off the floating `:main` tag.

### Risks

- **Interim conflation.** Until the companion "deploy immutable versioned
  images" issue lands, production still follows `:main`, so deploy and release
  remain conflated in practice. Mitigation: land that companion issue promptly;
  this ADR is the contract it implements against.
- **GHCR tag mutability.** A semver image tag could be re-pointed. Mitigation:
  the digest is the immutable identity and the semver tag is write-once by
  convention; a GHCR immutable-tag/retention policy is a follow-up.
- **Procedure drift.** The cut procedure is operator-run prose. Mitigation:
  keep the bump rules and procedure in this one ADR section; future automation
  (a release script / CI workflow) should enforce structure against it rather
  than restating the rules.

## Non-Goals

- No multi-host or multi-region deployment, and no separate staging environment
  beyond the single production host (ADR-030 non-goal preserved).
- No Kubernetes / Watchtower / Argo / Flux / managed-platform migration.
- No release dashboard, database-backed release entity, or Ground Control
  requirement-baseline automation.
- No replacement for the existing backup/restore, Flyway migration, or repo
  policy gates.
- No change in this PR to `GC_IMAGE`, `env.schema`, `validate-env.sh`, the
  deploy scripts, CI, or the policy gates. Those are the companion mechanism
  issues' surface.

## Related ADRs

- [ADR-030](./030-on-prem-hetzner-deployment.md): On-prem Hetzner Deployment.
  This ADR extends it with the release model it deliberately omitted.
- [ADR-021](./021-gated-agentic-development-loop.md): the changelog-fragment /
  `towncrier` discipline (Phase B, amended by issue #848) that this model's
  versioning and release notes build on.
- [ADR-026](./026-rest-api-access-control.md): credential and IP-allowlist
  model preserved unchanged; deploy-time env validation is part of the cut /
  promote / rollback path.
