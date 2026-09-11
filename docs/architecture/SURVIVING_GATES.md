# Surviving gate inventory and placement doctrine

This is the current enforcement inventory after the #1500 MCP-only re-platform
and the issue #1303 reconciliation. It covers repository policy, local hooks,
GitHub Actions and protection, `/implement`, and all 32 registered MCP tools.
Historical ADR text is not evidence that a gate still exists.

## Placement doctrine

1. **Put deterministic repository invariants in repository policy.** A check that
   can decide from tracked files belongs in `bin/policy`, runs through `make
   policy`, and is repeated by the required CI `policy` job. Its declaration and
   implementation must be two-sided and fail closed on malformed input.
2. **Put privileged state transitions at the MCP boundary.** GitHub and Git
   mutations bind the caller's checkout, issue, PR, branch, and observed OIDs
   server-side. Skill prose sequences these tools; it is not authority by itself.
3. **Keep human authority explicit.** A human merges the delivery PR and grants
   any `wontfix` or review-cap override. A marker rendered and verified by the MCP
   server records that authority; caller prose does not create it.
4. **Treat hooks and advisory jobs as early feedback.** They may be bypassed or
   absent on another driver. Their authoritative invariant must also exist in
   policy, an MCP boundary, required CI, or the human merge gate.
5. **Separate intent from live evidence.** The branch-protection baseline is
   tracked intent. `make branch-protection-check` is the authenticated live read.
   An unevaluable read is neither a match nor drift.
6. **Do not project gate results into another authority.** There is no backend,
   database, GRC graph, workflow-run store, or measurement plane. A gate's owner
   decides it once; issue-thread records preserve decisions without re-enforcing
   them.

In the tables, **input** means the authority-bearing data the control reads;
**bypass** means an intentional exception; **failure** describes how it refuses
or becomes unevaluable; **cost/history** explains why the placement survives.
Unless a row names a different cost, policy gates perform one bounded local scan
per policy/CI run, hooks run locally once per invocation, hosted controls consume
one job or authenticated read, and MCP tools perform bounded file/Git/GitHub or
Sonar I/O. Review tools additionally consume one configured model cycle. A row
without an escaped-defect example had none in this audit; it survives because
its authority placement is necessary, not because history was invented.

## Repository policy gates

All rows are **KEEP in `tools/policy/`**, invoked by `bin/policy`, `make policy`,
and required CI unless a row says otherwise.

| Gate | Invariant and input | Bypass, failure, cost/history |
|---|---|---|
| ADR guard | Changed governed surfaces update their owning ADR/docs. Input: changed paths plus `architecture/policies/adr-policy.json`. | Release PRs do not bypass it; malformed policy fails. Survives because architectural coupling is repo-local. |
| Version-mirror consistency | Root manifest is strict SemVer; configured mirrors equal it and resolve inside the checkout. Input: both Release Please files. | No malformed-entry or outside-path skip. Independent package versions are excluded declaratively. Relocated from stale backend/frontend literals to the surviving root config. |
| Repository identity drift | Configured repository identity matches the canonical tracked identity. | No ambient-repository override. Prevents privileged tools or policy from targeting a sibling repository. |
| Workflow-routing contract | Advisory stage ids, tiers, and providers match skill/config vocabulary. | Routing may be disabled; malformed enabled config fails. Kept for driver compatibility, never used as gate-result authority. |
| `/implement` execution contract | Skill/steps retain the immutable principles, ordering, MCP boundaries, and tombstones. | No driver-specific prose escape. Structural scan cost is small and prevents workflow weakening. |
| Test-quality decision-record contract | Reviewer separation and durable decision-record instructions stay aligned. | Human-authorized dispositions remain explicit; missing anchors fail. |
| Scan floor | Structural scanners must inspect a non-zero governed surface. | No “green because nothing was scanned” path. This is the common fail-closed floor. |
| Documentation-coverage anchors | Runtime/config surface changes name current docs and required outcome evidence. | Release PR body exemption does not exempt changed-file documentation coverage. |
| Sonar strictness | Sonar workflow/config retain strict quality-gate and issue behavior. | Repository without Sonar config is outside this repo's current declaration; malformed config fails. |
| Required-context contract | Required set equals the baseline; every local context has an unfiltered PR producer for every protected branch; strictness is true; hosted allowlist is a subset; provider map covers exactly. | Only two declared hosted contexts bypass local production. Unsupported/malformed triggers and path filters are non-producers. Rebuilt outside the deleted topology tests. |
| PR-title contract | `.ground-control.yaml` title types/scope/subject match the pinned PR-title Action configuration. | The hosted job is advisory, not an authority; policy drift is fatal. Relocated here to prevent two vocabularies. |
| GitHub Action pin contract | Every external `uses:` reference in every workflow is a 40-hex commit SHA and at least one reference is scanned. | Local actions are exempt. Zero scan and floating tags fail. Added because pinning prose had no prior repo-native owner. |
| File-size limit | Governed source files remain within the 500-LOC architecture limit. | Explicit governed exclusions only; split behavior rather than suppressing the check. |
| Requirement frontmatter | Every requirement path and frontmatter id/status/type contract is valid. | No backend fallback. Repo-local specs are the only requirement authority. |
| Repository-map freshness | The README repository map equals the current tracked top-level tree. | Update the map when the tree changes; do not hand-wave drift. Keeps comprehension evidence current, not execution state. |
| PR-body and no-deferral contract | A non-release PR carries the canonical sections, requirement refs, test evidence, docs outcome, and no invalid deferral language. Input: server-fetched PR body or an explicit trusted fixture. | Positively identified Release Please, promotion, and main-to-dev sync PRs bypass the feature-body shape. Missing body is not fabricated. |
| Changed-doc coverage | Changed governed surfaces have their required documentation outcome. | Release PRs bypass only aggregate-body ceremony; file-based coverage still runs. |

## Local hook and driver checks

| Surface | Invariant and input | Decision, bypass, failure, cost/history |
|---|---|---|
| Pre-commit: trailing whitespace, EOF, YAML, JSON, large files, merge markers, private keys, Bash syntax, gitleaks | Fast hygiene/security over the tracked tree. Input: `.pre-commit-config.yaml`. | **KEEP as early feedback.** `--no-verify` is possible, so required CI runs `pre-commit run --all-files`. CI's former manual partial hook list was deleted. |
| Pre-push: PR-body policy | Existing PR body matches policy before push. | **KEEP as early feedback.** No PR means no remote object to check; MCP creation and required CI are authoritative. |
| `scripts/install-hooks.sh` | This clone's effective Git dispatcher reaches managed pre-commit and pre-push hooks, then all-file hooks pass. | **KEEP as activation proof.** It refuses unmanaged/symlink hooks unless the operator chooses `--force`; fresh clones rerun it. |
| Claude `protect_files.sh` | Edit/write calls do not touch protected repository files. Input: project tool payload. | **KEEP driver-only.** Other drivers may not load it; filesystem permissions and review remain authoritative. |
| Claude `git-merge-guard.py` | Blocks PR/protected-branch merges, destructive reset, raw force; permits only the documented dev-to-feature maintenance merge. | **KEEP driver-only.** MCP boundaries and human merge ownership remain authoritative. |
| Claude `block-defer-language.py` | Blocks GitHub commands that attempt an invalid deferral disposition. | **KEEP driver-only early warning.** PR-body policy and decision tools enforce the durable contract. |
| Claude `block-implement-worktree.py` | Blocks unsupported `/implement` worktree/checkout shapes. | **KEEP driver-only.** Mechanical bootstrap independently binds one checkout. |
| Cursor CLI capability policy | Limits command capabilities for that driver. | **KEEP as sandbox configuration, not a gate.** It creates no durable pass evidence. Stale Java, npm, and Docker commands were deleted. |
| Unregistered completion verifier, backend-only implementation rule, skill-call logger, and `verify-extra.sh` | No runtime registration or surviving governed paths existed; file presence was mistaken for activation. | **DELETE.** Their duplicated policy work is authoritative in `make policy`; bootstrap/docs no longer advertise or copy them. |

## Required CI, live protection, and release automation

| Surface | Invariant and input | Decision, bypass, failure, cost/history |
|---|---|---|
| Required `policy` job | Full pre-commit, Python policy tests, MCP tests/lint, `bin/policy`, and Vale pass on the PR tree. | **KEEP authoritative hosted replay.** No workflow path filter. Token-bearing comment fetch is separated from PR-controlled policy code. |
| Required `sonar` job and `SonarCloud Code Analysis` | Coverage/analyzer execution and hosted quality-gate result exist for the head SHA. | **KEEP.** A skipped producer is not evidence of scope; the MCP watcher returns not-evaluable. |
| Required `trivy` and `osv-scanner` | Fixable high/critical filesystem/dependency vulnerabilities are absent. | **KEEP.** No path filter. Scanner failure is red, not a silent exemption. |
| Required `GitGuardian Security Checks` | Hosted secret scan passes for the head SHA. | **KEEP hosted producer exemption**, bound to its App id in live protection. |
| Branch-protection baseline | Tracked required contexts/providers, strictness, review, bypass, force/deletion, conversation, and admin intent are complete. | **KEEP as intent**, enforced offline by policy; not proof of live state. |
| `make branch-protection-check` | Live `main` and `dev` protection exactly match the baseline and provider bindings. Input: authenticated GitHub admin read. | **KEEP as explicit operator gate.** Exit 2 is unevaluable. It is separate because CI cannot receive `administration:read`; it never skips green. |
| Human PR merge | Reviewed delivery commit becomes authoritative on the protected branch. | **KEEP as the sole synchronous human touchpoint.** No agent or release workflow bypass. |
| `pr-title.yml` | Reports early Conventional Commit feedback. | **KEEP advisory.** Policy and MCP creation own enforcement; it is not a required context. |
| `release-please.yml` | Owns root manifest, generated changelog, immutable tag, and GitHub Release. | **KEEP automation, not a verification gate.** No image/deploy surface survives. Release-mode body exemption is explicit. |
| `sync-main-to-dev.yml` | A `main` change opens/updates one automation-owned PR to `dev`, bound to the observed branch OID and exact lease. | **KEEP automation plus human merge.** Ref/owner/OID mismatch refuses; interrupted PR creation and a retained branch from a completed bot-owned PR recover without abandoning the ownership proof. Raw force and implicit branch takeover were deleted. |

## `/implement` skill gates

| Band | Invariant and authority | Decision, bypass, failure/cost/history |
|---|---|---|
| Bootstrap (Steps 1–2) | Resolve repo-local requirements and issue, bind the immutable principles/checkout contract, prepare and label one feature branch. MCP is mutation authority. | **KEEP.** Resumption is marker-based; a mismatched checkout or issue requirement scope refuses. |
| Architecture/plan/TDD (2.5–5) | Preflight precedes code, plan is durable, each clause selects a TDD path, and targeted evidence is recorded. | **KEEP semantic agent work.** Prose-only changes may use static validation; runtime/config behavior may not. |
| Verify (6) | Configured completion and policy commands pass for the full in-scope tree. | **KEEP mechanical gate.** Async transport does not weaken the result; command failure requires repair. |
| Separated reviews (6.5–6.6) | Codex and test-quality engines review the coding agent's complete diff; findings receive durable decisions and fixes. | **KEEP.** Per-issue cap bounds cost; only recorded human or tool-attested cap authority extends it. No deferral disposition. |
| Publish/sync (7–8.5) | Pre-commit passes, commit/push is serialized, latest integration base is merged, and the synchronized tree is reverified. | **KEEP.** Conflict returns bounded repair; no reset/rebase/force escape. |
| PR/remote gates (9–11) | Server renders/creates a synchronized PR, watches all CI runs for the head, then evaluates Sonar. | **KEEP.** Unevaluable/skipped analysis does not pass. Fixes loop back through publish and sync. |
| Specs reconciliation (15–16) | Requirement status and IMPLEMENTS/TESTS links are edited in the delivery diff before publish. | **KEEP repo-local.** No post-merge mutation or backend transition survives. |
| Readiness/finalize (17/20) | Pre-merge record says ready, not complete; post-merge reads requirements at the immutable merge revision before final report/close. | **KEEP.** Merge state is the authority; override requires recorded human reason. |

## Registered MCP tool inventory

Every registered tool is **KEEP**. “Gate” tools make a refusal decision;
“evidence” tools acquire or render bounded facts; “support” tools perform a
privileged operation behind the same repository binding. Callers cannot bypass
repository identity, issue/PR scope, or public-text scrubbing unless a row names
an explicit recorded human override.

| Tool | Role | Invariant, input, bypass/failure, and placement history |
|---|---|---|
| `gc_get_repo_ground_control_context` | evidence | Validated checkout config is the workflow input; invalid/mismatched config refuses. Replaces driver-hardcoded project settings. |
| `gc_resolve_workflow_route` | evidence | Returns advisory stage/tier/provider metadata; disabled routing is a valid no-op. Never selects authority or manufactures an executor. |
| `gc_prepare_implement_branch` | gate/support | Repository identity, issue state, branch shape, and clean transition are server-checked. No arbitrary branch mutation. |
| `gc_mark_implement_issue_picked_up` | support | Applies the bounded workflow label to the bound issue; idempotent, not completion evidence. |
| `gc_get_issue_thread` | evidence | Reads the bound issue's durable markers/comments with bounded output; malformed/conflicting markers remain visible as failure. |
| `gc_update_issue_requirements` | gate/support | Adds/removes canonical repo-local UIDs in the issue's Requirements section under a lease. Removal needs trusted authorization. |
| `gc_create_github_issue` | gate/support | Creates from a validated requirement identity and scrubbed fields; cannot invent an unrelated repository target. |
| `gc_codex_architecture_preflight` | gate/evidence | A separated reviewer returns architecture guardrails before implementation; missing/non-verdict output does not pass. |
| `gc_post_implementation_plan` | gate/support | Posts one structured plan bound to issue/branch/requirements; dev-start policy may require it before code. |
| `gc_implement_mechanical` | gate/support | Owns bootstrap, verify, publish, monitor, readiness, and finalize sequencing over the immutable checkout contract. Returned `agent_required` is repair, not success. |
| `gc_codex_job` | support | Starts/polls bounded async work by idempotency key; transport completion never converts `result.ok=false` to pass. No fake cancellation claim. |
| `gc_codex_review` | gate/evidence | Separated engine reviews a bound PR/diff and returns structured findings; coverage/non-verdict failures refuse. |
| `gc_codex_review_cycle` | gate/support | Enforces issue-thread cycle order/cap and persists verbatim findings. Only recorded cap authority bypasses the normal cap. |
| `gc_codex_verify_finding` | evidence | Re-checks a named finding with a separated engine; caller assertion is not verification. |
| `gc_test_quality_review` | gate/evidence | Reviews test design/coverage independently; non-verdict or incomplete coverage does not pass. |
| `gc_test_quality_review_cycle` | gate/support | Applies the same durable cycle/cap contract to test-quality review. Explicit cap authority is the sole extension. |
| `gc_review_cap_disposition` | gate/support | Scores the configured cap boundary and records a bounded proceed/one-more/escalate disposition. Hard ceiling and shadow mode prevent silent authority expansion. |
| `gc_post_decision_record` | gate/support | Renders and posts fix/wontfix/not-applicable decisions with bounded rationale. `wontfix` is not self-authorizing. |
| `gc_record_execution_obligation` | gate/support | Persists a real surfaced finding/repair obligation on the issue thread; it cannot be silently dropped between attempts. |
| `gc_authorize_execution_obligation_wontfix` | gate/support | Converts an obligation only from explicit user authorization bound to that record. Missing/ambiguous authority refuses. |
| `gc_render_pr_body` | gate/evidence | Renders canonical sections and derives Release Please versus fragment mode from the target repo. Caller-selected mode mismatch refuses. |
| `gc_synchronize_implement_branch` | gate/support | Merges the latest integration base into the feature branch and rechecks the tree under OID/lease bounds. Conflicts return to the agent. |
| `gc_create_synchronized_implement_pr` | gate/support | Creates/updates only after synchronization evidence and title/body validation. No direct unsynchronized PR path. |
| `gc_watch_ci_run` | gate/evidence | Reads all relevant runs/checks for the authorized repository and exact head SHA. Missing, stale, or unauthorized evidence does not pass. |
| `gc_watch_sonar_analysis` | gate/evidence | Binds Sonar config/project and head producer evidence, polls within one timeout budget, and distinguishes failed, skipped, malformed, auth, and absent analysis. Only a true quality-gate pass clears it. |
| `gc_assert_completion` | gate/support | Pre-merge readiness and post-merge completion are distinct; post-merge reads exact requirement state at the immutable merge revision. Recorded override is explicit. |
| `gc_post_final_report` | gate/support | Posts a bounded canonical outcome only after prerequisite evidence; it does not independently decide gates. |
| `gc_close_issue_after_merge` | gate/support | Requires a merged linked PR and, for requirement-backed work, a trusted final-report marker. Already-closed is idempotent. |
| `gc_get_pr_review_context` | evidence | Returns bounded PR/base/head/review context for the authorized repository. No mutation or approval authority. |
| `gc_remediate_pull_request` | gate/support | Review-lane sync/publish/comment actions are explicitly scoped and authorization-gated; never merges or closes the PR. |
| `gc_integration_manager` | gate/support | Prepares or, only in its explicitly authorized mode, integrates approved PRs under its own workflow contract. It is not an `/implement` merge escape. |
| `gc_remember` | support | Atomically writes a scrubbed repo-local knowledge inbox item and starts detached ingest under containment/lock rules. It is not gate evidence. |

## Retired enforcement and shadow work

The following are **DELETE**, not dormant supported surfaces:

- Backend HTTP clients, workflow-run create/event adapters, station-result
  emission, tool-call/step telemetry, lifecycle normalizers, gate-finding
  adapters, measurement artifact projection, and their tests.
- The `GC_POLICY_JSON` / `GC_VALE_JSON` child-artifact path and policy `--json`
  writer, whose sole consumer was the retired measurement projection.
- Backend credentials and endpoints (`GC_BASE_URL`,
  `GROUND_CONTROL_API_TOKEN`, `GROUND_CONTROL_PACK_REGISTRY_ADMIN_TOKEN`) from
  server configuration, examples, and docs.
- Backend-era CI/protection contexts and topology assertions for `build`,
  `frontend`, `integration`, `test`, and `verify`.
- The dead `CI_PRE_COMMIT_HOOKS` tuple and CI's handwritten partial replay of
  hook commands; `.pre-commit-config.yaml` plus all-file execution own that list.
- Stale Claude Java formatting plus Cursor Gradle/npm/Docker command grants.
- Unregistered Stop-hook, skill-call-log, and `verify-extra` copies.

Removal is guarded by `mcp/ground-control/retired-backend-surfaces.test.js` and
the policy/CI contracts above. Reintroducing one of these concerns requires a
new product owner and placement decision; historical ADR prose alone is not
authorization.
