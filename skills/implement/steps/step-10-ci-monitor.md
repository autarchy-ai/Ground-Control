---
stage_id: ci_monitor
step: "Step 10"
tier: low
---

# Step 10: CI Monitor

On the normal path, Steps 10 and 11 are one
`gc_implement_mechanical action="monitor"` background job. Call it with
`async=true` and one bounded `idempotency_key` for this remote-gate attempt,
then poll the returned `job_id` through `gc_codex_job` until `status="done"` and
dispatch on `result`. Reuse the same key only when the start response was lost;
after pushing a repair, create a new key for the new attempt. The job waits for
CI and then SonarCloud, advancing without another model turn when both pass. It
stops before Sonar when CI fails and returns `agent_required: true` with the
failed stage and bounded diagnostics.

Replaces the previous "poll `gh run view` every 15 seconds for up to 45
minutes" inline loop with one server-side watcher behind a short start-and-poll
transport. The agent polls only Ground Control's compact job envelope; CI and
Sonar polling remains server-side and raw logs remain there. (Issues #934 and
#1473.)

1. Pass the absolute repository path, cached feature branch, and PR number to
   the mechanical `monitor` action. Its internal `gc_watch_ci_run` boundary
   applies the configured queued, total, and poll limits; the workflow does not
   supply caller-selected timing controls.

2. Read the CI result inside the completed mechanical envelope:
   - `conclusion: "success"` → CI passed. Advance to Step 11.
   - `conclusion: "queued_too_long"` → the run named by `run_id`/`url` waited more than 5 minutes for its first runner with no job started. A run that shows `queued` between jobs is not reported this way. Record the runner outage as an open execution obligation. This is a hard external dependency, so escalate it with the run URL and a concrete request to restore/check the runner pool (`gh api /repos/<owner>/<repo>/actions/runners`); resume CI monitoring after restoration.
   - `conclusion: "timed_out"` → record an open execution obligation with the run URL and evidence. Diagnose/retry when safe; escalate only when the timeout is a hard external dependency or requires user authority.
   - `conclusion: "failure"` (or `"cancelled"` / `"action_required"` / `"startup_failure"`) → CI failed. The envelope's `failed_steps[]` and `log_summary` (bounded UTF-8, from the tail of `gh run view --log-failed`) tell you which step + what to look at. Raw logs stay server-side; if you need to drill in, the `run_id` lets a separate `gh run view --log-failed` call retrieve them later.

3. On failure, diagnose and fix, then return to the `publish` action so its
   staging, hook, commit, push, and synchronization guardrails apply. After the
   new commit lands, call `monitor` with a new idempotency key to watch the new
   run.

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "ci_conclusion": "success" | "queued_too_long" | "timed_out" | "failure",
    "ci_run_id": <int> | null,
    "ci_url": "<URL>" | null,
    "failed_steps_count": <int>
  }
}
```

When `ci_conclusion` is not `"success"` and the agent was unable to recover, return `status: "escalated"` with `escalation_reason` set.

## Progressive remediation (issue #1628)

Begin diagnosis and repair as soon as any CI job or Sonar findings are actionable.
Do not wait for unrelated pending gates. The mechanical monitor observes CI and
Sonar concurrently and returns `head_sha`, `monitor_jobs`, and `resume` on failure.
Poll the remaining child jobs through `gc_codex_job` while batching related fixes.
A new push starts monitoring the new head; old results are diagnostic only.
Required current-head checks must all pass before readiness.
