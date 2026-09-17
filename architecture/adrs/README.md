# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for Ground Control. ADRs capture significant architectural decisions along with their context, rationale, and consequences.

> **Context-graph teardown (issue #1500, 2026-08-03).** Ground Control was re-platformed from a graph-native GRC/requirements product into the MCP server for the `/implement` workflow over repo-local files. The backend, PostgreSQL/Apache AGE database, React frontend, deploy/Docker surface, and the composed GRC/audit/verification/measurement layers were removed. The record of that decision is [ADR-093](093-requirements-specs-as-code.md) (requirements are repo-local files) and [ADR-094](094-graphify-comprehension-index.md) (Graphify is an optional comprehension index). ADRs describing the removed surfaces, the context graph, the GRC aggregates and composed product, the pluggable verification and formal-methods lanes, the production-line measurement model, the REST API access-control and deployment surfaces, and the frontend console, are historical: they document decisions for a system that no longer exists in this repo, superseded by the #1500 re-platform.

## Format

We use [MADR](https://adr.github.io/madr/) (Markdown Any Decision Records). Each ADR includes:

- **Status**: `proposed`, `accepted`, `deprecated`, or `superseded by ADR-XXX`
- **Context**: The problem or situation driving the decision
- **Decision**: What we chose and why
- **Consequences**: Trade-offs (positive, negative, risks)

## Principles

- ADRs are **immutable** once accepted. To reverse a decision, create a new ADR that supersedes it.
- ADRs are **numbered sequentially** and never reused.
- ADRs are **versioned with code**: they live in the repo, not a wiki.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [000](000-template.md) | ADR Template | - |
| [001](001-django-backend.md) | Python 3.12+ with Django and django-ninja for Backend | Superseded by ADR-013 |
| [002](002-postgresql-database.md) | PostgreSQL as Primary Database | Accepted |
| [003](003-design-by-contract.md) | Design by Contract with icontract | Superseded by ADR-013 |
| [004](004-code-quality-toolchain.md) | Code Quality Toolchain | Superseded by ADR-013 |
| [005](005-apache-age-graph.md) | Apache AGE for Graph Database Capabilities | Accepted |
| [011](011-requirements-data-model.md) | Requirements Data Model | Accepted |
| [012](012-formal-methods-process.md) | Formal Methods Development Process | Accepted |
| [013](013-java-spring-boot-rewrite.md) | Java/Spring Boot Backend Rewrite | Accepted |
| [014](014-pluggable-verification-architecture.md) | Pluggable Verification Architecture | Accepted |
| [015](015-cloud-database-deployment.md) | Cloud Database Deployment | Withdrawn |
| [016](016-project-scoping.md) | Project Scoping | Accepted |
| [017](017-interactive-web-application.md) | Interactive Web Application | Accepted |
| [018](018-aws-ec2-deployment.md) | AWS EC2 Deployment | Superseded by ADR-030 |
| [019](019-asset-topology-model.md) | Asset Topology and Boundary Relationships | Accepted |
| [020](020-asset-cross-entity-linking.md) | Asset Cross-Entity Linking | Accepted |
| [021](021-gated-agentic-development-loop.md) | Gated Agentic Development Loop | Accepted (amended by ADR-029, ADR-036, ADR-081; 2026-07-15 GC-P027/#1399 Release Please) |
| [022](022-content-pack-distribution-architecture.md) | Content Pack Distribution Architecture | Accepted |
| [023](023-plugin-architecture.md) | Plugin Architecture | Accepted |
| [024](024-threat-model-entry-boundary.md) | Threat Model Entry Boundary | Accepted |
| [025](025-backup-policy.md) | Backup Policy (GC-P021) | Accepted |
| [026](026-rest-api-access-control.md) | REST API Access Control (GC-P011) | Accepted |
| [027](027-agent-neutral-implement-workflow-packaging.md) | Agent-Neutral Implement Workflow Packaging | Accepted (amended 2026-05-26, GC-O011/#989; 2026-07-03, ADR-081) |
| [028](028-temporal-workflow-orchestration-boundary.md) | Temporal Workflow Orchestration Boundary | Superseded (issue #1359) |
| [029](029-issue-thread-gate-model.md) | Issue-Thread Gate Model | Accepted (amended 2026-05-26, GC-O011/#989) |
| [030](030-on-prem-hetzner-deployment.md) | On-prem Hetzner Deployment | Accepted (extended by ADR-063) |
| [031](031-codex-review-stopping-model.md) | Severity Rubric and Stopping Model for Pre-Push Codex Review | Proposed |
| [032](032-age-query-construction-boundary.md) | AGE Query Construction Boundary | Accepted |
| [033](033-authenticated-audit-actor-provenance.md) | Authenticated Audit Actor Provenance | Accepted |
| [034](034-api-enum-contract-single-source.md) | API Enum Contract Single Source of Truth | Accepted (amended 2026-06-15, #1106) |
| [035](035-mcp-tool-catalog-curation.md) | MCP Tool Catalog Curation | Accepted |
| [036](036-per-step-routing-tool-surfaces-telemetry.md) | Per-Step Model Routing and Durable-Record Tool Surfaces (telemetry history retained) | Accepted (telemetry superseded 2026-09-11, #1303) |
| [037](037-browser-session-access-control.md) | Browser Session Access Control | Accepted |
| [038](038-finding-entity-boundary.md) | Finding Entity Boundary | Accepted |
| [039](039-control-verification-subsystem.md) | Control Verification Subsystem (Tests + Effectiveness Assessments) | Accepted |
| [040](040-test-case-domain.md) | Test Case Domain Boundary | Accepted |
| [041](041-test-case-step-format.md) | Step-Based Test Case Format | Accepted |
| [042](042-test-case-bdd-gherkin-format.md) | BDD/Gherkin Authored Format for Test Cases | Accepted |
| [043](043-asset-classification-subtype-extensibility.md) | Asset Classification and Subtype Extensibility | Accepted |
| [043](043-test-case-hierarchical-organization.md) | Test Case Hierarchical Organization | Accepted |
| [044](044-test-plan-entity.md) | Test Plan Entity | Accepted |
| [045](045-evidence-derivation-and-temporal-state-history.md) | Evidence Derivation and Temporal State History | Accepted |
| [046](046-partial-knowledge-and-unknown-dependencies.md) | Partial Knowledge and Unknown Dependency Support | Accepted |
| [047](047-test-suite-entity.md) | Test Suite Entity | Accepted |
| [048](048-audit-entity-boundary.md) | Audit Entity Boundary | Accepted |
| [049](049-test-run-entity.md) | Test Run Entity | Accepted |
| [050](050-manual-test-execution-step-result.md) | Manual Test Execution Step Result | Accepted |
| [051](051-sonarcloud-gate-recalibration.md) | SonarCloud Gate Recalibration | Proposed |
| [052](052-risk-control-mapping.md) | Risk-Control Mapping Aggregate (GC-T003) | Accepted |
| [053](053-conversation-surface-hardening.md) | Conversation Surface Hardening | Accepted |
| [054](054-documentation-coverage-gate.md) | Documentation Coverage Gate | Accepted (amended 2026-06-14, #1102; 2026-09-06, #1562 mcp_tool surface anchors on the entry point and the server runtime) |
| [055](055-research-workflow-skills-and-citation-mcp.md) | Research Workflow Skills and Citation MCP | Accepted |
| [056](056-research-project-type-and-intake.md) | Research Project Type and Intake Metadata | Accepted |
| [057](057-per-run-grc-screening-gate.md) | Per-run GRC Screening Gate in /implement | Superseded by ADR-089 for active product and workflow behavior |
| [058](058-derivation-first-continuous-grc.md) | Derivation-First Continuous GRC | Superseded by ADR-089 for active product and workflow behavior |
| [059](059-mcp-usage-telemetry.md) | MCP Tool Usage Telemetry | Superseded (issue #1303) |
| [060](060-requirement-uid-identity.md) | Requirement UID identity | Accepted |
| [061](061-workflow-run-telemetry-reporting.md) | Workflow-Run Telemetry & Economics Reporting Surface | Superseded (issue #1303) |
| [062](062-age-graph-projection-snapshot-publication.md) | AGE Graph Projection Snapshot Publication | Accepted |
| [063](063-release-deployment-model.md) | Release & Deployment Model | Accepted (MCP-only release surface amendment 2026-09-11, #1303; npm distribution as grndctl amendment 2026-09-13, #1587) |
| [064](064-research-run-lifecycle-and-stage-gating.md) | Research Run Lifecycle and Stage Gating | Accepted |
| [065](065-research-run-observability-snapshot.md) | Research Run Observability Snapshot | Accepted |
| [066](066-research-review-comments-and-resolution-tracking.md) | Research Gate Decision Log and Review Comments | Accepted |
| [067](067-research-explainability-rationale-ledger.md) | Research Explainability Rationale Ledger | Accepted |
| [068](068-research-final-output-accountability-disclosure.md) | Research Final-Output Accountability Disclosure | Accepted |
| [069](069-research-artifact-provenance-ledger.md) | Research Artifact Provenance Ledger | Accepted |
| [070](070-research-artifact-graph-projection.md) | Research Artifact Graph Projection | Accepted |
| [071](071-research-interoperability-source-identity.md) | Research Interoperability and Source Identity Boundary | Accepted |
| [072](072-research-rest-and-mcp-tool-surface.md) | Research REST and MCP Tool Surface | Accepted |
| [073](073-research-extensibility-and-adapter-boundary.md) | Research Extensibility and Adapter Boundary | Accepted |
| [074](074-scheduled-evidence-collection.md) | Scheduled Evidence Collection Campaigns | Accepted |
| [075](075-research-factuality-claim-grounding.md) | Research Factuality and Claim Grounding Boundary | Accepted |
| [076](076-research-scientific-humility-surface.md) | Research Scientific Humility Surface | Accepted |
| [077](077-research-behavior-versioning-and-regression-tests.md) | Research Behavior Versioning and Regression Tests | Accepted (amended by ADR-078) |
| [078](078-research-methodology-catalog-reference-data.md) | Research Methodology Catalog as Backend Reference Data | Accepted |
| [079](079-commit-time-pre-commit-hook-activation.md) | Commit-Time Pre-commit Hook Activation | Accepted |
| [080](080-research-methodology-requirements-contract-artifact.md) | Research Methodology Requirements Contract Artifact | Accepted |
| [081](081-temporal-dev-workflow-and-console-program.md) | Temporal Dev Workflow and Console Program | Superseded (issue #1359) |
| [082](082-contract-surface-architecture.md) | Contract Surface Architecture and Enforcement Gates | Accepted |
| [083](083-research-protocol-plan-artifact-and-method-outputs.md) | Research Protocol Plan Artifact and Method-Specific Outputs | Accepted |
| [084](084-context-graph-concept-authority.md) | Context-Graph Concept Authority and Time Semantics | Accepted |
| [085](085-identity-model-users-groups-roles.md) | Identity Model - Users, Groups, and Roles as Data | Accepted (amended 2026-07-27, #1282) |
| [086](086-research-high-risk-operation-authorization.md) | Research High-Risk Operation Authorization | Accepted |
| [087](087-contract-locked-development-methodology.md) | Contract-Locked Development Methodology | Withdrawn (2026-07-10, #1296) |
| [088](088-temporal-human-gates.md) | Temporal Human Gates (Merge Observation and Authorized Operator Signals) | Superseded (issue #1359) |
| [089](089-retire-grc-product-and-next-issue-recommendation.md) | Retire the GRC Product Surface and Next-Issue Recommendation | Accepted |
| [090](090-production-line-measurement-model.md) | Production-Line Measurement Model | Superseded (issue #1303) |
| [091](091-ci-verification-topology.md) | CI Verification Topology | Accepted |
| [092](092-file-size-limit-gate.md) | Enforce the 500-LOC File-Size Limit in Repo Policy | Accepted |
| [093](093-requirements-specs-as-code.md) | Requirements as Specs-as-Code | Accepted |
| [094](094-graphify-comprehension-index.md) | Graphify Comprehension Index | Accepted |
| [095](095-repository-map-freshness-gate.md) | README Repository-Map Freshness Gate | Accepted |
| [096](096-host-wide-verification-dispatcher.md) | Host-Wide Verification Resource Dispatcher | Accepted |
| [097](097-versioned-artifact-release-reservations.md) | Versioned Artifact-Release Identity Reservations | Accepted |
| [098](098-native-agent-dashboard-connection.md) | Native Agent Dashboard Connection | Accepted |
| [099](099-bounded-codex-review-and-test-quality-retirement.md) | Bounded Codex Review and Test-Quality Retirement | Accepted |

Prior ADRs from the old project frame are archived in `archive/architecture/adrs/`.

Issue #1416 amends ADR-021, ADR-027, ADR-029, ADR-031, and ADR-036 to define
`/implement` execution principles, same-checkout branch preparation, and
durable execution-obligation completion gates.
