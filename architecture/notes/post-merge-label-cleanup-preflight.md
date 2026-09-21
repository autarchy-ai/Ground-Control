# Post-merge label cleanup preflight

Issue #1686 is the contract. This is design guidance, not an implementation plan
or a claim that the fix has shipped. ADR-100 supplies the shared finalizer and
ADR-102 supplies its automated caller; neither needs a new architectural model.

## Ownership and outcome

`runCloseIssueAfterMerge` in `mcp/ground-control/lib/close-issue.js` owns cleanup
whenever its close result is successful, including `already_closed: true`.
`implement/completion.js` composes this same close for both lanes;
`implement/phase-e-automation.js`, `gc_finalize_merged_pr`, and
`grndctl finalize-merged-pr` reach it without needing an agent. Keep the behavior
at that shared success boundary, not in each caller or in a workflow shell step.

The label is operational metadata, not requirement state, readiness, a lease,
or proof of completion. Preserve the existing close result and its error codes.
`already_closed` describes the issue-state transition, not whether cleanup did
work. Do not add a competing `closed` or label-success field: automation derives
closure from `close.ok`, and the CLI derives its exit status from finalization.

Only label cleanup has a best-effort exception boundary. Repository, linked-PR,
merge, report-trust, issue-read, and close-PATCH failures retain their original
results and attempt no cleanup. No unconditional `finally`, pre-merge cleanup,
or catch around the entire finalization. A lost PATCH response still reports the
incumbent close failure; a later successful replay can observe closed state and
clean up. Keep the existing already-closed path's gate semantics unchanged.

## Cross-cutting boundaries

| Layer | Incumbent and guardrail |
| --- | --- |
| Tool inputs | `tools/query.js` has the positive-integer Zod schema; `runCloseIssueAfterMerge` retains library validation for non-MCP callers. No new tool, DTO, label argument, or duplicate validator. |
| Repository authorization | `resolveAuthorizedIssueRepository` pins the real launch workspace, Git common directory, origin, and owner/name through `authorizeImplementRepoRoot`. Use its resolved repository and validated issue number for the new request. No caller-supplied repository or ambient `GH_REPO` routing. |
| Completion authority | Reuse `resolvePrForClose`, `findTrustedFinalReportMarker`, and `readTrustedMergeStateOverride`. The automation pointer/readiness version, lane, payload, digest and head-binding checks remain upstream; bot provenance is distinct from human override authority. Cleanup confers neither. |
| REST and OS process | Reuse `ghRestJson` in `lib/github-rest.js`, backed by `runtime-primitives.js` argv-based `execFile`. Pin `hostname: "github.com"` so ambient `GH_HOST` cannot redirect the new write. Use its finite `timeout` option; `lib/issue-dependency.js` already uses 30 seconds. Await one bounded attempt; no background promise, polling or retry loop. |
| Credentials and environment | Let `gh` use the existing host authentication or the Actions job's `GH_TOKEN`; never copy a token into argv, headers assembled on the command line, logs or returned data. The CLI and MCP startup have distinct existing provisioning paths; do not add dotenv reads or alter `server-env.js`'s inventory/parser and `.env.example` parity. |
| Config and workflow shape | Add no config key to `.ground-control.yaml` or its strict `parseGroundControlYaml`/normalizers. Preserve the repository workflow and installable `lib/phase-e-workflow.js` template, their pinned actions, merge-revision checkout, credential policy, concurrency, and sole `issues: write` permission. `tools/policy/phase_e_automation.py` guards this shape and the provenance trust anchor. |
| Errors and observability | Preserve `tools/respond.js` envelopes, `implement/completion.js` success propagation, and the automated finalizer/CLI outcome. Cleanup must not create a `gc:delivery-finalization-failed` record or change job status. `extractGhErrorMessage` extracts stderr but does not redact it; never expose the raw cleanup exception. If diagnostics are retained, use fixed non-sensitive metadata or existing bounding/sensitive-content helpers, without turning absence into an error. |
| Persistence | GitHub's issue-label association is sufficient. Existing issue-thread records remain the durable workflow authority; no new marker, local ledger, backend, database or queue. |

Remove only this issue's `in-progress` association through the single-label REST
endpoint: `DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/in-progress`.
Do not delete the repository label, clear all labels, or replace a fetched label
array, which could overwrite concurrent unrelated changes. GitHub documents a
missing label as HTTP 404 and accepts `issues: write` for this endpoint
([GitHub REST labels](https://docs.github.com/en/rest/issues/labels#remove-a-label-from-an-issue)).
Absence must be silent success at the close boundary; other cleanup failures
also preserve close success, without claiming that removal was verified. No
extra label read or new HTTP exception hierarchy is needed to uphold that rule.
This is replay convergence after a successful close observation, not an atomic
transaction with a simultaneous human reopen or a later pickup.

## Documentation and repository policy

The implementation must retire the executable `gh issue edit --remove-label`
recipe in `skills/implement/steps/step-17-completion.md`, not just change the
summary in `skills/implement/SKILL.md` and `docs/DEVELOPMENT_WORKFLOW.md`.
Step 17 can return success before merge. Step 20 and the descriptions in
`tools/query.js` and `tools/post-decision-record.js` must describe the same owner;
an already-closed issue is a no-op for closure, with cleanup still attempted.

`architecture/policies/adr-policy.json`'s `workflow-guardrail-sync` requires both
workflow docs, including `docs/WORKFLOW.md`, and one of its listed gate-model
records when the skill changes. ADR-100/102 are **not** in that accepted list.
A small ADR-021 amendment is relevant because it records the original lifecycle
and the later Step 17 best-effort rule. Preserve that history and clarify the new
owner; do not weaken policy or rewrite every historical ADR. ADR-100/102 do not
currently assign label cleanup, so no amendment to them is required solely for
this fix. Preserve the existing immediate-Phase-E and default-branch wording
guarded by `implement_scope_contract.py` and `issue_close_contract.py`.

Canonical skills ship through `mcp/ground-control/scripts/bundle-skills.mjs`;
do not hand-edit generated package copies or installed skills. Existing package
contents already include the changed library. No version, release or workflow
template change is needed for the cleanup behavior itself.

## Evidence and extension seam

Reuse `lib.closeissue-and-workflowrun.test.js`'s hermetic argv route shim,
`restLinkedPullRequestRoutes`, and `workspaceAuthorizationFor`. Assert observed
DELETE requests and ordering, not just `ok: true`: an unhandled shim route will
otherwise be swallowed by the best-effort boundary and let an absent or wrong
implementation pass. Cover fresh close, already-closed replay, absent-label 404,
other removal failures and bounded timeout, preserved unrelated labels, and zero
cleanup attempts on refusals or failed close. Keep the existing authorization and
marker/provenance tests; do not replace them with label-only fixtures.

The finalizer and automation suites already own result propagation. Any added
coverage there should use the actual close-result shape (`ok`, `already_closed`),
including successful finalization after a cleanup failure. Run relevant suites
through `scripts/run-node-tests.mjs`; broad policy and MCP suites belong to CI.
Both the current close module and its suite fit below the 500-line source limit;
preserve that limit without an unrelated extraction.

The extension seam is the existing authorized repository/issue input at the
shared close boundary and the REST helper's host, timeout and executor options.
A new finalizer caller inherits cleanup automatically. Keep the label fixed for
this issue; configurable lifecycle policy, other labels, new abstractions,
pickup changes, changed gates or permissions, and historical stale-label sweeps
are non-goals. A future configurable label would need one validated value shared
by pickup and close, not an independent setting or caller flag on each lane.
