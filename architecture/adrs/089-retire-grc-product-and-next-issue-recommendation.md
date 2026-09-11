# ADR-089: Retire the GRC Product Surface and Next-Issue Recommendation

## Status

Accepted

## Date

2026-07-11

## Context

The milestone 25 validation reports under
`docs/notes/milestone-25-grc-validation/` exercised the current derivation-backed
GRC program rather than treating non-use as evidence. The deployed path did not
analyze the caller repository, local output lost material security semantics,
the screening classifier treated all 20 defect/clean pairs identically, and the
historical replay produced a 40 percent clean-set false-positive rate. The
current composition therefore adds workflow cost and assurance risk without
credible defect-specific risk reduction.

The GRC decision is spread across more than one visible page. ADR-057 and
ADR-058 bind Step 3.5 screening to plan publication, review-cap scoring,
completion reconciliation, issue-thread markers, and control status
transitions. The same program is exposed through console workspaces, REST,
MCP, `/assess`, repo context, and documentation. Removing only navigation would
leave supported command surfaces and hidden blocking gates.

The post-merge close path also performs an unrelated best-effort GitHub issue
ranking and returns `next_issue_recommendation`. That advisory concern is
coupled to a security-sensitive, merge-verified close operation even though a
recommendation is not part of closing an issue and its quality is not an
established planning signal.

Issue #1346 makes the retirement decision. This ADR supersedes ADR-057 and
ADR-058 for active product and workflow behavior, and reverses only the
next-issue-recommendation amendments to ADR-021 and ADR-036. Their durable
issue-record, one-human-touchpoint, routing, and merge-verification decisions
remain in force. ADR-036 telemetry was later superseded by issue #1303.

## Decision

### 1. Retire the composed GRC product, not every underlying domain concept

The supported GRC product surface is retired. A surface is part of that product
when it composes, derives, recommends, or enforces a GRC conclusion rather than
owning one independently useful aggregate.

The retired boundary includes:

- the console Portfolio and Assurance workspace navigation and routes;
- GRC analysis, assessment-run, derivation, architecture-model,
  data-classification, threat-enumeration, control-identification, and composed
  workspace REST operations;
- the matching named MCP tools, GRC `gc_analyze` kinds, and `gc_query`
  allowlist entries;
- the `/assess` skill and its installed command aliases;
- Step 3.5, GRC plan deliverables, re-screening, reconciliation, routing, and
  phase-marker requirements in `/implement`;
- active GRC project creation and active GRC workflow classification; and
- user-facing workflow, API, MCP, console, and configuration documentation for
  those capabilities.

Existing `Control`, `ControlTest`, `EvidenceArtifact`, `Finding`, `Asset`,
`RiskScenario`, `ThreatModel`, risk-control mapping, requirement traceability,
and graph aggregates remain independently owned lower-level primitives. Their
normal Service+Aggregate, Repository, project-scoping, validation, audit, and
generic CRUD boundaries are not renamed or duplicated. Retiring GRC must not
be used as a reason to create parallel "security" or "assurance" schemas for
the same concepts.

The retained derivation adapters and deterministic services are internal
salvage candidates only. They have no supported REST, MCP, CLI, workflow, or
console entry point and are not described as a working GRC product. Existing
per-adapter `@ConfigurationProperties` enablement is the future experimental
seam; retained adapters default off. A future salvage experiment must be an
explicit, shadow-mode caller of the existing `DerivationAdapter` registry and
must earn a new product decision before acquiring blocking authority or a
supported surface.

### 2. Remove every hidden GRC workflow dependency as one boundary

The normal `/implement` flow proceeds from codebase assessment to planning
without a GRC screening phase. Plan publication requires the architecture
preflight and the existing non-GRC plan gates; it does not require a
`grc_screening` marker or `grc_deliverables` payload.

`gc_assert_completion` retains merge verification, traceability reconciliation,
CI, SonarCloud, review, content-scrub, and final-report gates. It no longer calls
or returns a GRC assertion, and final-report publication no longer requires a
`grc_reconciled` marker. Removing GRC must not weaken these independent gates.

The review-cap disposition model no longer reads or emits `grc_verdict`. Its
security finding and changed-surface signals remain, and its weights and tests
must be recalibrated so deleting the GRC input does not silently turn formerly
high-risk cases into low-risk automatic proceeds.

The GC-GRC-011 evidence precondition on every `ControlService.transitionStatus`
call is also retired. Leaving it in place would preserve a hidden GRC block
through the generic control API. The ordinary `ControlStatus` transition graph
remains authoritative. Behavior-based security tests are still good test
engineering and may remain in the test-quality rubric, but they must not claim
that a `ControlTest` row, graph link, or status is GRC efficacy proof.

### 3. Remove supported access, not only advertising

Deleting documentation or a navigation link is insufficient when a route or
tool remains callable. Retired backend mappings are absent, so requests use the
existing `NoResourceFoundException` handling and standard `ErrorResponse` 404
shape. Do not add a GRC-only exception hierarchy, a second error envelope, or a
nominally disabled endpoint that still appears in OpenAPI.

The API authorization posture of retained endpoints does not change. Removed
paths are removed from `ApiPathMatrix` and `contracts/authz/path-matrix.yaml`
where they have explicit rules; generic `/api/v1/**` authentication is not
broadened to compensate. Project resolution and repository project-scoping
remain in the existing services and repositories.

The committed OpenAPI document and generated TypeScript consumer are refreshed
from the backend through the ADR-082 contract tooling, never hand-edited. Route
removal is a declared breaking change in `contracts/CHANGES.md`. MCP Zod shapes,
tool registration, client helpers, tool-description tests, and OpenAPI parity
inventories change together so an unadvertised adapter cannot remain callable.

### 4. Preserve history without preserving an active product

Past records are evidence of what the system did and are not rewritten:

- accepted Flyway migration FILES are never rewritten or deleted; a table drop
  is implemented as a new forward migration, never an edit to an already-
  accepted one (see the 2026-07-11 amendment below for the disposition of the
  composed GRC product's own stored tables);
- Envers audit tables and stored rows for the retained aggregates (Decision 1
  — `Control`, `ControlTest`, `EvidenceArtifact`, `Finding`, `Asset`,
  `RiskScenario`, `ThreatModel`, risk-control mapping, requirement
  traceability, and graph) remain;
- milestone validation notes, changelog fragments, and historical ADR text
  remain;
- issue-thread GRC marker and deliverable parsers may remain read-only so old
  threads and workflow telemetry can still be interpreted; and
- persisted `ProjectType.GRC` and `WorkflowType.GRC_REVIEW` values remain
  readable as legacy values, but are not offered for new creation, routing, or
  normal UI selection.

No new workflow writes a GRC marker or record. Historical schema values are not
evidence of a currently supported product.

> **Amendment (2026-07-11, issue #1346): the retention decision this section
> originally deferred has been made.** The repository owner decided that the
> stored rows and tables owned solely by the retired composed-GRC aggregates
> (Decision 1's retired boundary—GRC analysis, assessment runs, derivations,
> architecture models, data classification, threat enumeration, control
> identification, and the composed workspace views) are experimental output
> from development against the shared prod/dev database, were never consumed
> by any active product, user, or downstream process, and are **not**
> retained. The backend change for issue #1346 adds a new forward Flyway
> migration that drops those tables; Envers audit history for a dropped table
> is dropped with it, since it audits rows that no longer exist. This does not
> rewrite, edit, or delete any already-accepted migration FILE—the drop is
> itself a new forward step, consistent with the migration-immutability rule
> enforced by `tools/policy/checks.py::run_migration_policy`. Unchanged by this
> amendment: the retained aggregates' own tables and Envers history (listed
> above), milestone-25 validation notes, changelog fragments, historical ADR
> text (including the original decision text in this section), issue-thread
> history, and the read-only legacy `ProjectType.GRC` /
> `WorkflowType.GRC_REVIEW` enum values and marker parsers.

Repo-context parsing accepts old `grc.*` blocks long enough not to break an
otherwise valid consumer repository, but treats them as ignored legacy input.
The suggested config, returned normal workflow context, routing defaults,
architecture vocabulary, and documentation do not advertise the retired
fields or `grc_screening` stage. This compatibility read must not become a
second active configuration model.

### 5. Decouple next-work selection from issue closure

`gc_close_issue_after_merge` performs only linked-PR resolution,
merge-state verification, and idempotent issue closure. It does not list open
issues, rank candidates, or return recommendation, reason, source, or lookup
error fields. Returning those keys with `null` values would still advertise the
feature and is not considered disabled.

This decision is narrow: research gate recommendations, review findings,
operator dispositions, and other domain concepts that happen to use the word
"recommendation" are unchanged.

If next-work recommendation is reconsidered, it belongs behind a separate,
explicitly invoked advisory stage or tool with its own evaluation contract. It
must not be reattached to the merge-verified close envelope or run as an
implicit post-close side effect.

### 6. Keep the existing security and host boundaries intact

Remaining GitHub issue-thread writes continue through the MCP server's existing
argv-shaped `gh api` helpers, reserved-marker checks, sensitive-content filter,
and body-size cap. Agents do not gain a new GitHub, token, shell, or local-state
path. Removing GRC writers and recommendation lookup reduces outbound calls and
returned issue metadata; it does not justify weakening the surviving filters.

The repo skill installer is the host boundary for `/assess`. New installs no
longer install it, and upgrades prune only installer-managed `assess` targets
for Claude, Codex, Cursor, and legacy prompt aliases. Unknown or locally edited
host directories are not deleted silently; the upgrade reports the manual
cleanup required. Merely deleting `skills/assess/` is insufficient because
hard-copied host commands can outlive their source.

Observability for retained internal primitives stays on the existing SLF4J and
ActorHolder paths and records bounded identifiers, counts, and outcomes only.
No raw source, scanner output, secrets, issue bodies, or recommendation
candidates are added to logs, errors, telemetry, process arguments, or durable
records.

## Consequences

### Positive

- Normal workflows no longer spend time on or block on the unvalidated GRC
  composition.
- Users cannot reach the retired product through a stale route, tool, API
  mapping, documented path, or normal response field.
- Independently useful domain and adapter primitives remain available for
  evidence-led reuse without being presented as assurance.
- Issue closure once again has one responsibility and one stable result shape.

### Negative

- Removing public API operations is an intentional breaking contract change.
- Existing bookmarks and direct callers of retired operations receive the
  standard 404 response.
- The composed GRC product's own historical stored data is dropped by a new
  forward migration rather than retained indefinitely (2026-07-11 amendment to
  §4, issue #1346): it was experimental output never consumed by any active
  product. Historical migration files, the retained aggregates' own stored
  data, changelog fragments, milestone validation notes, and ADR text are
  unaffected.
- A future salvage experiment must establish a new supported boundary instead
  of silently re-enabling the old one.

### Risks

| Risk | Guardrail |
|------|-----------|
| A partial removal leaves a hidden block | Treat screening, plan, review scoring, control status, completion, policy, and docs as one workflow retirement boundary. |
| Generic risk/control/evidence concepts are deleted or re-created under new names | Retain their canonical aggregates, services, repositories, validation, audit, and CRUD contracts; remove only composed GRC ownership. |
| Old consumer config breaks unrelated workflows | Tolerate and ignore legacy `grc.*` input while removing it from returned context, defaults, and docs. |
| Historical records become unreadable | Keep migration FILES, the retained aggregates' stored data, and read-only marker/schema compatibility. Scope excludes the composed GRC product's own dropped tables, which are a decided, deliberate removal (2026-07-11 amendment to §4), not an accidental loss. |
| `/assess` survives on developer hosts | Prune installer-managed copies and report unmanaged copies instead of deleting arbitrary host content. |
| Recommendation removal accidentally deletes research decision provenance | Match the exact `next_issue_recommendation` close-path concept, not generic recommendation fields. |

## Non-Goals

- Deleting historical database rows or audit history for the retained
  aggregates (Decision 1), issue comments, validation evidence, changelog
  fragments, or accepted migration FILES. (The composed GRC product's own
  stored rows and audit tables are dropped via a new forward migration per the
  2026-07-11 amendment to §4—a decided scope, not a violation of this
  non-goal.)
- Removing generic controls, evidence, findings, assets, risk scenarios, threat
  models, graph traversal, requirement traceability, or direct specialist
  scanners.
- Rebranding the same GRC product as `assurance`, `security`, or `portfolio`
  while leaving its behavior callable.
- Adding a global `grc.enabled` flag, a second configuration schema, or a
  GRC-specific disabled-error hierarchy.
- Selecting a replacement security product or implementing the bounded salvage
  experiment described by the milestone 25 verdict.

## References

- Issue #1346
- `docs/notes/milestone-25-grc-validation/1338-stage-0-charter.md`
- `docs/notes/milestone-25-grc-validation/1339-stage-1-reality-audit.md`
- `docs/notes/milestone-25-grc-validation/1340-stage-2-historical-replay.md`
- `docs/notes/milestone-25-grc-validation/1341-stage-3-seeded-defect-corpus.md`
- `docs/notes/milestone-25-grc-validation/1342-stage-4-verdict.md`
- ADR-021, ADR-027, ADR-029, ADR-031, ADR-036, ADR-057, ADR-058, ADR-082
