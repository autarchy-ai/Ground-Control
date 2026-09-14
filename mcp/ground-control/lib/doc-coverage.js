// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { resolveRepoRelativePath } from "./repo-context.js";
import { execFile } from "./runtime-primitives.js";

const DOCUMENTATION_OUTCOMES = Object.freeze(["updated", "verified_unchanged", "not_updated_authorized"]);
const DOCUMENTATION_RATIONALE_MAX_CHARS = 2000;
export function validateDocumentationOutcome(input) {
  if (input == null || typeof input !== "object") {
    return { ok: false, errors: ["documentation_outcome must be an object"] };
  }
  const errors = [];
  const { outcome, rationale } = input;
  if (typeof outcome !== "string" || !DOCUMENTATION_OUTCOMES.includes(outcome)) {
    errors.push(`documentation_outcome.outcome must be one of: ${DOCUMENTATION_OUTCOMES.join(", ")}`);
  }
  // Rationale rules: only `not_updated_authorized` may have a rationale; it is
  // required and bounded. Other outcomes must NOT supply one (strict).
  if (outcome === "not_updated_authorized") {
    if (typeof rationale !== "string" || rationale.trim() === "") {
      errors.push("documentation_outcome.rationale is required for outcome=not_updated_authorized and must be non-empty");
    } else if (rationale.length > DOCUMENTATION_RATIONALE_MAX_CHARS) {
      errors.push(
        `documentation_outcome.rationale exceeds the ${DOCUMENTATION_RATIONALE_MAX_CHARS}-character limit (got ${rationale.length})`,
      );
    }
  } else if (rationale != null) {
    errors.push(`documentation_outcome.rationale must not be supplied for outcome=${outcome} (strict)`);
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      outcome,
      ...(rationale != null ? { rationale } : {}),
    },
  };
}
const SURFACE_CLASS_MAP = [
  {
    surface_class: "workflow",
    prefix_patterns: ["skills/implement/", "skills/quickfix/"],
    doc_targets: ["architecture/adrs/", "docs/DEVELOPMENT_WORKFLOW.md"],
    outcome_required: true,
  },
  {
    surface_class: "mcp_tool",
    // The entry point and the runtime it loads. index.js became an environment
    // bootstrap in #1562 and the registrations moved to server-runtime.js;
    // anchoring only on index.js would keep matching a file the tool surface
    // had left, which is the same failure the config_parser note below records.
    exact_patterns: [
      "mcp/ground-control/index.js",
      "mcp/ground-control/server-runtime.js",
    ],
    doc_targets: ["docs/DEVELOPMENT_WORKFLOW.md"],
    outcome_required: true,
  },
  {
    surface_class: "config_parser",
    // The parser itself, plus the barrel that publishes it. Anchoring only on the barrel meant
    // that once the parser moved out of it, changing the parser stopped requiring documentation —
    // the surface kept matching a file the contract had left.
    exact_patterns: [
      "mcp/ground-control/lib.js",
      "mcp/ground-control/lib/ground-control-config.js",
    ],
    doc_targets: ["docs/DEVELOPMENT_WORKFLOW.md", "architecture/adrs/027-agent-neutral-implement-workflow-packaging.md"],
    outcome_required: true,
  },
  {
    surface_class: "policy",
    prefix_patterns: ["tools/policy/", "tools/tests/", "bin/policy", "architecture/policies/"],
    doc_targets: ["docs/DEVELOPMENT_WORKFLOW.md"],
    outcome_required: true,
  },
  {
    surface_class: "adr",
    prefix_patterns: ["architecture/adrs/"],
    doc_targets: ["architecture/adrs/README.md"],
    outcome_required: true,
  },
  {
    surface_class: "doc",
    prefix_patterns: ["docs/", "architecture/"],
    doc_targets: [],
    outcome_required: false,
  },
];
export function classifyChangedSurface(changedPaths, repoRoot) {
  if (!Array.isArray(changedPaths)) {
    throw new TypeError("classifyChangedSurface: changedPaths must be an array");
  }
  const classifications = [];
  let outcome_required = false;

  for (const rawPath of changedPaths) {
    // Lexical containment check — reuses the existing helper.
    const check = resolveRepoRelativePath(repoRoot, rawPath, "changed_path");
    if (!check.ok) {
      throw new TypeError(`classifyChangedSurface: ${check.error}`);
    }
    const normalizedPath = check.rel;

    let matched = null;
    for (const entry of SURFACE_CLASS_MAP) {
      // Check exact patterns first
      if (entry.exact_patterns) {
        for (const exact of entry.exact_patterns) {
          if (normalizedPath === exact) {
            matched = entry;
            break;
          }
        }
        if (matched) break;
      }
      // Then prefix patterns
      if (entry.prefix_patterns) {
        for (const prefix of entry.prefix_patterns) {
          if (normalizedPath.startsWith(prefix)) {
            matched = entry;
            break;
          }
        }
        if (matched) break;
      }
    }

    if (matched === null) {
      classifications.push({ path: rawPath, surface_class: "unclassified", doc_targets: [] });
    } else {
      classifications.push({ path: rawPath, surface_class: matched.surface_class, doc_targets: [...matched.doc_targets] });
      if (matched.outcome_required) {
        outcome_required = true;
      }
    }
  }

  return { classifications, outcome_required };
}
export function renderDocumentationSection(docOutcome) {
  const lines = [];
  lines.push("## Documentation");
  lines.push("");
  if (docOutcome.outcome === "updated") {
    lines.push("Updated: see diff.");
  } else if (docOutcome.outcome === "verified_unchanged") {
    lines.push("Verified unchanged: no documentation surface in scope.");
  } else {
    // not_updated_authorized
    lines.push(`Not updated (authorized): ${docOutcome.rationale}`);
  }
  return lines;
}
export function buildFinalReportMarker({ issueNumber, prNumber }) {
  return `<!-- gc:final-report issue="${issueNumber}" pr="${prNumber}" -->`;
}
export function renderCiStatus(s) {
  if (s === "green") return "✅ green";
  if (s === "red") return "❌ red";
  return "skipped";
}
export function renderSonarStatus(s) {
  if (s === "passed") return "✅ passed";
  if (s === "failed") return "❌ failed";
  return "skipped (no sonarcloud config)";
}
const CI_TERMINAL_STATUSES = new Set(["completed"]);
const CI_QUEUED_STATUSES = new Set(["queued", "pending", "waiting"]);
// A job has claimed a runner once it is running or has finished with a real
// result. A skipped job never needed a runner, so it does not show that the run
// left the queue.
export function ciRunHasStartedJob(snapshot) {
  const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
  return jobs.some(
    (job) =>
      job?.status === "in_progress" ||
      (job?.status === "completed" && job?.conclusion !== "skipped"),
  );
}
function ciTimestampMs(value) {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  // gh renders an unset timestamp as the zero time (0001-01-01), which parses.
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
// Seconds a run has waited for its first runner, or null when the run is not
// queued or any of its jobs has started. A run's status reads `queued` again
// between jobs, while finished jobs hand off to `needs:` dependents that are
// still waiting for a runner, and that is not a stuck queue (issue #1581).
// The wait is measured from the latest attempt's start (`startedAt`, which a
// re-run resets) or the run's creation, so a run queued before the watch began
// gets no fresh allowance; `firstQueuedObservedMs` covers a snapshot with
// neither timestamp.
export function ciRunQueuedSeconds(snapshot, nowMs, firstQueuedObservedMs) {
  if (!CI_QUEUED_STATUSES.has(snapshot?.status) || ciRunHasStartedJob(snapshot)) {
    return null;
  }
  const sinceMs =
    ciTimestampMs(snapshot?.startedAt) ?? ciTimestampMs(snapshot?.createdAt) ?? firstQueuedObservedMs;
  return Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
}
export function evaluateCiPollState({
  status,
  elapsedSeconds,
  queuedSeconds = null,
  queuedTimeoutSeconds,
  totalTimeoutSeconds,
}) {
  if (CI_TERMINAL_STATUSES.has(status)) {
    return { action: "complete" };
  }
  // `queuedSeconds` is the run's own wait for a first runner (see
  // ciRunQueuedSeconds), never the watch's elapsed time. The queued-too-long
  // signal is more specific than timed_out (a stuck runner pool is a different
  // failure mode than a slow run); report it even if the total cap was also
  // crossed.
  if (
    CI_QUEUED_STATUSES.has(status) &&
    Number.isFinite(queuedSeconds) &&
    queuedSeconds > queuedTimeoutSeconds
  ) {
    return { action: "queued_too_long" };
  }
  if (elapsedSeconds > totalTimeoutSeconds) {
    return { action: "timed_out" };
  }
  return { action: "continue" };
}
export function summarizeCiLogFailedOutput(rawText, maxBytes = 4096) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return "";
  }
  const buf = Buffer.from(rawText, "utf8");
  if (buf.length <= maxBytes) {
    return rawText;
  }
  // CI failure detail typically sits near the END of the log (the failing
  // step's stderr is the last thing written before the runner aborts).
  // Keep the tail; drop the front; add a clearly-marked truncation prefix.
  const tailBuf = buf.subarray(buf.length - maxBytes);
  const droppedBytes = buf.length - maxBytes;
  const marker = `[truncated: dropped first ${droppedBytes} bytes of ${buf.length}]\n`;
  return marker + tailBuf.toString("utf8");
}
export function extractFailedStepsFromJobsJson(jobsJson, maxSteps = 10) {
  if (!jobsJson || typeof jobsJson !== "object") return [];
  const jobs = Array.isArray(jobsJson.jobs) ? jobsJson.jobs : [];
  const out = [];
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      if (step.conclusion !== "failure") continue;
      out.push({
        job_name: typeof job.name === "string" ? job.name : "",
        step_name: typeof step.name === "string" ? step.name : "",
      });
      if (out.length >= maxSteps) return out;
    }
  }
  return out;
}
export function buildCiWatchGhArgs(repoSlug, runArgs) {
  // Exported for tests so callers can assert `--repo` is always first in
  // the argv shape. Concatenates `["--repo", "<owner>/<name>"]` ahead of
  // the run-specific flags.
  if (typeof repoSlug !== "string" || !repoSlug.includes("/")) {
    throw new Error(`buildCiWatchGhArgs: expected owner/name slug, got '${repoSlug}'`);
  }
  return ["--repo", repoSlug, ...runArgs];
}

export async function _fetchCiRunSnapshot(repoRoot, repoSlug, runId) {
  const { stdout } = await execFile(
    "gh",
    buildCiWatchGhArgs(repoSlug, [
      "run",
      "view",
      String(runId),
      "--json",
      "status,conclusion,databaseId,url,createdAt,startedAt,updatedAt,workflowName,jobs",
    ]),
    { cwd: repoRoot },
  );
  return JSON.parse(stdout);
}
export async function _fetchCiRunFailedLog(repoRoot, repoSlug, runId) {
  try {
    const { stdout } = await execFile(
      "gh",
      buildCiWatchGhArgs(repoSlug, ["run", "view", String(runId), "--log-failed"]),
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  } catch (e) {
    // Best-effort. The run summary is more valuable than a fragile log dump;
    // surface the partial stdout if gh emitted anything before erroring.
    return typeof e?.stdout === "string" ? e.stdout : "";
  }
}
export function _sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
