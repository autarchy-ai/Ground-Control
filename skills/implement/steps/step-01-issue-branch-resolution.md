---
stage_id: issue_branch_resolution
step: "Step 1"
tier: low
---

# Step 1: Resolve the Issue and Branch

On the normal path, complete input classification and compliant branch-name
derivation, then call `gc_implement_mechanical` with `action="bootstrap"`.
That single operation gets repository context, prepares the branch, reads and
parses the authoritative issue section, resolves every in-scope requirement,
reads issue traceability, and records pickup. Use the individual primitives
below only to resolve a requirement-UID input to its authoritative issue before
`bootstrap`, or to repair the bounded stage named by a failed bootstrap
envelope.

The immutable `execution_contract` and
`development_principles_verbatim` were loaded before this step. Refuse to run
if they are absent, if their digest no longer matches, or if
`execution_contract.checkout_mode` is not `same_checkout`.

1. Use `execution_contract.invocation_root` as `repo_path`. Confirm it is the
   canonical absolute repository top-level. Do not substitute another checkout
   or worktree. This invocation root is the starting worktree and immutable
   mutation boundary for the run and every delegated step. Agents and delegated
   agents MUST NOT make repository changes outside the starting worktree without
   explicit user authorization naming the other repository or worktree.
   Read-only inspection outside the starting worktree is allowed.

2. Call `gc_get_repo_ground_control_context` with `repo_path`. Stop with the
   returned suggested configuration when the status is not `ok`; never guess a
   Ground Control project. Cache the full context as `cfg`.

3. Classify the input:

   - Issue: `123`, `#123`, or `issue:123`.
   - Requirement UID: the exact `<letters>-<letters/digits>` input. Never
     synthesize or rewrite a prefix.
   - Otherwise ask for disambiguation.

4. For a requirement UID, read `docs/requirements/<UID>/requirement.md` and its
   `## Traceability` section. Reuse its `GITHUB_ISSUE` entry or call
   `gc_create_github_issue` with the UID, project, and invocation root. The
   resolved issue number is authoritative.

5. Call `gc_get_issue_thread` and cache its content hash. Parse the issue
   body's `##` through `#### Requirements` section. Every valid UID bullet is
   in scope; an absent or empty section means a requirement-free run. Resolve
   every UID by reading `docs/requirements/<UID>/requirement.md` and cache its
   title, statement, status, and wave. If the run started from a UID, ensure that UID appears in
   the issue Requirements section: when it does not, call `gc_update_issue_requirements`
   with `operation="add"` and that UID. That tool is the only supported writer for the
   section — it validates each UID against its repo-local requirement file, preserves
   every other byte of the body, is a no-op when the scope already matches, and keeps
   the write on the MCP server's pinned repository identity (ADR-027). Do not edit the
   issue body by hand or through any other command. A successful call changes the run's authoritative scope, so reconcile the cached scope
   before continuing: re-read the thread with `gc_get_issue_thread`, replace the cached
   `issue_thread_hash`, and replace `in_scope_requirements[]` with the UID set the tool
   returned, resolving each newly added UID's requirement file for its title, statement,
   status, and wave.

6. Derive an informational `implementation_intent` from the issue labels and
   body already returned by `gc_implement_mechanical action="bootstrap"`:

   - `bug-fix` when a `bug` label, a semantic `## Bug` section, or the issue's
     own requested outcome says shipped behavior is broken, regresses, crashes,
     or returns a wrong result;
   - `feature` when the issue asks for new behavior, a new requirement, or a
     process/contract extension without a shipped-behavior defect;
   - `mixed` when separate clauses contain both kinds of work.

   Treat quoted examples, historical discussion, and out-of-scope text as
   context rather than raw keyword matches. Cache the value for the semantic
   steps only. It is an informational hint, not a gate, label, configuration
   field, or authorization. Step 4's per-clause `tdd_path` classification is
   authoritative and may correct the issue-level hint.

7. Read the requirement files' `## Traceability` sections for `GITHUB_ISSUE` entries naming the issue and cache them.

8. Derive a compliant branch name `<issue-number>-<short-slug>` from two to
   four words naming the change. The total is at most 50 characters and uses
   only lowercase ASCII letters, digits, and hyphens.

9. Call `gc_prepare_implement_branch` with:

   - `repo_path`: `execution_contract.invocation_root`
   - `invocation_root`: `execution_contract.invocation_root`
   - `issue_number`: resolved issue number
   - `branch_name`: the compliant name
   - `base_branch`: `cfg.workflow.base_branch`, default `dev`
   - `checkout_mode`: `same_checkout`

   This MCP operation is the only branch-mutation path for `/implement`. It
   creates or switches the branch inside the invocation checkout with fixed
   argv/cwd and verifies afterward that the canonical top-level, Git directory,
   origin, and branch shape are unchanged/compliant. Do not invoke a direct
   branch-development recipe, create a worktree, relocate the process, or
   reconstruct the returned branch. Cache the tool's exact `branch`.

   A structured branch failure is an execution obligation. Repair it when safe.
   When the failure requires destructive/external authority, significant
   architecture or security judgment, unresolved ambiguity, or unexpectedly
   material scope expansion, record an escalated obligation with a concrete
   decision request and keep it open. Workload or inconvenience is not a pause
   reason.

10. Call `gc_mark_implement_issue_picked_up` with the invocation root, issue
   number, driver, and exact branch returned by
   `gc_prepare_implement_branch`. This deterministic MCP operation owns all
   pickup-side GitHub mutations: it creates the `in-progress` label when
   absent without overwriting an existing label, applies it to the issue, and
   posts the timestamped pickup comment through the server's pinned repository
   identity and canonical error boundary. Do not reproduce those writes with
   `gh`, another shell command, or a caller-rendered comment.

   Surface any failure before Step 2. The label remains on partial/error paths
   because the work is active or paused, not finished.

11. When `$TMUX` is set and `cfg.short_code` is non-null, best-effort rename
    the current session to `<short_code>-<issue_number>`. This cosmetic action
    is non-fatal and adds no cached state.

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "repo_path": "<invocation root>",
    "issue_number": 123,
    "branch": "123-short-slug",
    "cfg": {},
    "execution_contract": {},
    "development_principles_verbatim": "<exact canonical contents>",
    "in_scope_requirements": [],
    "implementation_intent": "feature | bug-fix | mixed",
    "issue_thread_hash": "<sha256>",
    "issue_traceability_links": []
  }
}
```

The parent verifies immutable fields before merging the envelope. On a
non-recoverable error return
`{"status":"error","error":"<stable-key>","message":"<one line>"}`.
