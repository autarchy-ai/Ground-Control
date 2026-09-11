# Live Branch-Protection Reconciliation Preflight

GC-P031 extends the existing GC-P030 required-context contract. The change is
not a one-time status-check repair: the repository needs one complete versioned
policy, an offline shape/producer gate, and a separately invoked read-only check
of GitHub's live enforcement. This note is architecture guidance, not an
implementation plan, and it performs no live GitHub mutation.

## Authority and Boundaries

- `.github/branch-protection-baseline.json` is the single versioned declaration
  of the in-scope protection semantics for every intended protected branch.
- `tools/policy/core.py::CI_STRICTNESS_BRANCHES` and
  `CI_STRICTNESS_REQUIRED_CONTEXTS` remain the independent policy declarations
  for the branch set and required checks. The baseline must match them exactly;
  this prevents a coordinated baseline/workflow edit from silently deleting a
  merge authority.
- `tools/policy/ci_strictness.py::run_ci_required_context_contract` remains the
  offline `Violation`-returning gate. It owns baseline loading and validation as
  well as workflow-producer discovery. The live checker must reuse its validated
  baseline projection or the same shared pure validator, not parse and validate
  the JSON a second way.
- `tools/ci/check_branch_protection.py` is a read-only adapter around that
  validated declaration. Keep collection, semantic normalization, comparison,
  and rendering separable so unit tests need no network or credential.
- `make branch-protection-check` is explicitly invoked from a reviewed, trusted
  checkout. It is not a dependency of `make policy` and must not be added to a
  pull-request workflow: GitHub's branch-protection read requires repository
  Administration (read), which the workflow `permissions:` map cannot grant.
- The checker has no write or repair mode. Reconciling GitHub remains a separate
  maintainer-authorized operation followed by a fresh readback. No generic MCP
  administration tool is introduced by this requirement.

The desired required-context set on both `main` and `dev` is `policy`, `sonar`,
`trivy`, `osv-scanner`, `SonarCloud Code Analysis`, and
`GitGuardian Security Checks`, with `strict: true`. Both branches require pull
requests, block force pushes and deletion, and retain the deliberately selected
admin-bypass policy. Values not fixed by GC-P031, especially review and
conversation settings, must be recorded as an intentional ADR-091 decision;
do not promote an incidental live value to policy merely because it is live.

## One Closed Semantic Schema

Keep the baseline in repository language and define the GitHub mapping once.
The exact per-branch leaf set must be closed and shared by offline validation
and live comparison:

| Baseline fact | Expected shape | GitHub response mapping |
| --- | --- | --- |
| `required_status_checks.strict` | boolean | `required_status_checks.strict` |
| `required_status_checks.contexts` | sorted, unique, non-empty strings | names from `required_status_checks.checks[].context`, with `contexts[]` only as the compatibility fallback |
| `changes_land_via_pull_request` | boolean; must be `true` here | presence of a valid `required_pull_request_reviews` object |
| `review_policy.required_approving_review_count` | integer from 0 through 6; a Python boolean is not an integer here | same response field |
| `review_policy.dismiss_stale_reviews` | boolean | same response field |
| `review_policy.require_code_owner_reviews` | boolean | same response field |
| `review_policy.require_last_push_approval` | boolean | same response field |
| `review_policy.dismissal_restrictions.{users,teams,apps}` | sorted, unique string identifiers | normalized logins/slugs from the response object; absent is the documented empty policy only where the API contract makes those equivalent |
| `review_policy.bypass_pull_request_allowances.{users,teams,apps}` | sorted, unique string identifiers | normalized logins/slugs from the response object; absent is the documented empty policy only where the API contract makes those equivalent |
| `conversation_resolution_required` | boolean | `required_conversation_resolution.enabled` |
| `force_pushes_allowed` | boolean | `allow_force_pushes.enabled` |
| `deletions_allowed` | boolean | `allow_deletions.enabled` |
| `admin_bypass_allowed` | boolean | inverse of `enforce_admins.enabled` |

The review leaves are part of the two-sided rule. Comparing whichever keys
happen to appear under `review_policy` is insufficient: deleting
`require_code_owner_reviews`, `require_last_push_approval`, or an allowance list
would make the declaration shrink silently. Reject unknown or missing baseline
keys at every governed level, reject extra baseline branches, and assert the
exact branch set against `CI_STRICTNESS_BRANCHES`. Conversely, ignore unrelated
fields newly added to GitHub's response; two-sidedness applies to the checker's
closed semantic schema, not to every property GitHub may ever return.

Do not raw-diff the GitHub document. Response URLs, ordering, identity objects,
and wrapper objects are transport details. Normalize only the governed facts,
then compare scalars and sets while rendering stable sorted values. If both
`checks` and legacy `contexts` are returned, inconsistent name sets are an
invalid observation rather than permission to choose whichever one matches.
Provider `app_id` binding is not declared by GC-P031; preserve it during any
separate live reconciliation and do not claim name equality proves provider
identity. Adding provider binding to the baseline would be a separate policy
decision.

## Cross-Cutting Layers

| Layer | Required treatment |
| --- | --- |
| Local config validation | Treat the baseline as untrusted local input. Require a top-level mapping, the exact protected-branch set, the exact nested leaf set and types, canonical context/identity arrays, and the required-PR invariant. Missing, malformed, unreadable, empty, extra, or wrongly typed data fails closed through the existing policy `Violation` model. |
| Workflow producer validation | Reuse `_load_workflow`, `_pull_request_trigger`, `_trigger_covers`, `_reported_check_name`, `EXTERNALLY_POSTED_CONTEXTS`, and `require_scanned`. Producer evidence remains per branch; a hosted-context exemption is not emission evidence. |
| Repository identity | Reuse `tools/policy/repo_identity.py::CANONICAL_REPO_SLUG`; do not add another hard-coded slug or honor `GH_REPO`. If a `--repo` assertion is retained, validate owner/repository shape and require case-insensitive agreement with the canonical repository before any privileged read. |
| Authentication and authorization | Let `gh` use the operator's existing credential store or environment binding. Require Administration (read), never accept a token argument, never read a secret file, and never provision an admin credential in Actions. Run only reviewed code from a trusted checkout because the Python process inherits the operator environment. |
| OS/process exposure | Invoke `gh api` with an argv array and `shell=False`, a fixed GitHub host, the validated repository, and only declared safe branch names. Tokens and authorization headers never enter argv. Bound subprocess duration and handle missing executables, timeout, nonzero exit, and invalid JSON. |
| GitHub response validation | Require a mapping and validate every governed wrapper, scalar, list entry, and nested identity before comparison. Missing evidence is not a false/default value except for API-documented null/absence semantics. Each declared branch must yield an independently readable document. |
| Error envelope and observability | Keep deterministic drift records containing branch, field, declared value, and observed value. Distinguish drift from inability to evaluate (invalid baseline, missing `gh`, unauthorized/not found, timeout, malformed response), return nonzero for both, and bound/sanitize console and JSON output. Never print raw headers, credentials, full protection documents, exception traces, or unbounded remote stderr. No logging framework or telemetry schema is needed. |
| Persistence and review | Git stores the requirement, baseline, checker, tests, docs, and ADR. GitHub stores live protection and the issue-thread workflow record. There is no backend, database, cache, migration, controller, DTO, repository object, or application log in this path. `.github/CODEOWNERS` already routes all relevant policy/config paths to the repository owner. |

The standalone tool can follow `tools/ci/measure_ci_timings.py`'s existing
pure-core/argv-adapter/rendering shape, but not its best-effort skip semantics:
one unreadable protected branch invalidates the whole result. The MCP
`collectRequiredContexts` behavior is the existing semantic precedent for
reporting admin-gated protection as unavailable rather than as an empty set;
do not duplicate its JavaScript implementation in Python.

## Extensibility Seam

The seams are the existing protected-branch tuple, required-context set,
hosted-context allowlist, and one closed protection-field/normalizer registry.
A future protected branch extends the tuple and baseline; a future governed
field extends the registry and every branch declaration. Neither change should
require new comparison control flow. The live command always checks all declared
protected branches; a caller-selectable single-branch mode would allow a partial
green and is out of scope.

Keep the hosted-context allowlist shrink-only. Keep the protection-field schema
closed down to nested review leaves, with a test proving equality between schema,
baseline, and comparator coverage. Do not generalize this into a GitHub Actions
interpreter, an arbitrary JSON-path comparison framework, or a reusable GitHub
administration client before a real third call site exists.

## Verification Guardrails

Focused tests must cover drift in both directions, every scalar and nested
review leaf, wrong types (including `true` accepted accidentally as integer
`1`), duplicate/empty values, missing and extra branches/fields, malformed live
wrappers, disagreement between `checks` and `contexts`, and each live branch
being unreadable. Test the collector through an injected runner so assertions
can prove it issues only fixed-host GET reads and never carries a token in argv.
The real-baseline test belongs in the offline policy suite; no unit test should
need network access.

`make policy` remains the offline merge gate and must validate the complete
baseline shape. `make branch-protection-check` is the explicit live gate. Its
clean report is evidence only when every declared branch was read and every
governed leaf was compared.

## Gotchas and Anti-Patterns

- Do not keep separate baseline loaders or separate type schemas in the offline
  and live tools.
- Do not compare only top-level field names; nested review keys and allowance
  collections can otherwise become decorative.
- Do not iterate only expected branches while ignoring extra baseline branches.
- Do not coerce values with `str()`, `bool()`, `set()`, or `or []` before shape
  validation; coercion hides malformed values and sets hide duplicates.
- Do not treat a missing `enabled` wrapper as `false`, an unreadable branch as
  empty protection, or an HTTP failure as a clean result.
- Do not trust `GH_REPO`, a caller-supplied repository slug, or ambient host
  selection with an administration-capable credential.
- Do not place a PAT in CI, accept a token CLI option, log raw API errors, or run
  unreviewed PR-head code with an admin credential in scope.
- Do not copy `.claude/skills/repo-setup/SKILL.md`; it is a broad setup recipe,
  carries stale `dev` force-push intent, and performs full protection writes.
- Do not add a write flag, generic GitHub proxy, ruleset migration, new MCP tool,
  database, cache, exception hierarchy, or telemetry event for this check.

## Non-Goals and Implementation Boundaries

- No live mutation is performed by this checker or by architecture preflight.
- No change to CI jobs, check names, workflow triggers, path filters, scanner
  thresholds, Sonar behavior, or workflow permissions.
- No policy for restrictions, signed commits, linear history, branch locking,
  fork syncing, branch creation, or provider-bound required checks unless the
  requirement and baseline are deliberately expanded later.
- No claim that every emitted workflow job must be a required merge context;
  `pr-title.yml` remains outside the required-context set.
- No new `.ground-control.yaml` field and no ad hoc parser for that file.
- No direct issue comment from the checker. Durable before/after evidence uses
  the existing issue-thread workflow record after a human-authorized live
  reconciliation.

## Design Vocabulary That Applies

- **Pattern: Issue-thread record.** The final bounded readback belongs in the
  existing issue-thread workflow record; the checker does not create another
  persistence format.
- **Canonical helper: gh API argv-based posting in
  `mcp/ground-control/lib.js`.** Reuse it only when the workflow posts the final
  record. It is not a branch-protection administration client.
- **Boundary contract.** Repo-local requirements, baseline, tests, docs, and ADR
  remain reviewed Git artifacts. The MCP server owns agent-initiated privileged
  GitHub/Git side effects; this standalone checker is read-only, and any live
  repair remains a separately authorized maintainer action.
- **Binding ADR-027.** Do not add a parallel `.ground-control.yaml` reader or let
  sandbox code perform the live mutation.
- **Binding ADR-029.** The issue thread remains the durable workflow record for
  the final reconciliation evidence.
- **Binding ADR-093.** GC-P031 remains the repo-local
  `docs/requirements/GC-P031/requirement.md`; no backend requirement record is
  introduced.
- **Anti-recommendation: no abstraction below three call sites.** Use the one
  narrow field registry and existing policy/CLI shapes; do not introduce a
  general administration service or JSON comparison framework.
- **Anti-recommendation: tool-layer trust boundary.** Do not try to secure a
  future write path with workflow prose alone.
- **Anti-recommendation: comments explain non-obvious why.** Comments should
  explain inversions, API compatibility, and fail-closed invariants, not narrate
  obvious mappings.
- **Anti-recommendation: no sandbox `gh` / `git` / `curl`.** Codex and Claude do
  not execute the live check or reconciliation with operator credentials; the
  explicit command is for an authorized maintainer in a trusted checkout.
