// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { _fetchCiRunFailedLog, _fetchCiRunSnapshot, _sleepMs, ciRunQueuedSeconds, evaluateCiPollState, extractFailedStepsFromJobsJson, summarizeCiLogFailedOutput } from "./doc-coverage.js";
import { ensureGitRepo } from "./grc-legacy-compat-4.js";
import { authorizeWatcherRepoRead } from "./watcher-repo-authorization.js";
import { FINDING_CLASSIFICATIONS, FINDING_SWEEP_EVIDENCE_MAX, truncateReviewProse } from "./grc-legacy-compat.js";
import { buildCiWatchGhArgs } from "./doc-coverage.js";
import { execFile } from "./runtime-primitives.js";

export const TEST_QUALITY_REVIEW_DEFAULT_MODEL = "claude-sonnet-5";
// Hard timeout for a single review call. Repository-scale test cutovers can
// legitimately require more than ten minutes of read-only inspection. The
// async job owns cancellation and result polling; this 30-minute ceiling is a
// final stuck-child bound, not an MCP request-lifetime surrogate.
export const TEST_QUALITY_REVIEW_TIMEOUT_MS = 1_800_000;
export const TEST_QUALITY_FINDING_FIELDS_DESCRIPTION = [
  '    `severity`        — exactly "critical" or "warning".',
  "    `location`        — `<file>::<TestClass>::<test_method>` OR `<file>:<line>`.",
  "    `problem`         — what's wrong (non-empty).",
  "    `why_it_matters`  — what regression this test would miss (optional but recommended).",
  "    `fix`             — specific fix, not vague advice (non-empty).",
  '    `classification`  — exactly "one-off" or "class". Same rules as the codex reviewer.',
  '    `sweep_evidence`  — REQUIRED when classification is "one-off". One-line statement of what you swept and what you did NOT find. Forbidden when classification is "class".',
  '    `category`        — REQUIRED when classification is "class"; forbidden when "one-off". Object: `shape` and `instances` (non-empty array).',
  "    `structural_blocker` — optional boolean. Set on a one-off that warrants verdict=don't-ship.",
].join("\n");
export const TEST_QUALITY_FINDING_EXAMPLE = '{"severity":"critical","location":"backend/src/test/java/com/keplerops/groundcontrol/unit/domain/FooServiceTest.java::FooServiceTest::createFoo_returns_the_new_foo","problem":"Test calls fooService.create(...) but only verifies that the mock fooRepository.save was called. No assertion on the returned Foo.","why_it_matters":"Refactoring FooService.create to return null would still pass this test.","fix":"Assert on the returned Foo (id, name, status) after calling create().","classification":"class","category":{"shape":"@Test method that only verifies a mock interaction without asserting on the SUT\'s return value or state change","instances":["backend/src/test/java/com/keplerops/groundcontrol/unit/domain/FooServiceTest.java:42","backend/src/test/java/com/keplerops/groundcontrol/unit/domain/BarServiceTest.java:55"]}}';
export async function _resolveCiRunsForBranch(repoRoot, repoSlug, branch) {
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
      "status,conclusion,databaseId,url,createdAt,headSha",
    ]),
    { cwd: repoRoot },
  );
  return selectCiRunsForHeadSha(JSON.parse(stdout));
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

export function selectCiRunsForHeadSha(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return [];
  }
  const headSha = runs[0]?.headSha;
  if (typeof headSha !== "string" || headSha.length === 0) {
    // Older gh versions, or a payload without headSha: fall back to the prior
    // single-run behavior rather than watching an arbitrary mixed set.
    return [runs[0]];
  }
  return runs.filter((run) => run?.headSha === headSha);
}

export function validateTestQualityFinding(raw, i) {
  if (raw == null || typeof raw !== "object") {
    throw new Error(`test-quality review blocking[${i}] is not an object`);
  }
  const { severity, location, problem, why_it_matters, fix, classification } = raw;
  if (severity !== "critical" && severity !== "warning") {
    throw new Error(
      `test-quality review blocking[${i}].severity must be 'critical' or 'warning', got ${JSON.stringify(severity)}`,
    );
  }
  if (typeof location !== "string" || location.trim() === "") {
    throw new Error(`test-quality review blocking[${i}].location must be a non-empty string`);
  }
  if (typeof problem !== "string" || problem.trim() === "") {
    throw new Error(`test-quality review blocking[${i}].problem must be a non-empty string`);
  }
  if (typeof fix !== "string" || fix.trim() === "") {
    throw new Error(`test-quality review blocking[${i}].fix must be a non-empty string`);
  }
  if (why_it_matters != null && typeof why_it_matters !== "string") {
    throw new Error(
      `test-quality review blocking[${i}].why_it_matters must be a string when set`,
    );
  }
  if (!FINDING_CLASSIFICATIONS.has(classification)) {
    throw new Error(
      `test-quality review blocking[${i}].classification must be 'one-off' or 'class', got ${JSON.stringify(classification)}`,
    );
  }

  // Class: require category{shape, instances>=1}; reject sweep_evidence.
  let category = null;
  if (classification === "class") {
    if (raw.category == null || typeof raw.category !== "object" || Array.isArray(raw.category)) {
      throw new Error(
        `test-quality review blocking[${i}] has classification 'class' but is missing required object field 'category' ({shape, instances})`,
      );
    }
    if (typeof raw.category.shape !== "string" || raw.category.shape.trim() === "") {
      throw new Error(`test-quality review blocking[${i}].category.shape must be a non-empty string`);
    }
    if (!Array.isArray(raw.category.instances) || raw.category.instances.length === 0) {
      throw new Error(
        `test-quality review blocking[${i}].category.instances must be a non-empty array`,
      );
    }
    raw.category.instances.forEach((inst, j) => {
      if (typeof inst !== "string" || inst.trim() === "") {
        throw new Error(`test-quality review blocking[${i}].category.instances[${j}] must be a non-empty string`);
      }
    });
    if (raw.sweep_evidence !== undefined && raw.sweep_evidence !== null) {
      throw new Error(
        `test-quality review blocking[${i}] has classification 'class' but also carries 'sweep_evidence' — class findings use category.instances instead`,
      );
    }
    category = { shape: raw.category.shape.trim(), instances: raw.category.instances.map((s) => s.trim()) };
  } else {
    // one-off: require sweep_evidence; reject category.
    if (raw.category !== undefined && raw.category !== null) {
      throw new Error(
        `test-quality review blocking[${i}] has classification 'one-off' but also carries 'category' — omit it for one-off findings`,
      );
    }
    if (typeof raw.sweep_evidence !== "string" || raw.sweep_evidence.trim() === "") {
      throw new Error(
        `test-quality review blocking[${i}] has classification 'one-off' but is missing required 'sweep_evidence' (one-line statement of what you swept)`,
      );
    }
  }

  let structuralBlocker = false;
  if (raw.structural_blocker !== undefined && raw.structural_blocker !== null) {
    if (typeof raw.structural_blocker !== "boolean") {
      throw new Error(`test-quality review blocking[${i}].structural_blocker must be a boolean when set`);
    }
    if (raw.structural_blocker === true && classification === "class") {
      throw new Error(
        `test-quality review blocking[${i}] has classification 'class' so structural_blocker is implicit — set it only on one-off`,
      );
    }
    structuralBlocker = raw.structural_blocker === true;
  }

  const finding = {
    severity,
    location: location.trim(),
    problem: problem.trim(),
    why_it_matters: typeof why_it_matters === "string" ? why_it_matters.trim() : "",
    fix: fix.trim(),
    classification,
  };
  if (category !== null) finding.category = category;
  if (raw.sweep_evidence != null && classification === "one-off") {
    finding.sweep_evidence = truncateReviewProse(raw.sweep_evidence.trim(), FINDING_SWEEP_EVIDENCE_MAX);
  }
  if (structuralBlocker) finding.structural_blocker = true;
  return finding;
}
export async function runWatchCiRun({
  repoPath,
  branch,
  runId = null,
  expectedHeadSha = null,
  queuedTimeoutSeconds = 300,
  totalTimeoutSeconds = 2700,
  pollIntervalSeconds = 15,
  authorizeRepoRead = authorizeWatcherRepoRead,
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

  // Resolve the run set. An explicit runId watches exactly that run; otherwise
  // watch every run the branch's newest commit triggered, so the gate cannot
  // pass on an unrelated workflow that happened to finish first (issue #1461).
  let watchedRunIds = [];
  if (runId !== null && runId !== undefined) {
    watchedRunIds = [runId];
  } else {
    let selected;
    try {
      const deadline = now() + totalTimeoutSeconds * 1000;
      do {
        selected = await resolveRuns(repoRoot, repoSlug, branch);
        if (!expectedHeadSha) break;
        selected = selected.filter((run) => run.headSha === expectedHeadSha);
        if (selected.length || now() >= deadline) break;
        await sleep(pollIntervalSeconds * 1000);
      } while (true);
    } catch (e) {
      return {
        ok: false,
        error: "ci_watch_run_lookup_failed",
        message: e?.message ?? "gh run list failed",
        branch,
      };
    }
    if (selected.length === 0) {
      return {
        ok: false,
        error: "ci_watch_no_run_for_branch",
        message: `no CI runs found for branch '${branch}'`,
        branch,
      };
    }
    if (expectedHeadSha) selected = selected.filter((run) => run.headSha === expectedHeadSha);
    watchedRunIds = selected
      .map((run) => (typeof run.databaseId === "number" ? run.databaseId : null))
      .filter((id) => id !== null);
    if (watchedRunIds.length === 0) {
      return {
        ok: false,
        error: "ci_watch_run_lookup_failed",
        message: "gh run list returned no databaseId",
        branch,
      };
    }
  }
  const startMs = now();
  const firstQueuedObservedMs = new Map();
  let observed = [];
  while (true) {
    observed = [];
    for (const id of watchedRunIds) {
      try {
        observed.push({ id, snapshot: await fetchRunSnapshot(repoRoot, repoSlug, id) });
      } catch (e) {
        return {
          ok: false,
          error: "ci_watch_snapshot_failed",
          message: e?.message ?? "gh run view failed",
          run_id: id,
        };
      }
    }
    const nowMs = now();
    const elapsedSeconds = Math.floor((nowMs - startMs) / 1000);
    // A failed job is actionable even while other jobs in its workflow run.
    const failed = observed.find(({ snapshot }) =>
      ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(snapshot?.conclusion)
      || (snapshot?.jobs ?? []).some((job) => ["failure", "timed_out", "cancelled"].includes(job.conclusion)));
    if (failed) {
      return { ...ciWatchEnvelope(failed, "failure", elapsedSeconds, observed),
        head_sha: failed.snapshot?.headSha ?? expectedHeadSha,
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
        return ciWatchEnvelope(run, "queued_too_long", elapsedSeconds, observed);
      }
      if (decision.action === "timed_out") {
        timedOut ??= run;
      }
    }
    if (timedOut) {
      return ciWatchEnvelope(timedOut, "timed_out", elapsedSeconds, observed);
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

  const envelope = ciWatchEnvelope(failingRun, ghConclusion, elapsedSeconds, observed);
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
function ciWatchEnvelope(run, conclusion, elapsedSeconds, observed) {
  const summary = ciRunSummary(run);
  return {
    ok: true,
    run_id: summary.run_id,
    conclusion,
    status: summary.status,
    url: summary.url,
    duration_seconds: elapsedSeconds,
    failed_steps: [],
    log_summary: null,
    runs: observed.map(ciRunSummary),
  };
}
