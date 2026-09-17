---
stage_id: base_sync
step: "Step 8.5"
tier: low
---

# Step 8.5: Synchronize the Remote Integration Branch

This boundary is mandatory after Step 8 and immediately before Step 9.

1. Call `gc_synchronize_implement_branch` with:
   - `repo_path`: the canonical invocation checkout;
   - `issue_number`;
   - `branch_name`: the active issue branch;
   - `action: "start"`.
2. The tool fetches the configured integration branch from `origin` with an
   explicit remote-tracking refspec. Never substitute a local base branch,
   `FETCH_HEAD`, tag, raw SHA, another remote, worktree, rebase, or force-push.
3. Dispatch on the returned status:
   - `complete` / `already_current`: cache the attestation fields and continue.
     CI owns the broad checks on the published head.
   - `merge_ready`: run targeted tests only when the fetched changes affect an
     integration seam that benefits from a narrow check, then continue to
     `complete`.
   - `conflicts`: resolve every conflict in the invocation checkout without
     discarding feature work or selecting an automatic side. Run targeted tests
     while iterating, then continue to `complete`.
4. For `merge_ready` or `conflicts`, call the same tool with
   `action: "complete"` plus the exact `record_id`, `pre_sync_sha`,
   `fetched_base_sha`, and `outcome` returned by `start`. The tool requires every
   merge change to be staged, binds the index tree to the merge commit, checks
   the merge graph, pushes normally, and records synchronization identity.
   It runs no completion or policy suites. A retry resumes a valid merge commit
   after a transient push, remote-read, or recording failure.
5. A fetch, identity, graph, conflict, gate, push, or attestation failure keeps
   this step incomplete. Preserve inspectable Git state, fix the condition, and
   retry this boundary.

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "synchronization_record_id": "<opaque record id>",
    "synchronization_record_url": "<issue comment URL>",
    "integration_branch": "<configured base>",
    "integration_source": "refs/remotes/origin/<configured base>",
    "pre_sync_sha": "<object id>",
    "fetched_base_sha": "<object id>",
    "synchronization_outcome": "already_current | merged_clean | merged_conflicts_resolved",
    "synchronized_feature_sha": "<published object id>",
    "verified_tree_sha": "<object id of the synchronized tree>"
  }
}
```
