// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { _fetchCiRunFailedLog, _fetchCiRunSnapshot, _sleepMs, ciRunQueuedSeconds, evaluateCiPollState, extractFailedStepsFromJobsJson, summarizeCiLogFailedOutput } from "./doc-coverage.js";
import { ensureGitRepo } from "./grc-legacy-compat-4.js";
import { authorizeWatcherRepoRead } from "./watcher-repo-authorization.js";
import { buildCiWatchGhArgs } from "./doc-coverage.js";
import { execFile } from "./runtime-primitives.js";

export async function _resolveBranchHeadSha(repoRoot, repoSlug, branch) {
  // The branch tip, read from GitHub rather than from the newest run gh
  // reports. The newest run is exactly what cannot be trusted here: right after
  // a push it still belongs to the previous commit (issue #1365). `gh api`
  // takes no `--repo`, so the authorized slug is spelled into the path, which
  // leaves `GH_REPO` no target to retarget.
  const { stdout } = await execFile(
    "gh",
    ["api", `repos/${repoSlug}/commits/${branch}`, "--jq", ".sha"],
    { cwd: repoRoot },
  );
  return stdout.trim();
}

export async function _resolveCiRunsForBranch(repoRoot, repoSlug, branch, headSha) {
  const { stdout } = await execFile(
    "gh",
    buildCiWatchGhArgs(repoSlug, [
      "run",
      "list",
      "--branch",
      branch,
      "--limit",
      "20",
      "--json",
      "status,conclusion,databaseId,url,createdAt,headSha,workflowName,event",
    ]),
    { cwd: repoRoot },
  );
  return selectCiRunsForHeadSha(JSON.parse(stdout), headSha);
}

export function aggregateCiRunOutcomes(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return { conclusion: "unknown", failing: null };
  }
  const nonSuccess = snapshots.filter((snap) => snap?.conclusion !== "success");
  if (nonSuccess.length === 0) {
    return { conclusion: "success", failing: null };
  }
  const failing =
    nonSuccess.find((snap) => snap?.conclusion === "failure") ?? nonSuccess[0];
  return {
    conclusion:
      typeof failing?.conclusion === "string" && failing.conclusion.length > 0
        ? failing.conclusion
        : "unknown",
    failing,
  };
}

// Selection is by the head SHA the watch is bound to, never by whichever run
// gh listed first. The old "newest run wins" reading was the defect in issue
// #1365: a run list is ordered by creation, so before the pushed commit's runs
// register the newest entry is the previous commit's - and its success would
// have been reported as this commit's gate.
export function selectCiRunsForHeadSha(runs, headSha) {
  if (typeof headSha !== "string" || headSha.length === 0) {
    throw new Error("selectCiRunsForHeadSha: a head SHA is required");
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    return [];
  }
  return runs.filter((run) => run?.headSha === headSha);
}

export async function runWatchCiRun({
  repoPath,
  branch,
  runId = null,
  expectedHeadSha = null,
  queuedTimeoutSeconds = 300,
  totalTimeoutSeconds = 2700,
  pollIntervalSeconds = 15,
  runRegistrationTimeoutSeconds = 300,
  authorizeRepoRead = authorizeWatcherRepoRead,
  resolveHeadSha = _resolveBranchHeadSha,
  resolveRuns = _resolveCiRunsForBranch,
  fetchRunSnapshot = _fetchCiRunSnapshot,
  fetchFailedLog = _fetchCiRunFailedLog,
  now = Date.now,
  sleep = _sleepMs,
}) {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return {
      ok: false,
      error: "ci_watch_input_invalid",
      message: "repo_path is required",
    };
  }
  if (typeof branch !== "string" || branch.length === 0) {
    return {
      ok: false,
      error: "ci_watch_input_invalid",
      message: "branch is required",
    };
  }
  if (runId !== null && runId !== undefined) {
    if (
      typeof runId !== "number" ||
      !Number.isInteger(runId) ||
      runId <= 0
    ) {
      return {
        ok: false,
        error: "ci_watch_input_invalid",
        message: "run_id must be a positive integer when provided",
      };
    }
  }
  for (const [name, value] of [
    ["queued_timeout_seconds", queuedTimeoutSeconds],
    ["total_timeout_seconds", totalTimeoutSeconds],
    ["poll_interval_seconds", pollIntervalSeconds],
    ["run_registration_timeout_seconds", runRegistrationTimeoutSeconds],
  ]) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value <= 0
    ) {
      return {
        ok: false,
        error: "ci_watch_input_invalid",
        message: `${name} must be a positive integer`,
      };
    }
  }

  let repoRoot;
  try {
    repoRoot = await ensureGitRepo(repoPath);
  } catch (e) {
    return {
      ok: false,
      error: "ci_watch_repo_not_found",
      message: e?.message ?? "ensureGitRepo failed",
    };
  }

  // Resolve owner/name up-front so every subsequent `gh` call can pass
  // `--repo <slug>` and ignore any rogue `GH_REPO` env var on the MCP host.
  // The slug comes from the authorized launch-workspace identity, not from the
  // caller-selected checkout's origin: these reads spend the MCP host's GitHub
  // credentials, and origin alone does not establish that the checkout is one
  // this server may act on (issue #1559).
  const authorized = await authorizeRepoRead({ repoRoot, errorPrefix: "ci_watch" });
  if (!authorized.ok) return authorized;
  const repoSlug = authorized.repoSlug;

  // The total cap is spent from here, so the wait for a run to register cannot
  // buy the poll loop a second budget (issue #1365).
  const startMs = now();

  // Resolve the run set. An explicit runId watches exactly that run; otherwise
  // the watch binds to one head commit - the caller's when it supplied one,
  // else the branch tip read from GitHub - and watches every run that commit
  // triggered, so the gate can pass on neither an unrelated workflow that
  // finished first (issue #1461) nor an earlier commit's run (issue #1365).
  let watchedRunIds = [];
  let boundHeadSha = typeof expectedHeadSha === "string" && expectedHeadSha.length > 0
    ? expectedHeadSha
    : null;
  if (runId !== null && runId !== undefined) {
    watchedRunIds = [runId];
  } else {
    if (boundHeadSha === null) {
      try {
        boundHeadSha = await resolveHeadSha(repoRoot, repoSlug, branch);
      } catch (e) {
        return {
          ok: false,
          error: "ci_watch_head_sha_unresolved",
          message: e?.message ?? "gh api commits lookup failed",
          branch,
        };
      }
    }
    // Failing closed is the point: with no commit to bind to there is no run
    // set this watch could honestly report on. The shape is checked because a
    // lookup that answered with something other than a commit did not answer.
    if (typeof boundHeadSha !== "string" || !/^[0-9a-f]{7,40}$/.test(boundHeadSha)) {
      return {
        ok: false,
        error: "ci_watch_head_sha_unresolved",
        message: `could not resolve the head commit of branch '${branch}'`,
        branch,
      };
    }
    // GitHub registers a push's runs seconds to minutes after the push, so an
    // empty set means "not yet", not "never". Wait, bounded by the smaller of
    // the registration cap and what is left of the total cap.
    const registrationSeconds = Math.min(runRegistrationTimeoutSeconds, totalTimeoutSeconds);
    const registrationDeadline = startMs + registrationSeconds * 1000;
    let selected = [];
    while (true) {
      try {
        selected = await resolveRuns(repoRoot, repoSlug, branch, boundHeadSha);
      } catch (e) {
        return {
          ok: false,
          error: "ci_watch_run_lookup_failed",
          message: e?.message ?? "gh run list failed",
          branch,
          head_sha: boundHeadSha,
        };
      }
      if (selected.length > 0) break;
      const remainingMs = registrationDeadline - now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(pollIntervalSeconds * 1000, remainingMs));
    }
    if (selected.length === 0) {
      return {
        ok: false,
        error: "ci_watch_no_run_for_head_sha",
        message:
          `no CI run registered for branch '${branch}' at head ${boundHeadSha} ` +
          `within ${registrationSeconds}s`,
        branch,
        head_sha: boundHeadSha,
      };
    }
    watchedRunIds = selected
      .map((run) => (typeof run.databaseId === "number" ? run.databaseId : null))
      .filter((id) => id !== null);
    if (watchedRunIds.length === 0) {
      return {
        ok: false,
        error: "ci_watch_run_lookup_failed",
        message: "gh run list returned no databaseId",
        branch,
        head_sha: boundHeadSha,
      };
    }
  }
  const firstQueuedObservedMs = new Map();
  let observed = [];
  while (true) {
    observed = [];
    for (const id of watchedRunIds) {
      let snapshot;
      try {
        snapshot = await fetchRunSnapshot(repoRoot, repoSlug, id);
      } catch (e) {
        return {
          ok: false,
          error: "ci_watch_snapshot_failed",
          message: e?.message ?? "gh run view failed",
          run_id: id,
        };
      }
      // A pinned `run_id` is the one path that reaches here unbound by the
      // selection above; a caller that also named a head gets it checked.
      if (boundHeadSha && typeof snapshot?.headSha === "string" && snapshot.headSha !== boundHeadSha) {
        return {
          ok: false,
          error: "ci_watch_run_head_mismatch",
          message: `run ${id} ran on ${snapshot.headSha}, not the watched head ${boundHeadSha}`,
          run_id: id,
          branch,
          head_sha: boundHeadSha,
          run_head_sha: snapshot.headSha,
        };
      }
      observed.push({ id, snapshot });
    }
    const nowMs = now();
    const elapsedSeconds = Math.floor((nowMs - startMs) / 1000);
    // A failed job is actionable even while other jobs in its workflow run.
    const failed = observed.find(({ snapshot }) =>
      ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(snapshot?.conclusion)
      || (snapshot?.jobs ?? []).some((job) => ["failure", "timed_out", "cancelled"].includes(job.conclusion)));
    if (failed) {
      return { ...ciWatchEnvelope(failed, "failure", elapsedSeconds, observed, boundHeadSha),
        failed_steps: extractFailedStepsFromJobsJson(failed.snapshot),
        pending_run_ids: observed.filter((run) => run.snapshot?.status !== "completed").map((run) => run.id),
        log_summary: failed.snapshot?.status === "completed"
          ? summarizeCiLogFailedOutput(await fetchFailedLog(repoRoot, repoSlug, failed.id), 4096) : null,
        time_to_actionable_ms: nowMs - startMs, wait_after_actionable_ms: 0 };
    }
    // The set is only settled when every run is settled. Each unsettled run is
    // judged on its own queue wait, so one run's hand-off between jobs cannot
    // read as another run's stuck queue (issue #1581).
    const pending = observed.filter((run) => run.snapshot?.status !== "completed");
    if (pending.length === 0) {
      break;
    }
    let timedOut = null;
    for (const run of pending) {
      const queuedSeconds = ciRunQueuedSeconds(
        run.snapshot,
        nowMs,
        firstQueuedObservedMs.get(run.id) ?? nowMs,
      );
      if (queuedSeconds !== null && !firstQueuedObservedMs.has(run.id)) {
        firstQueuedObservedMs.set(run.id, nowMs);
      }
      const decision = evaluateCiPollState({
        status: run.snapshot?.status,
        elapsedSeconds,
        queuedSeconds,
        queuedTimeoutSeconds,
        totalTimeoutSeconds,
      });
      if (decision.action === "queued_too_long") {
        return ciWatchEnvelope(run, "queued_too_long", elapsedSeconds, observed, boundHeadSha);
      }
      if (decision.action === "timed_out") {
        timedOut ??= run;
      }
    }
    if (timedOut) {
      return ciWatchEnvelope(timedOut, "timed_out", elapsedSeconds, observed, boundHeadSha);
    }
    await sleep(pollIntervalSeconds * 1000);
  }

  // Terminal state reached. Success requires every watched run to have
  // succeeded; otherwise report the run responsible.
  const elapsedSeconds = Math.floor((now() - startMs) / 1000);
  const outcome = aggregateCiRunOutcomes(observed.map((run) => run.snapshot));
  if (!outcome.failing) {
    // A success belongs to the whole set, so no single member stands in for it
    // unless it is the only one watched; `runs` lists every member.
    const only = observed.length === 1 ? observed[0] : null;
    return {
      ok: true,
      run_id: only ? only.id : null,
      conclusion: "success",
      status: "completed",
      url: only ? ciRunSummary(only).url : null,
      head_sha: boundHeadSha ?? observed[0]?.snapshot?.headSha ?? null,
      workflow: only ? ciRunSummary(only).workflow : null,
      duration_seconds: elapsedSeconds,
      failed_steps: [],
      log_summary: null,
      runs: observed.map(ciRunSummary),
    };
  }
  const failingRun = observed.find((run) => run.snapshot === outcome.failing);
  const ghConclusion = outcome.conclusion;
  const isFailure =
    ghConclusion === "failure" ||
    ghConclusion === "cancelled" ||
    ghConclusion === "timed_out" ||
    ghConclusion === "action_required" ||
    ghConclusion === "startup_failure";

  const envelope = ciWatchEnvelope(failingRun, ghConclusion, elapsedSeconds, observed, boundHeadSha);
  if (isFailure) {
    envelope.failed_steps = extractFailedStepsFromJobsJson(failingRun.snapshot);
    const rawLog = await fetchFailedLog(repoRoot, repoSlug, failingRun.id);
    envelope.log_summary = summarizeCiLogFailedOutput(rawLog, 4096);
  }
  return envelope;
}

function ciRunSummary({ id, snapshot }) {
  const text = (value) => (typeof value === "string" ? value : "");
  return {
    run_id: id,
    workflow: text(snapshot?.workflowName),
    head_sha: text(snapshot?.headSha),
    status: text(snapshot?.status),
    conclusion: text(snapshot?.conclusion),
    url: text(snapshot?.url),
  };
}

// Every identifying field comes from the one run the conclusion is about: the
// id is the one that run was fetched by, never a different member of the set.
function ciWatchEnvelope(run, conclusion, elapsedSeconds, observed, boundHeadSha = null) {
  const summary = ciRunSummary(run);
  return {
    ok: true,
    run_id: summary.run_id,
    conclusion,
    status: summary.status,
    url: summary.url,
    head_sha: summary.head_sha || boundHeadSha || null,
    workflow: summary.workflow || null,
    duration_seconds: elapsedSeconds,
    failed_steps: [],
    log_summary: null,
    runs: observed.map(ciRunSummary),
  };
}
