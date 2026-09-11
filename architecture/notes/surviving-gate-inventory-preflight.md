# Surviving Gate Inventory Preflight

Issue #1303 is an assessment of enforcement that remains after the repository-local
requirements migration in #1500. This note fixes the architectural boundaries for
that assessment. It does not choose implementation tasks or introduce another gate
framework.

## What Counts as a Gate

A gate is an executable decision point that can refuse, defer, or authorize a
workflow transition, repository mutation, publication, or merge. Registration as an
MCP tool, production of a status check, creation of a durable record, or execution of
a test does not by itself make that surface a distinct gate.

Inventory at the smallest existing decision point that has its own invariant or
authority. Use the incumbent identifier rather than creating a new ID namespace:

- MCP tool name and, for multiplexed tools, action name;
- policy check function;
- hook ID and activation phase;
- workflow job or externally produced required context;
- skill stage plus the MCP action that mechanically enforces it, when one exists.

Each row needs the protected invariant, authoritative input, current placement,
bypass model, runtime cost, failure mode, evidenced defect history, and a
keep/delete/relocate decision. Plain Markdown is sufficient. Do not create a schema,
registry, service, or measurement pipeline for the inventory.

Reachability must include skill action names and shell entry points, not only
JavaScript call sites. The removal and subsequent restoration of
`gc_integration_manager` after #1500 demonstrates that a JavaScript-only call graph
is not a safe dead-code test. Conversely, a compatibility export, test fixture,
comment, or historical ADR reference is not evidence that a production gate remains
reachable. Any automated inventory scan must prove that it inspected a non-zero,
expected-shaped source set, following the policy scan-floor precedent from #1355.

## Placement Doctrine

Place each surviving invariant with the authority and inputs needed to decide it:

| Kind of decision | Authoritative placement | Boundary |
| --- | --- | --- |
| Deterministic invariant over tracked repository state | `bin/policy` and blocking CI | Local hooks may provide faster feedback but are bypassable and are not the durable authority. |
| Privileged Git or GitHub mutation | MCP library operation behind a registered tool | The tool has a Zod input shape, while the library owns semantic authorization, repository binding, safe process execution, and the stable failure result. |
| Human authorization | Explicit user gate, represented by the incumbent trusted GitHub record where durable proof is required | A model assertion, untrusted issue text, or process-local flag cannot substitute for authority. |
| Hosted check or branch-protection requirement | Hosted producer plus the versioned branch-protection baseline and live comparison | Offline workflow validation proves what the repository declares; only the live admin-readable comparison proves current GitHub enforcement. Treat an unreadable live state as unevaluable, not clean or drifted. |
| Workflow evidence | GitHub issue-thread record bound to current repository identities | A record is evidence, not automatically a gate. It becomes an input only where an incumbent reader validates trusted authorship, marker shape, and immutable issue/commit identities. |
| Telemetry or measurement | No enforcement placement | Measurement must not authorize or block delivery. Post-#1500 backend egress with no surviving consumer should be deleted, not promoted into a gate. |

Repeated verification is not necessarily duplication: the same deterministic check
can validly run in a local feedback loop and again in trusted CI against the final
tree. The inventory should merge rows only when the protected invariant, authority,
inputs, and failure consequences are the same. Tests of a policy check are evidence
for that check, not another gate.

## Canonical Cross-Cutting Contracts

Surviving MCP enforcement must reuse the current layers rather than adding parallel
schemas or exception conventions:

| Layer | Canonical incumbent | Required use |
| --- | --- | --- |
| Tool shape | Zod schemas in `mcp/ground-control/tools/` with thin handlers | Validate transport shape, then delegate to one library operation. Do not duplicate semantic workflow checks in handlers. |
| Repository configuration | `parseGroundControlYaml` and the normalizers in `mcp/ground-control/lib/ground-control-config.js` and repository-context modules | Preserve strict config keys, repo-relative containment, and the `.ground-control.yaml` context contract. New policy placement should first use existing `workflow.*_command` and branch-protection configuration seams. |
| Repository and actor authorization | Existing implement authorization helpers, origin-derived `getOwnerRepo`, launch-workspace bindings, and trusted issue-record readers | Bind decisions to the configured repository, issue, branch, and commit. Do not accept ambient `GH_REPO`, caller-provided repository identity, or untrusted marker text as authority. |
| Requirement state | `mcp/ground-control/lib/requirement-files.js` | Requirement-backed lanes must use the repo-local file reader and full commit OIDs. Issue #1303 is explicitly scoped to `GC-O007`, `GC-P027`, and `GC-P030`; keep all three in reconciliation and do not synthesize a new UID or backend record. |
| Paths and sensitive content | Existing repo-relative/realpath containment and sensitive-body/reserved-marker validators | Validate before file access or GitHub publication. Do not weaken the protected-file and secret-scanning boundaries while removing stale agent-specific ceremony. |
| Process and OS boundary | `execFile` with fixed argv/cwd, `gate-command-runner.js`, verification-gate helpers, and the existing documented repository-command shell boundary | Privileged operations stay in MCP. Repository-supplied shell commands remain branch-controlled inputs and are not contributor-resistant proof; external CI supplies that trust domain. Never place secrets in argv or command text. |
| Environment | `mcp/ground-control/lib/server-env.js` and `codexEngineEnv` | Keep launch-root parsing, owned-name clearing, and the child-process allowlist. Driver environment inheritance is a separate exposure surface, not an MCP configuration source or authorization proof. Removing legacy backend configuration must update the parser inventory, `.env.example`, tests, and docs together. |
| Failures and MCP responses | Stable `failure`/`commandFailure` results plus `mcp/ground-control/tools/respond.js` | Preserve bounded `{ ok: false, error, message, next_action }` semantics and MCP envelopes. `respond.js::err` serializes `RequestError.detail`, so producers must keep that detail closed, bounded, and scrubbed; never place raw stderr, environment values, tokens, prompts, diffs, or unbounded logs there. |
| Durable workflow state | Trusted GitHub issue-thread markers under ADR-029; repository files for requirements and ADRs | Process-local async job state is transport state only. Do not recreate database, Temporal, graph, or backend persistence. |
| Observability | Stable operation/job identifiers and bounded outcome summaries | Log enough to diagnose the decision without logging sensitive payloads. Fail-open telemetry is still outbound behavior and must justify its survival even when it is not a gate. |

The extension seam is one additional inventory row keyed by the existing executable
surface and one authoritative artifact in its existing owner. For example, a new
required GitHub context extends `.github/branch-protection-baseline.json` and its
producer; a new repository command extends the existing workflow config shape. Do
not add a generic gate engine or a second policy/config model.

## Reconciliation Risks Already Visible

The assessment must explicitly resolve these current inconsistencies rather than
copying the nearest prose description:

- The current registrations expose 32 Node MCP tools, while comments and architecture
  prose contain older approximate counts. Derive the inventory from registrations and
  action dispatch, then update prose only if an exact count remains useful.
- `GC-P027` still states pre-#1500 product-version mirrors and GHCR image publication,
  while `release-please-config.json` has an empty `extra-files` inventory and
  `release-please.yml` explicitly publishes no image. This is an ACTIVE requirement in
  the issue's declared scope, not historical prose that can be ignored. Separate the
  surviving Release Please/CHANGELOG/title/back-merge invariants from retired product
  surfaces, and reconcile the requirement plus ADR-063 whenever the decision narrows
  that contract; deleting the old checks alone would leave authoritative specs false.
- `server-runtime.js` installs tool telemetry, and workflow/review code still contains
  optional `/api/v1/...` lifecycle egress keyed by `GC_BASE_URL`. `.env.example`, the
  server-environment inventory, exports, docs, and tests retain related post-#1500
  backend settings. These are not blocking gates, but they are live cost, egress, and
  maintenance surface that require reachability and consumer evidence to survive.
- The repository Claude settings contain a post-edit Java/Gradle formatter hook even
  though this repository has no backend. Other copied or user-level Claude hooks are
  not made authoritative merely because their scripts remain tracked.
- `scripts/bootstrap-claude-workflow.sh` copies `verify-implementation.sh` and
  `log-skill-call.sh` to a user-level directory, but `.claude/settings.json` does not
  register either hook; its five-file allowlist also disagrees with the four-file list
  in `docs/DEVELOPMENT_WORKFLOW.md`. Documentation instead asserts host-level
  registrations that this repository-wide inspection cannot verify. Inventory the
  tracked declaration, installer, and tests separately from live host activation, and
  mark the latter unevaluable rather than assuming the copy is an active gate.
- `.codex/config.toml` describes ambient credential inheritance and
  `.cursor/cli.json` allows direct `git`/`gh` plus stale backend commands. These driver
  capabilities do not establish authority and cannot weaken the MCP-only mutation or
  launch-root environment contracts. Reconcile the checked-in driver guidance, but do
  not create another permission schema or treat an allow/deny list as proof that a
  privileged operation is safe.
- Bash syntax validation currently exists as a local pre-commit hook but is not in the
  manual CI pre-commit subset. If the invariant survives, its authoritative copy must
  be in policy/CI; otherwise it remains explicitly advisory.
- Blocking CI tools do not all have immutable installation inputs: the security job
  downloads and executes an OSV Scanner release asset without a digest/signature check,
  the policy and Sonar jobs install unversioned Python packages, and Sonar invokes the
  floating `c8@10` range. The inventory must record those supply chain inputs and
  distinguish a pinned workflow action SHA from the mutable tools that action or shell
  step subsequently installs. A keep decision needs a reproducible trust story; a green
  status from drifting gate code is not durable enforcement.
- The PR-title workflow produces a status that is absent from the versioned required-
  context baseline. The assessment must decide whether it is advisory or required and
  reconcile workflow, baseline, live protection, and documentation accordingly.
- No admin-readable live branch-protection comparison is available to this preflight.
  The versioned baseline and offline producer check cannot establish live
  reconciliation. Completion therefore requires an admin-readable comparison or an
  explicit record that this acceptance criterion remains blocked; it must not infer
  success.

Historical regressions should be attached only to the rows they support. Relevant
examples include vacuous policy scans (#1355), ineffective clone hooks under a global
`core.hooksPath` (#1153), live protection drift (#1155), branch-controlled command
trust (#1429), ambient environment/repository identity injection (#1383 and #1562),
child-process credential exposure (#1518), interrupted publish and process-tree
handling (#1495), and immutable post-merge requirement verification (#1541). A
historical incident is evidence for an invariant, not a reason to preserve every
mechanism that ever mentioned it.

## Guardrails and Non-Goals

- Do not delete a whole module because some exports are obsolete. Live review,
  compatibility, and old backend helpers coexist in several files; decide at symbol
  or action granularity.
- Do not classify readers, record writers, monitors, tests, telemetry, or status
  producers as separate gates without an executable refusal or authorization edge.
- Do not turn fail-open telemetry into enforcement, and do not keep legacy network
  egress merely because it fails open.
- Do not duplicate validation across skills, tool handlers, libraries, hooks, and
  policy. Skills describe sequencing; MCP and policy/CI enforce what their trust
  boundaries can actually prove.
- Do not treat `.git/hooks` state as repository truth. It is clone-local and
  bypassable. Inspect tracked hook configuration, installation/verification behavior,
  and CI independently.
- Do not flatten `clean`, `drifted`, and `unevaluable` into a Boolean result for live
  protection, hosted checks, credentials, or network-dependent validation.
- Do not assume identical check names identify the same producer. Preserve provider
  IDs and head-SHA binding where incumbent checks use them.
- Do not add a backend, database, Temporal workflow, GRC layer, mandatory Graphify
  index, gate metrics, enforcement dashboard, or generated gate registry.
- Do not change protected branches, merge or close a pull request, or perform other
  privileged mutations as part of the assessment without the existing explicit
  authority gates.
- Do not use this architecture preflight as an implementation plan. Concrete follow-up
  issues should be created only for a surviving, evidenced need after every inventory
  row has a decision.

## Design Vocabulary That Applies

The proposed assessment intersects this bounded subset of the repository vocabulary:

- **Canonical patterns:** `Tool registration`, `Requirement file reader`, and
  `Issue-thread record`.
- **Canonical helpers:** argv-based `gh api` posting in
  `mcp/ground-control/lib.js`, and the `requirement-files.js` reader.
- **Boundary contract:** the MCP server is the only running service and owns every
  privileged Git/GitHub side effect.
- **Binding ADRs:** ADR-027 for context and privileged boundaries; ADR-029 for the
  durable issue-thread record; ADR-031 for structured findings with MCP-owned writes;
  ADR-093 for repo-local requirement state; and ADR-094 to keep Graphify optional.
- **Anti-recommendations:** do not introduce an abstraction below three call sites;
  do not add skill prose that the MCP tools cannot enforce; do not add comments that
  merely restate code; and do not invoke privileged `gh`, `git`, or `curl` operations
  from agent sandboxes.
