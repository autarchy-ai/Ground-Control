# ADR-054: Documentation coverage gate

## Status

accepted

## Date

2026-05-23

> **Sync note for issue #1303 (2026-09-11, surviving gate inventory):** The Python
> documentation-outcome check moved from the mixed version-mirror module to
> `tools/policy/documentation_coverage.py`; `tools/policy/checks.py` remains the compatibility
> barrel and the command-line entry point imports the check from its focused owner. The move keeps
> the fixture protocol, classifications, failure codes, and PR-body requirement unchanged while
> bringing both policy modules below the 500-line limit. The same issue strengthens CI topology,
> title-contract, action-pin, and version-mirror checks; those placements and their bypass models
> are documented in `docs/architecture/SURVIVING_GATES.md`. The MCP classifier, outcome mapping,
> Vale rules, installer, and `.vale.ini` are unchanged, and no documentation style rule is added.

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

> **Sync note for issue #650 (2026-09-05, post-re-platform documentation reconciliation):**
> The `config_parser` surface's `doc_targets` named
> `architecture/adrs/027-ground-control-yaml-context-contract.md`, an ADR filename that has
> never existed. A doc target that cannot resolve can never be satisfied, so that surface's
> documentation requirement had silently stopped being enforceable. The path is corrected to
> `architecture/adrs/027-agent-neutral-implement-workflow-packaging.md`, and a new case in
> `mcp/ground-control/lib.acquireknowledgelock.test.js` asserts every file-shaped `doc_targets`
> entry resolves against the real tree, so the class of defect cannot recur silently. The same
> change retires the documents whose subject the #1500 re-platform removed (`docs/API.md`, the
> `docs/deployment/`, `docs/frontend/`, and `docs/operations/` trees, the console design
> specification, the `/deploy` skill, the dead `tools/ground_control/` backend clients, and the
> `pack-registry-sync` workflow), and corrects
> `.github/branch-protection-baseline.json` plus `CI_STRICTNESS_REQUIRED_CONTEXTS`, which still
> required five contexts no workflow produces. The surface classes themselves, the
> `outcome_required` mapping, the Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are
> unchanged, and no new `docs/DOC_STYLE.md` style rule is established; `docs/DOC_STYLE.md`
> changes only to drop dead references and to mark its per-issue precedent log historical.

> **Sync note for issue #633 follow-up (2026-09-04, /integrate lane restored):** #1506 removed
> `mcp/ground-control/gc-integrate.js` and its `gc-integrate/*` modules as dead code after checking
> for callers in JS and finding none; the caller is `skills/integrate/SKILL.md`, which names tools in
> prose, so the sweep left GC-O011 (ACTIVE, MUST) with no entry point. The implementation and its
> nine test suites are restored unchanged, registered through a new `mcp/ground-control/tools/integrate.js`,
> and `mcp/ground-control/skill-tool-registration-contract.test.js` now asserts every `gc_*` name in
> any skill is a registered tool, so the prose-to-registration boundary is checked. The documentation
> coverage classifier, its surface classes, the `outcome_required` mapping, the Vale rule set,
> `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no `docs/DOC_STYLE.md` style rule is
> established.

> **Sync note for issue #633 (2026-09-04, MCP server identity and documentation):**
> Three corrections to how the MCP server describes itself. (1) `mcp/ground-control/index.js` reads
> the version it advertises in the `initialize` handshake from `mcp/ground-control/package.json`
> instead of a hard-coded `1.0.0` literal, so a tool-surface change can no longer ship without a
> semantic version bump; the package moved to 1.1.0 and `server-version.test.js` asserts the
> handshake matches it. (2) The PR-body renderer's pre-push review attestation became lane-aware:
> `gc_render_pr_body` takes `lane` and `pre_push_reviews`, and `_check_ground_control_checks` accepts
> either accurate attestation, so a `/quickfix` run with the reviewers off no longer claims they
> completed. The attestation stays mandatory. The PR-body policy surface moved to
> `mcp/ground-control/lib/pr-body-policy.js` to keep `runtime-primitives.js` under the 500-LOC gate.
> (3) `README.md` and the `index.js` environment header were rewritten against the registered
> surface; both still described the REST backend deleted by #1500 and the entity tools removed by
> #1506 - a required `GC_BASE_URL`, bearer tokens for `/api/v1/**`, the `GC_MCP_ADMIN` opt-in (read
> nowhere in the server), `gc_query`, and roughly 80 unregistered `gc_*` tools. None of this is a
> documentation-coverage extension: the classifier in `mcp/ground-control/lib/doc-coverage.js`, its
> surface classes, the `outcome_required` mapping, the Vale rule set, `tools/install-vale.sh`, and
> `.vale.ini` are unchanged, and no `docs/DOC_STYLE.md` style rule is established.

> **Sync note for issue #871 (2026-08-14, strict Sonar enforcement):** The SonarCloud workflow
> now runs the repository's zero-open-issues assertion after the hosted quality gate, including
> when that gate has already failed, and `run_sonar_strictness_contract` prevents either boundary
> from being removed or reordered. The policy package keeps `tools/policy/checks.py` as a dynamic
> compatibility barrel while implementations remain in focused modules, including the extracted
> implement scope/completion check. This is a CI and policy enforcement change. The documentation
> coverage classifier, outcome mapping, Vale rules, installer, and `.vale.ini` are unchanged, and
> no documentation style rule is established.

> **Sync note for issue #1506 (2026-08-09, dead GRC handler removal):** Removed the ~63
> unregistered GRC/backend tool handlers left over from the #1500 teardown—the top-level
> `gc-asset.js`, `gc-audit.js`, `gc-control.js`, `gc-evidence.js`, `gc-finding.js`,
> `gc-identity-admin.js`, `gc-integrate.js`, `gc-observation.js`, `gc-query.js`,
> `gc-research-provenance.js`, `gc-research-operation-authorization.js`, `gc-risk-governance.js`,
> `gc-risk-scenario.js`, `gc-threat-model.js`, `gc-workflow-run.js`, `gc-workflow-run-ingest.js`,
> `link-create.js` tool-handler modules (none registered a tool `tools/*.js` calls), their fixture
> tests, and the dead REST-wrapper functions inside `mcp/ground-control/lib/api-controls-2.js`,
> `lib/api-controls-3.js` (deleted), `lib/api-history.js` (deleted), `lib/api-workflow-run.js`,
> `lib/assert-completion.js`, `lib/assert-traceability.js`, `lib/sonar-watcher.js`, and
> `lib/pr-body.js`, plus `mcp/ground-control/index.js`'s ~290-line dead import block. Every removed
> export was verified to have zero callers anywhere in the live MCP surface, including
> barrel-mediated imports through `lib.js`, before deletion. This is a dead-code removal, not a
> documentation-coverage extension: the classifier in `mcp/ground-control/lib/doc-coverage.js`, the
> surviving surface classes, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`,
> and `.vale.ini` are unchanged, and no `docs/DOC_STYLE.md` style rule is established.

> **Sync note for issue #1437 (2026-07-30, Live Activity):** Added the project-scoped
> `GET /api/v1/workflow-runs/activity` read projection, its generated OpenAPI/TypeScript contract,
> deployment configuration, and console workspace. Documentation lives in ADR-061, `docs/API.md`,
> `docs/architecture/ARCHITECTURE.md`, and `docs/deployment/DEPLOYMENT.md`. This uses the existing
> `public_api`, `configuration`, and architecture coverage classes; the documentation-coverage
> classifier, `outcome_required` mapping, Vale rules, installer, and `.vale.ini` are unchanged, and
> no new documentation classification or style rule is established.

> **Sync note for issue #1462 (2026-07-28, completion project inference):** Added
> `resolveAssertProject` and structured `project_required` propagation in
> `mcp/ground-control/lib.js` so `gc_assert_traceability_reconciled` and
> `gc_assert_completion` infer `project` from `repo_path`'s
> `.ground-control.yaml` when the parameter is omitted, preserve backend
> `project_required` detail through the composite completion envelope, and
> updated the Step 17 contract in `skills/implement/steps/step-17-completion.md`
> plus tool descriptions in `mcp/ground-control/index.js`. This is MCP workflow
> error-propagation and repo-context reuse under ADR-027: the documentation-coverage
> classifier (`classifyChangedSurface`), the `outcome_required` mapping, the Vale
> rule set, `tools/install-vale.sh`, `.vale.ini`, and the `docs/DOC_STYLE.md`
> style rules are all unchanged, and no new documentation-coverage surface class
> is introduced.

> **Sync note for issue #1282 (2026-07-27, identity administration):**
> Registered the non-secret `gc_identity_admin` MCP tool and its identity API
> client helpers. Extended the authorization path-matrix policy check so it
> verifies both legacy `ROLE_ADMIN` matchers and the new
> `PERMISSION_IDENTITY_ADMIN` matcher against
> `contracts/authz/path-matrix.yaml`. The REST and MCP contracts are documented
> in `docs/API.md`, `docs/architecture/ARCHITECTURE.md`,
> `mcp/ground-control/README.md`, ADR-035, and amended ADR-085. The
> documentation-coverage classifier, `outcome_required` mapping, Vale rules,
> installer, and `.vale.ini` are unchanged; no new documentation classification
> or style rule is established.

> **Sync note for issue #1309 (2026-07-17, ADR-084 §5 Envers as-of spine):**
> Removed the dead `threats-insufficient-effectiveness` action (and its
> `as_of` / `min_effectiveness` / `freshness_window_days` parameters) from the
> `gc_risk_control_mapping` tool in `mcp/ground-control/index.js`, and the
> backing `getThreatsInsufficientEffectiveness` helper from
> `mcp/ground-control/lib.js`. The action called a REST route that
> `RiskControlAnalysisController` never exposed; it was the last surviving
> divergent as-of surface (ADR-084 §5: the canonical as-of coordinate is the
> Envers revision, resolved by the new `AsOfRevisionResolver`; see
> `docs/architecture/ARCHITECTURE.md` § As-Of Time Semantics). This is a
> policy-surface removal, not an extension: the documentation-coverage
> classifier, `outcome_required` mapping, Vale rule set,
> `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new
> `docs/DOC_STYLE.md` style rule is established.

> **Sync note for issue #1308 (2026-07-15, graph enum contract):** Added
> `GraphEntityType` to the existing ADR-034 `ENUM_CONTRACT_INVENTORY`, so
> `make policy` checks the backend enum against the generated TypeScript union
> and `GRAPH_ENTITY_TYPES` constant. The graph contract and consumer guidance
> lives in ADR-034, ADR-084, `docs/DEVELOPMENT_WORKFLOW.md`, and
> `docs/architecture/ARCHITECTURE.md`. The documentation-coverage classifier,
> `outcome_required` mapping, Vale rules, `tools/install-vale.sh`, `.vale.ini`,
> and this ADR's coverage model are unchanged; no new `docs/DOC_STYLE.md` style
> rule is established.

> **Sync note (2026-07-14, policy diff-base merge-base fix):** Fixed the `base`
> arm of `read_changed_files` in `tools/policy/checks.py` to scope the diff to
> `merge-base(base, HEAD)` (new `merge_base_or` helper) instead of the two-dot
> `git diff <base> --`. Two-dot compares the tip of `base` against the working
> tree, so any commit `base` gains after a branch forks is attributed to the
> branch. On a busy repo where `dev` advances mid-PR, the diff-scoped gates
> (this documentation-coverage gate, the changelog-fragment gate, and
> enum/controller parity) fire on files the branch never touched (observed on
> PR #1393). The merge-base scope matches GitHub's own PR diff. The working-tree
> comparison is preserved so the local and pre-push path still catches
> uncommitted changes, and the helper falls back to `base` when no common
> ancestor exists. This is a
> policy-tooling correctness fix, not a documentation-classifier change: the
> documentation-coverage classifier, `outcome_required` mapping, Vale rule set,
> `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new
> `docs/DOC_STYLE.md` style rule is established.

> **Sync note for issue #1307 (2026-07-14, ontology binding gate):** Added
> `tools/policy/checks.py::run_ontology_binding_check` to validate the three
> ADR-084 ontology contracts and compare their surface-qualified bindings with
> an independently discovered Java graph-vocabulary inventory. The policy
> surface is documented in ADR-084, `docs/DEVELOPMENT_WORKFLOW.md`, and
> `contracts/CHANGES.md`. The documentation-coverage classifier,
> `outcome_required` mapping, Vale rules, `tools/install-vale.sh`, `.vale.ini`,
> and this ADR's coverage model are unchanged; no new `docs/DOC_STYLE.md` style
> rule is established.

> **Sync note for issue #1500 (2026-08-03, context-graph teardown):** The backend, frontend, and database were removed; Ground Control is now the MCP server over repo-local files. Two documentation-coverage surface classes lost their subjects and were dropped from the classifier in `mcp/ground-control/lib/doc-coverage.js`: `public_api` (anchored on `backend/src/main/java/.../api/`) and `user_visible` (anchored on `frontend/src/`). The surviving classes are `workflow`, `mcp_tool`, `config_parser`, `policy`, `adr`, and `doc`. The Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and the `outcome_required` mapping for the surviving classes are unchanged, and no new `docs/DOC_STYLE.md` style rule is established.
>
> **Sync note for issue #1359 (2026-07-12, remove Temporal orchestration lane):** Deleted the `/api/v1/workflow-executions**` REST surface (`WorkflowExecutionController`/`WorkflowExecutionService`/`WorkflowControlPort`/`TemporalWorkflowControlAdapter`) and the `gc_workflow_execution` MCP tool (`start`/`get`/`list`/`signal`, handler `mcp/ground-control/gc-workflow-execution.js`) together with its API-client helpers and field mappings in `mcp/ground-control/lib.js`/`index.js`; removed `infrastructure/temporal/**` (worker config, control adapter, `/implement` workflow and activities, activity-payload contract records) and `domain/workflowexecution/**`; removed `domain/llm`/`infrastructure/llm` including the Anthropic adapter, so `ROUTING_PROVIDERS` reverts to `["claude"]` and the canonical `anthropic` provider id and `claude`→`anthropic` normalization are gone; and dropped the `run_workflow_payload_contract_check`, `run_gate_set_invariant_check`, and `deploy-temporal-topology` policy checks from `tools/policy/checks.py` along with the `contracts/schemas/workflow/` activity-payload schemas (the ADR-061 `workflow-run-record.v1.schema.json` telemetry schema is unaffected). ADR-028, ADR-081, and ADR-088 are marked Superseded (issue #1359) in `architecture/adrs/README.md`; the run-economics surface this issue does not touch (`workflow_run`, ADR-061 telemetry, `gc_workflow_run`/`gc_workflow_run_ingest`, ADR-036 per-step routing, ADR-029 issue-thread gates) is unchanged. This is a policy-surface, MCP tool-surface, public-API, and infrastructure removal: the documentation-coverage classifier, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new `docs/DOC_STYLE.md` style rule is established.
>
> **Sync note for issue #1429 (2026-07-26 configuration-derived policy command):** Added `workflow.policy_command` to the `.ground-control.yaml` parser in `mcp/ground-control/lib.js` (`emptyWorkflowConfig`, `normalizeWorkflowConfig`, new `DEFAULT_POLICY_COMMAND` / `resolveWorkflowPolicyCommand`), routed the two executable policy boundaries (`runImplementFinalTreeGates` and `gc_implement_mechanical action=verify`) through it, and replaced the PR body's hardcoded `` `make policy` `` check line with the semantic `- [x] Configured repository policy command passes` in `buildPrBody` / `checkPrBodyShape` / `tools/policy/checks.py::check_pr_body` / `.github/PULL_REQUEST_TEMPLATE.md`. The same change adds `workflow.precommit_command` (normalized default `pre-commit run --all-files`) and routes `runImplementPreCommit` plus the `gc_implement_mechanical action=publish` hook boundary through it, so the mandatory pre-publish boundary no longer requires the pre-commit framework specifically. The `tools/policy/checks.py` edit is a token update to the existing `/implement` verification-surface drift check, not a new gate. This is a configuration-parser and workflow-gate change; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and `docs/DOC_STYLE.md` style rules are unchanged.

> **Sync note for issue #1438 (2026-07-27, versioned measurement contract and station catalogue):** Added `run_measurement_catalogue_check` to `tools/policy/checks.py` (plus `STATION_CATALOGUE_PATH`, `MEASUREMENT_RECORD_SCHEMA_PATH`, and three new schema/data entries in `CONTRACT_REQUIRED_PATHS`), which asserts the ADR-090 station catalogue is internally coherent and that every station id emitted by `gc-implement-mechanical.js`, every `gc:phase` marker value, and every `.ground-control.yaml` routing stage resolves to a declared entry. This is a new contract-drift gate over data artifacts under `contracts/`: the documentation-coverage classifier (`classifyChangedSurface`), the `outcome_required` mapping, the Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and the `docs/DOC_STYLE.md` style rules are all unchanged, and no new documentation-coverage surface class is introduced.
>
> **Sync note for issue #1436 (2026-07-27, live workflow-run SSE transport):** The `mcp/ground-control/lib.js` edit is a single guard in the shared `request()` helper: a response whose `content-type` is `text/event-stream` is rejected as `unsupported_media_type` before `res.text()` is called, because reading a live event stream never resolves and would hang the MCP server rather than fail. `mcp/ground-control/gc-query.js` denylists the new `/api/v1/workflow-runs/stream` path, which the existing `/api/v1/workflow-runs` prefix allowlist would otherwise have admitted, and `mcp/ground-control/gc-workflow-run.js` records that the stream is deliberately not an MCP action. This is an HTTP-client and read-allowlist change: the documentation-coverage classifier (`classifyChangedSurface`), the `outcome_required` mapping, the Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and the `docs/DOC_STYLE.md` style rules are all unchanged, and no new documentation-coverage surface class is introduced.
>
> **Sync note for issue #1435 (2026-07-26, live workflow-run lifecycle emission):** Added an optional `signal` pass-through to the shared `request()` helper in `mcp/ground-control/lib.js` (so a fail-open emitter can bound its own writes), threaded it through `createWorkflowRun`/`recordWorkflowRunEvent`, and added the `listWorkflowRunEvents` client for the new project-scoped `GET /api/v1/workflow-runs/{runId}/events` read. The new emitter module `mcp/ground-control/workflow-run-lifecycle.js` and `mcp/ground-control/gc-implement-mechanical.js` were added to ADR-090's `measurement-model-sync` trigger. This is an HTTP-client and telemetry-emitter change: the documentation-coverage classifier (`classifyChangedSurface`), the `outcome_required` mapping, the Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and the `docs/DOC_STYLE.md` style rules are all unchanged, and no new documentation-coverage surface class is introduced.
>
> **Sync note for issue #1280 (2026-07-11 GC-O009 phase 5 LLM provider boundary):** Changed `ROUTING_PROVIDERS`, added `ROUTING_PROVIDER_ALIASES`/`normalizeProviderId`, and updated `normalizeRoutingConfig`/`normalizeRoutingStageConfig`/`resolveWorkflowRouteFromConfig` in `mcp/ground-control/lib.js` so the canonical LLM provider id `anthropic` is accepted and the legacy label `claude` normalizes to it in every output (ADR-027 amendment). This is the `.ground-control.yaml` routing parser, not the documentation-coverage gate; the documentation-coverage classifier, outcome mapping, Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and `docs/DOC_STYLE.md` style rules are unchanged.
>
> **Sync note for issue #1468 (2026-07-28, ADR-091 frontend lane amendment):** `tools/policy/checks.py::CI_STRICTNESS_REQUIRED_CONTEXTS` gained the `frontend` context for the new CI lane that runs Biome lint, the Vitest unit suite, and the frontend build. `frontend` is also added to `.github/branch-protection-baseline.json` and to `docker.needs`, and `tools/tests/test_ci_topology.py` gains frontend-specific invariants covering the job's existence, its read-only permissions, and its lint/test/build steps. Before this the frontend was compiled only inside the Docker image build, which runs after merge and runs neither lint nor tests. This is a policy-surface extension on the CI strictness contract, not the documentation-coverage gate; the classifier, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new `docs/DOC_STYLE.md` style rule is established.

> **Sync note for issue #1461 (2026-07-28, ADR-091 CI verification topology):** `tools/policy/checks.py::CI_STRICTNESS_REQUIRED_CONTEXTS` dropped the `mutation` context. Commit `bf766bfe` removed the CI `mutation` job and `tools/mutation/` with the Contract-Locked Development track (see the CLD track drop note below), but left the context declared here and in `.github/branch-protection-baseline.json`, so `run_ci_strictness_contract` required a check that no job produced. Applying the baseline as written would have blocked every pull request on `main` and `dev`. The new `tools/tests/test_ci_topology.py` asserts that every required context has a job in `ci.yml` and that the baseline matches this constant, so the drift cannot recur. The same issue fixed a false green in `mcp/ground-control/lib.js::runWatchCiRun`, which watched only the newest workflow run for a branch and so could report an unrelated fast workflow's success as the CI gate; it now groups runs by head SHA and requires all of them to succeed (new `selectCiRunsForHeadSha` / `aggregateCiRunOutcomes` helpers, contract in the ADR-027 2026-07-28 amendment). This is a policy-surface removal that completes an earlier one plus a workflow-tool correctness fix, not a gate relaxation: the documentation-coverage classifier, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new `docs/DOC_STYLE.md` style rule is established.

> **Sync note for issue #1346 (2026-07-11, ADR-089 GRC retirement):** `tools/policy/checks.py::run_traceability_reconciliation_gate_contract` dropped its `next_issue_recommendation` prose anchors from the Step 20 and SKILL.md requirements (the field is retired), and `ENUM_CONTRACT_INVENTORY` dropped the seven enum-contract entries owned by the retired GRC surface (`ThreatEventKind`, `ThreatSourceRelevance`, `NistLikelihoodBand`, `NistImpactBand`, `NormalizedConcept`, `CrosswalkVocabularySurface`, `MethodologyFamily`); `VerificationStatus` and `AssuranceLevel` are unaffected. This is a policy-surface removal, not an extension: the documentation-coverage classifier, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new `docs/DOC_STYLE.md` style rule is established.

> **Sync note for issue #1279 (2026-07-10 GC-O009 (b) human gates):** Added `run_gate_set_invariant_check` to `tools/policy/checks.py` so `make policy` pins the operator-gate set to the closed catalog (`cancel` / `retryFrom` / `applyReviewCapDisposition`) across the workflow `@SignalMethod` contract, the `OperatorSignalType` enum, the `implement-signals.v1` schema, and the MCP `WORKFLOW_SIGNAL_TYPES` catalog, and fails if a plan/merge-approval gate is reintroduced (ADR-029). Documentation lives in ADR-088, `docs/API.md`, and the changelog fragment. This is a policy-surface extension; the documentation-coverage classifier, outcome mapping, Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and `docs/DOC_STYLE.md` style rules are unchanged.

> **Sync note for CLD track drop (issue #1296, 2026-07-10):** Removed the Contract-Locked Development enforcement gates from `tools/policy/checks.py` (`run_protected_path_authority_check`, `run_module_graph_boundary_check`, `run_mutation_gate_contract`, and their helpers), the CI `mutation` job, `tools/mutation/`, `architecture/registry/`, the backend `RegistryBoundaryArchitectureTest`, the oracle-battery scaffolds, and the `gc_post_design_authority_approval` MCP tool. The CLD milestone (#1296 through #1299) was dropped as premature optimization; the reviewer anti-gaming prompt checklist is retained. This is a policy-surface and tooling removal: the documentation-coverage classifier, outcome mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no `docs/DOC_STYLE.md` style rule changed.

> **Sync note for issue #1294 (2026-07-05 GC-CLD-5):** Added `run_protected_path_authority_check` to `tools/policy/checks.py`, backed by `architecture/registry/protected-paths.json`, so `make policy` distinguishes protected contract, oracle, policy, workflow, and registry paths from ordinary implementation paths. Mixed implementation plus protected-path diffs require a scope-bound design-authority approval marker posted through the new `gc_post_design_authority_approval` MCP tool, and the same check treats oracle-battery weakening, such as skipped tests or lowered mutation thresholds, as protected-path approval work. Once the registry exists on the base branch, PR CI reads protected selectors and approvers from the base branch rather than from the PR head, passes sanitized PR comments into policy without exposing `GH_TOKEN` to PR-head Python, and requires an out-of-band MCP approval grant before posting approval markers. Documentation lives in `docs/DEVELOPMENT_WORKFLOW.md`, ADR-087, and the protected-path registry. This is a policy-surface and workflow-gate extension; the documentation-coverage classifier, outcome mapping, Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and `docs/DOC_STYLE.md` style rules are unchanged.

> **Style sync for issue #751 (2026-06-14):** Repository-wide Vale cleanup normalized punctuation in documentation prose. This ADR's documentation coverage gate stays the same.

> **Sync note for issue #1276 (2026-07-05 GC-O009 Temporal infrastructure):** Extended `tools/policy/checks.py::run_deploy_artifact_consistency` with the `deploy-temporal-topology` guard for the required `temporal-db`, `temporal`, and `temporal-worker` production compose services, pinned Temporal images, SQL visibility database wiring, Tailscale-bound gRPC port, health checks, and resource limits. Documentation lives in `deploy/docker/README.md`, `docs/deployment/DEPLOYMENT.md`, `docs/operations/backup-restore.md`, and `docs/DEVELOPMENT_WORKFLOW.md`. This is a deploy-policy-surface extension; the documentation-coverage classifier, outcome mapping, Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and `docs/DOC_STYLE.md` style rules are unchanged.

> **Sync note for issue #1293 (2026-07-04 GC-CLD-4):** Added `run_mutation_gate_contract` to `tools/policy/checks.py` so `make policy` verifies the CLD mutation gate runner, registry schema, CI mutation job, pull-request base-ref scoping, report artifact, and branch-protection context. Documentation lives in `docs/DEVELOPMENT_WORKFLOW.md`, ADR-087, and the mutation registry README. This is a policy-surface extension; the documentation-coverage classifier, outcome mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged. No new `docs/DOC_STYLE.md` style rule is established.

> **Sync note for issue #1275 (2026-07-04 GC-O014 contract surface foundation):** Extended `tools/policy/checks.py` with contract-surface policy checks for the committed `contracts/` artifact set, the generated frontend API type shim, JSON Schema invariant enforcement metadata, and authorization path-matrix synchronization with `ApiPathMatrix`. The new executable surfaces are documented in `docs/DEVELOPMENT_WORKFLOW.md`, `docs/architecture/ARCHITECTURE.md`, and ADR-082, with generated artifacts under `contracts/`. This is a policy-surface extension covered by the existing `tools/policy/checks.py` trigger path; the documentation-coverage classifier, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and `docs/DOC_STYLE.md` style rules are unchanged.

> **Sync note for issue #1008 (2026-07-03 GC-RSCH-R005 / ADR-086):** Registered the `gc_research_operation_authorization` MCP tool (handler `mcp/ground-control/gc-research-operation-authorization.js`; actions `request` / `decide` / `consume` / `list` / `get`) and its API-client helpers plus the research egress-policy enum constants in `mcp/ground-control/lib.js`, backed by the new `/api/v1/research-runs/{runId}/operation-authorizations/**` REST surface for research high-risk operation authorization; the `gc_research_run` `start` snapshot and `gc_research_run` intake surface also carry the new run-policy fields. Two MCP OpenAPI write-contract rows (`request` → `OperationAuthorizationRequest`, `decide` → `OperationAuthorizationDecisionRequest`) were added to `mcp/ground-control/openapi-contract.test.js`. Documentation lives in `docs/API.md`, `docs/architecture/ARCHITECTURE.md`, `docs/research/RESEARCH_WORKFLOW.md`, and ADR-086. Curated writes mirror REST; run-scoped reads also route through the existing `gc_query` `/api/v1/research-runs` allow-list (no allowlist change). No new documentation coverage surface class, Vale rule, `.vale.ini` setting, or style rule changed.

> **Sync note for issue #1118 (2026-06-28):** Added the `gc_architecture_model` MCP tool, architecture-model API helpers, `/api/v1/architecture-models` read allowlist entry, and MCP OpenAPI contract rows for the new architecture-model snapshot request. Documentation lives in `docs/API.md`, `docs/architecture/ARCHITECTURE.md`, `mcp/ground-control/README.md`, and ADR-035. No new documentation coverage surface class, Vale rule, `.vale.ini` setting, or style rule changed.

> **Sync note for issue #1107 (2026-06-14):** The `gc_requirement` history/timeline reads gained an `expand` passthrough (MCP `lib.js`/`index.js`) so callers can fetch full, untruncated audit-diff field values; the new audit-diff API surface is documented in `docs/API.md`. The `classifyChangedSurface` surface vocabulary and `outcome_required` mapping are unchanged.

> **Sync note for issue #1106 (2026-06-15):** The MCP–backend write-contract drift gate exported `TO_CAMEL` / `OPAQUE_VALUE_KEYS` from `mcp/ground-control/lib.js` and corrected the drifted `GOVERNANCE_FIELDS` allowlists (consumed by the new `mcp/ground-control/openapi-contract.test.js`), and fixed the `gc_control` / `gc_asset` / `gc_risk_governance` adapter field allowlists and Zod shapes to match the backend DTOs. No new public `gc_*` tool is registered; the `classifyChangedSurface` surface vocabulary, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged. The new gate's own documentation lives in `docs/DEVELOPMENT_WORKFLOW.md`, `mcp/ground-control/README.md`, and the ADR-034 amendment.

> **Sync note for issue #1180 (2026-06-18):** Added optional `short_code` field to `.ground-control.yaml` config parsing (`parseGroundControlYaml` in `mcp/ground-control/lib.js`): validated as uppercase alphanumeric 1–8 characters, absent defaults to null, surfaced via `getRepoGroundControlContext`. The implement-workflow skills (`step-01-issue-branch-resolution.md`, `step-20-close-issue-on-merge.md`) were updated to rename the tmux session when `$TMUX` is set and `cfg.short_code` is non-null. No new public `gc_*` tool is registered; the `classifyChangedSurface` surface vocabulary and `outcome_required` mapping are unchanged.

> **Sync note for issue #1117 (2026-06-28):** Added `grc.boundaries` parsing to `.ground-control.yaml` context in `mcp/ground-control/lib.js`, extended `gc_derivation` with declared-boundary forwarding and `get_boundary_model`, and documented the REST/MCP boundary-model readback in `docs/API.md`, `docs/DEVELOPMENT_WORKFLOW.md`, `docs/architecture/ARCHITECTURE.md`, and `mcp/ground-control/README.md`. No new documentation coverage surface class, Vale rule, `.vale.ini` setting, or style rule changed.

> **Sync note for issue #1176 (2026-06-15):** Extended `tools/policy/checks.py::ENUM_CONTRACT_INVENTORY` with three new enum-contract entries (`VerificationStatus`, `AssuranceLevel`, `MethodologyFamily`) so ADR-034's enum-mirror gate covers GRC verification enums. Added corresponding TypeScript union types and constant arrays to `frontend/src/types/api.ts`, mirrored the enum values at the MCP layer, and updated MethodologyProfile interface field types from string to MethodologyFamily per ADR-034. The classifier, Vale rules, `.vale.ini`, and `docs/DOC_STYLE.md` style rules are unchanged.

> **Sync note for issue #1005 (2026-06-29):** Modified the `select_methodology` and `record_methodology_source` action schemas in `mcp/ground-control/index.js` to close the GC-RSCH-F006 methodology source coverage vacuous-pass hole: `record_methodology_source` lost `source_required` (boolean - required sources are now snapshotted immutably at selection time) and `select_methodology` gained `required_source_refs` (optional string array, 500-character limit per element). The `classifyChangedSurface` surface vocabulary, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

## Context

Changes that modify workflow behavior, MCP tool surfaces, config parsing,
policy, ADRs, public APIs, or user-visible behavior require corresponding
documentation updates. Without a mechanical gate, documentation drifts from
the code it describes. The `workflow.pr_title` block in `step-09-pr-body.md`
referenced a config key that `normalizeWorkflowConfig` did not parse, and this
went undetected until issue #896.

Three checks need to hold at the end of every `/implement` run:

1. The changed-surface classifier identifies which documentation targets are
   in scope.
2. The PR body and final report carry a structured `documentation_outcome`
   field recording what happened: docs updated, docs verified unchanged, or
   docs intentionally not updated with an authorized rationale.
3. The prose quality of any modified docs meets the project style standard
   (Google Developer Documentation Style Guide for voice; Diátaxis for
   structure).

ADR-027 establishes `.ground-control.yaml` and `gc_get_repo_ground_control_context`
as the agent-neutral config contract. ADR-029 mandates that durable evidence
belongs in the PR and issue-thread records, not in optional free-form summaries.
ADR-036 requires deterministic renderers for PR bodies and final reports so
omissions are visible at the tool boundary.

## Decision

A documentation coverage gate is added to the `/implement` workflow with three
executable layers:

**Layer 1: changed-surface classifier (`classifyChangedSurface` in lib.js).**
A closed-vocabulary function maps repo paths to surface classes and documentation
targets. Surface classes: `workflow`, `mcp_tool`, `config_parser`, `policy`,
`adr`, `public_api`, `user_visible`, `doc`, `unclassified`. When any path
classifies as one of the first five non-doc surfaces, `outcome_required` is
true and the PR body must carry a `documentation_outcome` field.

**Layer 2: structured outcome field in PR body and final report.**
`validatePrBodyInput` and `validateFinalReportInput` accept an optional
`documentation_outcome: { outcome, rationale? }` field. The outcome enum is
closed: `updated`, `verified_unchanged`, `not_updated_authorized`. Only the
third value permits a rationale string (1-2000 characters); the other two
reject it (strict). When `outcome_required` is true and the field is absent,
the renderer rejects the input rather than posting an incomplete record.

**Layer 3: Vale prose linter wired into `make policy` and CI.**
Vale with the `errata-ai/Google` package enforces the Google Developer
Documentation Style Guide on docs modified in the current diff. The binary is
pinned to a specific version, verified by SHA-256 checksum, and installed by
`tools/install-vale.sh` to `.tools/vale/` (gitignored). Both `make policy` and
the CI policy job install Vale automatically on first need rather than
skipping; agents and contributors do not bypass the gate by virtue of a fresh
clone.

**House-style overrides (`GoogleProject/` namespace).** The `.vale/styles/GoogleProject/`
directory is the registry for project-specific rules that augment the upstream
`errata-ai/Google` package. The first such rule is `EmDashDensity`: an
occurrence-based check scoped to paragraph, `max: 1`, `level: error`, that
flags paragraphs containing more than one em-dash. The rule pairs with the
em-dash density guidance in `docs/DOC_STYLE.md §Em-dash density` and runs at
error level so the on-touch ratchet enforces density compliance the same way
it enforces every other Google rule: any doc touched in a PR must satisfy the
budget. Future house-style overrides (passive-voice budget, sentence length,
hedging patterns) land as sibling YAML files in the same
namespace with no additional plumbing.

**Scope: whole file on first touch.** Vale lints any `.md` / `.markdown` file
that appears in the current diff (added, copied, modified, or renamed vs the
base ref) in its entirety, not line-by-line. A one-line edit to a previously
untouched document brings the whole file into scope; all of its style
violations must be fixed in that PR. Untouched docs are not linted. This
"ratchet on touch" produces a finite migration trajectory: each touched file
becomes permanently compliant, and the codebase converges as docs are edited
in the normal course of work. Line-range / hunk-aware linting, for example
via reviewdog, was considered and rejected; it permits prose rot to persist in
touched files indefinitely.

The canonical documentation style is: Google Developer Documentation Style
Guide for voice, tense, and concision; Diátaxis (`tutorial / how-to / reference
/ explanation`) for structure. Docs describe the system as it ships on the
current commit. Roadmaps, phase tables, and forward guidance belong in tracking
issues.

A new MCP tool `gc_documentation_coverage` exposes the classifier to agents:
input `{ repo_path, changed_paths[] }`, output
`{ ok, classifications[], outcome_required, suggested_doc_targets[] }`.

**MCP-surface additions are classified `mcp_tool`.** New `gc_admin` actions
(for example `replace_research_intake` in issue #999) or any future
`gc_*` tool registered in `mcp/ground-control/index.js` inherit the existing
`mcp_tool` classification on path basis; the closed-vocabulary classifier
does not need an update per-action. The gate-sync rule
(`doc-coverage-gate-sync` in `architecture/policies/adr-policy.json`) fires
whenever the listed trigger paths change so this ADR and `DOC_STYLE.md` stay
current with the actual classifier surface.

## Consequences

- PRs that modify a classified surface must supply `documentation_outcome` or
  the PR-body renderer rejects the input.
- `not_updated_authorized` requires a bounded rationale string; silent omission
  is not possible.
- Vale failures gate `make policy` on docs modified in the diff.
- The `workflow.pr_title` parser gap is fixed as the concrete drift example
  this gate exists to prevent.
- Existing docs migrate organically when modified; no bulk rewrite is required.
- The doc-target map is data-driven: adding a new surface class is a single
  table edit in `classifyChangedSurface`.

## Alternatives considered

- **Prose-only enforcement** (skill instructions telling the agent to check
  docs): rejected. Prose instructions cannot be mechanically verified and
  accumulate silent drift. The preflight note for this issue explicitly
  prohibits "a broad natural-language style reviewer as the enforcement layer."
- **Separate database table for documentation state**: rejected per the
  preflight non-goals. The PR body and final report are the durable records
  (ADR-029); a second store would create reconciliation problems.
- **Lint the whole doc tree on every run**: rejected. Bulk rewrites risk losing
  intent in existing prose. Diff-scoped linting achieves organic migration
  without the risk.
- **Hunk-aware linting (reviewdog or line-range Vale)**: rejected. Reduces the
  migration cost of touching old docs but lets pre-existing prose rot stay
  in touched files forever, defeating the ratchet. Whole-file-on-touch is the
  deliberate cost.
- **Graceful skip when Vale is not installed locally**: rejected. Lets agents
  and contributors commit unlinted prose on fresh clones, which is the
  failure mode the gate exists to prevent. `make policy` and the CI policy job
  install Vale via `tools/install-vale.sh` on first need.

## References

- ADR-027: `.ground-control.yaml` and `gc_get_repo_ground_control_context` are
  the agent-neutral config contract.
- ADR-029: The GitHub issue thread is the durable workflow record.
- ADR-036: Per-step routing, deterministic record-rendering tools, and
  per-step telemetry.
- Issue #896: Enforce documentation coverage + style as an explicit workflow
  step.
- Issue #863 / GC-T004 C8: extended the MCP `gc_risk_governance` Zod shape and
  the `TO_CAMEL` map in `mcp/ground-control/lib.js` for typed reassessment
  triggers and the `reassessment_required_at` response field. The change is
  an additive surface extension governed by the same gate; the underlying
  classifier already covered `mcp/ground-control/lib.js` as a `config_parser`
  surface, so no classification update was needed.
- Google Developer Documentation Style Guide: https://developers.google.com/style
- Diátaxis: https://diataxis.fr/
- Vale: https://vale.sh/
- errata-ai/Google Vale package: https://github.com/errata-ai/Google

## Amendments

### Issue #1355 (2026-07-28): the gate's implementation moved out of lib.js

`mcp/ground-control/lib.js` exceeded the repo's 500-LOC limit by a factor of forty, so it
was split into `mcp/ground-control/lib/*` with `lib.js` retained as a barrel. This gate's
implementation (`gc_documentation_coverage`, the surface classifier, and the doc-target
mapping) now lives in `mcp/ground-control/lib/doc-coverage.js`.

Nothing about the gate's behaviour changed: the surface classes, the `outcome_required`
mapping, and every doc target are identical, and the split is verified behaviour-neutral by
the unchanged test suite.

The consequence worth recording is for the *checks that read this surface*. Several policy
checks located the gate by reading `mcp/ground-control/lib.js` as a single file. After the
split that file holds only re-exports, so those checks would have found no implementation
and passed silently: a gate reporting green because it was looking at the wrong file.
`tools/policy/checks.py::read_mcp_library` now returns the barrel plus every extracted
module, and each content check reads that instead of one path.

**2026-07-13 (env-template orphan-key invariant - issue #1384, GC-P023).** Extended `run_deploy_artifact_consistency` in `tools/policy/checks.py` with a reverse template-to-consumer check (violation code `deploy-env-template-orphan-key`, helpers `_run_env_template_consumer_check`, `_env_template_keys`, `_compose_consumed_names`, `_schema_consumed_names`, `_spring_bound_prefixes`, `_literal_consumed_names`, inventory `ENV_TEMPLATE_CONTRACTS`). The existing check proved that every `${VAR}` the production compose dereferences is declared in `env.schema`; nothing proved the reverse, so a key could outlive the service that read it - which is exactly what the Temporal removal (#1359) left behind in `.env.example` and `deploy/docker/.env.example`. The new check fails `make policy` when an active env template advertises a key with no executable consumer, where the legitimate consumer surfaces are declared per template in `ENV_TEMPLATE_CONTRACTS` (compose interpolation and list-form inherit, `env.schema` directives with the ADR-026 credential/allowlist slots expanded, the deploy validator and script, `application*.yml` placeholders, the MCP client's `process.env` reads, and Spring relaxed binding onto a declared `@ConfigurationProperties` prefix). Two rules are load-bearing: a compose **literal** (`- GC_SERVER_PORT=8000`) pins the value and is not a consumer of the operator's, and the production template does not get the backend-application surface, because an `application.yml` placeholder is irrelevant to `/opt/gc/.env` unless compose forwards the value into the container. Tests, docs, superseded ADRs, and historical migrations are not consumers. This is a repo-native policy-surface addition anchored on GC-P023 clauses (a) and (e); the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-05 (issue #1295 GC-CLD-2 architecture-as-code registry).** Added the `run_module_graph_boundary_check` policy check to `tools/policy/checks.py` (with the `_validate_module_graph_registry`, `_module_for_path`, `_resolve_import_target`, and `_module_graph_authority_violations` helpers) and wired it into `main()`. The check validates `architecture/registry/module-graph.json`, asserts the registry is covered by a design-authority protected path, and fails frontend/MCP cross-module imports whose edge is absent from the registry's `allowed_edges`; the backend arm is `RegistryBoundaryArchitectureTest` (ArchUnit), which reads the same registry. This is a repo-native policy-surface addition: the user-facing reference lives in `architecture/registry/README.md` and `docs/DEVELOPMENT_WORKFLOW.md`, the contract in the ADR-087 §1/§3 amendment, and the temporal record in `changelog.d/1295.added.md`; `docs/DOC_STYLE.md`'s policy-surface sync note records the new check. The documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-30 (issue #1005 / ADR-078 backend methodology catalog).** Made the methodology catalog backend-owned, validated-on-load reference data (`backend/src/main/resources/research/methodology-catalog.yaml`) and derived the required-source set from it instead of the caller. The `gc_research_run` MCP tool's `select_methodology` action lost `method_label`, `profile_version`, `catalog_version`, and `required_source_refs` (now only `method_key`), and a new read action `list_methodology_catalog` (global; `GET /api/v1/research-runs/methodology/catalog`) was added in `mcp/ground-control/index.js` + `lib.js`. Updated the tool description strings, the OpenAPI write-contract row for `select_methodology`, and added a `list_methodology_catalog` contract check in `mcp/ground-control/openapi-contract.test.js`. `docs/API.md`, `docs/research/RESEARCH_WORKFLOW.md`, and the changelog document the new surface; a `make policy` drift check keeps the skill catalog mirror in sync. These are public-API and MCP-adapter surfaces covered by existing classifier trigger paths; the `classifyChangedSurface` surface vocabulary, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged. No new `docs/DOC_STYLE.md` style rule is established.

**2026-06-29 (issue #1119 GC-GRC-006 data classification lattice).** Added the project-scoped data classification lattice REST surface under `/api/v1/data-classification` (lattice get/replace/reset and a read-only evaluation endpoint), registered the action-multiplexed `gc_data_classification` MCP tool in `mcp/ground-control/index.js` with its handler module `mcp/ground-control/gc-data-classification.js` (actions: `get_lattice`, `set_lattice`, `reset_lattice`, `evaluate`), added the `getDataClassificationLattice` / `putDataClassificationLattice` / `resetDataClassificationLattice` / `evaluateDataClassification` API-client helpers plus the `grc.data_classification` config-block normalizer in `mcp/ground-control/lib.js`, and added the `/api/v1/data-classification` read prefix to `gc_query` (`gc-query.js`, `mcp/ground-control/README.md`, and ADR-035). Lattice writes are a thin passthrough over the admin-only backend endpoints; all lattice-soundness validation and the deterministic evaluation are enforced server-side. Documentation lives in `docs/API.md` (the Data Classification Lattice reference) and ADR-072. These are additive MCP tool-surface and config-parser registrations covered by the existing classifier trigger paths; the documentation-coverage classifier, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged. The `docs/DOC_STYLE.md` sync-note list records the new tool; no new style rule is established.

**2026-06-29 (issue #1118 GC-GRC-005 snapshot-list summary fix).** Changed the architecture-model snapshot list endpoint (`GET /api/v1/architecture-models/snapshots`) to return snapshot summaries (metadata and element/flow counts) via the new `ArchitectureModelSnapshotSummaryResponse`, instead of embedding every element of every historical snapshot, and dropped the per-snapshot element-state query; full element state stays behind `GET /snapshots/{id}` (a Codex pre-push blocking finding that did not land in the original merge). The MCP surface is a thin passthrough, so the `gc_architecture_model` tool description (`mcp/ground-control/gc-architecture-model.js`), the `listArchitectureModelSnapshots` client doc (`mcp/ground-control/lib.js`), and the tool registration comment (`mcp/ground-control/index.js`) were updated to record the summary/full split; `docs/API.md` documents the new summary response. These are public API and MCP-adapter surfaces covered by existing classifier trigger paths; the documentation-coverage classifier, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged. The `docs/DOC_STYLE.md` new-doc-shape guidance is generalized to note that changing an existing endpoint's response shape (not only adding a tool) requires a `docs/API.md` schema sync; no new style rule is established.

**2026-06-28 (issue #1118 GC-GRC-005 architecture model aggregate).** Added the server-side architecture-model aggregate REST surface under `/api/v1/architecture-models`, registered the `gc_architecture_model` MCP tool in `mcp/ground-control/index.js`, added architecture-model client helpers and enum mirrors in `mcp/ground-control/lib.js`, added the `/api/v1/architecture-models` read prefix to `gc_query`, and added `gc_architecture_model/create_snapshot` rows to the MCP OpenAPI write-contract inventory. Documentation lives in `docs/API.md`, `docs/architecture/ARCHITECTURE.md`, `mcp/ground-control/README.md`, and ADR-035. These are public API, MCP-adapter, config-parser, and write-contract inventory surfaces covered by existing classifier trigger paths; the documentation-coverage classifier, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and `docs/DOC_STYLE.md` style rules are unchanged.

**2026-06-28 (issue #1002 GC-RSCH-R004/N002/N004 research provenance ledger).** Registered the action-multiplexed `gc_research_provenance` MCP tool in `mcp/ground-control/index.js` (actions: `record_node`, `record_edge`, `list_nodes`, `list_edges`, `chain`) with its handler module `mcp/ground-control/gc-research-provenance.js` and the `recordResearchProvenanceNode` / `recordResearchProvenanceEdge` / `listResearchProvenanceNodes` / `listResearchProvenanceEdges` / `getResearchProvenanceChain` API-client helpers plus two new enum constant arrays (`PROVENANCE_NODE_KINDS`, `PROVENANCE_EDGE_RELATIONS`) in `mcp/ground-control/lib.js`. The tool is a thin REST passthrough over the new `/api/v1/research-runs/{runId}/provenance/**` controller endpoints (ADR-069); all write legality (run scoping with cross-project/run 404 concealment, self-edge and directed-cycle rejection, idempotent replay, rework supersession, bounded-summary content guard) is enforced server-side in `ResearchProvenanceService`. The run-scoped reads also remain reachable through the existing `gc_query` `/api/v1/research-runs` allow-list; the two write surfaces are covered by new `openapi-contract.test.js` drift rows (`record_node` → `ProvenanceNodeRequest`, `record_edge` → `ProvenanceEdgeRequest`). Documentation lives in `docs/API.md` (the Research Provenance Ledger reference) and the `index.js` tool description. These are additive MCP tool-surface registrations covered by the existing classifier MCP trigger paths; the `classifyChangedSurface` surface vocabulary, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged. The `docs/DOC_STYLE.md` sync-note list records the new tool; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-28 (issue #1001 GC-RSCH-F004/F034/N012/N013 research decision gates).** Extended the action-multiplexed `gc_research_run` MCP tool in `mcp/ground-control/index.js` with nine new actions (`list_gate_decision_log`, `add_review_comment`, `list_review_comments`, `resolve_review_comment`, `add_rationale`, `list_rationale`, `create_disclosure`, `add_disclosure_entry`, `get_disclosure`) and their sibling API-client helpers plus ten new enum constant arrays (`GATE_RECOMMENDATION_PROVENANCES`, `REVIEW_COMMENT_TARGETS`, `REVIEW_COMMENT_STATUSES`, `REVIEW_COMMENT_PROVENANCES`, `RATIONALE_ENTRY_KINDS`, `RATIONALE_EVIDENCE_BASES`, `RATIONALE_PROVENANCES`, `DISCLOSURE_STATUSES`, `DISCLOSURE_ENTRY_FAMILIES`, `DISCLOSURE_UNCERTAINTY_CATEGORIES`) in `mcp/ground-control/lib.js`. These are thin REST passthroughs over the new `/api/v1/research-runs/{id}/{gates/decision-log,review-comments,rationale,disclosure}` controller endpoints (ADR-066 gate decision log + review comments, ADR-067 explainability rationale ledger, ADR-068 final-output accountability disclosure); all lifecycle legality (append-only decision log, comment resolution independence, disclosure freshness and completeness gating of `complete()`) is enforced server-side in `ResearchRunService`. The matching `openapi-contract.test.js` write-contract drift rows were added. Documentation lives in `docs/API.md` (the Research Runs reference). These are additive MCP tool-surface registrations covered by the existing classifier MCP trigger paths; the `classifyChangedSurface` surface vocabulary, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged. The `docs/DOC_STYLE.md` research-run surface paragraph is extended to record the new actions; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-25 (release pin: floating-tag → versioned-release-pin invariant - issue #1222, ADR-063).** `run_deploy_artifact_consistency` in `tools/policy/checks.py` now requires `deploy/docker/env.schema` to mark `GC_IMAGE` `RELEASE_PIN` (was `FLOATING_TAG`); the violation code is `deploy-env-schema-release-pin` (was `deploy-env-schema-floating-tag`). The matching deploy-time validator `deploy/docker/validate-env.sh` now requires an immutable versioned release tag (`...:X.Y.Z` / `...:X.Y`) and rejects a floating branch tag (`:main`/`:latest`/`:dev`) or an untagged ref, with a digest pin allowed only under `GC_ALLOW_IMAGE_PIN=1` for a deliberate rollback. This reverses the prior "floating tag required, digest rejected" rule per ADR-063 (production runs a promoted release, not a moving tag); ADR-030 carries the dated amendment and GC-P023 clause (b) is amended to match. This is a deploy-policy-surface change; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged.

**2026-06-25 (issue #1000 GC-RSCH-R001/R003 research-run lifecycle).** Registered the action-multiplexed `gc_research_run` MCP tool in `mcp/ground-control/index.js` (actions: start / list / get / get_by_uid / snapshot / list_artifacts / list_gates / record_artifact / advance / gate_decision / stop / fail / resume / complete / record_usage) with its `startResearchRun` / `advanceResearchRun` / `recordResearchRunArtifact` / `getResearchRunSnapshot` and sibling API-client helpers plus the research-run enum constant arrays (`RESEARCH_RUN_STAGES`, `RESEARCH_ARTIFACT_TYPES`, `RESEARCH_GATE_POINTS`, etc.) in `mcp/ground-control/lib.js`. The tool is a thin REST passthrough over the `/api/v1/research-runs` controller (ADR-064 / ADR-065); lifecycle legality (the stage prerequisite matrix, gate behaviour, idempotent resume) is enforced server-side. Added the `/api/v1/research-runs` read prefix to the `gc_query` allowlist (`gc-query.js`, `mcp/ground-control/README.md`, and ADR-035). Documentation lives in `docs/API.md` (the Research Runs reference) and `docs/architecture/ARCHITECTURE.md` (the research-run lifecycle section). These are additive MCP tool-surface registrations covered by the existing classifier MCP trigger paths; the `classifyChangedSurface` surface vocabulary, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and `docs/DOC_STYLE.md` style rules are unchanged.

**2026-06-24 (issue #859 workflow-run telemetry reporting).** Registered two new MCP tools in `mcp/ground-control/index.js`: `gc_workflow_run` (action-multiplexed: record / record_event / import_cost / list / aggregate / cross_project_aggregate) and `gc_workflow_run_ingest` (bridge ingestion of canonical issue-thread `gc:` markers), with their API-client helpers in `mcp/ground-control/lib.js` and the workflow-run DTO field bindings added to the shared `TO_CAMEL` map. Added the two project-scoped read paths (`GET /api/v1/workflow-runs` and `/api/v1/workflow-runs/aggregate`) to the `gc_query` allowlist (`gc-query.js`, `mcp/ground-control/README.md`, and ADR-035); the admin cross-project rollup and all POST paths stay off the read allowlist. Documentation lives in `docs/API.md` (the `/api/v1/workflow-runs**` reference) and ADR-061. A follow-up review-fix commit clarified the record action's idempotent-upsert and 409-conflict semantics in the tool description, `lib.js` JSDoc, and `docs/API.md`. These are additive MCP tool-surface registrations covered by the existing classifier MCP trigger paths; the `classifyChangedSurface` surface vocabulary, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, `.vale.ini`, and `docs/DOC_STYLE.md` style rules are unchanged.

**2026-06-23 (release PR exempt from the per-PR body contract).** The `dev` -> `main` release PR aggregates feature PRs that each already satisfied the PR-body contract on the way into `dev`, so re-imposing it failed every release PR on `pr-requirement-uid` / `pr-ground-control-checks` / the `## Documentation` outcome. `main()` in `tools/policy/checks.py` now resolves the PR base/head (`_resolve_pr_refs`) and, for a release PR (`base == main` and `head == dev`, via `_is_release_pr`), skips `check_pr_body` and passes `pr_body=None` to the documentation-coverage check; the changed-file checks (changelog, migration, enum/controller parity, etc.) still run on the aggregate diff. The surface classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged.

**2026-06-23 (Flyway migration immutability guard).** Added a `migration-immutability` check to `run_migration_policy` in `tools/policy/checks.py`: any migration file already present on the released baseline (`origin/main`) that is modified or removed in the diff fails `make policy`, since Flyway validates checksums on every startup and editing an applied migration crashes every database that already ran it (the V043/V045 production incident, which a fresh-DB smoke test structurally cannot catch). New forward migrations are exempt because they are absent from the baseline. This is a migration-policy-surface extension; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged.

**2026-07-15 (issue #1399, GC-P027 Release Please adoption).** `tools/policy/checks.py` retired `run_changelog_fragment_check` (with its fragment-filename parser, the fragment-infrastructure check, and the application-source predicate) and added `run_version_mirror_consistency_check`, which fails `make policy` with `version-mirror-drift` when a product-version mirror (`backend/build.gradle.kts`, `frontend/package.json`, `frontend/package-lock.json`) diverges from `.release-please-manifest.json`, sourcing the mirror inventory from `release-please-config.json` rather than a second hard-coded list. This is a release/version-policy-surface change: the documentation-coverage classifier (`run_documentation_coverage_check` / `classifyChangedSurface`), the `outcome_required` mapping, the Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged. `docs/DOC_STYLE.md` is updated in lockstep (CHANGELOG.md ownership moved to Release Please; the gate-surface trigger list is unchanged).

**2026-06-23 (GHCR namespace drift gate - issue #953, GC-P022).** Added `run_ghcr_namespace_drift` to `tools/policy/checks.py`: a static post-condition that scans a fixed inventory of deploy/CI/doc artifacts (`Makefile`, `.github/workflows/ci.yml`, the `deploy/docker/.env.*` templates and compose/deploy scripts, `deploy/scripts/deploy.sh`, the deployment docs, and ADR-030) and fails `make policy` when any references a non-canonical `ghcr.io/<ns>/ground-control` namespace (canonical: `autarchy-ai`). The check exists because the CI publish namespace silently diverged from the deploy-host image pin across the KeplerOps → Brad-Edwards → autarchy-ai org moves, so `docker compose pull` kept resolving a frozen image for ~10 days while the healthy old container kept the deploy health check green (#953). `CHANGELOG.md` is excluded (historical release notes); test files are excluded (their negative-case fixtures legitimately carry non-canonical literals). This is a deploy-policy-surface extension; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged.

**2026-06-23 (deploy artifact consistency gate - issue #855, GC-P023).** Added `run_deploy_artifact_consistency` to `tools/policy/checks.py`: a static post-condition over the operator-driven deploy surface that fails `make policy` when (a) a second contradictory env template (`.env.template`) or the dead duplicate wrapper (`deploy/scripts/deploy.sh`) reappears, (b) `deploy/docker/env.schema` drifts from the production compose contract (a `${VAR}` dereferenced with no default but not marked `REQUIRED`, or absent entirely) or stops marking `GC_IMAGE` `FLOATING_TAG`, (c) `deploy/docker/MANIFEST.sha256` no longer matches the canonical artifacts byte-for-byte (regenerate with `make deploy-manifest`), or (d) the operator wrapper `scripts/deploy.sh` reimplements the `docker compose pull/up` rollout primitives that belong only in the canonical `deploy/docker/deploy.sh`. The check exists because the red-dragon deploy broke silently many times on artifact drift with no single source of truth (#855); `env.schema` is now the one contract shared by this gate and the deploy-time `validate-env.sh`. The GHCR-namespace inventory was updated for the removed `.env.template` and the relocated wrapper path. This is a deploy-policy-surface extension; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged.

**2026-06-22 (issue #1162 gc_create_github_issue undefined fix).** Fixed the `gc_create_github_issue` tool handler in `mcp/ground-control/index.js`, which forwarded its raw `{uid, project, repo, labels, extra_body}` args straight into `createGitHubIssue` (which expects `{title, body, labels, repo}`) and therefore created issues with literal `undefined` title and body and no traceability link. Added a `createGitHubIssueFromRequirement` orchestration helper in `mcp/ground-control/lib.js` that fetches the requirement by UID, renders the title and body via the existing `formatIssueBody` (now reading the API-normalized `folder_title` field that `toSnakeCase` produces), and auto-creates the IMPLEMENTS (ACTIVE) / DOCUMENTS (otherwise) traceability link, surfacing a `traceability_error` instead of silently succeeding on partial failure. The tool description string was updated to reflect the DRAFT auto-link and partial-failure behavior. These are MCP tool-surface / bug-fix changes only; the `classifyChangedSurface` surface vocabulary, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged.

**2026-06-22 (issue #260 GC-T005 risk appetite & tolerance).** Added a new `gc_analyze` kind `appetite_evaluation` (registered in `mcp/ground-control/index.js`) with the matching `analyzeRiskAppetiteEvaluation` helper in `mcp/ground-control/lib.js`, and a new `risk_appetite_profile` entity on `gc_risk_governance` (`mcp/ground-control/gc-risk-governance.js`) with its CRUD helpers and `GOVERNANCE_FIELDS` / `GOVERNANCE_STATUS_ENUMS` allowlists in `lib.js`. Added the `appetite_key` / `methodology_family` / `appetite_statement` / `tolerance_thresholds` / `effective_from` / `effective_to` entries to the shared `TO_CAMEL` map so the snake_case MCP fields round-trip to the backend camelCase DTO, and matching `RiskAppetiteProfileRequest` / `UpdateRiskAppetiteProfileRequest` write-contract blocks in `mcp/ground-control/openapi-contract.test.js`. Documentation lives in `docs/API.md` (`/api/v1/risk-appetite-profiles` CRUD and `GET /api/v1/analysis/grc/appetite-evaluation`) and `docs/architecture/ARCHITECTURE.md` (risk appetite & tolerance section). These are MCP config-parser / tool-surface additions; the `classifyChangedSurface` surface vocabulary, `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged.

**2026-05-26 (issue #989).** The `gc_integration_manager` MCP tool (`mcp/ground-control/gc-integrate.js`) and the `gc_integration_manager` entry in `mcp/ground-control/index.js` are new tool surfaces added under this issue. The doc-coverage gate (`doc-coverage-gate-sync` policy rule) triggers on changes to `mcp/ground-control/lib.js` and `mcp/ground-control/index.js`; the tool's documentation lives in `mcp/ground-control/README.md § gc_integration_manager` and `docs/DEVELOPMENT_WORKFLOW.md § /integrate`. No change to the Vale rule set, the `tools/install-vale.sh` installer, the `.vale.ini` configuration, or `docs/DOC_STYLE.md` itself.

**2026-05-26 (issue #989 follow-up).** Fixed a wrapper-layer regression where `gc_render_pr_body` and `gc_post_final_report` did not propagate the optional `documentation_outcome` field. The Zod input schemas omitted the field and the destructure-and-call did not forward it, so the renderer never emitted the `## Documentation` section that this ADR's policy gate requires. Both wrappers now accept `documentation_outcome` (object with `outcome` enum and optional `rationale`) and pass it through to `runRenderPrBody` / `runPostFinalReport`. Unit tests in `lib.test.js::runRenderPrBody` cover the three rendering paths and the omission case.

**2026-05-26 (issue #989 merge carve-out).** The `lib.js` change in this commit adds `INTEGRATION_MANAGER_MERGE_STRATEGIES` and extends `normalizeIntegrationManagerConfig` with the `merge_strategy` field. These changes are to the integration manager config parser, not to any documentation coverage gate surface. No change to the Vale rule set, the `.vale.ini` configuration, or `docs/DOC_STYLE.md` is required.

**2026-06-15 (issue #1168).** `tools/policy/checks.py` gained `run_workflow_routing_contract` and its `parse_routing_agents` helper - a guardrail that asserts the async-poll `/implement` routing stages in `.ground-control.yaml` resolve to `agent: parent`. The change is unrelated to documentation coverage: the surface classifier (`run_documentation_coverage_check`), the Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged. `docs/DOC_STYLE.md` is updated only to list `tools/policy/checks.py` among the gate-surface trigger paths it previously omitted.

**2026-07-29 (issue #1283, GC-Q015 console session read).** The new `SessionController` (`GET /api/v1/session`) added a `getCurrentSession` completeness helper in `mcp/ground-control/lib/api-session.js` (re-exported by `mcp/ground-control/lib.js` and imported in `mcp/ground-control/index.js`) plus a `/api/v1/session` entry in the `gc_query` read allowlist (`mcp/ground-control/gc-query.js`), for API/MCP parity; the endpoint is documented in `docs/API.md § Session`. This is an MCP tool-surface addition only - the documentation-coverage classifier (`classifyChangedSurface` / `run_documentation_coverage_check`), the `outcome_required` mapping, the Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged. `docs/DOC_STYLE.md` is updated only to add the previously omitted `mcp/ground-control/lib/doc-coverage.js` gate-surface trigger path.

**2026-07-26 (issue #1421).** The #1168 executor-routing guard above is
retired because `/implement` no longer carries an `agent` execution-control
field. `run_workflow_routing_contract` now rejects those retired fields and
pins the advisory `base_sync` stage instead. Documentation coverage
classification remains unchanged.

**2026-07-26 (issue #1425 requirement-UID validation).** `mcp/ground-control/lib.js`
splits requirement-UID handling into three named contracts, and
`mcp/ground-control/index.js` points each tool schema at the right one.
`EXACT_REQUIREMENT_UID_RE` becomes a bounded identifier check (1-50 characters,
matching the `Requirement.uid` column bound) rather than an allocator-shaped
grammar, because the previous pattern required two or more characters after the
final hyphen and so rejected every UID `RequirementUidAllocator` mints for the
first nine requirements of a prefix, such as `APP-2`. Identity stays the
project-scoped backend lookup's decision, and every surface accepts a subset of
that one corpus. `tools/policy/checks.py` changes the `pr-requirement-uid` gate
from a whole-body scan for a UID-shaped token to a structural parse of the
`## Requirement UIDs` section (one UID per bullet, or the explicit
`- (none — ...)` marker), mirroring `checkPrBodyShape`. That gives the gate and
`gc_render_pr_body` the same accepted set, so a UID that reconciles and reports
can always be rendered. It also decouples two unrelated gates: a requirement-free
change no longer has to carry an incidental `ADR-NNN` token somewhere in the body
to pass a requirement check, and ADR impact remains gated on its own by
`pr-adr-impact`. `PR_REQUIREMENT_RE` survives only for free-form prose scanning,
strictly narrower than the corpus. The surface classifier
(`run_documentation_coverage_check`), the `outcome_required` mapping, the Vale
rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged.

**2026-05-26 (issue #989 SDK schema hotfix).** Re-registered `gc_integration_manager` via `server.tool(name, desc, zodShape, handler)` so the SDK's `safeParseAsync` path resolves; the prior `server.registerTool({inputSchema: <raw JSON Schema>})` form crashed every invocation with `v3Schema.safeParseAsync is not a function`. The fix touches `mcp/ground-control/index.js` only; no change to the Vale rule set, the `.vale.ini` configuration, the doc-coverage classifier, or any documentation target surface.

**2026-05-28 (issue #720 FAIR risk scenario refactor).** The `gc_risk_scenario` MCP tool field renames (`threat_source`→`threat`, `threat_event`→`method`, `affected_object`→`asset`, `consequence`→`effect`) required updating the `TO_CAMEL` mapping in `mcp/ground-control/lib.js` to remove obsolete snake_case bindings and add the new derived field `fair_sentence` mapping. Additionally, `tools/policy/checks.py` was updated to recognize `mcp/ground-control/gc-risk-scenario.js` as a valid MCP-adapter file (alongside `gc-risk-governance.js`) for the `controller-parity` policy check. These are config-parser and policy surfaces; no change to the Vale rule set, the `.vale.ini` configuration, or `docs/DOC_STYLE.md` itself.

**2026-06-11 (issue #1100 GRC reconciliation gate).** The `gc_assert_grc_reconciled` MCP tool is registered in `mcp/ground-control/index.js` and implemented in `mcp/ground-control/lib.js`. The doc-coverage gate triggers on these paths; the tool's documentation lives in `docs/DEVELOPMENT_WORKFLOW.md` (GRC reconciliation gate row added to the per-step optimization table) and `skills/implement/steps/step-17-verify.md` (Step 6 added for `gc_assert_grc_reconciled`). The tool-enumeration example list in `docs/DOC_STYLE.md` was extended to name `gc_assert_grc_reconciled` (and a pre-existing duplicated paragraph there consolidated); no new Vale rule, `tools/install-vale.sh` installer change, `.vale.ini` change, or new DOC_STYLE style rule was required. The new tool surface is an additive `mcp_tool` class extension covered by the existing classifier path logic.

**2026-06-15 (issue #1169).** The action-multiplexed MCP tool descriptions in `index.js` and `gc-risk-governance.js` gained per-action required-field enumeration, and `gc_risk_governance` create actions gained `reqArg` guards. This is an MCP tool-surface description/validation change; the documentation-coverage classifier, Vale rule set, and `DOC_STYLE.md` style rules are unchanged.

**2026-05-29 (issue #721 GC-T014 NIST SP 800-30 assessment).** Added a new `gc_analyze` kind `nist_assessment` (registered in `mcp/ground-control/index.js`) and the matching `analyzeNistAssessment` helper in `mcp/ground-control/lib.js`. Extended `OPAQUE_VALUE_KEYS` in `lib.js` with methodology-defined value-bag keys (`inputFactors` / `computedOutputs` / `uncertaintyMetadata` / `inputSchema` / `outputSchema` / `treatmentStrategyVocabulary`) so NIST profile-defined inner keys (`threat_event_relevance`, legacy `threat_source_relevance`, `likelihood_initiation`, `likelihood_adverse_impact`, etc.) reach the caller verbatim, per the GC-T014 preflight note. Extended `tools/policy/checks.py::ENUM_CONTRACT_INVENTORY` with four NIST tag enums (`ThreatEventKind`, `ThreatSourceRelevance`, `NistLikelihoodBand`, `NistImpactBand`) so ADR-034's enum-mirror gate covers them. Documentation lives in `docs/API.md` (`GET /api/v1/analysis/grc/nist-sp-800-30`) and the tool description in `mcp/ground-control/index.js`. The 2026-06 source-alignment fix only updates the protected opaque-key examples and keeps the existing classifier behavior. No change to the Vale rule set, `.vale.ini`, or the classifier.

**2026-05-29 (issue #721 follow-on, MCP test regression fix).** The `gc_risk_scenario` FAIR-CRST rename in #720 removed the `threat_source` → `threatSource` and `threat_event` → `threatEvent` entries from `TO_CAMEL` in `mcp/ground-control/lib.js`. The `gc_threat_model` tool still uses those snake_case field names on its public surface (per ADR-034); Jackson was silently dropping the fields on the wire so threat models created via MCP shipped without the threat source or event. Restored both mappings. Also corrected the `gcAuditZodShape` "preserves every backend create body field through Zod parse" test to supply `phases` in the input. Zod by design drops absent optional fields from the parsed object, so the original test was self-defeating. No change to the Vale rule set, `.vale.ini`, the classifier, or `docs/DOC_STYLE.md`.

**2026-05-29 (issue #748 GC-Q010 Threat Modeling Workspace).** The `getThreatModelWorkspace` function was added to `mcp/ground-control/lib.js` as a thin API client for the new `GET /api/v1/threat-models/workspace` endpoint. This is an additive API-client surface (mirrors the pattern for `createThreatModelLink`, `listThreatModelLinks`, etc.); the underlying classifier already covers `mcp/ground-control/lib.js` as a surface, so no classification update is needed. No change to the Vale rule set, the `.vale.ini` configuration, or `docs/DOC_STYLE.md` itself.

**2026-05-29 (issue #719 GC-T012 multi-framework risk terminology crosswalk).** Added the `NORMALIZED_CONCEPTS` and `CROSSWALK_VOCABULARY_SURFACES` constant arrays to `mcp/ground-control/lib.js` mirroring the two new Java enums (`NormalizedConcept`, `CrosswalkVocabularySurface`) on `MethodologyProfile`. Extended `tools/policy/checks.py::ENUM_CONTRACT_INVENTORY` with the two new rows so ADR-034's enum-mirror gate covers them. Extended the `gc_risk_governance` `methodology_profile` Zod shape with an optional `crosswalk_entries` array. Documentation lives in `docs/API.md` (`MethodologyProfileRequest` / `CrosswalkEntry` field reference) and `docs/architecture/ARCHITECTURE.md` (`MethodologyProfile` aggregate section). These are config-parser, policy-inventory, and MCP-adapter surfaces; no change to the Vale rule set, `.vale.ini`, the classifier, or `docs/DOC_STYLE.md`.

**2026-05-29 (issue #747 GC-Q009 Risk Scenario Workspace).** The `getRiskScenarioWorkspace` function was added to `mcp/ground-control/lib.js` as a thin API client for the new `GET /api/v1/risk-scenarios/workspace` endpoint, and the `gc_risk_scenario_workspace` tool was registered in `mcp/ground-control/index.js`. These are additive API-client and tool-registration surfaces; the underlying classifier already covers `mcp/ground-control/lib.js` and `mcp/ground-control/index.js`. No change to the Vale rule set, the `.vale.ini` configuration, or `docs/DOC_STYLE.md` itself.

**2026-06-13 (issue #749 GC-Q011 Control Assurance Workspace).** The `getControlAssuranceWorkspace` function was added to `mcp/ground-control/lib.js` as a thin API client for the new `GET /api/v1/controls/workspace` endpoint, and the `gc_control_assurance_workspace` tool was registered in `mcp/ground-control/index.js`. These are additive API-client and tool-registration surfaces. Documentation lives in `docs/API.md`, `mcp/ground-control/README.md`, and `docs/architecture/ARCHITECTURE.md`; the classifier already covers the MCP trigger paths. No change to the Vale rule set, `.vale.ini`, the classifier, or `docs/DOC_STYLE.md`.

**2026-06-15 (issue #1173).** Corrected the gc_risk_governance methodology_profile and verification_result MCP create/update field allowlists in lib.js (and the Zod shape + reqArg guards in gc-risk-governance.js) to match the backend DTOs. This is an MCP config-parser/tool-surface fix; the documentation-coverage classifier, Vale rule set, and DOC_STYLE.md style rules are unchanged.

**2026-06-13 (issue #750 GC-Q012 Evidence and State Explorer).** The `getEvidenceStateWorkspace` function was added to `mcp/ground-control/lib.js` as a thin API client for the new `GET /api/v1/evidence-state/workspace` endpoint, and the `gc_evidence_state_workspace` tool was registered in `mcp/ground-control/index.js`. These are additive API-client and tool-registration surfaces. Documentation lives in `docs/API.md`, the tool description in `mcp/ground-control/index.js`, and the workspace architecture entry in `docs/architecture/ARCHITECTURE.md`; the classifier already covers the MCP trigger paths. No change to the Vale rule set, the `.vale.ini` configuration, or `docs/DOC_STYLE.md` itself.

**2026-05-30 (issue #1058 traceability + post-merge close gate at MCP tool layer).** Added `runAssertTraceabilityReconciled` and `runCloseIssueAfterMerge` to `mcp/ground-control/lib.js`, registered the matching `gc_assert_traceability_reconciled` and `gc_close_issue_after_merge` MCP tools in `mcp/ground-control/index.js`, and extended `runPostFinalReport` to refuse without the `traceability_reconciled` phase marker. Added `run_traceability_reconciliation_gate_contract` to `tools/policy/checks.py` as the prose-side guardrail for the four anchor files (`skills/implement/SKILL.md`, `skills/implement/steps/step-17-verify.md`, `skills/implement/steps/step-19-final-report.md`, `skills/implement/steps/step-20-close-issue-on-merge.md`). The tool documentation lives in the tool descriptions in `mcp/ground-control/index.js` and in the skill prose under `skills/implement/`. These are MCP-adapter, config-parser, and policy surfaces; no change to the Vale rule set, the `tools/install-vale.sh` installer, the `.vale.ini` configuration, or `docs/DOC_STYLE.md`.

**2026-06-10 (issue #1099 threat/risk screening gate).** Added `runPostGrcScreening` to `mcp/ground-control/lib.js` and registered the matching `gc_post_grc_screening` MCP tool in `mcp/ground-control/index.js`. The tool implements the `/implement` Step 3.5 GRC screening gate per ADR-057, posting a schema-versioned durable record to the GitHub issue thread. Updated `skills/implement/SKILL.md` to include the new step in the step-list table and added `docs/WORKFLOW.md` to document the screening gate in Phase 3 (step 4 in the numbered development loop). Added a new step file `skills/implement/steps/step-03.5-grc-screening.md` with the step contract, verdicts, and decision logic. These are MCP-adapter, config-parser, and skill-prose surfaces; no change to the Vale rule set, the `.vale.ini` configuration, the doc-coverage classifier, or `docs/DOC_STYLE.md`.
**2026-06-10 (SonarCloud gate remediation for #1085).** The dev->main SonarCloud cleanup refactored internals of `mcp/ground-control/lib.js` (split `runAssertTraceabilityReconciled` and `runCloseIssueAfterMerge` into module-scope helpers to lower cognitive complexity, and added a null-deref guard) and applied behavior-preserving smell fixes in `mcp/ground-control/index.js`. The documentation-coverage classifier, its surface set, the thresholds, the Vale rule set, and `.vale.ini` are unchanged; this is a behavior-preserving refactor of code the classifier already covers, so no classification update is needed.

**2026-06-11 (issue #1101 quality-gate evaluation at the completion gate).** Added `runAssertQualityGates` (and its pure `buildQualityGateAssertion` transform) to `mcp/ground-control/lib.js` and registered the matching `gc_assert_quality_gates` MCP tool in `mcp/ground-control/index.js`. The tool wraps the existing server-side `QualityGateService.evaluate` contract and is wired into the `/implement` completion gate (Step 6) so a failing project quality gate blocks the run; documentation lives in `docs/DEVELOPMENT_WORKFLOW.md`, `docs/WORKFLOW.md`, and `skills/implement/steps/step-06-completion-gate.md`. A new `COVERAGE`/`metricParam=DOCUMENTS` quality gate ("Active DOCUMENTS Coverage") was also declared in `tools/ground_control/policy.json`. **That gate measures requirement-link documentation coverage (the share of ACTIVE requirements carrying a `DOCUMENTS` traceability link) and is distinct from ADR-054's documentation-coverage classifier gate, which classifies changed file paths and runs Vale; the two must not be conflated.** These are MCP-adapter, policy, and skill-prose surfaces; the doc-coverage classifier, its surface set, the thresholds, the Vale rule set, the `tools/install-vale.sh` installer, and `.vale.ini` are unchanged. No new `docs/DOC_STYLE.md` style rule is established; only the workflow-gate tool-enumeration example list there is extended to name `gc_assert_quality_gates`.

**2026-06-13 (issue #1156 final-report outcome and next-issue recommendation).** Added the `plain_english_outcome` final-report field to `mcp/ground-control/lib.js` and `mcp/ground-control/index.js`, with `/implement` requiring it and `/quickfix` leaving it optional. Also extended `gc_close_issue_after_merge` to return `next_issue_recommendation` or an explicit no-recommendation/failure reason after a merge-verified close succeeds. The matching prose anchors live in `docs/DEVELOPMENT_WORKFLOW.md`, `docs/WORKFLOW.md`, ADR-021, ADR-029, ADR-036, and the implement/quickfix skill prose; `tools/policy/checks.py` keeps those workflow surfaces synced. These are MCP-adapter and workflow-policy changes. The documentation-coverage classifier, Vale rule set, installer, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-13 (issue #1114 GC-GRC-001 derivation adapter port).** Added the `/api/v1/derivations` REST surface, the `gc_derivation` MCP adapter, derivation API helpers in `mcp/ground-control/lib.js`, and the `/api/v1/derivations` read prefix in `gc_query`. Documentation lives in `docs/API.md` for the REST schema, `mcp/ground-control/README.md` for the tool catalog and query allowlist, and the `gc_derivation` adapter description for the MCP action contract. These are public API, MCP-adapter, and config-parser surfaces. The doc-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-13 (issue #1155 CI strictness baseline).** Added `run_ci_strictness_contract` to `tools/policy/checks.py` so `make policy` verifies the CI strictness surfaces: selected pre-commit hygiene and secret-scan hooks run in the CI policy job, the Sonar job waits for the quality gate and invokes `tools/sonar/assert_no_new_issues.py`, and `.github/branch-protection-baseline.json` records strict required checks for `main` and `dev` with admin bypass retained. Documentation lives in `docs/DEVELOPMENT_WORKFLOW.md` and `tools/sonar/README.md`. This is a policy-surface extension; the doc-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged. No new `docs/DOC_STYLE.md` style rule is established.

**2026-06-14 (issue #1102 documentation coverage status-hole closure).**
The active `DOCUMENTS` coverage gate now has two status-independent
enforcement points. First, `/implement` Step 6 calls
`gc_assert_quality_gates` with the issue's `in_scope_requirements[]`; when an
enabled `COVERAGE` gate with `metricParam=DOCUMENTS` and
`scopeStatus=ACTIVE` exists, the tool verifies each in-scope requirement has a
`DOCUMENTS` traceability link regardless of DRAFT or ACTIVE status. Second,
`RequirementService` rejects DRAFT-to-ACTIVE transitions for requirements
missing a `DOCUMENTS` link while that gate is active, including per-item
failures in bulk transition. This closes the prior escape where keeping a
requirement DRAFT kept it out of active-status project coverage until after
the completion gate had already passed. The backend uses the existing
quality-gate and traceability repositories; no new coverage schema, endpoint,
or frontend-only validation layer was added.

**2026-06-14 (issue #689 GC-Q003 Traceability Matrix).** The `getTraceabilityMatrix` function was added to `mcp/ground-control/lib.js` as a thin API client for the new `GET /api/v1/requirements/matrix` endpoint, and the `gc_traceability_matrix` read tool was registered in `mcp/ground-control/index.js`. These are additive API-client and tool-registration surfaces. Documentation lives in `docs/API.md` and the tool description in `mcp/ground-control/index.js`; the classifier already covers the MCP trigger paths. The doc-coverage classifier, Vale rule set, `tools/install-vale.sh` installer, and `.vale.ini` configuration are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-14 (next-issue recommendation skips umbrella/tracking issues).**
Refined the `gc_close_issue_after_merge` next-issue recommendation in
`mcp/ground-control/lib.js` so an umbrella or tracking issue is never handed
back as the next thing to pick up after a merge-verified close. The new pure
helpers `isUmbrellaNextIssueCandidate` and `selectNextIssueRecommendation` drop
a candidate when it carries an `epic`/`umbrella`/`tracking`/`meta` marker
label, a `Tracking:`/`Epic:`/`Umbrella:` or bracketed title prefix,
GitHub-native sub-issues (`sub_issues_summary.total > 0`), or a body task list
that checks off five or more child issues. The task-list threshold separates a
coordinating tracking issue (dozens of issue-referencing checkboxes) from a
leaf requirement issue (a handful of acceptance-criteria checkboxes that
reference no issues). This refines the credible-next-issue filter added for
#1156; the matching prose anchor is the recommendation source description in
`skills/implement/steps/step-20-close-issue-on-merge.md`, and the changelog
fragment records the temporal change. These are MCP-adapter and
workflow-policy changes. The documentation-coverage classifier, its surface
set, the thresholds, the Vale rule set, the `tools/install-vale.sh` installer,
and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is
established.

**2026-06-14 (issue #1103 Phase D consolidation).** Added `runAssertCompletion` to `mcp/ground-control/lib.js` and registered `gc_assert_completion` in `mcp/ground-control/index.js`. Updated `tools/policy/checks.py` to point the traceability-gate contract check at the consolidated `step-17-completion.md` surface (now requiring `gc_assert_completion`, `traceability_reconciled`, and `plain_english_outcome`). These are MCP-adapter and policy-surface changes. The documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-14 (issue #1104 MCP tool-usage telemetry).** Added the internal
handler-boundary telemetry wrapper `installToolTelemetry` and the `err()`
`_meta` outcome-code channel to `mcp/ground-control/index.js`, and an
admin-token routing entry for the aggregate read path to `requiresAdminRole`
in `mcp/ground-control/lib.js`. The new `McpTelemetryController` exposes
`POST /api/v1/mcp-tool-usage/events` (capture, any authenticated session) and
`GET /api/v1/mcp-tool-usage` (aggregate, ROLE_ADMIN gated in `ApiPathMatrix`
because it exposes cross-project operational telemetry); the read prefix is
added to the `gc_query` allowlist (`gc-query.js`, `mcp/ground-control/README.md`,
ADR-035). Documentation lives in `docs/API.md`, ADR-059, and the changelog
fragment. Capture is internal to the adapter (no new public `gc_*` tool is
registered), so the doc-coverage classifier surface set, the Vale rule set, the
`tools/install-vale.sh` installer, and `.vale.ini` are unchanged; the
`docs/DOC_STYLE.md` MCP-shape-extensions list is extended to record the surface
addition. No new `docs/DOC_STYLE.md` style rule is established.

**2026-06-16 (issue #723 GC-T011 Open FAIR quantitative risk analysis).** Added
`analyzeFairQuantitative` adapter helper to `mcp/ground-control/lib.js` and
registered `fair_quantitative` in the `ANALYZE_KINDS` array and `gc_analyze`
tool description in `mcp/ground-control/index.js`. The backend surface is
`GET /api/v1/analysis/grc/fair-quantitative` (documented in `docs/API.md`).
This follows the `gc_analyze`-kind extension pattern already established for
`nist_assessment` (GC-T014 / #721) and recorded in `docs/DOC_STYLE.md §
MCP-shape-extensions`. The documentation-coverage classifier, Vale rule set,
`tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md`
style rule is established.

**2026-06-18 (issue #1181 model-tier refresh).** The `mcp/ground-control/lib.js`
change in this commit bumps the `CLAUDE_MODEL_BY_TIER.high` routing-default
constant from `claude-opus-4-7` to `claude-opus-4-8` (with the matching
high-tier `.ground-control.yaml` stages `planning` and `review_cycle_1_consume`).
This is a one-line routing-default model-id change, not a documentation-coverage
gate surface: the `run_documentation_coverage_check` classifier, the Vale rule
set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new
`docs/DOC_STYLE.md` style rule is established.

**2026-06-18 (issue #1181 telemetry consistency fields).** A second
`mcp/ground-control/lib.js` change under #1181 adds `expected_model` and
`model_matches_expected` to the `/implement` step-telemetry record (schema
bumped to `gc.implement.telemetry/v2`), documented in ADR-036's telemetry
contract. This is an internal telemetry-record field addition, not a
documentation-coverage gate surface: the `run_documentation_coverage_check`
classifier, the Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are
unchanged, and no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-20 (issue #266 GC-H006 threat-control mapping).** Extended
`gc_risk_control_mapping` in `mcp/ground-control/index.js` and
`mcp/ground-control/lib.js` to support `ThreatModel` as a third analysis-side
endpoint. Changes: (1) `threat_model_id` added to the Zod schema as an optional
UUID field; (2) `"unmapped-threats"`, `"threat-unmapped-controls"`, and
`"threats-insufficient-effectiveness"` added to `RISK_CONTROL_MAPPING_ACTIONS`;
(3) three matching query params (`min_effectiveness`, `as_of`,
`freshness_window_days`) added; (4) `getUnmappedThreats`,
`getThreatUnmappedControls`, and `getThreatsInsufficientEffectiveness` helper
functions added to `lib.js`; (5) `threat_model_id` threaded through the
`create` action body. These are additive extensions to an existing
`gc_risk_control_mapping` action-multiplexed tool; the underlying classifier
already covers both MCP trigger paths. Documentation lives in `docs/API.md`
and `docs/architecture/ARCHITECTURE.md`. The doc-coverage classifier, Vale rule
set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new
`docs/DOC_STYLE.md` style rule is established.

**2026-06-20 (issue #763 GC-I004 continuous compliance monitoring).** Added
`analyzeComplianceMonitoring` adapter helper to `mcp/ground-control/lib.js` and
registered `continuous_compliance_monitoring` in the `ANALYZE_KINDS` array and
`gc_analyze` tool description in `mcp/ground-control/index.js`. The backend
surface is `GET /api/v1/analysis/grc/compliance-monitoring` (documented in
`docs/API.md`). This follows the `gc_analyze`-kind extension pattern already
established for `fair_quantitative` (GC-T011 / #723) and recorded in
`docs/DOC_STYLE.md § MCP-shape-extensions`. The documentation-coverage
classifier, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are
unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-21 (issue #746 GC-I017 FAIR-CAM control analytics).** Added
`analyzeFairCamControlAnalytics` adapter helper to `mcp/ground-control/lib.js` and
registered `fair_cam_control_analytics` in the `ANALYZE_KINDS` array and
`gc_analyze` tool description in `mcp/ground-control/index.js`. The backend
surface is `GET /api/v1/analysis/grc/fair-cam-control-analytics` (documented in
`docs/API.md`). This follows the `gc_analyze`-kind extension pattern established
for `fair_quantitative` (GC-T011 / #723), `continuous_compliance_monitoring`
(GC-I004 / #763), and recorded in `docs/DOC_STYLE.md § MCP-shape-extensions`.
The documentation-coverage classifier, Vale rule set, `tools/install-vale.sh`,
and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is
established. Pre-push review follow-up refined the same MCP surfaces only: the
`gc_analyze` tool description and the `analyzeFairCamControlAnalytics` helper
comment now note that the FAIR-CAM scope filters compose as an intersection and
that `methodology_profile_id` is an applied filter. No new kind, endpoint, or
style rule; `docs/API.md` carries the matching contract update.

**2026-06-20 (issue #1194 dev-start plan gate).** Added the optional `workflow.dev_start_gate` parser to `mcp/ground-control/lib.js`, wired `gc_post_implementation_plan` to refuse invalid enabled gate sections before posting a plan marker, and extended `gc_render_pr_body` in `mcp/ground-control/index.js` with an optional `dev_start_gate` Markdown section. The workflow contract lives in `skills/implement/steps/step-04-planning.md` and `skills/implement/steps/step-09-pr-body.md`; the tool descriptions and parser validation are the MCP surface. These are workflow, MCP-adapter, and config-parser surfaces; no change to the Vale rule set, the `tools/install-vale.sh` installer, or the `.vale.ini` configuration.

**2026-06-21 (issue #1167 controller @WebMvcTest mapping by FQCN).** Rewrote `run_controller_contracts` in `tools/policy/checks.py` (and the parallel `ControllerPolicyTest` ArchUnit-style test) to resolve a controller's `@WebMvcTest` companion by the controller's fully qualified class, derived from its repo path and matched against each test's `@WebMvcTest(...)` annotation resolved through that file's `import`, instead of the controller's bare filename stem. The stem heuristic collided on same-named controllers in different packages (`api/audit/AuditController` versus `api/audits/AuditController`), causing a false `controller-webmvctest-update` failure and letting the wrong test spuriously satisfy the check. The `controller-webmvctest-update`, `controller-webmvctest-missing`, and `controller-webmvctest-annotation` codes are unchanged. The parser matches dotted Java identifiers and strips the `.class` suffix in code so the regular expressions stay linear-time (no super-linear backtracking, Sonar S8786). The documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-22 (issue #963 gc_assert_completion phase parameter).** Added a `phase` parameter (`"pre_merge"` | `"post_merge"`, default `"post_merge"`) to the `gc_assert_completion` MCP tool surface in `mcp/ground-control/index.js` and threaded it through `runAssertCompletion` / `runPostFinalReport` / `buildFinalReport` in `mcp/ground-control/lib.js` (post-merge merge-gate; pre-merge readiness record). This is an MCP-adapter surface change; per the `docs/DOC_STYLE.md` "MCP tool surface" convention the addition is recorded in this ADR and the `changelog.d/963.changed.md` fragment, and the required agent behavior lives in `skills/implement/steps/step-17-completion.md`. The documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-23 (issue #1197 Requirement UID identity).** Extended `mcp/ground-control/lib.js` and `mcp/ground-control/index.js` with two additive MCP surface changes: (1) `gc_requirement` create now accepts `uid_prefix` as a mutually exclusive alternative to `uid`, with `uid_prefix` added to the `TO_CAMEL` map and the `ENTITY_FIELDS` allowlist; (2) `gc_get_traceability_by_artifact` and the internal `checkOrphanedIssueLinks` helper now accept an optional `project` parameter forwarded as a `?project=` query string to scope the reverse lookup. Documentation lives in `docs/API.md`, `mcp/ground-control/README.md`, `architecture/adrs/060-requirement-uid-identity.md`, `docs/architecture/ARCHITECTURE.md`, and `docs/DEVELOPMENT_WORKFLOW.md`. The documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established. Review-fix refinement (same issue, same date): the `gc_get_traceability_by_artifact` tool description and the `getTraceabilityByArtifact` helper comment were clarified to state the reverse lookup is *always* project-scoped: `RequirementController` resolves a single project (or fails with `project_required` in a multi-project instance) and the service no longer falls back to an unscoped query; `docs/API.md` carries the matching contract wording.

**2026-06-30 (issue #1120 GC-GRC-007 deterministic threat enumeration).** Registered the `gc_threat_enumeration` MCP tool (`mcp/ground-control/gc-threat-enumeration.js`) in `mcp/ground-control/index.js` and added the `threatEnumeration` API-client helper to `mcp/ground-control/lib.js`. The tool is a dedicated read-only adapter for the new `GET /api/v1/threat-enumeration` REST surface, which enumerates candidate threats deterministically (no LLM) from an architecture-model snapshot against a registered `THREAT_RULE_PACK`. Documentation lives in `docs/API.md` (`### Threat Enumeration (GC-GRC-007)`). The tool does not add a path to the `gc_query` allowlist (it is a dedicated tool surface, not a query path). The documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-01 (issue #1121 GC-GRC-008 deterministic control identification).** Registered the `gc_control_identification` MCP tool (`mcp/ground-control/gc-control-identification.js`) in `mcp/ground-control/index.js` and added the `controlIdentification` / `controlCoverage` API-client helpers to `mcp/ground-control/lib.js`. The tool is a dedicated read adapter (`action` = `identify` | `coverage`) for the new `GET /api/v1/control-identification` and `GET /api/v1/control-identification/coverage` REST surfaces, which deterministically map enumerated threats to candidate controls (from installed control packs and project controls) and read confirmed threat→control coverage. The companion `POST /api/v1/control-identification/confirmations` write is REST-only and records through the existing `RiskControlMapping` / `ThreatModelLink` aggregates (so it is not a new MCP write tool). Documentation lives in `docs/API.md` (`### Control Identification (GC-GRC-008)`). The tool does not add a path to the `gc_query` allowlist (it is a dedicated tool surface, not a query path). The documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-28 (issue #1245 automated review-cap disposition gate).** Added the `gc_review_cap_disposition` MCP tool to `mcp/ground-control/lib.js` (`runReviewCapDisposition` plus the `normalizeReviewDispositionConfig` config parser, `scoreDisposition` / `collectDispositionSignals` deterministic scorer, `parseReviewAutoDispositionMarkers` / `buildReviewAutoDispositionRecord` durable-record helpers, the pure `evaluateAutoDispositionGrant` authorization logic, the `effectiveReviewerCap` server-side cap resolver, `verifyAutoDispositionGrant`, and the provenance helpers `readIssueCommentsWithAuthors` / `getAuthenticatedGitHubLogin`) and registered it in `mcp/ground-control/index.js` (with an optional bounded `findings_summary` input); the `gc_codex_review_cycle` / `gc_test_quality_review_cycle` tools gained an `auto_grant` boolean that the cycle wrappers verify against the durable `gc:review-auto-disposition` marker (only when posted by the trusted MCP identity, in authoritative mode, and not already spent) before honoring an over-cap cycle. These are additive MCP-adapter, config-parser, and durable-record surfaces gated by `workflow.review_disposition.enabled` (default false). Per the `docs/DOC_STYLE.md` "New /implement workflow-gate MCP tools" convention the addition is recorded here and in the `changelog.d/1245.added.md` fragment; the workflow contract lives in `architecture/adrs/031-codex-review-stopping-model.md`, `architecture/adrs/029-issue-thread-gate-model.md`, GC-O007, `skills/implement/steps/_review-loop-rules.md`, `skills/implement/steps/step-06.5-codex-review.md`, `skills/implement/steps/step-06.6-test-quality-review.md`, and `docs/DEVELOPMENT_WORKFLOW.md`. The documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-06-30 (issue #214 GC-S005 scheduled evidence collection).** Registered the project-scoped `gc_evidence_campaign` MCP tool (actions: create / list / get / update / pause / resume / trigger / runs_list) in `mcp/ground-control/index.js` and `mcp/ground-control/lib.js` (handler in `mcp/ground-control/gc-evidence-campaign.js`), backed by the new `/api/v1/evidence-campaigns**` REST surface. The doc-coverage gate triggers on the `index.js` / `lib.js` change; the tool and its request/response schemas are documented in `docs/API.md`, `docs/architecture/ARCHITECTURE.md`, and `architecture/adrs/074-scheduled-evidence-collection.md`. This is an additive `mcp_tool` surface covered by the existing classifier path logic; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-01 (issue #1264 Sonnet-tier refresh).** The `mcp/ground-control/lib.js` change in this commit bumps the `CLAUDE_MODEL_BY_TIER.medium` routing-default constant and the `TEST_QUALITY_REVIEW_DEFAULT_MODEL` engine default from `claude-sonnet-4-6` to `claude-sonnet-5` (with the matching medium-tier `.ground-control.yaml` stages and the `index.js` `gc_test_quality_review` tool-description text), and loosens the executable-routing model-id validator to accept single-segment canonical ids (`claude-sonnet-5`). This is a routing-default model-id change plus a validator relaxation, not a documentation-coverage gate surface: the `run_documentation_coverage_check` / `classifyChangedSurface` classifier, the `outcome_required` mapping, the Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-02 (issue #1122 GC-GRC-009 derivation-backed change screening).** Reworked the `/implement` Step 3.5 screening tool in `mcp/ground-control/index.js` and `mcp/ground-control/lib.js`: `gc_post_grc_screening` no longer accepts a caller `verdict` / `entities_*` / `code_links` and instead computes a v2 record (`gc.implement.grc-screening/v2`) whose `impact_set` / `gap_set` / `stale_set` are derived (via the pure `classifyGrcScreening`) from the diff, the existing GRC `CODE`-link graph, and the latest/pinned derivation run plus architecture-model snapshot, with deterministic GC-GRC-007/008 candidates and a reproducible provenance block. `gc_assert_grc_reconciled` gained a schema-branch that blocks on a non-empty `gap_set` while keeping the v1 verdict path for historical/in-flight records. This is a change to an existing `mcp_tool` surface covered by the existing classifier path logic; the tool contract lives in the `index.js` tool descriptions, `docs/DEVELOPMENT_WORKFLOW.md`, `docs/WORKFLOW.md`, `skills/implement/steps/step-03.5-grc-screening.md`, and the ADR-057 v2 amendment (target contract ADR-058). The documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-01 (issue #1006 / ADR-080 methodology requirements contract).** Added two `gc_research_run` MCP actions - `record_methodology_requirements_contract` (`POST /api/v1/research-runs/{id}/methodology/requirements-contract`) and `get_methodology_requirements_contract` (`GET` same path) - in `mcp/ground-control/index.js` (with nested `entries` / `rejected_alternatives` Zod inputs and the `CONTRACT_ENTRY_KINDS` enum mirror) and `mcp/ground-control/lib.js` (`recordMethodologyRequirementsContract` / `getMethodologyRequirementsContract` client helpers plus the `CONTRACT_ENTRY_KINDS` export). The GET read routes through the existing `/api/v1/research-runs` `gc_query` prefix allow-list (no new allow-list path). The new surface is documented in `docs/API.md` and `docs/research/RESEARCH_WORKFLOW.md`, with the backend contract in `architecture/adrs/080-research-methodology-requirements-contract-artifact.md` and a `changelog.d/1006.added.md` fragment. This is an additive `mcp_tool` / public-API surface covered by the existing classifier path logic; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-03 (issue #1007 / ADR-083 protocol plan).** Added two `gc_research_run` MCP actions - `record_protocol_plan` (`POST /api/v1/research-runs/{id}/protocol-plan`) and `get_protocol_plan` (`GET` same path) - in `mcp/ground-control/index.js` (with nested `coverages` / `sections` Zod inputs and the `PROTOCOL_COVERAGE_DISPOSITIONS` / `PROTOCOL_ANSWER_PROVENANCES` / `PROTOCOL_SECTION_KINDS` / `PROTOCOL_SOURCE_ROLES` enum mirrors) and `mcp/ground-control/lib.js` (`recordProtocolPlan` / `getProtocolPlan` client helpers plus those four enum exports). The GET read routes through the existing `/api/v1/research-runs` `gc_query` prefix allow-list (no new allow-list path). The new surface is documented in `docs/API.md`, `docs/architecture/ARCHITECTURE.md`, and `docs/research/RESEARCH_WORKFLOW.md`, with the backend contract in `architecture/adrs/083-research-protocol-plan-artifact-and-method-outputs.md` and a `changelog.d/1007.added.md` fragment. This is an additive `mcp_tool` / public-API surface covered by the existing classifier path logic; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged, and no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-03 (issue #1123 GC-GRC-010 design-time GRC deliverables gate).** Extended the existing `gc_post_implementation_plan` MCP tool in `mcp/ground-control/index.js` and `mcp/ground-control/lib.js` with the design-time GRC deliverables gate: a new `grc_deliverables` param and the pure `validateGrcDeliverablesPlanGate` / `renderGrcDeliverablesRecord` / `renderGrcDeliverablesScaffold` / `parseGrcDeliverablesData` helpers, plus a `grc_screening` prerequisite marker alongside `preflight`. When the Step 3.5 screening record is `security_relevant`, the tool refuses a plan that does not cover every screening `gap_set` surface and `stale_set` entity with a structured deliverable or an authorized disposition (no-defer, GC-GRC-015), and renders an authoritative `gc:grc-deliverables-data` machine block into the plan comment (the plan→completion trace GC-GRC-012 will read). The tool also rejects a forged deliverables block / reserved markers in caller text and scrubs sensitive content before posting. This is a change to an existing `mcp_tool` / `workflow` surface covered by the existing classifier path logic; the contract lives in the `index.js` tool description, `docs/DEVELOPMENT_WORKFLOW.md`, `skills/implement/steps/step-04-planning.md`, `skills/implement/steps/step-03.5-grc-screening.md`, `.gc/plan-rules.md`, `mcp/ground-control/README.md`, and the ADR-058 §5 realization. The documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-04 (issue #1129 GC-GRC-016 on-demand GRC assessment lane).** Registered the `gc_grc_assess` MCP tool in `mcp/ground-control/index.js` and `mcp/ground-control/gc-grc-assess.js`, and added the `createGrcAssessmentRun` / `reviewGrcAssessmentRun` / `getGrcAssessmentRun` / `listGrcAssessmentRuns` client helpers plus field mappings in `mcp/ground-control/lib.js`. The tool fronts the new `/api/v1/grc-assessment-runs` REST surface, records durable assessment-run metadata, and routes approved model/reassess work through the shared derivation-backed engine rather than a second assessment engine. The read prefix `/api/v1/grc-assessment-runs` was also added to the `gc_query` allowlist and documented in ADR-035 and `mcp/ground-control/README.md`. This is an additive `mcp_tool` / public-API / workflow-skill surface covered by existing classifier path logic; the user-facing contract lives in `docs/API.md`, `docs/DEVELOPMENT_WORKFLOW.md`, `mcp/ground-control/README.md`, and `skills/assess/SKILL.md`. The documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-05 (issue #1124 GC-GRC-011 in-loop control implementation gate).** Extended the `gc_test_quality_review` rubric (`buildTestQualityReviewPrompt`) in `mcp/ground-control/lib.js` with a critical category (#7) that flags control efficacy tests which only prove existence (a `ControlTest` row / CODE link exists, a control reached `IMPLEMENTED`/`OPERATIONAL`, a snapshot contains the control UID, or a mock was called) instead of driving the protected behavior and asserting the control effect, per GC-GRC-011 acceptance criterion 3; a matching key-phrase assertion was added to `mcp/ground-control/lib.test.js`. The backend enforcement (the `ControlService.transitionStatus` evidence gate) and the workflow prose (`skills/implement/steps/step-04.4-tdd.md`, `docs/DEVELOPMENT_WORKFLOW.md`, `docs/architecture/ARCHITECTURE.md`) ship in the same change with a `changelog.d/1124.added.md` fragment. This is a change to an existing `mcp_tool` / `workflow` review-prompt surface covered by existing classifier path logic; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-05 (issue #1330 protected-path approval gate temporarily non-blocking).** Downgraded the `protected-path-approval-missing` / `battery-weakening-approval-missing` results in `tools/policy/checks.py::main` from blocking `make policy` failures to non-blocking warnings via the new `_downgrade_temp_nonblocking` helper plus `TEMP_NONBLOCKING_APPROVAL_CODES`. The `gc:design-authority-approval` marker those codes demand is currently unsatisfiable: `gc_post_design_authority_approval` refuses to post without an out-of-band `approval_token` matching an MCP-server grant that is not configured on any server we run, so the gate hard-blocked every protected-path plus implementation diff (all CI jobs depend on `policy`, dead-locking the pipeline) while `git commit/push --no-verify` bypassed the local hook entirely. Detection (`run_protected_path_authority_check`) is unchanged and still runs and prints; only the blocking exit is suppressed until the redesign tracked in #1330. This is a policy-gate exit-behavior change, not a documentation-coverage change; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-05 (issue #1277 GC-O009 deterministic core workflow payload contract).** Added `run_workflow_payload_contract_check` (plus the `_collect_x_gc_records` helper and the `WORKFLOW_CONTRACT_RECORD_DIR` / `WORKFLOW_SCHEMA_DIR` constants) to `tools/policy/checks.py` and registered it in `main`. The check enforces the ADR-082 `workflow-payload-contract` rule (owned by this issue): every Java record under the deterministic `/implement` Temporal contract package (`infrastructure/temporal/implement/contract`) maps 1:1 to an `x-gc-record`-tagged `$def` in `contracts/schemas/workflow/`, so no activity payload ships without a committed schema and no schema tag dangles. This is a policy-surface change recorded here (per the `docs/DOC_STYLE.md` convention that `tools/policy/checks.py` policy additions are ADR-054 amendments, not documentation edits); the Java/contract surface lives in `architecture/adrs/082-contract-surface-architecture.md`, `architecture/adrs/028-temporal-workflow-orchestration-boundary.md`, and `contracts/schemas/workflow/README.md`. The documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-06 (issue #1334 policy PR-comments parser one-comment fix).** Fixed `load_pr_issue_comments` in `tools/policy/checks.py` so `make policy` no longer fails with `pr-comments-json-invalid` on a PR whose thread has exactly one comment. The one-comment case makes `gh api --jq '.[]|{...}'` emit a single bare JSON object, which `json.loads` parses as a `dict`, so the newline-delimited fallback never ran and the object was rejected. The parser now accepts a lone comment object as a one-element list and decodes the multi-object fallback with `JSONDecoder.raw_decode` (also covering the `gh api --paginate` cross-page concatenation case, via the new `_decode_concatenated_comment_objects` helper). This is a policy-tooling correctness fix; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-08 (issue #1124 GC-GRC-011 GRC reconciliation project-scoping fix).** Fixed `reconcileGrcScreeningV2` in `mcp/ground-control/lib.js` to resolve the `project` from `.ground-control.yaml` (the same way the screening runner `runPostGrcScreening` does) when the caller omits it, and exported the function plus made `getRepoGroundControlContext` and `postPhaseMarker` injectable for a direct regression test in `mcp/ground-control/gc-grc-reconciled.test.js`. Before the fix, `gc_assert_completion` (which does not pass `project`) ran the reconciliation's `fetchGrcGraph(null)` unscoped, so no project entities were returned, every touched source surface read as uncovered, and the gate spuriously failed `grc_not_reconciled` even when modeled controls/threat-models cover the surface. Also added a Step 4.5 workflow instruction (`skills/implement/steps/step-04.5-clause-mapping.md`) to re-screen against the real diff after implementation, since the Step 3.5 screening runs before any code exists and otherwise leaves security relevance undetected until the post-merge reconciliation. This is a change to `mcp_tool` / `workflow` surfaces covered by the existing classifier path logic; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-08 (issue #1278 GC-O009 workflow control surface).** Registered the `gc_workflow_execution` MCP tool (handler `mcp/ground-control/gc-workflow-execution.js`; actions `start` / `get` / `list` / `signal`) plus the workflow-control API-client helpers (`startWorkflowExecution` / `listWorkflowExecutions` / `getWorkflowExecution` / `signalWorkflowExecution`) and the snake↔camel field mappings in `mcp/ground-control/lib.js` and `index.js`, backed by the new `/api/v1/workflow-executions**` REST surface (`WorkflowExecutionController` → `WorkflowExecutionService` → `WorkflowControlPort` / `TemporalWorkflowControlAdapter`). The surface starts `/implement` Temporal executions, reads execution state from Temporal Visibility plus non-secret Memo correlation data (no mirrored Postgres state machine, ADR-028), and sends the closed operator-signal catalog (`cancel` / `retry-from` / `review-cap disposition`; PR merge is observed, never signaled). Signal routes are `ROLE_ADMIN` in `ApiPathMatrix` (interim until GC-P024) with the matching `contracts/authz/path-matrix.yaml` row. Documentation lives in `docs/API.md`, `docs/DEVELOPMENT_WORKFLOW.md`, `docs/architecture/ARCHITECTURE.md`, the `index.js` tool description, and the ADR-028 boundary. This is a new `mcp_tool` / `public_api` surface covered by the existing classifier path logic; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-12 (issue #1364 ADR-089 dangling GRC prose removal).** Rewrote the `gc_test_quality_review` rubric's control-efficacy category in `mcp/ground-control/lib.js` (`buildTestQualityReviewPrompt`) into a screening-independent form, with the matching prompt-contract assertion in `mcp/ground-control/lib.test.js` and the mirrored implementer-facing rule in `skills/implement/steps/step-04.4-tdd.md`. The prior category was authored for GC-GRC-011 and conditioned on machinery ADR-089 retired: it triggered on a security control "identified for" the change (identification was the now-tombstoned Step 3.5) and routed an unimplementable control to a GC-GRC-015 disposition (removed by #1346), so its trigger could never be established and its remedy path led nowhere. The replacement keys off the diff, requiring that production logic which enforces a protection ships a test that fails when the enforcement is removed, bypassed, or materially weakened. This preserves the engineering practice ADR-089 §2 explicitly retains while dropping the GC-GRC-011 framing, the `ControlTest`-row/`ControlLink` linkage requirement, and the disposition escape hatch. The same change deletes the orphaned `backend/src/main/resources/threat-rules/stride-baseline-v1.json` rule pack (consumers removed by #1346) and replaces a `ControlControllerTest` case that stubbed the retired implementation-evidence gate with real coverage of the reachable `control_referenced` conflict. This is a change to an existing `mcp_tool` / `workflow` review-prompt surface covered by the existing classifier path logic; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-13 (issue #1385 reject `GRC` on project creation).** Removed `GRC` from the `gc_admin` `create_project` `type` enum in `mcp/ground-control/index.js` and updated the `createProject` client-helper doc comment in `mcp/ground-control/lib.js`, mirroring the backend guard added to `ProjectService.create` that rejects `type=GRC` at creation with a `project_type_grc_not_creatable` validation error (ADR-089 §4) while keeping persisted `GRC` rows readable. `docs/API.md` already documents `type` as `SOFTWARE | RESEARCH` with `GRC` as a legacy read-only value (issue #1346), so no API-doc change was needed. This is a change to an existing `mcp_tool` surface covered by the existing classifier path logic; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-13 (issue #1383 repository identity consistency + drift gate, GC-P026).** Hardened checkout-derived repository identity across the MCP surface and added a `make policy` drift gate. `mcp/ground-control/lib.js` now routes `createGitHubIssue` (a mutation, fail-closed) and `getIssueContext` (a read) through `getOwnerRepo(repoRoot|cwd, {allowGhFallback:false})`, so identity comes from the checkout's git `origin` remote and never from `process.env.GH_REPO`; a caller-supplied `repo` is validated (owner/repo shape + case-insensitive agreement with the checkout) and rejected on mismatch; `parseGroundControlYaml` now requires `github_repo` to match the `owner/repo` shape; `mcp/ground-control/index.js` `gc_create_github_issue` takes `repo_path` for checkout context; and `mcp/ground-control/gc-integrate.js` refuses with `github_identity_mismatch` when `.ground-control.yaml` `github_repo` disagrees with the checkout. `tools/policy/checks.py` gains `run_repo_identity_drift` (registered in `main`), an inventory-based gate modeled on `run_ghcr_namespace_drift` that pins active repository-identity surfaces to `autarchy-ai/Ground-Control` while exempting historical ADR/changelog references and test fixtures; `tools/tests/test_policy.py` carries its positive/negative/historical tests. Per the convention that `tools/policy/checks.py` policy additions and MCP-behavior changes are recorded here rather than as standalone documentation edits, this amendment is the durable record; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-17 (issue #1310 ACES concept-family crosswalk gate, ADR-084 §4).** `tools/policy/checks.py` gained `run_ontology_crosswalk_check` (registered in `main`, alongside `run_ontology_binding_check`) with the helpers `_safe_ontology_external_path`, `_load_ontology_family_ids`, and `_validate_crosswalk_pin`. The gate validates the new `contracts/ontology/crosswalks/aces-concept-families-v1.json` artifact: pin/hash integrity against the immutable reference snapshot under `contracts/ontology/external/aces-sdl/0.23.0/`, referential integrity of every family reference over both the Ground Control catalog and the vendored ACES snapshot, the closed effect vocabulary (`annotates|aligns|refines|constrains`), the `aligns`⇒no-divergence / `refines`⇒recorded-divergence invariant, and the stated time omission; it reads only tracked files in-process with no network, package import, or subprocess (ADR-084 §2 hermetic rule). `tools/tests/test_policy.py` carries its positive/negative fixtures. `docs/DOC_STYLE.md` is updated in lockstep to note that a new policy check records its contract in the owning ADR (here ADR-084 §4). This is a policy-surface addition; the documentation-coverage classifier (`classifyChangedSurface`), `outcome_required` mapping, Vale rule set, `tools/install-vale.sh`, and `.vale.ini` are unchanged; no new `docs/DOC_STYLE.md` style rule is established.

**2026-07-25 (issue #1416 `/implement` execution-contract gate).**
`tools/policy/checks.py` gains `run_implement_execution_contract`, registered in
`main`, to enforce the canonical principles-before-routing order, immutable
delegation tokens, the closed pause classes, same-checkout branch-tool boundary,
absence of direct worktree/branch commands, and the open-obligation completion
gate. The MCP tool descriptions for branch preparation and obligation records
name every enforced input and are covered by the live description-parity test.
The existing documentation-coverage classifier, `outcome_required` mapping,
Vale rules, installer, and `.vale.ini` are unchanged.

The issue #1416 pre-push reviews further harden the MCP mutations:
caller-supplied repository paths and origins are pinned at MCP launch, branch
checkout disables hooks and executable Git configuration, branch results omit
the raw origin URL, pickup writes use one server operation,
execution-obligation authority checks effective repository permission, and
`wontfix` requires a replayable structured record derived from an exact source
command. These are security corrections to the same documented tool surfaces;
classifier and style behavior remain unchanged.
The subsequent issue #1416 verification correction adds a binding
risk-proportionate local-test principle, reconciles the review and completion
step text, and extends the structural policy test. It changes workflow
scheduling documentation, not documentation classification, Vale rules, or
style policy.

**2026-07-26 (issue #1426 deterministic phase tool).**
`mcp/ground-control/index.js` registers `gc_implement_mechanical`, whose six
actions compose existing `/implement` primitives. Its public inputs are listed
in `mcp/ground-control/README.md` and enforced by the live
tool-description-parity test. The workflow behavior is synchronized across
ADR-021, ADR-029, ADR-031, ADR-036, the implement/quickfix skills, and workflow
documentation. The documentation-coverage classifier, `outcome_required`
mapping, Vale rules, installer, and `.vale.ini` are unchanged; no new style
rule is established.

**2026-07-26 (issue #1414 review-coverage fields).** `mcp/ground-control/lib.js`
and `mcp/ground-control/index.js` change the `gc_codex_review` /
`gc_codex_review_cycle` result shape (`diff_mode`, `review_coverage`) and the
diff-acquisition behavior behind it. The public inputs and the new output fields
are documented in `mcp/ground-control/README.md`, and the workflow behavior is
synchronized across ADR-021, ADR-029, ADR-031, ADR-036, the implement and
quickfix skills, and the workflow documents. The documentation-coverage
classifier, its `outcome_required` mapping, the Vale rules, the installer, and
`.vale.ini` are unchanged; no new documentation classification or style rule is
established.

**2026-07-26 (issue #1434 requirement identity for repository gates).**
`mcp/ground-control/lib.js` and `mcp/ground-control/index.js` add the shared
`implementGateEnvironment` helper and an additive optional
`requested_requirement_uid` input on `gc_synchronize_implement_branch`, so the
requirement under test reaches every repo-authored gate as the
`ACES_REQUIREMENT_UID` environment variable. The field is documented in the
`gc_synchronize_implement_branch` and `gc_implement_mechanical` description
strings and in `mcp/ground-control/README.md`; the execution-boundary contract
is documented in `docs/DEVELOPMENT_WORKFLOW.md` and an ADR-027 amendment, and
`docs/DOC_STYLE.md` records why a new environment variable that repository
commands depend on needs a durable record even though the field itself is only
a contract surface. The documentation-coverage classifier
(`classifyChangedSurface`), its `outcome_required` mapping, the Vale rules,
`tools/install-vale.sh`, and `.vale.ini` are unchanged; no new documentation
classification or style rule is established.

**2026-07-27 (commit-time broad-gate de-duplication).** Removed the
`vale-prose-lint`, `repo-policy`, `gradle-check`, and `openjml-esc` hooks from
`.pre-commit-config.yaml`. Each re-ran work the `/implement` completion and
policy gates already perform at Step 6 and again on the post-base-sync tree at
Step 8.5, and that the CI `policy`, `test`, and `openjml` jobs perform on every
pull request. The commit-time copy was the weakest of the three: skippable with
`--no-verify`, path-filtered so it degraded silently on diffs outside its
`files:` patterns, and producing no result any gate or workflow record could
attest to. Vale enforcement is unchanged in substance - `make policy` and the
CI policy job remain the authoritative surfaces, and both still install Vale on
first need. Layer 3 prose and the rejected "graceful skip" alternative are
updated to name those two surfaces instead of the hook. The eight hygiene and
secret-scan hooks pinned by `run_ci_strictness_contract` are untouched, as is
the ADR-025 backup-policy assertion. The documentation-coverage classifier
(`classifyChangedSurface`), its `outcome_required` mapping, the Vale rules,
`tools/install-vale.sh`, and `.vale.ini` are unchanged; no new documentation
classification or style rule is established.

> **Sync note for issue #1467 (2026-07-28, enforce the 500-LOC file-size limit):**
> The documentation-coverage classifier, its `outcome_required` mapping, the Vale
> rule set, `tools/install-vale.sh`, and `.vale.ini` are all unchanged. What moved
> is where two of this gate's trigger surfaces live: `mcp/ground-control/index.js`
> kept its bootstrap and now registers tools through `mcp/ground-control/tools/*`,
> and `tools/policy/checks.py` gained one line wiring in the new file-size gate
> (`tools/policy/file_size.py`, ADR-092). Recorded here because this ADR names
> those files as the gate's surfaces: a reader looking for a registration in
> `index.js` alone would no longer find it. No documentation classification, Vale
> rule, or style rule is established or altered by that change.

**2026-07-28 (issue #1473 async mechanical jobs).**
`gc_implement_mechanical` adds bounded `async` and `idempotency_key` inputs for
its long `verify`, `publish`, and `monitor` actions, and the existing
`gc_codex_job` surface becomes the shared review/preflight/mechanical poller.
The public shape is synchronized in the live tool-description test and MCP
README; behavior is synchronized in ADR-036, the implement/quickfix skills, and
the workflow documents. The documentation-coverage classifier,
`outcome_required` mapping, Vale rules, installer, and `.vale.ini` are
unchanged. This amendment records a changed MCP/workflow contract; it adds no
documentation classification or style rule.

**2026-07-30 (#1434 follow-up: auto-resolve the requirement UID for repository
gates).** `authorizeRequestedRequirementUid` in
`mcp/ground-control/lib/codex-workflow-3.js` (re-exported by the
`mcp/ground-control/lib.js` barrel) now resolves an issue's sole in-scope
requirement UID from its `## Requirements` section when the caller omits
`requested_requirement_uid`, so the shared repository gates (`verify`,
`publish`, and base-sync completion) receive requirement-governance context even
on a branch named for the issue number rather than the UID. Zero
(requirement-free) or multiple (ambiguous) in-scope requirements resolve to no
UID, and an explicit UID is still validated against the issue and still blocks
on an unreadable issue. This changes only the requirement-context environment
carried into the gate subprocess. The documentation-coverage classifier
(`classifyChangedSurface`), its `outcome_required` mapping, the Vale rules,
`tools/install-vale.sh`, and `.vale.ini` are unchanged; no new documentation
classification or style rule is established.

**2026-08-19 (#1535, maintainer `/review` lane).** The lane registers two MCP
tools (`gc_get_pr_review_context`, `gc_remediate_pull_request`) in
`mcp/ground-control/tools/pr-review.js`, wired in `mcp/ground-control/index.js`;
their contract surface is the tool descriptions, the MCP README section, and
`skills/review/SKILL.md`. This records a changed MCP tool/registration surface.
The documentation-coverage classifier (`classifyChangedSurface`), its
`outcome_required` mapping, doc targets, the Vale rule set,
`tools/install-vale.sh`, and `.vale.ini` are unchanged; edits to
`skills/review/` are gated by the ADR-021 `workflow-guardrail-sync` rule (which
requires the two workflow documents plus a gate-model ADR), not by a new
documentation-coverage surface class, and no new style rule is established.
