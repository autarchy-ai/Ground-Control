---
id: GC-O007
title: "Gated Agentic Development Loop"
status: ACTIVE
type: FUNCTIONAL
priority: MUST
wave: 2
created_at: 2026-04-05T18:56:23.312401Z
updated_at: 2026-08-14T02:33:44+02:00
---

# GC-O007 — Gated Agentic Development Loop

## Statement

The system's agentic development workflow shall enforce a gated loop with the following mandatory phases and the GitHub issue thread as the durable record:

(A) Plan and Implement: The agent shall fetch the requirement from Ground Control, create and link a GitHub issue, explore existing codebase coverage, produce an implementation plan, post the plan as a comment on the GitHub issue, and proceed directly to TDD without waiting for synchronous user approval. Implementation shall verify clause-by-clause against the requirement statement.

(B) Quality Gate: Before publishing, the agent shall pass the configured completion command and repository policy command, complete clause-by-clause mapping, and satisfy the repository's quality gates. Release Please owns `CHANGELOG.md` and product-version updates; feature work supplies a valid Conventional Commit title instead of editing release artifacts directly. The requirement-status transition to ACTIVE and the IMPLEMENTS/TESTS traceability edits are made in the requirement files as part of the delivery diff before publish, so they are reviewed in — and become authoritative through — the delivery pull request (issue #1541). Pre-merge readiness names that state as proposed, not authoritative.

(C) Review, Stage, Commit, Push, and Synchronize: Before the first push, the agent shall run the configured pre-push Codex and test-quality review cycles against the complete local diff, fix findings locally with proportionate self-verification, and re-stage as directed by the bounded review contract. It shall then run the configured pre-commit command, commit and push the feature branch, synchronize it with the latest integration branch, and re-verify the synchronized tree before PR creation.

(D) Ship Pipeline: The agent shall create a synchronized PR, monitor CI, validate the SonarCloud quality gate, and present the PR for human review and merge with a pre-merge readiness record (the Phase D terminal signal). The agent shall not merge PRs.

(E) Post-Merge Validation: After the user merges the PR, the agent — re-invoked on the issue — shall perform no requirement-file mutation. It shall resolve the linked pull request's immutable target-branch merge revision and verify every in-scope requirement at that revision (exact UID path, frontmatter id, expected lifecycle status, and required traceability), failing closed before the final report on any missing file, malformed record, UID mismatch, status mismatch, or missing required traceability. Only on success shall it post the reconciled final report and close the issue. Each step is gated on the linked PR being merged (merged_at non-null AND state MERGED); the merged tree, not caller-supplied status, is the authority, so a reviewed-but-abandoned PR leaves the requirement DRAFT and the issue open (issue #1541, superseding the #963 post-merge mutation ordering).

Within Phase A, the agent shall select one TDD path for every requirement clause or acceptance criterion: new requirement/feature, shipped-code bug fix, reviewer-finding fix, or prose-only/static contract narrowing. Issue-level feature/bug-fix/mixed intent is informational; the plan's clause-level path is authoritative. A shipped-code bug fix shall reproduce the reported defect with a failing test against the unmodified buggy tree before repair and shall not use the documentation-only carve-out for runtime-consumed configuration, schemas, grammars, fixtures, or policy data. A reviewer finding fixed in executable code or a runtime-consumed data contract shall carry proportionate regression evidence that fails when the defect is reintroduced. Because cycle decision records are written before fixes, the post-fix test evidence belongs to the agent's self-verification record rather than the earlier decision rationale.

The Codex review loop is a single pre-push pass (Step 6.5) hard-capped per issue at a configurable cycle count (default 1 per issue #906; configurable via `workflow.codex_review.pre_push_cap` in `.ground-control.yaml`; bounds [1, 10]). The counter is anchored to the GitHub issue thread; the branch is recorded in the marker for audit context but is not part of the cap key, so a branch rename on the same issue cannot reset the counter. Last-in-cap-cycle findings shall be fixed and self-verified; the cap forbids running an over-cap cycle as a verification pass — any concern remaining after fixing last-in-cap findings shall be escalated to the user as an issue-thread comment, not addressed in an over-cap cycle. The `override_cap=true` + `override_reason=<authorization quote>` escape lets the user authorize a single over-cap cycle on demand, regardless of the configured default. Every successful Codex review cycle posts a verbatim findings record to the resolved issue thread (durable per ADR-029); a failed findings post returns a structured review_comment_post_failed result so the cycle is not consumed and the run is retried after the underlying GitHub issue is resolved. The post-push tool entrypoint (gc_codex_review with a pr_number) remains as defense-in-depth for direct callers but the SKILL no longer drives a separate post-push review pass — merge-commit drift relative to the target branch is the responsibility of CI (compile/tests/integration) and SonarCloud (quality). Codex remains the reviewer of record regardless of whether Claude Code, Codex, or a future Temporal worker drives the workflow; review tools always route through gc_codex_review, gc_codex_verify_finding, and gc_codex_architecture_preflight.

When `workflow.review_disposition.enabled` is true (default false; with it absent or false the cap behavior above is byte-for-byte unchanged, and the human `override_cap` escape remains the only over-cap path), the agent shall, after fixing and self-verifying the last-in-cap-cycle findings and re-staging, call the `gc_review_cap_disposition` MCP tool to obtain an automated disposition of the cap boundary in place of immediately escalating to the user. The tool scores the post-fix change deterministically (diff size, changed-surface class, finding shape, and prior auto-overrides) and returns one of `proceed`, `one_more_cycle`, or `escalate_to_human`; a gray-zone LLM judge may rank only the residual undecided band, never override the deterministic ceiling or fast paths. On `proceed` the agent advances to Phase C; on `escalate_to_human` it escalates to the user exactly as without the gate; on `one_more_cycle` it runs exactly one server-authorized over-cap cycle whose authority is a durable `gc:review-auto-disposition` marker the tool posts (schema `gc.implement.review-auto-disposition/v1`), not agent-supplied `override_reason` text — `gc_codex_review_cycle` / `gc_test_quality_review_cycle` verify that marker via an `auto_grant=true` parameter before honoring the over-cap cycle. A hard ceiling (`max_auto_overrides`, default 1), enforced in the scorer and re-clamped after any judge, bounds automated over-cap cycles so the auto path can never grant a second over-cap cycle; beyond it only the human `override_cap` escape proceeds. `mode: shadow` (default) posts the disposition for agreement-building but still escalates to the user; `mode: authoritative` lets the disposition drive control flow. This gate is enforced at the MCP layer (ADR-031 / ADR-029 amendments, issue #1245) and changes only the cap-boundary disposition; the one-human-touchpoint contract (PR merge), the per-issue cycle counter, the verbatim findings record, and the zero-deferral rule are unchanged.

The workflow shall have exactly one human touchpoint: PR merge. Plan, review findings, and decisions on findings (fix / wontfix / not-applicable, each with a one-line rationale) shall be recorded as comments on the GitHub issue thread so the durable record survives PR merge/close. Agent silence on a finding is a process violation. `defer` is not a valid decision: all reviewer findings shall be fixed before the PR is presented; deferring a finding violates the workflow contract. All other gates are automated and enforced by the agent toolchain.

## Rationale

Ground Control's value proposition depends on agents maintaining traceability and quality gates as a side effect of normal development. The original GC-O007 (ADR-021) specified two human touchpoints — plan approval and PR merge — but empirically the plan-approval gate had >95% accept-as-is rate and added coordination tax without affecting outcomes. ADR-029 amends the contract to one human touchpoint (PR merge) and promotes the GitHub issue thread to the durable record of plan, review findings, and decisions on findings. Issue #804 collapses the previous two-step Codex review (pre-push Step 6.5 + post-push Step 12) into a single pre-push pass, bumps the cycle cap from 2 to 3 (one combined pass keeps the net iteration bound tighter than the old 2+2=4 across two steps while restoring "review feels like a real review, not a hot-cap" headroom), and makes every successful cycle post a verbatim findings record to the resolved issue thread so the durable record never depends on the agent's separate decision-summary comments. Issue #906 (2026-05) drops the default pre-push cap from 3 to 1 based on empirical observation that cycle 1 catches the production-readiness issues that matter while cycles 2–3 often surface defects the agent introduced WHILE fixing cycle 1's findings (compounding cost rather than catching net-new bugs); CI / SonarCloud / the human reviewer cover residual risk. The cap is configurable per repo (`workflow.codex_review.pre_push_cap`, bounds [1, 10]) for callers who want the older multi-cycle behavior. ADR-027 packages the workflow so it can be driven by Claude Code or Codex from a single canonical SKILL.md parameterized by .ground-control.yaml; ADR-029 ensures the gate model is uniform across drivers and repos. ADR-021 is amended (not superseded). GC-O009's eventual Temporal workflow consumes the same configuration model and preserves the same gate contract. Issue #963 (2026-06) moves the requirement DRAFT→ACTIVE transition, traceability reconciliation, and the reconciled final report from Phase D (pre-merge) to a new Phase E (post-merge), extending the #1058 post-merge close-ordering guarantee to the rest of the Ground Control state so a reviewed-but-abandoned PR never leaves a requirement ACTIVE with links to code that never shipped; mechanically gated by gc_assert_completion's phase parameter (post_merge is merge-gated; pre_merge posts the Phase D readiness record). Issue #1245 (2026-06) adds an optional, default-off automated review-cap disposition gate (`workflow.review_disposition`): rather than every over-cap boundary stopping for the user, the agent may call `gc_review_cap_disposition` after fixing the last-in-cap findings to get a deterministic `proceed` / `one_more_cycle` / `escalate_to_human` disposition, with a hard `max_auto_overrides` ceiling (default 1), authority carried by a durable `gc:review-auto-disposition` marker rather than agent text, and a `shadow` default mode that posts the disposition but still escalates while agreement data accrues. The goal is to cut the friction of always-asking while keeping runaway review cycles bounded; the cap evaluators, counter, and one-human-touchpoint contract are unchanged.

## Traceability

- DOCUMENTS → DOCUMENTATION `docs/DEVELOPMENT_WORKFLOW.md` (Development Workflow documentation)
- DOCUMENTS → DOCUMENTATION `docs/WORKFLOW.md` (Workflow navigation page pointing at the owning references)
- DOCUMENTS → ADR `architecture/adrs/021-gated-agentic-development-loop.md` (ADR-021: Gated Agentic Development Loop)
- IMPLEMENTS → CODE_FILE `.claude/agents/completion-verifier.md` (Completion verifier agent)
- IMPLEMENTS → CODE_FILE `.claude/rules/implementation-quality.md` (Implementation quality rules)
- IMPLEMENTS → CODE_FILE `.claude/rules/review-standards.md` (Review fix standards (zero-deferral policy))
- IMPLEMENTS → PULL_REQUEST `938` (PR #938 — async job envelope + MCP client timeout fix for codex review/preflight gates)
- IMPLEMENTS → GITHUB_ISSUE `803` (Issue #803 — gc_watch_ci_run MCP tool (implemented by PR #935))
- IMPLEMENTS → CODE_FILE `skills/implement/SKILL.md` (/implement skill (canonical, agent-neutral))
- IMPLEMENTS → CODE_FILE `bin/install-skills.sh` (install-skills.sh distribution script)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib.js` (MCP server lib (cycle/phase enforcement, schema))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/server-runtime.js` (MCP server tool registration (gc_codex_review/_verify_finding/_post_implementation_plan); moved out of index.js when the entry point became an environment bootstrap (issue #1562))
- DOCUMENTS → ADR `architecture/adrs/027-agent-neutral-implement-workflow-packaging.md` (ADR-027: Agent-Neutral Implement Workflow Packaging)
- DOCUMENTS → ADR `architecture/adrs/029-issue-thread-gate-model.md` (ADR-029: Issue-Thread Gate Model (amends GC-O007))
- IMPLEMENTS → POLICY `architecture/policies/adr-policy.json` (ADR-021 workflow-guardrail-sync rule (covers canonical SKILL.md per ADR-027))
- IMPLEMENTS → GITHUB_ISSUE `937` (Issue #937 — async job envelope + MCP client timeout fix for codex review/preflight gates)
- DOCUMENTS → ADR `architecture/adrs/036-per-step-routing-tool-surfaces-telemetry.md` (ADR-036: Per-Step Routing, Durable-Record Tool Surfaces, Step Telemetry (amends ADR-021))
- DOCUMENTS → DOCUMENTATION `architecture/notes/implement-cost-routing-tool-surfaces-preflight.md` (Preflight design note for issue #868 (codex architecture preflight))
- TESTS → TEST `tools/render_pr_body_fixture.mjs` (Renderer-vs-check_pr_body subprocess fixture (binds JS renderer to Python policy))
- IMPLEMENTS → CONFIG `.ground-control.yaml` (Repo config opting in to routing.enabled + telemetry.enabled (ADR-036))
- IMPLEMENTS → CODE_FILE `tools/policy/checks.py` (run_step13_decision_record_contract — make policy structural gate (#884))
- DOCUMENTS → DOCUMENTATION `architecture/notes/test-quality-clean-continuation-preflight.md` (Issue #884 architecture preflight note (test-quality clean continuation))
- DOCUMENTS → DOCUMENTATION `architecture/notes/test-quality-review-engine.md` (Test-quality review engine — mechanism / auth / failure modes (#884 v2))
- DOCUMENTS → DOCUMENTATION `architecture/notes/launch-directory-env-authority-preflight.md` (Issue #1562 binding-guardrails note — the launch directory's .env is the only source of Ground Control's variables)
- IMPLEMENTS → PULL_REQUEST `935` (PR #935 — Thin /implement orchestrator + server-side workflow loops)
- IMPLEMENTS → CODE_FILE `skills/implement/steps/_review-loop-rules.md` (Canonical pre-push review loop rules (Step 6.5 / 6.6 dedup destination))
- DOCUMENTS → DOCUMENTATION `architecture/notes/implement-thin-orchestrator-server-side-loops-preflight.md` (Issue #934 codex preflight binding-guardrails note)
- IMPLEMENTS → PULL_REQUEST `1195` (feat: add dev-start plan gate)
- DOCUMENTS → DOCUMENTATION `skills/implement/steps/step-04-planning.md` (Planning step dev-start gate instructions)
- IMPLEMENTS → DOCUMENTATION `skills/implement/steps/step-04-planning.md` (/implement Step 4: structural-gate-runs-need-GC-requirement rule (PR #986))
- IMPLEMENTS → PULL_REQUEST `986` (Step 4: structural-gate runs need a GC requirement, even when issue is requirement-free)
- DOCUMENTS → PULL_REQUEST `1035` (Document Sonar strict-profile standard + roll out strict profiles across both orgs)
- CONSTRAINS → CONFIG `tools/sonar/profiles` (SonarCloud strict-profile XML backups (brad-edwards + keplerops))
- DOCUMENTS → DOCUMENTATION `docs/CODING_STANDARDS.md#static-analysis-thresholds-sonarcloud` (Coding Standards: Static Analysis Thresholds (SonarCloud))
- IMPLEMENTS → CODE_FILE `skills/implement/steps/step-20-close-issue-on-merge.md` (/implement Step 20 (Phase E): post-merge close via gc_close_issue_after_merge (#1058))
- IMPLEMENTS → GITHUB_ISSUE `1058` (Issue #1058 — Enforce traceability + post-merge issue close at the MCP tool layer (GC-O007))
- IMPLEMENTS → PULL_REQUEST `1060` (PR #1060 — Traceability + post-merge close gates at MCP tool layer (#1058))
- IMPLEMENTS → GITHUB_ISSUE `1194` (Add repo-configured dev-start plan gate)
- IMPLEMENTS → GITHUB_ISSUE `1156` (Issue #1156 — Explain Phase D outcome and recommend next issue in Phase E)
- IMPLEMENTS → PULL_REQUEST `1157` (PR #1157 — Phase D outcome and Phase E next-issue recommendation (#1156))
- IMPLEMENTS → GITHUB_ISSUE `1102` (Issue #1102 — Enforce documents traceability coverage for draft in-scope requirements)
- IMPLEMENTS → PULL_REQUEST `1158` (PR #1158 — Documentation coverage gate for draft in-scope requirements (#1102))
- IMPLEMENTS → DOCUMENTATION `skills/implement/steps/step-06-completion-gate.md` (/implement Step 6 explicit in-scope requirements completion gate)
- DOCUMENTS → DOCUMENTATION `docs/DOC_STYLE.md` (Documentation style note for #1102 gate-doc extension)
- DOCUMENTS → ADR `architecture/adrs/054-documentation-coverage-gate.md` (ADR-054 amendment: in-scope documentation coverage gate)
- IMPLEMENTS → CODE_FILE `skills/implement/steps/step-17-completion.md` (/implement Step 17 consolidated completion step (gc_assert_completion) (#1103))
- DOCUMENTS → DOCUMENTATION `architecture/notes/implement-completion-record-consolidation-preflight.md` (Issue #1103 codex architecture preflight binding-guardrails note)
- IMPLEMENTS → GITHUB_ISSUE `1103` (Issue #1103 — Consolidate /implement Phase D tail into gc_assert_completion)
- DOCUMENTS → DOCUMENTATION `skills/implement/steps/step-09-pr-body.md` (PR body dev-start gate instructions)
- IMPLEMENTS → PULL_REQUEST `496` ([codex] Enforce ADR conformance across repo tooling)
- IMPLEMENTS → CODE_FILE `skills/implement/steps/step-15-transition.md` (/implement Step 15 (Phase E): post-merge requirement DRAFT→ACTIVE transition (#963))
- IMPLEMENTS → CODE_FILE `skills/implement/steps/step-16-reconcile.md` (/implement Step 16 (Phase E): post-merge traceability reconciliation (#963))
- DOCUMENTS → DOCUMENTATION `architecture/notes/implement-phase-d-context-reduction-preflight.md` (Issue #963 codex architecture preflight binding-guardrails note)
- IMPLEMENTS → GITHUB_ISSUE `963` (Issue #963 — /implement transition + reconcile post-merge (Phase E))
- DOCUMENTS → GITHUB_ISSUE `802` (Validate PR body against GC policy template before `gh pr create`)
- DOCUMENTS → GITHUB_ISSUE `804` (Collapse codex review to single pre-push pass; bump cap to 3; post findings to issue thread)
- IMPLEMENTS → GITHUB_ISSUE `796` (Cap pre-push gc_codex_review cycles (Step 6.5))
- IMPLEMENTS → GITHUB_ISSUE `794` (Enforce workflow caps and ordering at the tool layer, not in skill prose)
- IMPLEMENTS → PULL_REQUEST `812` (Sync gc_codex_review tool descriptions with live cap constants)
- IMPLEMENTS → GITHUB_ISSUE `868` (/implement cost: per-step routing + tool surfaces for durable records + step telemetry)
- IMPLEMENTS → PULL_REQUEST `869` (Per-step model routing + durable-record tool surfaces + step telemetry (ADR-036))
- IMPLEMENTS → GITHUB_ISSUE `1416` (Harden /implement execution principles and persistence)
- IMPLEMENTS → GITHUB_ISSUE `1421` (Require /implement to synchronize origin/dev before opening a PR)
- IMPLEMENTS → PULL_REQUEST `1424` (Require dev synchronization before PR creation)
- DOCUMENTS → DOCUMENTATION `architecture/notes/implement-pre-pr-remote-base-sync-preflight.md` (Pre-PR remote-base synchronization design note)
- IMPLEMENTS → CODE_FILE `skills/implement/steps/step-08.5-sync-base.md` (/implement Step 8.5: synchronize origin/dev before PR creation)
- DOCUMENTS → ADR `architecture/adrs/031-codex-review-stopping-model.md` (ADR-031: sliced review of an over-cap diff; coverage fails closed (#1414))
- DOCUMENTS → DOCUMENTATION `architecture/notes/codex-manifest-review-evidence-preflight.md` (Issue #1414 codex architecture preflight binding-guardrails note)
- IMPLEMENTS → CODE_FILE `skills/implement/steps/step-06.5-codex-review.md` (/implement Step 6.5: coverage-failure dispatch and sliced-review notes (#1414))
- DOCUMENTS → DOCUMENTATION `mcp/ground-control/README.md` (MCP README: diff_mode / review_coverage and the untracked consent boundary (#1414))
- IMPLEMENTS → GITHUB_ISSUE `1414` (Issue #1414 — gc_codex_review manifest mode returned a verdict without reading any per-file diff)
- IMPLEMENTS → PULL_REQUEST `1430` (PR #1430 — review every slice of an over-cap diff instead of a manifest (#1414))
- DOCUMENTS → ADR `architecture/adrs/090-production-line-measurement-model.md` (ADR-090: measurement semantics for the gated loop's step and workflow-run telemetry (measurement-model-sync policy gate))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/gc-implement-mechanical.js` (Mechanical execution bands; requirement-identity gate environment and authorization (#1434))
- IMPLEMENTS → PULL_REQUEST `1443` (PR #1443 — carry requirement identity into repository gates, bound to the issue (#1434))
- TESTS → TEST `tools/tests/test_policy_implement_execution.py` (Policy tests covering the /implement execution contract (ADR-021 workflow-guardrail sync))
- TESTS → TEST `mcp/ground-control/lib.evaluatecodexreviewprepushcyclecap.test.js` (Pre-push review cycle-cap enforcement tests (per-issue counter, override escape))
- TESTS → TEST `mcp/ground-control/gc-implement-mechanical.runimplementmechanical-publish.test.js` (Mechanical band tests; requirement-UID authorization enforcement at bootstrap, verify, publish (#1434))
- TESTS → TEST `mcp/ground-control/gc-implement-base-sync.synchronized-pr-gate.test.js` (MCP branch synchronization and synchronized PR creation tests)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/review-reattempt.js` (Bounded non-verdict station retry policy (#1476))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/execution-obligation-v2.js` (Execution-obligation v2 marker codec; station-observation binding (#1476))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/station-observation-records.js` (Durable station-observation records: open, reobserved, escalate (#1476))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/station-observation-seam.js` (Station-observation orchestration for the review cycle seam (#1476))
- TESTS → TEST `mcp/ground-control/lib.review-reattempt-policy.test.js` (Retry-policy, attempt-boundary, and unobserved-station escalation tests (#1476))
- TESTS → TEST `mcp/ground-control/gc-implement-contract.station-observation-ledger.test.js` (v1/v2 ledger coexistence, cross-family isolation, reobservation attestation tests (#1476))
- TESTS → TEST `mcp/ground-control/lib.non-verdict-retry-config.test.js` (non_verdict_retry_limit config parsing and bounds tests (#1476))
- DOCUMENTS → DOCUMENTATION `architecture/notes/unobserved-station-recovery-preflight.md` (Issue #1476 codex architecture preflight binding-guardrails note)
- IMPLEMENTS → GITHUB_ISSUE `1476` (Issue #1476 — an unobserved gate could only be cleared by human authorization)
- IMPLEMENTS → PULL_REQUEST `1477` (PR #1477 — bounded re-attempt and tool-attested re-observation for unobserved stations (#1476))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/merged-requirement-state.js` (Merge-verified requirement-state validator — post-merge Phase E authority (#1541))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/requirement-files.js` (readRequirementAtRevision: immutable-revision requirement reader (#1541))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/assert-completion.js` (post-merge merged-requirement-state verification wired into runAssertCompletion (#1541))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/close-issue.js` (final-report marker close gate + merge-commit OID resolution (#1541))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/pr-body-render.js` (non-closing Refs #n for requirement-backed runs (#1541))
- TESTS → TEST `mcp/ground-control/lib.merged-requirement-state.test.js` (immutable-revision reader + merged-state verifier tests (#1541))
- TESTS → TEST `mcp/ground-control/gc-assert-completion.merged-requirement-state.test.js` (post-merge verification integration + DRAFT-cannot-report-ACTIVE regression (#1541))
- DOCUMENTS → DOCUMENTATION `architecture/notes/merge-verified-requirement-state-preflight.md` (Issue #1541 codex architecture preflight binding-guardrails note)
- DOCUMENTS → ADR `architecture/adrs/093-requirements-specs-as-code.md` (ADR-093 amendment: delivery + completion authority (#1541))
- IMPLEMENTS → GITHUB_ISSUE `1541` (Issue #1541 — align specs-as-code requirement transitions with merged Phase E state)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/issue-requirements-scope.js` (Shared Requirements-section parser and bounded section transformer (#1569))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/issue-requirements-writer.js` (gc_update_issue_requirements: repository-bound writer for an issue's in-scope UID list (#1569))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/requirement-files.js` (readRequirementIdentity: strict working-tree requirement identity for the scope write gate (#1569))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/issue-thread.js` (Targeted issue-thread cache invalidation after a body mutation (#1569))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/filesystem-lease.js` (Issue-scope read-modify-write lease serializing concurrent scope updates (#1569))
- IMPLEMENTS → CODE_FILE `mcp/ground-control/tools/query.js` (Thin zod registration of gc_update_issue_requirements (#1569))
- IMPLEMENTS → CODE_FILE `tools/policy/implement_scope_contract.py` (implement-scope-writer-tool policy anchor for Step 1 and Step 4 (#1569))
- TESTS → TEST `mcp/ground-control/lib.issue-requirements-scope.test.js` (Section transformer: byte preservation, monotonic add, explicit remove, parser round-trip (#1569))
- TESTS → TEST `mcp/ground-control/gc-update-issue-requirements.test.js` (Writer: bounded section rewrite, idempotence, requirement identity (#1569))
- TESTS → TEST `mcp/ground-control/gc-update-issue-requirements.authorization.test.js` (Writer: repository binding, trusted removal authorization, public-text refusals, cache coherence, scope lease (#1569))
- TESTS → TEST `mcp/ground-control/gc-update-issue-requirements.fixture.test.js` (Shared hermetic fixture and its gh-shim self-check (#1569))
- TESTS → TEST `tools/tests/test_policy_issue_requirements_tool.py` (Policy test for the scope-writer prose anchor (#1569))
- TESTS → TEST `mcp/ground-control/lib.requirement-identity.test.js` (Strict requirement identity: raw frontmatter id, symlinked-ancestor refusal (#1569))
- DOCUMENTS → DOCUMENTATION `architecture/notes/issue-requirements-section-writer-preflight.md` (Issue #1569 codex architecture preflight binding-guardrails note)
- IMPLEMENTS → GITHUB_ISSUE `1569` (Issue #1569 — an MCP tool that writes an issue's Requirements section)

## Historical traceability

Links below named artifacts the #1500 re-platform deleted. They are kept for
provenance and are outside the parsed `## Traceability` section, so no tool reads
them as live evidence. Do not infer current implementation from them.

- DOCUMENTS → DOCUMENTATION `docs/API.md` (API documentation for documentation_link_missing activation errors)
- TESTS → TEST `mcp/ground-control/gc-grc-reconciled.test.js` (GRC final-report prerequisite tests updated for plainEnglishOutcome (#1156))
- IMPLEMENTS → CODE_FILE `backend/src/main/java/com/keplerops/groundcontrol/domain/requirements/service/RequirementService.java` (RequirementService DRAFT-to-ACTIVE DOCUMENTS coverage enforcement)
- IMPLEMENTS → CODE_FILE `backend/src/main/java/com/keplerops/groundcontrol/domain/qualitygates/repository/QualityGateRepository.java` (QualityGateRepository active DOCUMENTS coverage gate lookup)
- TESTS → TEST `mcp/ground-control/gc-assert-quality-gates.test.js` (MCP quality-gate tests for in-scope DOCUMENTS coverage)
- TESTS → TEST `backend/src/test/java/com/keplerops/groundcontrol/unit/domain/RequirementServiceTest.java` (RequirementService tests for DRAFT activation DOCUMENTS coverage)
- TESTS → TEST `mcp/ground-control/gc-assert-completion.test.js` (gc_assert_completion composition tests (#1103))
- IMPLEMENTS → GITHUB_ISSUE `1557` (Issue #1557 — pre-push reviewer prompt separates review scope from repository evidence (clause (C)))
