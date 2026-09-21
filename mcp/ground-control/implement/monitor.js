import { startAsyncJob, pollAsyncJob, asyncJobInputFingerprint } from "../lib/async-job-registry.js";
import { readRemoteGateSnapshot } from "../lib/remote-gates.js";
import { classifySonarGateFailure, sonarGatePassed } from "../lib/sonar-gate.js";
import { failure, requireField } from "./gate-helpers.js";

function observedResult(current, ci, sonar, evidence) {
    for (const [gate, job] of [["ci", ci], ["sonar", sonar]]) {
      if (!job.ok) return failure("monitor", "monitor_child_failed", job.message ?? job.error,
        "inspect_monitor_job_then_retry", { failed_stage: gate, ...evidence });
    }
    if (sonar.status === "done" && !sonarGatePassed(sonar.result)) {
      const classified = classifySonarGateFailure(sonar.result);
      return failure("monitor", classified.error, classified.message, classified.next_action,
        { failed_stage: "sonar", sonar_gate: classified.sonar_gate, sonar: sonar.result,
          ...(sonar.result?.scope_evidence ? { sonar_scope_evidence: sonar.result.scope_evidence } : {}), ...evidence });
    }
    if (current.failures.length || (ci.status === "done" && (!ci.result.ok || ci.result.conclusion !== "success"))) {
      return failure("monitor", "ci_failure", "Hosted checks reported an actionable failure",
        "diagnose_and_fix_ci_then_rerun_publish_and_monitor",
        { failed_stage: "ci", ci: ci.result, failed_checks: current.failures, ...evidence });
    }
    if (ci.status === "done" && sonar.status === "done" && current.passed) {
      return { ok: true, action: "monitor", phase: "remote_gates_complete", head_sha: evidence.head_sha,
        ci: ci.result, sonar: sonar.result, ci_status: "green",
        sonar_status: sonar.result.skipped ? "skipped" : "passed", next_action: "post_pre_merge_readiness" };
    }
  return null;
}

// A pull request that conflicts with its base cannot produce checks at all: GitHub never
// builds the merge ref, so nothing runs and the watch would otherwise poll out its full cap
// before reporting a timeout that names none of this. `DIRTY` is GitHub's answer for that
// state, and it is actionable the moment it is read (issue #1671).
function conflictFailure(snapshot, extra = {}) {
  if (snapshot.merge_state !== "DIRTY") return null;
  return failure(
    "monitor",
    "monitor_pr_conflicted",
    "The pull request conflicts with its base branch, so its checks cannot run. "
      + "Merge the base into the branch, resolve the conflicts, and push.",
    "resolve_the_base_conflict_then_rerun_publish_and_monitor",
    { failed_stage: "merge_state", merge_state: snapshot.merge_state, ...extra },
  );
}

// While nothing changes, ask less often. The reads themselves are conditional and cost
// ~nothing against the rate limit, but a slower cadence also spends less of the secondary
// (burst) budget every agent on the host shares. Any observed change resets the cadence, so
// reaction time after something actually happens is unchanged.
const MONITOR_INTERVAL_BASE_MS = 15000;
const MONITOR_INTERVAL_MAX_MS = 120000;

export function nextMonitorInterval(currentMs, unchanged) {
  if (!unchanged) return MONITOR_INTERVAL_BASE_MS;
  return Math.min(Math.round(currentMs * 1.5), MONITOR_INTERVAL_MAX_MS);
}

// Child jobs survive an early failure response. Their handles let the driver
// keep consuming diagnostics while repairing. A new SHA gets new child jobs;
// so does a rerun on the same SHA whose previous child ended without a verdict
// (watchCi/watchSonar resolve `ok:false` only when they could not produce an
// answer - `isNonVerdictWatchResult` below) - reusing that non-answer left
// `monitor` stuck replaying it for the job's whole TTL (issue #1695).
function isNonVerdictWatchResult(result) {
  return result != null && typeof result === "object" && result.ok === false;
}

// The monitor loop's own window (`MONITOR_TOTAL_TIMEOUT_MS` below) is the
// longest a single watch is worth waiting on. The Sonar child must be given at
// least that long to wait for its producer check to register, or a repository
// whose Sonar job starts only after a long-running test job fails its first
// watch deterministically, before the producer ever appears (issue #1695).
const MONITOR_TOTAL_TIMEOUT_MS = 2700000;

export async function runMonitor(args, deps) {
  const invalid = requireField(args, "prNumber", "monitor");
  if (invalid) return invalid;
  const snapshot = deps.remoteSnapshot ?? readRemoteGateSnapshot;
  const read = () => snapshot({ repoPath: args.repoPath, prNumber: args.prNumber });
  const initial = await read();
  if (!initial.ok) return initial;
  // Refuse before starting any watcher: a conflicted pull request has nothing to watch.
  const initialConflict = conflictFailure(initial);
  if (initialConflict) return initialConflict;
  const head = initial.head_sha;
  const start = deps.startMonitorJob ?? startAsyncJob;
  const poll = deps.pollMonitorJob ?? pollAsyncJob;
  const sleep = deps.monitorSleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.monitorNow ?? Date.now;
  const started = now();
  const jobs = {};
  for (const [gate, run] of [
    ["ci", () => deps.watchCi({ repoPath: args.repoPath, branch: initial.branch, expectedHeadSha: head })],
    ["sonar", () => deps.watchSonar({
      repoPath: args.repoPath, prNumber: args.prNumber, initialWaitSeconds: 0, expectedHeadSha: head,
      totalTimeoutSeconds: MONITOR_TOTAL_TIMEOUT_MS / 1000,
    })],
  ]) {
    const job = start(`monitor_${gate}`, run, {
      idempotencyKey: head,
      idempotencyNamespace: `monitor:${args.repoPath}:${args.prNumber}:${gate}`,
      fingerprint: asyncJobInputFingerprint({ head }),
      retryStaleResult: isNonVerdictWatchResult,
    });
    if (!job.ok) return job;
    jobs[gate] = job.job_id;
  }
  const evidence = () => ({ head_sha: head, monitor_jobs: jobs,
    resume: { action: "monitor", repo_path: args.repoPath, issue_number: args.issueNumber, pr_number: args.prNumber },
    time_to_actionable_ms: now() - started, wait_after_actionable_ms: 0 });
  let intervalMs = MONITOR_INTERVAL_BASE_MS;
  while (now() - started < MONITOR_TOTAL_TIMEOUT_MS) {
    const current = await read();
    if (!current.ok) return { ...current, ...evidence() };
    if (current.head_sha !== head) return failure("monitor", "monitor_head_changed",
      "The PR head changed; previous results are diagnostic only", "monitor_the_current_pr_head", evidence());
    // A conflict can also appear mid-watch, when the base moves under an open pull request.
    const conflict = conflictFailure(current, evidence());
    if (conflict) return conflict;
    const ci = poll(jobs.ci);
    const sonar = poll(jobs.sonar);
    const result = observedResult(current, ci, sonar, evidence());
    if (result) return result;
    intervalMs = nextMonitorInterval(intervalMs, current.unchanged === true);
    await sleep(intervalMs);
  }
  return failure("monitor", "monitor_timed_out", "Hosted checks remain incomplete",
    "resume_monitoring_pending_checks", evidence());
}
