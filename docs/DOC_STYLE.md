# Documentation style

> **Sync note for issue #1303 (2026-09-11, surviving gate inventory):** The Python
> documentation-outcome check now lives in `tools/policy/documentation_coverage.py` instead of the
> version-mirror module, with `tools/policy/checks.py` preserving the compatibility import surface.
> The fixture protocol, classifications, outcome mapping, Vale rules, installer, `.vale.ini`, and
> this file's style rules are unchanged. ADR-054 and
> `docs/architecture/SURVIVING_GATES.md` record the placement decision.

> **Sync note for issue #1562 (2026-09-06, launch-directory environment authority):** The MCP server
> reads Ground Control's variables from `<launch directory>/.env` and nowhere else - no machine-level
> or user-level file, and no fallback to the ambient environment. `mcp/ground-control/index.js` became
> an environment bootstrap that binds the file before dynamically importing
> `mcp/ground-control/server-runtime.js`, so an environment-derived default cannot evaluate first. The
> `mcp_tool` surface class therefore anchors on both paths; without that addition the surface would
> keep matching a file the tool registrations had left. The `outcome_required` mapping, the Vale rule
> set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new `docs/DOC_STYLE.md` style
> rule is established.

> **Sync note for issue #946 (2026-09-06, MCP-host environment provisioning), superseded by issue
> #1562 (2026-09-06):** #946 had the MCP server resolve its optional environment from an inherited
> non-empty value, then `.env` in the launch directory, then a per-host `~/.config/ground-control/env`.
> #1562 removed the machine-level file and the ambient fallback: `<launch directory>/.env` is now the
> only source of Ground Control's variables. What survives from #946 is the loader living in `lib/`
> rather than the entry point, and the single `parseEnvFileLine` grammar; the loader is now
> `mcp/ground-control/lib/server-env.js`. ADR-036 records both decisions.

> **Sync note for issue #633 follow-up (2026-09-04, /integrate lane restored):** The
> `gc_integration_manager` implementation removed by #1506 is restored and registered, and a new
> contract test asserts every `gc_*` tool named in skill prose is registered. ADR-054 records the
> change. The documentation-coverage classifier, `outcome_required` mapping, Vale rules, installer,
> `.vale.ini`, and this file's style rules are unchanged.

> **Sync note for issue #633 (2026-09-04, MCP server identity and documentation):** The MCP server
> now advertises the version from `mcp/ground-control/package.json` in the `initialize` handshake,
> `gc_render_pr_body` renders a lane-accurate pre-push review attestation (`lane` /
> `pre_push_reviews`, with `tools/policy/authz_matrix.py` accepting either form), and the server's
> README and `index.js` environment header were rewritten against the registered tool surface.
> ADR-054 records the change. The documentation-coverage classifier, `outcome_required` mapping,
> Vale rules, installer, `.vale.ini`, and this file's style rules are unchanged.

> **Sync note for issue #871 (2026-08-14, strict Sonar enforcement):** The SonarCloud workflow
> now enforces zero open issues after the hosted quality gate, and repository policy protects that
> ordering and failure behavior. The policy compatibility barrel resolves focused module exports
> dynamically so analysis does not treat re-exports as unused code. ADR-054 records the policy
> surface change. The documentation coverage classifier, outcome mapping, Vale rules, installer,
> `.vale.ini`, and this file's style rules are unchanged.

> **Sync note for issue #1506 (2026-08-09, dead GRC handler removal):** Removed the unregistered
> GRC/backend tool-handler modules and their dead REST-wrapper functions left over from the #1500
> teardown, plus `mcp/ground-control/index.js`'s dead import block, per the ADR-054 sync note for
> this issue. The documentation-coverage classifier, `outcome_required` mapping, Vale rules,
> installer, `.vale.ini`, and this file's style rules are unchanged.

> **Sync note for issue #1500 (2026-08-03, context-graph teardown):** The backend, frontend, and
> database were removed; Ground Control is now the MCP server over repo-local files. The
> documentation-coverage classifier in `mcp/ground-control/lib/doc-coverage.js` dropped its
> `public_api` (backend) and `user_visible` (frontend) surface classes, whose subjects no longer
> exist; the surviving classes and the Vale rule set, installer, and `.vale.ini` are unchanged, and
> no style rule in this file changed.

> **Sync note for issue #1437 (2026-07-30, Live Activity):** Added a bounded project-scoped
> activity read projection and console page, with configuration and API/architecture documentation
> in ADR-061, ADR-054, `docs/API.md`, `docs/architecture/ARCHITECTURE.md`, and
> `docs/deployment/DEPLOYMENT.md`. The documentation-coverage classifier, `outcome_required`
> mapping, Vale rules, installer, `.vale.ini`, and this file's style rules are unchanged.

> **Sync note for issue #1462 (2026-07-28, completion project inference):** The
> MCP completion assertion now infers `project` from `repo_path`'s
> `.ground-control.yaml` when omitted and preserves backend `project_required`
> detail through `gc_assert_completion`. Contract updates live in
> `skills/implement/steps/step-17-completion.md`, `docs/DEVELOPMENT_WORKFLOW.md`,
> `docs/WORKFLOW.md`, and ADR-054. The documentation-coverage classifier,
> `outcome_required` mapping, Vale rules, installer, `.vale.ini`, and this file's
> style rules are unchanged.

> **Sync note for issue #1282 (2026-07-27, identity administration):** Added
> the non-secret `gc_identity_admin` MCP surface and extended the authorization
> path-matrix policy check to distinguish legacy `ROLE_ADMIN` access from
> `PERMISSION_IDENTITY_ADMIN`. The API and MCP contracts are documented in
> `docs/API.md`, `docs/architecture/ARCHITECTURE.md`,
> `mcp/ground-control/README.md`, ADR-035, ADR-054, and amended ADR-085. The
> documentation-coverage classifier, `outcome_required` mapping, Vale rules,
> installer, `.vale.ini`, and this file's style rules are unchanged.

> **Sync note for issue #1421 (2026-07-26):** The `/implement` workflow gains
> repository-bound MCP tools for remote integration-branch synchronization and
> synchronized PR creation. The routing parser retires execution-control fields
> that forced subagent dispatch, and the workflow policy checks now enforce
> advisory routing plus the new Step 8.5 boundary. The current contract is
> documented in the implement and quickfix skills, workflow docs, tool
> descriptions, and ADR amendments. The documentation-coverage classifier,
> Vale rules, and this file's style rules are unchanged.

> **Sync note for issue #1308 (2026-07-15, graph enum contract):** Added
> `GraphEntityType` to the existing ADR-034 enum-contract policy inventory and
> generated `GRAPH_ENTITY_TYPES` for frontend graph colors and tooltip coverage.
> Documentation lives in ADR-034, ADR-084, `docs/DEVELOPMENT_WORKFLOW.md`, and
> `docs/architecture/ARCHITECTURE.md`; ADR-054 records the policy-surface sync.
> The documentation-coverage classifier, `outcome_required` mapping, Vale rules,
> `tools/install-vale.sh`, `.vale.ini`, and this file's style rules are unchanged.

> **Sync note (2026-07-14, policy diff-base merge-base fix):** Fixed the `base`
> arm of `read_changed_files` in `tools/policy/checks.py` to scope the diff to
> `merge-base(base, HEAD)` instead of the two-dot `git diff <base> --`, so a PR
> branch that trails `dev` is no longer charged with `dev`'s later commits by
> the diff-scoped gates (observed on PR #1393, where an unrelated 2-file change
> tripped `doc-coverage-outcome-missing` on `dev`'s own docs). This is a
> policy-tooling correctness fix, not a documentation-classifier change: the
> documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`,
> and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1307 (2026-07-14, ontology binding gate):** Added
> `tools/policy/checks.py::run_ontology_binding_check` for the ADR-084 ontology
> contracts and their independently discovered Java vocabulary inventory.
> Documentation lives in ADR-084, `docs/DEVELOPMENT_WORKFLOW.md`, and
> `contracts/CHANGES.md`; ADR-054 records the policy-surface amendment. The
> documentation-coverage classifier, `outcome_required` mapping, Vale rules,
> `tools/install-vale.sh`, `.vale.ini`, and this file's style rules are
> unchanged.

> **Sync note for issue #1355 (2026-07-28, scan-floor contract):** Added `run_scan_floor_contract` in `tools/policy/workflow_contracts.py` and the shared `require_scanned` guard in `tools/policy/core.py`. A test that reads a source file and builds a collection from it by regex must now prove the extraction found something; an extraction that matches nothing fails instead of passing vacuously. This closes a class of fail-open gate found four times while decomposing `lib.js`: a check that located its subject by reading one file reported clean after the subject moved. The guard accepts any spelling that fails on an empty extraction (a `len()` floor, a truthiness assertion, or a membership assertion against the extracted collection), because demanding one form would push tests toward a shape their author did not mean. `run_repo_identity_drift` and `run_ghcr_namespace_drift` keep deliberately skipping absent inventory entries, but now fail if the inventory as a whole resolves to nothing. This is a policy-surface addition: the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1355 (2026-07-28, gate outcome measurement + MCP library decomposition):** Split `mcp/ground-control/lib.js` from a single 20,634-line module into `mcp/ground-control/lib/*` (48 modules, none over the 500-LOC limit in `docs/CODING_STANDARDS.md`), leaving `lib.js` as a barrel of star re-exports so `index.js` and every existing test keep importing from one place. The split is behaviour-neutral and was derived from the module's own AST dependency graph, which contains no mutual recursion; all 1873 MCP tests pass unchanged. The documentation-coverage gate's implementation (`gc_documentation_coverage`, the classifier, and its doc-target mapping) moved from `lib.js` to `mcp/ground-control/lib/doc-coverage.js` without any change to its behaviour, classifications, `outcome_required` mapping, or doc targets. `tools/policy/checks.py` gained `read_mcp_library`, so every content check reads the barrel plus all extracted modules rather than one path, because a check that read only `lib.js` after the split would see no implementation and silently pass. Also added the ADR-090 station-result and gate-finding measurement projection (`contracts/measurement/gc-station-catalogue-v2.json`, `gc.measurement.gate-finding.v1`) and the `triggerContent` content-scoping facility in `architecture/policies/adr-policy.json`. This is a policy-surface, MCP-internals, and public-API change: the Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1384 (2026-07-13, retired orchestration config and console assumptions):** Extended `tools/policy/checks.py::run_deploy_artifact_consistency` with the `deploy-env-template-orphan-key` guard: an active env template may advertise only keys some executable surface actually reads, with the legitimate consumer surfaces declared per template in `ENV_TEMPLATE_CONTRACTS` (compose interpolation and list-form inherit, `env.schema` directives with the ADR-026 credential/allowlist slots expanded, the deploy validator and script, `application*.yml` placeholders, the MCP client's `process.env` reads, and Spring relaxed binding onto a declared `@ConfigurationProperties` prefix). A compose literal (`- KEY=value`) pins the value and is not a consumer of the operator's; tests, docs, superseded ADRs, and historical migrations are not consumers. Removed the `TEMPORAL_*` / `GROUNDCONTROL_TEMPORAL_WORKER_*` keys the #1359 lane left behind in `.env.example` and `deploy/docker/.env.example` (plus `GC_SERVER_PORT` / `GC_CACHE_TYPE`, which the production compose pins as literals and never read from the operator's env file). Re-scoped `architecture/design/console-ia-design-system.md` and its preflight note onto the surviving read/reporting model (ADR-029 issue thread + ADR-061 telemetry projection), removing gate actions, operator signals, and run start/cancel/retry as product surfaces; requirement GC-Q016 is superseded by a stack-agnostic statement. This is a policy-surface and design-reference update: the documentation-coverage classifier, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1359 (2026-07-12, remove Temporal orchestration lane):** Removed the `/api/v1/workflow-executions**` REST surface and the `gc_workflow_execution` MCP tool (`start`/`get`/`list`/`signal`, handler `mcp/ground-control/gc-workflow-execution.js`) plus its API-client helpers and field mappings in `mcp/ground-control/lib.js`/`index.js`; removed `infrastructure/temporal/**`, `domain/workflowexecution/**`, `domain/llm`, and `infrastructure/llm` (including the Anthropic adapter), so the routing parser's canonical provider id is `claude` again with no `anthropic` alias; and dropped the `run_workflow_payload_contract_check`, `run_gate_set_invariant_check`, and `deploy-temporal-topology` policy checks from `tools/policy/checks.py` along with the `contracts/schemas/workflow/` activity-payload schemas. ADR-028, ADR-081, and ADR-088 are marked Superseded (issue #1359) in `architecture/adrs/README.md`; the run-economics surface (`workflow_run`, ADR-061 telemetry, `gc_workflow_run`/`gc_workflow_run_ingest`, ADR-036 per-step routing, ADR-029 issue-thread gates) is unaffected. This is a policy-surface, MCP tool-surface, and public-API removal: the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1346 (2026-07-11, ADR-089 GRC retirement):** `tools/policy/checks.py::run_traceability_reconciliation_gate_contract` dropped its `next_issue_recommendation` prose anchors (the field is retired from `gc_close_issue_after_merge`'s close envelope), and `ENUM_CONTRACT_INVENTORY` dropped the seven enum-contract entries owned by the retired composed GRC surface. This is a policy-surface removal, not a documentation-classifier change: the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1429 (2026-07-26):** The repository policy gate command is now read from `workflow.policy_command` in `.ground-control.yaml` (default `make policy`) instead of being hardcoded, and the PR body names it semantically (`- [x] Configured repository policy command passes`) rather than asserting a Make target. The mandatory pre-publish hook boundary is configurable the same way through `workflow.precommit_command`. `tools/policy/checks.py` changed only its `check_pr_body` required-line literal and the `/implement` verification-surface drift tokens. This is a configuration and workflow-gate change, not a documentation-classifier change: the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed. Prose in this repository's own developer instructions still names `make policy`, because that is this repository's configured command.

> **Sync note for issue #1438 (2026-07-27):** ADR-090's measurement model is now published as versioned contract artifacts under `contracts/`, with a new `tools/policy/checks.py` gate that fails when an emitted station id, a `gc:phase` marker, or an ADR-036 routing stage resolves to nothing the station catalogue declares. This is a contract-drift gate, not a documentation-classifier change: the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1436 (2026-07-27):** The workflow-runs console now receives committed run and phase-event facts over a project-scoped SSE stream instead of only polling for them. The `mcp/ground-control/lib.js` edit is a guard that refuses a `text/event-stream` response before reading it, since that read would never return; `gc-query.js` denylists the stream path so the agent read escape hatch cannot open it. This is an HTTP-client and read-allowlist change, not a documentation-classifier change: the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1435 (2026-07-26):** `/implement` now records its workflow run into the ADR-061 reporting model live, through a fail-open emitter in the MCP tool layer. The `mcp/ground-control/lib.js` edits are an optional abort `signal` on the shared `request()` helper plus a client for the new phase-event read endpoint. This is a telemetry-emitter and HTTP-client change, not a documentation-classifier change: the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for CLD track drop (issue #1296, 2026-07-10):** Removed the Contract-Locked Development enforcement gates from `tools/policy/checks.py` (`run_protected_path_authority_check`, `run_module_graph_boundary_check`, `run_mutation_gate_contract`, and their helpers), the CI `mutation` job, `tools/mutation/`, `architecture/registry/`, the backend `RegistryBoundaryArchitectureTest`, the oracle-battery scaffolds, and the `gc_post_design_authority_approval` MCP tool. The CLD milestone (#1296 through #1299) was dropped as premature optimization; the reviewer anti-gaming prompt checklist is retained. This is a policy-surface and tooling removal: the documentation-coverage classifier, outcome mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no `docs/DOC_STYLE.md` style rule changed.

> **Sync note for issue #1278 / GC-O009 (2026-07-08):** Registered the `gc_workflow_execution` MCP tool (handler `mcp/ground-control/gc-workflow-execution.js`; actions `start` / `get` / `list` / `signal`) plus workflow-control API-client helpers in `mcp/ground-control/lib.js` and `index.js`, backed by the new `/api/v1/workflow-executions**` REST surface for the GC-O009 phase-3 workflow control surface (start `/implement` Temporal executions, read execution state from Temporal Visibility, send the closed operator-signal catalog). Documentation lives in `docs/API.md`, `docs/DEVELOPMENT_WORKFLOW.md`, `docs/architecture/ARCHITECTURE.md`, the `index.js` tool description, and the ADR-054 amendment below. This is a new `mcp_tool` / `public_api` surface covered by the existing classifier path logic; the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1124 / GC-GRC-011 (2026-07-08):** Fixed `reconcileGrcScreeningV2` in `mcp/ground-control/lib.js` to resolve the project from `.ground-control.yaml` when the caller omits it (so the GRC reconciliation graph fetch is project-scoped and does not spuriously fail `grc_not_reconciled`), with a regression test in `mcp/ground-control/gc-grc-reconciled.test.js`, plus a Step 4.5 re-screen instruction in `skills/implement/steps/step-04.5-clause-mapping.md`. These are policy/workflow-tooling correctness fixes, not documentation-classifier changes: the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1334 (2026-07-06):** Fixed `load_pr_issue_comments` in `tools/policy/checks.py` so `make policy` no longer fails `pr-comments-json-invalid` on a PR with exactly one comment (the lone bare JSON object `gh api --jq` emits is now accepted; the multi-object fallback uses `JSONDecoder.raw_decode`). This is a policy-tooling correctness fix, not a documentation-classifier change: the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1330 (2026-07-05):** `tools/policy/checks.py::main` now downgrades the protected-path / battery approval-missing results to non-blocking warnings (TEMP, pending the #1330 redesign) because the design-authority approval marker is currently unsatisfiable (`gc_post_design_authority_approval` requires an out-of-band token configured on no MCP server). Detection is unchanged; only the blocking exit is suppressed. This is a policy-gate exit-behavior change, not a documentation-classifier change: the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no DOC_STYLE.md style rule changed.

> **Sync note for issue #1294 (2026-07-05 GC-CLD-5):** Added protected-path authority policy in `tools/policy/checks.py`, the `architecture/registry/protected-paths.json` registry, and the scope-bound `gc_post_design_authority_approval` MCP marker surface in `mcp/ground-control/index.js` and `mcp/ground-control/lib.js`. Documentation lives in `docs/DEVELOPMENT_WORKFLOW.md`, ADR-087, and the ADR-054 sync note; the change is a policy/workflow-gate surface update, not a documentation style update. No style rule changed.

> **Sync note for issue #1276 (2026-07-05 GC-O009):** Extended `tools/policy/checks.py::run_deploy_artifact_consistency` with the `deploy-temporal-topology` guard for the required Temporal production compose services, pinned images, SQL visibility database wiring, Tailscale-bound gRPC port, health checks, and resource limits. Documentation lives in `deploy/docker/README.md`, `docs/deployment/DEPLOYMENT.md`, `docs/operations/backup-restore.md`, and `docs/DEVELOPMENT_WORKFLOW.md`; ADR-054 records the policy-surface amendment. No style rule changed.

> **Sync note for issue #1293 (2026-07-04 GC-CLD-4):** Added `tools/policy/checks.py::run_mutation_gate_contract` so `make policy` verifies the CLD mutation gate runner, registry schema, CI mutation job, pull-request base-ref scoping, report artifact, and branch-protection context. Documentation lives in `docs/DEVELOPMENT_WORKFLOW.md`, ADR-087, and the mutation registry README; the surface change is recorded in the ADR-054 amendment. No style rule changed.

> **Sync note for issue #1275 (2026-07-04 GC-O014):** Added contract-surface policy checks in `tools/policy/checks.py` for the committed `contracts/` artifact set, generated frontend API type shim, JSON Schema invariant enforcement metadata, and authorization path-matrix synchronization. The contract-surface documentation lives in ADR-082, `docs/DEVELOPMENT_WORKFLOW.md`, and `docs/architecture/ARCHITECTURE.md`; ADR-054 records the policy-surface amendment. No style rule changed.

> **Sync note for issue #1468 (2026-07-28, ADR-091 frontend lane amendment):** `tools/policy/checks.py::CI_STRICTNESS_REQUIRED_CONTEXTS` gained the `frontend` required context, and `tools/tests/test_ci_topology.py` gained the matching invariants. The same issue finished removing the withdrawn CLD mutation tooling from `frontend/` and deleted the stale `make mutation` / registry instructions from `docs/DEVELOPMENT_WORKFLOW.md`. Documentation lives in `docs/ci/CI_PIPELINE.md`, `docs/DEVELOPMENT_WORKFLOW.md`, and the ADR-091 2026-07-28 amendment. This is a policy-surface change on the CI strictness contract, not the documentation-coverage gate; the classifier, Vale rule set, and `.vale.ini` are unchanged, and no style rule changed.

> **Sync note for issue #1461 (2026-07-28, ADR-091 CI verification topology):** `tools/policy/checks.py::CI_STRICTNESS_REQUIRED_CONTEXTS` dropped the `mutation` context, which commit `bf766bfe` orphaned when it removed the CI `mutation` job. `tools/tests/test_ci_topology.py` now asserts the required-context set, the branch-protection baseline, and the `ci.yml` job graph agree. The same issue fixed `mcp/ground-control/lib.js::runWatchCiRun`, which reported the newest workflow run's result as the CI gate and so could pass on an unrelated fast workflow; it now groups runs by head SHA and requires all of them to succeed. Documentation lives in `docs/ci/CI_PIPELINE.md`, `docs/DEVELOPMENT_WORKFLOW.md`, ADR-091, and the ADR-027 2026-07-28 amendment. This is a policy-surface change on the CI strictness contract, not the documentation-coverage gate; the classifier, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no style rule changed.

> **Sync note for issue #1129 (2026-07-04 GC-GRC-016):** Registered the `gc_grc_assess` MCP tool (handler `mcp/ground-control/gc-grc-assess.js`; actions `run` / `review` / `get` / `list`) plus GRC assessment run API-client helpers in `mcp/ground-control/lib.js` and `index.js`, backed by the new `/api/v1/grc-assessment-runs` REST surface for durable on-demand assessment runs. The `/api/v1/grc-assessment-runs` read prefix was added to the `gc_query` allowlist (`gc-query.js`, `mcp/ground-control/README.md`, ADR-035). Documentation lives in `docs/API.md`, `docs/DEVELOPMENT_WORKFLOW.md`, `mcp/ground-control/README.md`, and `skills/assess/SKILL.md`; the surface addition is recorded in the ADR-054 amendment. No style rule changed.

> **Sync note for issue #1008 / ADR-086 (2026-07-03 research privacy/security controls):** Registered the `gc_research_operation_authorization` MCP tool (handler `mcp/ground-control/gc-research-operation-authorization.js`; actions `request` / `decide` / `consume` / `list` / `get`) plus research egress-policy enum constants and API-client helpers in `mcp/ground-control/lib.js` and `index.js`, backed by the new `/api/v1/research-runs/{runId}/operation-authorizations/**` REST surface for research high-risk operation authorization. New request/response schemas are documented under the research-runs section of `docs/API.md` per the "Adding a new MCP tool" rule; the surface change is recorded in the ADR-054 amendment, `docs/architecture/ARCHITECTURE.md`, and `docs/research/RESEARCH_WORKFLOW.md`. No style rule changed.

> **Sync note for issue #1007 / ADR-083 (2026-07-03 protocol plan):** The `gc_research_run` MCP tool gained `record_protocol_plan` and `get_protocol_plan` actions (`POST`/`GET /api/v1/research-runs/{id}/protocol-plan`) in `mcp/ground-control/index.js` + `lib.js` for the structured phase-2 protocol plan, mirroring the ADR-080 methodology-requirements-contract action pair (`#1006`). The surface change is recorded in the ADR-054 amendment, `docs/API.md`, `docs/architecture/ARCHITECTURE.md`, and `docs/research/RESEARCH_WORKFLOW.md`; no style rule changed.

> **Sync note for issue #1123 (2026-07-03 GC-GRC-010):** Added the design-time GRC deliverables gate to the existing `gc_post_implementation_plan` MCP tool in `mcp/ground-control/index.js` and `mcp/ground-control/lib.js` (new `validateGrcDeliverablesPlanGate` / `renderGrcDeliverablesRecord` / `parseGrcDeliverablesData` helpers, a `grc_deliverables` param, and a `grc_screening` prerequisite marker). A `security_relevant` change must enumerate structured deliverables covering every screening gap surface and stale entity or record an authorized disposition (no-defer, GC-GRC-015); the tool renders an authoritative `gc:grc-deliverables-data` machine block into the plan comment. This is a change to an existing `mcp_tool` / `workflow` surface covered by the existing classifier path logic; documentation lives in the `index.js` tool description, `docs/DEVELOPMENT_WORKFLOW.md`, `skills/implement/steps/step-04-planning.md`, `skills/implement/steps/step-03.5-grc-screening.md`, `.gc/plan-rules.md`, `mcp/ground-control/README.md`, and the ADR-058 §5 realization. No new `gc_query` allowlist path and no style rule changed.

> **Sync note for issue #1122 (2026-07-02 GC-GRC-009):** Reworked the `/implement` Step 3.5 GRC screening tool `gc_post_grc_screening` in `mcp/ground-control/index.js` and `mcp/ground-control/lib.js` to a derivation-backed v2 contract (`gc.implement.grc-screening/v2`): the tool now computes `impact_set` / `gap_set` / `stale_set` from the diff, the GRC CODE-link graph, and derived facts (agent no longer asserts a verdict), and `gc_assert_grc_reconciled` branches on record schema and blocks on a non-empty `gap_set`. Documentation lives in the `index.js` tool descriptions, `docs/DEVELOPMENT_WORKFLOW.md`, `docs/WORKFLOW.md`, `skills/implement/steps/step-03.5-grc-screening.md`, and the ADR-057 v2 amendment (target contract ADR-058). This is a change to an existing `mcp_tool` surface covered by the existing classifier path logic; no new `gc_query` allowlist path and no style rule changed.

> **Sync note for issue #1121 (2026-07-01 GC-GRC-008):** Registered the `gc_control_identification` MCP tool (handler `mcp/ground-control/gc-control-identification.js`; read actions `identify` / `coverage`) and the `controlIdentification` / `controlCoverage` API-client helpers in `mcp/ground-control/lib.js`, backed by the new `GET /api/v1/control-identification` REST surface for GC-GRC-008 deterministic control identification and mapping. Documentation lives in `docs/API.md` (`### Control Identification (GC-GRC-008)`), the `index.js` tool description, and the ADR-054 amendment below. The confirmation write is REST-only (records through existing `RiskControlMapping` / `ThreatModelLink` aggregates); the read tool does not touch the `gc_query` allowlist. No style rule changed.

> **Sync note for issue #214 (2026-06-30 GC-S005):** Registered the project-scoped `gc_evidence_campaign` MCP tool (actions: create / list / get / update / pause / resume / trigger / runs_list) in `mcp/ground-control/index.js`, `mcp/ground-control/lib.js`, and `mcp/ground-control/gc-evidence-campaign.js`, backed by the new `/api/v1/evidence-campaigns**` REST surface for scheduled evidence collection. Documentation lives in `docs/API.md`, `docs/architecture/ARCHITECTURE.md`, and `architecture/adrs/074-scheduled-evidence-collection.md`; the surface addition is recorded in the ADR-054 amendment below. New request/response schemas are documented under the relevant `docs/API.md` service section per the "Adding a new MCP tool" rule. No style rule changed.

> **Sync note for issue #1120 (2026-06-30):** Registered the `gc_threat_enumeration` MCP tool
> (handler `mcp/ground-control/gc-threat-enumeration.js`) and the `threatEnumeration` API-client
> helper in `mcp/ground-control/lib.js`, backed by the new `GET /api/v1/threat-enumeration` REST
> surface for GC-GRC-007 deterministic threat enumeration. Documentation lives in `docs/API.md`
> (`### Threat Enumeration (GC-GRC-007)`), the `index.js` tool description, and the ADR-054
> amendment. The tool is a dedicated read-only adapter that does not touch the `gc_query` allowlist;
> the surface addition is recorded in the ADR-054 amendment. No style rule changed.

> **Sync note for issue #1119 (2026-06-29):** Registered the `gc_data_classification` MCP tool (handler `mcp/ground-control/gc-data-classification.js`; actions `get_lattice` / `set_lattice` / `reset_lattice` / `evaluate`) and its API-client helpers plus the `grc.data_classification` config normalizer in `mcp/ground-control/lib.js`, backed by the new `/api/v1/data-classification` REST surface for the GC-GRC-006 data classification lattice. The `/api/v1/data-classification` read prefix was added to the `gc_query` allowlist (`gc-query.js`, `mcp/ground-control/README.md`, ADR-035). Documentation lives in `docs/API.md`, the `index.js` tool description, and ADR-072; the surface addition is recorded in the ADR-054 amendment. No style rule changed.

> **Sync note for issue #1118 (2026-06-28):** Registered the `gc_architecture_model` MCP tool and architecture-model client helpers for the canonical server-side aggregate. The REST and MCP contract is documented in `docs/API.md`, `docs/architecture/ARCHITECTURE.md`, `mcp/ground-control/README.md`, and the tool description; ADR-035 carries the `gc_query` read allowlist update. No style rule changed.

> **Sync note for issue #1002 (2026-06-28):** A new MCP tool `gc_research_provenance` (actions: record_node / record_edge / list_nodes / list_edges / chain) was registered in `mcp/ground-control/index.js` and `mcp/ground-control/lib.js` (handler in `gc-research-provenance.js`), backed by the new `/api/v1/research-runs/{runId}/provenance/**` REST surface for the research provenance ledger (ADR-069). It is an additive curated-write tool whose run-scoped reads also route through the existing `gc_query` `/api/v1/research-runs` allow-list. Documentation lives in `docs/API.md`, the `index.js` tool description, and ADR-069; the two write surfaces are covered by the `openapi-contract.test.js` drift gate. The surface addition is recorded in the ADR-054 amendment below. No style rule changed.

> **Sync note for issue #1117 (2026-06-28):** The `gc_derivation` MCP surface now forwards declared boundary inputs from `grc.boundaries` and exposes `get_boundary_model` for derivation-run boundary snapshots. The current contract is documented in `docs/API.md`, `docs/DEVELOPMENT_WORKFLOW.md`, `docs/architecture/ARCHITECTURE.md`, and `mcp/ground-control/README.md`. No style rule changed.

> **Sync note for issue #859 (2026-06-24):** Two new MCP tools were registered in `mcp/ground-control/index.js` and `mcp/ground-control/lib.js`: `gc_workflow_run` (action-multiplexed workflow-run telemetry: record / record_event / import_cost / list / aggregate / cross_project_aggregate) and `gc_workflow_run_ingest` (bridge ingestion from canonical issue-thread `gc:` markers), backed by the new `/api/v1/workflow-runs**` REST surface, with the two project-scoped read paths added to the `gc_query` allowlist (`gc-query.js`, `mcp/ground-control/README.md`, ADR-035). Documentation lives in `docs/API.md`, the `index.js` tool descriptions, and ADR-061; the surface addition is recorded in the ADR-054 amendment below. A follow-up review-fix commit clarified the record action's idempotent-upsert semantics in the tool description and `docs/API.md`. No style rule changed.

> **Sync note for issue #1162 (2026-06-22):** The `gc_create_github_issue` MCP tool was fixed to render the issue title/body from the requirement (it previously produced literal `undefined`) and to auto-create the IMPLEMENTS/DOCUMENTS traceability link, via a new `createGitHubIssueFromRequirement` helper in `mcp/ground-control/lib.js` plus updated wiring and description in `index.js`. Documentation lives in the tool description string and `mcp/ground-control/README.md`. No style rule changed.

> **Sync note for issue #260 (2026-06-22 GC-T005):** The `gc_analyze` tool gained the `appetite_evaluation` kind and `gc_risk_governance` gained the `risk_appetite_profile` entity in `mcp/ground-control/index.js`, `lib.js`, and `gc-risk-governance.js`. These are additive extensions to existing action-multiplexed tools backed by fixed REST endpoints. Documentation lives in `docs/API.md` (`/risk-appetite-profiles` CRUD and `/analysis/grc/appetite-evaluation`) and `docs/architecture/ARCHITECTURE.md`. No style rule changed.

> **Sync note for issue #721 (2026-06-21):** The NIST `gc_analyze`
> opaque-key examples now name `threat_event_relevance` and retain legacy
> `threat_source_relevance` as a compatibility key. The API reference carries
> the current contract. No style rule changed.

> **Sync note for issue #266 (2026-06-20 GC-H006):** The `gc_risk_control_mapping` MCP tool in `mcp/ground-control/index.js` and `mcp/ground-control/lib.js` was extended with `threat_model_id` and three new threat-coverage query actions. These are additive extensions to an existing action-multiplexed tool. Documentation lives in `docs/API.md` and `docs/architecture/ARCHITECTURE.md`. No style rule changed.

> **Sync note (2026-06-23, release PR body-contract exemption):** `tools/policy/checks.py::main` now skips the per-PR body contract (`check_pr_body` and the `## Documentation` outcome) for the `dev` -> `main` release PR, which aggregates feature PRs that already satisfied it. Detection is by PR base/head (`_is_release_pr`); all changed-file checks still run. The classifier, Vale rules, `.vale.ini`, and this document's style rules are unchanged.

> **Sync note (2026-06-23, Flyway migration immutability guard):** Added a `migration-immutability` check to `tools/policy/checks.py::run_migration_policy` that fails `make policy` when a migration already present on the released baseline (`origin/main`) is modified or removed (editing an applied migration breaks Flyway checksum validation on every database that ran it). New forward migrations are exempt. The classifier, Vale rules, `.vale.ini`, and this document's style rules are unchanged.

> **Sync note (2026-06-23, GHCR namespace drift gate - #953 / GC-P022):** Added `tools/policy/checks.py::run_ghcr_namespace_drift` so `make policy` fails when a deploy/CI artifact references a non-canonical `ghcr.io/<ns>/ground-control` namespace (canonical: `autarchy-ai`). This closes the silent stale-deploy gap left by the org move. It is a deploy-policy-surface extension; the classifier, Vale rules, `.vale.ini`, and this document's style rules are unchanged.

> **Sync note (2026-06-23, deploy artifact consistency gate - #855 / GC-P023):** Added `tools/policy/checks.py::run_deploy_artifact_consistency` so `make policy` fails on operator-deploy artifact drift: a reintroduced second env template or dead wrapper, an `env.schema` that diverges from the production compose contract or stops marking `GC_IMAGE` `FLOATING_TAG`, a stale `deploy/docker/MANIFEST.sha256` (regenerate with `make deploy-manifest`), or an operator wrapper that reimplements the `docker compose pull/up` rollout. `env.schema` is the single contract shared with the deploy-time `validate-env.sh`. It is a deploy-policy-surface extension; the classifier, Vale rules, `.vale.ini`, and this document's style rules are unchanged.

> **Sync note (2026-06-25, release pin - #1222 / ADR-063):** `run_deploy_artifact_consistency` now requires `env.schema` to mark `GC_IMAGE` `RELEASE_PIN` instead of `FLOATING_TAG` (violation code `deploy-env-schema-release-pin`), and `validate-env.sh` requires an immutable versioned release tag (`...:X.Y.Z`) and rejects a floating branch tag like `:main` (digest allowed only with `GC_ALLOW_IMAGE_PIN=1` for rollback). This reverses the earlier floating-tag rule per ADR-063. Still a deploy-policy-surface change; the classifier, Vale rules, `.vale.ini`, and this document's style rules are unchanged.

> **Sync note for issue #1197 (2026-06-23):** `gc_requirement` create gained `uid_prefix` (mutually exclusive with `uid`); `gc_get_traceability_by_artifact` and `checkOrphanedIssueLinks` gained an optional `project` parameter. A review-fix refinement (same date) clarified the `gc_get_traceability_by_artifact` description and helper comment: the reverse lookup is always project-scoped (`project_required` in a multi-project instance), never an unscoped fallback. These MCP tool-surface changes are recorded in ADR-054 (2026-06-23 amendment). No style rule changed.

> **Sync note for issue #1107 (2026-06-14):** The audit-diff API reference (`docs/API.md`) and the `gc_requirement` MCP tool description were reviewed against these rules when the requirement history/timeline `expand` parameter was added. No style rule changed.

> **Sync note for issue #1106 (2026-06-15):** The new MCP write-contract gate docs (`docs/DEVELOPMENT_WORKFLOW.md`, `mcp/ground-control/README.md`, and the ADR-034 amendment) were reviewed against these rules. No style rule changed.

> **Sync note for issue #1180 (2026-06-18):** The `short_code` config-parser addition and tmux session-rename skill updates were reviewed against these rules. No style rule changed.

> **Sync note for issue #1176 (2026-06-15):** Extended `tools/policy/checks.py::ENUM_CONTRACT_INVENTORY` with three GRC enum-contract entries (`VerificationStatus`, `AssuranceLevel`, `MethodologyFamily`). The classifier, Vale rules, `.vale.ini`, and this document's style rules are unchanged.

> **Sync note for issue #1167 (2026-06-21):** Corrected `tools/policy/checks.py::run_controller_contracts` (and the parallel `ControllerPolicyTest`) to map a controller to its `@WebMvcTest` companion by fully qualified class instead of filename stem, fixing a same-named-controller collision across packages. The parser strips the `.class` suffix in code so the matching regex stays linear-time (Sonar S8786). The classifier, Vale rules, `.vale.ini`, and this document's style rules are unchanged.

> **Sync note for issue #963 (2026-06-22):** Added a `phase` parameter to the `gc_assert_completion` MCP tool (`mcp/ground-control/index.js`, `mcp/ground-control/lib.js`) so the requirement transition, traceability reconciliation, and final report run post-merge (Phase E). The tool-description text and the operative agent prose in `skills/implement/steps/step-17-completion.md` were reviewed against these rules; the surface addition is recorded in ADR-054 and the `changelog.d/963.changed.md` fragment. The classifier, Vale rules, `.vale.ini`, and this document's style rules are unchanged.

> **Sync note for issue #1005 (2026-06-29):** The `gc_research_run` MCP tool's `record_methodology_source` action lost `source_required` (boolean) and `select_methodology` gained `required_source_refs` (optional string array, max 500 chars per element) in `mcp/ground-control/index.js`. Required sources are now snapshotted immutably at selection time; callers cannot inject a required flag via the record-source endpoint. The surface change is recorded in the ADR-054 amendment; no style rule changed.

> **Sync note for issue #1005 / ADR-078 (2026-06-30):** The methodology catalog became backend-owned, validated-on-load reference data, and the required-source set is now derived from it rather than supplied by the caller. The `gc_research_run` MCP tool's `select_methodology` action was reduced to `{id, method_key}` (dropping `method_label`, `profile_version`, `catalog_version`, `required_source_refs`), and a new global read action `list_methodology_catalog` (`GET /api/v1/research-runs/methodology/catalog`) was added in `mcp/ground-control/index.js` + `lib.js`. The surface change is recorded in the ADR-054 amendment and `docs/API.md`; no style rule changed.

> **Sync note for issue #1006 / ADR-080 (2026-07-01):** The `gc_research_run` MCP tool gained `record_methodology_requirements_contract` and `get_methodology_requirements_contract` actions (`POST`/`GET /api/v1/research-runs/{id}/methodology/requirements-contract`) in `mcp/ground-control/index.js` + `lib.js` for the structured phase-1 methodology requirements contract. The surface change is recorded in the ADR-054 amendment, `docs/API.md`, and `docs/research/RESEARCH_WORKFLOW.md`; no style rule changed.

## Rules

Docs describe the system as it ships on the current commit. Write in present
tense. Use active voice. Be concise: remove any sentence that does not add
information the reader needs to understand the feature, architecture, or
contract.

Strip:

- Fluff: restatement of context the reader already has, throat-clearing,
  hedging prose.
- Forward guidance: "future work," "this feature is planned."
- Roadmapping: phase tables, milestone summaries. Roadmaps belong in
  tracking issues.
- Meta-commentary: "this document explains," "the next section covers." If a
  choice needs explaining, the rationale lives in an ADR.

### Em-dash density

Prefer commas, semicolons, periods, or parentheses for clause breaks. Reach
for an em-dash only when the construction genuinely demands the heavier break:
a parenthetical that requires emphasis, or a sharp pivot that a comma or
semicolon cannot carry.

Soft budget: at most one em-dash per paragraph, typically zero. If a paragraph
has two, rewrite one.

Em-dash chains (`X - Y - Z`) should almost always be reordered into separate
clauses.

This pattern was surfaced in shifter #704, where agent-written prose accumulated
56 em-dash occurrences across five documents in a single PR. The
`GoogleProject.EmDashDensity` Vale rule enforces the per-paragraph budget
mechanically at error level; touched docs that exceed the budget fail the
prose-lint gate. See `.vale/styles/GoogleProject/EmDashDensity.yml`.

## Style anchors

- **Voice and tense:** [Google Developer Documentation Style Guide](https://developers.google.com/style).
  Present-tense default, plain English, concision.
- **Structure:** [Diátaxis](https://diataxis.fr/) - every doc is one of
  `tutorial`, `how-to`, `reference`, or `explanation`. Reference and how-to
  docs do not contain roadmaps or meta-commentary by construction.

## Enforcement

Vale with the `errata-ai/Google` package runs on docs touched in the current
diff via `make policy` and the CI `policy` job. Both install Vale via
`tools/install-vale.sh` on first need; no manual `make vale-install` step is
required. Vale does not run at commit time: `make policy` already runs it at
the `/implement` policy gate and again on the post-base-sync tree, and CI runs
it on every pull request.

Changes to any doc-coverage gate surface - `mcp/ground-control/index.js`,
`mcp/ground-control/lib.js`, `mcp/ground-control/lib/doc-coverage.js`,
`tools/policy/checks.py`, `tools/install-vale.sh`,
`.vale.ini`, or this file - trigger the `doc-coverage-gate-sync` rule per
ADR-054, which requires this file and ADR-054 to stay current with the gate
surface they describe. A new policy check in `tools/policy/checks.py` records
its contract in the ADR that owns the surface it guards (for example, the ACES
concept-family crosswalk check under ADR-084 §4); this file carries the
gate-surface trigger inventory above, not per-check contracts. Changing the
behavior of an existing validator or recognizer on a gate surface follows the
same rule: record the new contract in the ADR that owns it, and note in ADR-054
whether the change touched documentation-coverage classification.

As of #1399 (GC-P027) Release Please owns `CHANGELOG.md`: contributors do not
hand-edit it or file `changelog.d/` fragments (that Towncrier convention was
retired). Changelog entries are generated from Conventional Commit PR titles,
enforced by `.github/workflows/pr-title.yml`; product-version literals are
mechanically updated by the release PR and their consistency is enforced by
`run_version_mirror_consistency_check`.
Adding a new MCP tool, or changing an existing tool's request/response shape,
does not require new style rules here. The tool's registration and its
description string in `mcp/ground-control/index.js` are the contract surface, and
`mcp/ground-control/README.md` carries the tool reference; both are linted by Vale
on touch. The REST reference that once held request/response schemas
(`docs/API.md`) went with the backend it described (issue #1500).

## Scope: whole file on first touch

When a `.md` / `.markdown` file appears in the current diff (added, copied,
modified, or renamed vs the base ref), Vale lints it in its entirety - not just
the changed lines. A one-line edit to a previously untouched document brings
the whole file into scope; all of its style violations must be fixed in that
PR. Untouched docs are not linted.

The model is "ratchet on touch": each touched file becomes permanently
compliant, and the codebase converges as docs are edited in the normal course
of work. There is no line-range or hunk-aware mode, and there is no carve-out
for "I only changed one paragraph"; if you touch a doc, you own its full
style compliance. See ADR-054 for the rationale behind this trade-off.

## Temporal context

ADRs carry the durable *why*. Release notes and the changelog carry temporal
context. Tracking issues carry roadmaps. Reference docs state the current
contract only.

## Operational lane docs

Operational skill lanes (`/integrate`, `/implement`, `/quickfix`, `/review`)
document their contracts in `docs/DEVELOPMENT_WORKFLOW.md` and in their
`SKILL.md` files. The style rules above apply to those files the same as to any
other touched `.md` file: present tense, active voice, no forward guidance, at
most one em-dash per paragraph. The `/integrate` lane's `mode=merge` extension is
documented in `docs/DEVELOPMENT_WORKFLOW.md § /integrate § Configuration` and
`skills/integrate/SKILL.md § Invocation`; no separate doc surface is required.
The maintainer `/review` lane (GC-O015) documents its read-only default,
authorized remediation, and post-merge closure in
`docs/DEVELOPMENT_WORKFLOW.md § /review` and `skills/review/SKILL.md`.

Per-PR documentation outcomes are recorded as a `## Documentation` section in
the PR body and the Step 17 final-report comment. Pass the optional
`documentation_outcome` field to `gc_render_pr_body` or `gc_post_final_report`
when the diff touches a classified surface (per ADR-054). The renderer emits
the section automatically; agents do not hand-author it.

MCP tool registrations in `mcp/ground-control/index.js` are sensitive to
schema shape: `server.tool(name, desc, zodShape, handler)` and
`server.registerTool(name, {description, inputSchema: <Zod schema>}, handler)`
both work, but `server.registerTool({inputSchema: <raw JSON Schema>})` passes
the registration gate and crashes every call with
`v3Schema.safeParseAsync is not a function`. New tools should match the
`server.tool` pattern used by the bulk of the file.

## MCP shape extensions and policy updates are not doc edits

An additive Zod schema field on a registered tool does not by itself require new
reference-doc prose. The tool's description string in
`mcp/ground-control/index.js`, plus its handler and the `lib/` function it
delegates to, are the contract surface; keep the description accurate when adding
or removing a field. The temporal record is the Conventional Commit history that
Release Please turns into `CHANGELOG.md` (GC-P027); the `changelog.d/` fragment
convention this section once named was retired in #1399.

A new repo-native check in `tools/policy/` is a policy-surface change, not a
documentation edit. Its user-facing reference belongs in
`docs/DEVELOPMENT_WORKFLOW.md`, and the surface addition is recorded as an
amendment to the ADR that owns the surface it guards, not as a new style rule
here.

Per-action required-field enumeration in an action-multiplexed tool's description string (issue #1169) is a contract-surface edit to that tool's description, not a new doc page.

An additive optional input that changes how a tool invokes a repository command
follows the same convention, with one addition. The
`requested_requirement_uid` field added to `gc_synchronize_implement_branch`
for issue #1434 is documented by that tool's description string and by the
`gc_implement_mechanical` description. Because the field also establishes an
execution-boundary contract - the `ACES_REQUIREMENT_UID` environment variable
that repo-authored gates read - the boundary itself belongs in
`docs/DEVELOPMENT_WORKFLOW.md` and in an ADR-027 amendment. The rule is the
distinction: the field is a contract surface, but a new environment variable
that a repository's own commands depend on is a durable interface and needs a
durable record.

### Precedent log (historical)

Everything below is a dated, issue-anchored record of past rulings on whether a
particular change needed a new style rule. The answer was almost always no, and
that general answer is the rule stated above. The entries stay for provenance.

Read them as history, not as current guidance. Many describe surfaces the #1500
re-platform removed: the Spring backend and its REST API, the React console, the
GRC, measurement, research-run, and test-management products, `docs/API.md`, and
the retired `changelog.d/` fragment convention. A path or tool named in an entry
below is not evidence that it exists today; check the tree.

Mirrored API-boundary enum constants follow the same convention: the
`NORMALIZED_CONCEPTS` and `CROSSWALK_VOCABULARY_SURFACES` arrays added to
`mcp/ground-control/lib.js` for GC-T012 / #719 mirror two new Java enums on
`MethodologyProfile` and are documented by the methodology profile entry in
`docs/API.md` and the `gc_risk_governance` tool description in
`mcp/ground-control/index.js`. The static `ENUM_CONTRACT_INVENTORY`
extension in `tools/policy/checks.py` enforces parity across backend, MCP,
and frontend per ADR-034. No new sections in this style guide.

Restoring a `TO_CAMEL` mapping in
`mcp/ground-control/lib.js` (for example, the `threat_source` /
`threat_event` entries the `gc_risk_scenario` rename in #720 dropped but
the `gc_threat_model` tool still needs on its public surface) is a
config-parser fix: the contract surface that names the snake_case fields
is the tool's adapter file (`gc-threat-model.js` or sibling), and the
amendment record lives in ADR-054. No new sections in this style guide.

New API client functions added to `mcp/ground-control/lib.js` (for example,
`getThreatModelWorkspace` for GC-Q010, `getRiskScenarioWorkspace` for GC-Q009,
`getControlAssuranceWorkspace` for GC-Q011, `getEvidenceStateWorkspace` for
GC-Q012, or `getTraceabilityMatrix` for GC-Q003) that directly mirror backend
endpoints follow the same pattern: record the surface addition in the ADR-054
amendment and the changelog fragment; no new DOC_STYLE.md prose is needed unless
a new style rule is being established. The matching `gc_traceability_matrix` read
tool for GC-Q003 mirrors the new `GET /api/v1/requirements/matrix` endpoint and
needs no new style rule.

The GC-GRC-001 derivation API helpers and `gc_derivation` MCP tool follow the
same convention: `docs/API.md` documents `/api/v1/derivations`, the adapter
description documents the MCP action contract, and the changelog fragment
records the temporal change. No new style rule is established here.

CI strictness policy checks in `tools/policy/checks.py` follow the same
documentation pattern: `docs/DEVELOPMENT_WORKFLOW.md` documents the current
merge-gate contract, `tools/sonar/README.md` documents Sonar-specific helper
scripts, and ADR-054 records the policy-surface amendment. No new style rule
is established here.

New /implement workflow-gate MCP tools or fields added to
`mcp/ground-control/lib.js` and `mcp/ground-control/index.js` are documented by
the tool description strings in `index.js` and the skill prose under
`skills/implement/`. Examples include `gc_assert_traceability_reconciled` and
`gc_close_issue_after_merge` for GC-O007 / #1058, `gc_post_grc_screening` for
GC-O012 / #1099, `gc_assert_grc_reconciled` for #1100,
`gc_assert_quality_gates` for #1101, `plain_english_outcome` /
`next_issue_recommendation` for #1156, and `gc_review_cap_disposition` (plus
the `auto_grant` field on `gc_codex_review_cycle`)
for the automated review-cap disposition gate in #1245. The matching policy check in
`tools/policy/checks.py` is the prose-side guardrail. The surface addition is
recorded in the ADR-054 amendment and the changelog fragment; no new
DOC_STYLE.md prose is needed unless a new style rule is being established.

Extensions to existing /implement workflow-gate MCP tools follow the same
documentation pattern. The #1102 `gc_assert_quality_gates` extension adds
PR-scoped `DOCUMENTS` traceability enforcement for in-scope requirements, and
the backend DRAFT-to-ACTIVE transition rule enforces the same requirement-link
contract. The current behavior is documented in `docs/DEVELOPMENT_WORKFLOW.md`,
`docs/API.md`, and `skills/implement/steps/step-06-completion-gate.md`, with
the durable rationale in ADR-054. No new DOC_STYLE.md style rule is established.

The 2026-06-10 SonarCloud remediation (#1085) refactored `mcp/ground-control/lib.js` and `index.js` internals without changing any prose style rule or documented-surface classification; no new DOC_STYLE.md rule is established.

The next-issue recommendation refinement (umbrella/tracking exclusion) follows
the same documentation pattern. `gc_close_issue_after_merge` now skips
umbrella/tracking issues when it picks the issue to recommend after a
merge-verified close. The current behavior is documented in the recommendation
source description in `skills/implement/steps/step-20-close-issue-on-merge.md`,
with the durable rationale in the ADR-054 amendment and the temporal change in
the changelog fragment. This refines an existing workflow-gate tool and touches
no documentation-coverage surface; no new DOC_STYLE.md style rule is
established.

The 2026-06-14 Phase D consolidation (#1103) added `gc_assert_completion` to `mcp/ground-control/lib.js` and `index.js`, updated `tools/policy/checks.py` for the consolidated Step 17 surface, and reorganized the /implement SKILL step prose. No new DOC_STYLE.md style rule is established.

The MCP tool-usage telemetry capture (#1104 / ADR-059) follows the same
documentation pattern. It adds an internal handler-boundary instrumentation
wrapper (`installToolTelemetry`) in `mcp/ground-control/index.js`, an
admin-token routing entry for the aggregate read in
`mcp/ground-control/lib.js`, and the new `McpTelemetryController` endpoints
documented in `docs/API.md`. Capture is internal to the adapter (no new
public `gc_*` tool is registered), so the doc-coverage classifier surface set
is unchanged. The surface addition is recorded in the ADR-054 amendment and
the changelog fragment; no new DOC_STYLE.md style rule is established.

Correcting a `GOVERNANCE_FIELDS` create/update allowlist in `mcp/ground-control/lib.js` to match the backend DTO (issue #1173) is a config-parser fix recorded in an ADR-054 amendment, not a new doc page.

Bumping the `CLAUDE_MODEL_BY_TIER.high` routing-default model id in `mcp/ground-control/lib.js` from `claude-opus-4-7` to `claude-opus-4-8` (issue #1181) is a constant change recorded in an ADR-054 amendment, not a new doc page or style rule.

Adding `expected_model` and `model_matches_expected` to the `/implement` step-telemetry record in `mcp/ground-control/lib.js` (issue #1181, schema `gc.implement.telemetry/v2`) is a telemetry-record field addition documented in ADR-036 and recorded in an ADR-054 amendment, not a new doc page or style rule.

Bumping the `CLAUDE_MODEL_BY_TIER.medium` routing-default model id and loosening the routing model-id validator to accept single-segment canonical ids (issue #1264) is a constant change plus a validator relaxation recorded in an ADR-054 amendment, not a new doc page or style rule.

New `/implement` workflow-gate configuration under `.ground-control.yaml`
(for example, `workflow.dev_start_gate` for GC-O007 / #1194) follows the same
contract. The config parser and MCP tool descriptions are the authoritative
machine surface, and the required agent behavior lives in the `skills/implement/`
step files. Record the surface addition in ADR-054 and the changelog fragment;
do not add separate reference prose unless the change creates a new
documentation style rule.

The research-run lifecycle surface (GC-RSCH-R001/R003 / ADR-064 / ADR-065 /
#1000) follows the same pattern as the other backend-mirroring MCP additions.
The `gc_research_run` action-multiplexed tool plus its `startResearchRun` /
`advanceResearchRun` / `recordResearchRunArtifact` / `getResearchRunSnapshot`
(and sibling) client functions in `mcp/ground-control/lib.js` and
`mcp/ground-control/index.js` mirror the `/api/v1/research-runs` controller
endpoints documented in `docs/API.md`; the tool description string is the
contract surface and enumerates the per-action required fields. The surface
addition is recorded in the ADR-054 amendment and the changelog fragment; no new
DOC_STYLE.md style rule is established.

The research decision-gate surfaces (GC-RSCH-F004/F034/N012/N013 / ADR-066 /
ADR-067 / ADR-068 / #1001) extend the same `gc_research_run` tool with nine
additional actions (`list_gate_decision_log`, `add_review_comment`,
`list_review_comments`, `resolve_review_comment`, `add_rationale`,
`list_rationale`, `create_disclosure`, `add_disclosure_entry`, `get_disclosure`)
and ten new Zod enum mirrors in `mcp/ground-control/lib.js`, mirroring the new
`/api/v1/research-runs/{id}/{gates/decision-log,review-comments,rationale,disclosure}`
endpoints documented in `docs/API.md`. The surface addition is recorded in the
ADR-054 amendment and the changelog fragment; no new DOC_STYLE.md style rule is
established.

The `.ground-control.yaml` routing parser in `mcp/ground-control/lib.js`
accepts the single provider id `claude`. Per the convention above, changes to
that parser are recorded in an amendment to ADR-054, not a documentation edit;
the documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`,
and `.vale.ini` are unchanged and no new DOC_STYLE.md style rule is
established.

The `gc_admin` `create_project` `type` enum in `mcp/ground-control/index.js`
and its `createProject` client-helper doc comment in `mcp/ground-control/lib.js`
no longer offer `GRC` (issue #1385): the value is a legacy read-only project
type per ADR-089 §4, rejected at creation by `ProjectService.create` and already
documented as `SOFTWARE | RESEARCH` in `docs/API.md`. Per the convention above,
tightening that tool-input enum is recorded in an amendment to ADR-054 and the
changelog fragment, not a documentation edit; the documentation-coverage
classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are
unchanged and no new DOC_STYLE.md style rule is established.

Repository identity (`<owner>/Ground-Control`) is derived from the checkout's
git `origin` remote by the MCP server (`mcp/ground-control/lib.js`, `index.js`,
`gc-integrate.js`), with `.ground-control.yaml` `github_repo` and any caller
`repo` treated as validated assertions, and is pinned across active surfaces by
the `run_repo_identity_drift` policy gate in `tools/policy/checks.py` (issue
#1383, GC-P026). Per the convention above, those MCP-behavior and policy-gate
changes are recorded in an amendment to ADR-054 and the changelog fragment, not
a documentation edit; the documentation-coverage classifier, Vale rule set,
`tools/install-vale.sh`, and `.vale.ini` are unchanged and no new DOC_STYLE.md
style rule is established.

The `threats-insufficient-effectiveness` action on the `gc_risk_control_mapping`
tool, and its `as_of` / `min_effectiveness` / `freshness_window_days` parameters,
were removed from `mcp/ground-control/index.js` and the backing
`getThreatsInsufficientEffectiveness` helper was removed from
`mcp/ground-control/lib.js` (issue #1309, ADR-084 §5): the action called a REST
route that `RiskControlAnalysisController` never exposed (ADR-089/V199 retired
the composed GRC surface without ever wiring this one), and its `as_of`
parameter was the last surviving divergent as-of surface in the repo. Per the
convention above, retiring a dead tool-input surface is recorded in an
amendment to ADR-054, not a documentation edit; the documentation-coverage
classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are
unchanged and no new DOC_STYLE.md style rule is established.

The `/implement` execution-contract policy check added for issue #1416 records
its workflow contract in ADR-021, ADR-027, ADR-029, ADR-031, ADR-036, and the
corresponding workflow documentation. Its MCP descriptions must name every
enforced tool input and remain covered by the live description-parity test.
This follows the existing convention for policy additions: the owning ADRs
define behavior, while this document records the documentation obligation.

The issue #1416 review hardening of the same MCP surfaces (launch-time
workspace/origin binding, sanitized checkout, server-owned pickup writes,
permission-checked obligation signers, structured `wontfix` authorization, and
redacted branch results) is documented by the existing ADR-029, ADR-036, and
ADR-054 amendments plus `docs/DEVELOPMENT_WORKFLOW.md`; it does not add a new
documentation style rule.

The issue #1416 risk-proportionate verification correction is likewise a
workflow-contract clarification documented in those workflow ADRs and docs;
it changes no documentation classification or style rule.

The issue #1426 `gc_implement_mechanical` registration follows the same
tool-surface convention: the public inputs are documented in the MCP README
and description-parity test, while the execution contract is synchronized in
ADR-021, ADR-029, ADR-031, ADR-036, ADR-054, and the workflow documents. It
changes no documentation classification, Vale rule, or style rule.

The issue #1414 review-coverage change follows the same tool-surface
convention: the new `diff_mode` and `review_coverage` output fields are
documented in the MCP README and the tool descriptions, while the workflow
contract is synchronized in ADR-021, ADR-029, ADR-031, ADR-036, ADR-054, and the
workflow documents. It changes no documentation classification, Vale rule, or
style rule.

The issue #1467 file-size work establishes no new style rule. It adds a
repo-native gate (`tools/policy/file_size.py`, ADR-092) that fails `make policy`
on a tracked source file over 500 lines, and it splits the files that were over
it. The documentation classification, the `outcome_required` mapping, and the
Vale configuration are untouched; the only documentation change is the
enforcement section added to `docs/CODING_STANDARDS.md`.

The issue #1473 async mechanical-job change follows the same convention:
`async`, `idempotency_key`, and bounded `job_id` are documented in the MCP
README and live tool schemas; start-and-poll behavior is synchronized in
ADR-036, ADR-054, ADR-090, the implement/quickfix skills, and workflow
documentation. The existing documentation classifier, Vale configuration, and
style rules are unchanged.

The #1434 follow-up that auto-resolves an issue's sole in-scope requirement UID
for the mechanical repository gates (`authorizeRequestedRequirementUid` in
`mcp/ground-control/lib/codex-workflow-3.js`, re-exported by the
`mcp/ground-control/lib.js` barrel) follows the same convention: it changes the
requirement-governance environment carried into the gate subprocess, not any
reference-doc prose or contract surface. It changes no documentation
classification, Vale rule, or style rule.
