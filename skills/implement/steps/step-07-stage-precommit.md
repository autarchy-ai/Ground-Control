---
stage_id: git_publish
step: "Step 7"
tier: low
---

# Step 7: Stage & Pre-commit Loop

On the normal path, Steps 7, 8, and 8.5 are one
`gc_implement_mechanical action="publish"` background job. Call it with
`async=true` and one bounded `idempotency_key` for the publish attempt, then
poll the returned `job_id` through `gc_codex_job` until `status="done"` and
dispatch on `result`. Reuse the same key only when the start response was lost.
After repairing a hook failure or resolving synchronization conflicts, create a
new key for that new attempt and pass the returned `retry_input` as
`synchronization`. The action screens changed paths before staging, runs
pre-commit, commits, pushes, starts base synchronization, and completes a clean
merge automatically; the existing synchronization boundary verifies, commits,
pushes, and attests a preserved merge.

1. The action stages all relevant changed files after refusing environment
   files, credentials, secrets, and sensitive key material.
2. The action runs the workflow's single mandatory pre-publish hook invocation:
   `cfg.workflow.precommit_command`, default
   `pre-commit run --all-files`. The boundary is mandatory; a repo on lefthook,
   husky, or a bespoke script configures that field. Do not duplicate a
   successful boundary elsewhere, and do not run the hook chain by hand before
   calling `publish` to check first: a hook failure is a completed `publish`
   result carrying repair evidence. The explicit invocation exists because
   commit-time hook installation is per clone and cannot be assumed. The
   mechanical commit deliberately disables Git hook dispatch after that explicit
   boundary, so an installed hook cannot execute the same checks a second time.
3. If the completed result names a hook failure, read its bounded output, fix
   the issue, and retry `publish` with a new idempotency key. Repeat up to 5
   failed attempts. If it still fails, escalate with the failure details and
   record the open execution obligation.
4. When the completed result passes, continue from its synchronization and
   publication evidence.

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "precommit_iterations": <int>,
    "staged_paths_count": <int>
  }
}
```
