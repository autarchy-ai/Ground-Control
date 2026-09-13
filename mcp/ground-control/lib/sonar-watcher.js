// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { _sleepMs } from "./doc-coverage.js";
import { ensureGitRepo } from "./grc-legacy-compat-4.js";
import { authorizeWatcherRepoRead } from "./watcher-repo-authorization.js";
import { assertRealpathInRepo } from "./repo-context-2.js";
import { resolveRepoRelativePath } from "./repo-context.js";
import { execFile as _execFile } from "./runtime-primitives.js";
import { buildSonarScopeEvidence, classifySonarProducer, fetchSonarProducerEvidence, readSonarCloudConfigStrict, selectSonarProducerChecks } from "./sonar-scope.js";
import { SONAR_BASE_URL, SONAR_EXPORT_RETENTION, SONAR_RETRY_DELAYS_MS, _pruneSonarExports, _sonarAuthHeader, shouldRetrySonarStatus, summarizeSonarHotspots, summarizeSonarIssues } from "./repo-vocabulary.js";

/**
 * The one deadline for a watch.
 *
 * `total_timeout_seconds` used to bound only the quality-gate polling loop, so
 * the propagation wait, the retry backoffs, and the issue/hotspot pagination all
 * ran outside it and the documented cap was never the real ceiling. Every sleep
 * in this module now goes through `sleep`, which clips to what is left, and
 * every loop consults `expired` before spending another request (issue #1559).
 */
function createWatchBudget({ totalTimeoutSeconds, now, sleepMs }) {
  const startMs = now();
  const limitMs = totalTimeoutSeconds * 1000;
  const elapsedMs = () => now() - startMs;
  return {
    expired: () => elapsedMs() >= limitMs,
    sleep: async (ms) => {
      const capped = Math.min(ms, Math.max(0, limitMs - elapsedMs()));
      if (capped > 0) await sleepMs(capped);
    },
  };
}
async function _sonarFetchWithRetry(url, init, budget) {
  let lastErr = null;
  for (let attempt = 0; attempt <= SONAR_RETRY_DELAYS_MS.length; attempt++) {
    let resp;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      // Network failure (DNS, connection reset, timeout). Treated as
      // transient at the same retry tier as 5xx.
      lastErr = err;
      if (attempt < SONAR_RETRY_DELAYS_MS.length && !budget.expired()) {
        await budget.sleep(SONAR_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw err;
    }
    if (!shouldRetrySonarStatus(resp.status)) return resp;
    if (attempt >= SONAR_RETRY_DELAYS_MS.length || budget.expired()) return resp;
    await budget.sleep(SONAR_RETRY_DELAYS_MS[attempt]);
  }
  // Unreachable — loop above always returns or throws. Keep the throw
  // as a sentinel so a future refactor that breaks the loop semantics
  // surfaces cleanly.
  throw lastErr ?? new Error("sonar fetch retry exhausted");
}
// A credential the API rejected is not a credential the host is missing, and the
// two have different repairs. Raised as a tagged error so the watcher can name
// the right one instead of folding both into a generic fetch failure.
function _sonarError(code, message) {
  const err = new Error(message);
  err.sonarErrorCode = code;
  return err;
}
async function _fetchSonarQualityGate({ projectKey, prNumber, token, budget }) {
  const url = `${SONAR_BASE_URL}/api/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}&pullRequest=${encodeURIComponent(String(prNumber))}`;
  const resp = await _sonarFetchWithRetry(url, {
    headers: { Authorization: _sonarAuthHeader(token), Accept: "application/json" },
  }, budget);
  if (resp.status === 404) return { available: false };
  if (resp.status === 401 || resp.status === 403) {
    throw _sonarError(
      "sonar_watch_authentication_failed",
      `SonarCloud rejected the host credential: HTTP ${resp.status}`,
    );
  }
  if (!resp.ok) {
    throw new Error(`sonar quality gate fetch failed: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  // HTTP status and response shape are separate signals. SonarCloud answers a
  // pull request it has no component for with a 200 carrying an `errors`
  // document; that is the propagation case and stays a poll. Anything else
  // without a gate status is a body this code cannot read, and turning it into
  // another "not available" poll spends the whole cap on a parse failure.
  const status = data?.projectStatus?.status;
  if (typeof status === "string" && status.length > 0) {
    return { available: true, status };
  }
  if (data != null && typeof data === "object" && Array.isArray(data.errors)) {
    return { available: false };
  }
  throw _sonarError(
    "sonar_watch_quality_gate_malformed",
    "SonarCloud returned a quality-gate response carrying neither a status nor an error document",
  );
}
async function _fetchSonarIssues({ projectKey, prNumber, token, budget, maxPages = 20 }) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${SONAR_BASE_URL}/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&pullRequest=${encodeURIComponent(String(prNumber))}&resolved=false&ps=500&p=${page}`;
    const resp = await _sonarFetchWithRetry(url, {
      headers: { Authorization: _sonarAuthHeader(token), Accept: "application/json" },
    }, budget);
    if (!resp.ok) {
      throw new Error(`sonar issues fetch failed (page ${page}): HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const issues = Array.isArray(data?.issues) ? data.issues : [];
    out.push(...issues);
    const total = typeof data?.total === "number" ? data.total : out.length;
    if (out.length >= total) break;
    if (issues.length === 0) break;
    // Pagination used to run past the last elapsed-time check, so a wide result
    // set could spend well beyond the cap after the gate was already read.
    if (budget.expired()) break;
  }
  return out;
}
async function _fetchSonarHotspots({ projectKey, prNumber, token, budget, maxPages = 20 }) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${SONAR_BASE_URL}/api/hotspots/search?projectKey=${encodeURIComponent(projectKey)}&pullRequest=${encodeURIComponent(String(prNumber))}&status=TO_REVIEW&ps=500&p=${page}`;
    const resp = await _sonarFetchWithRetry(url, {
      headers: { Authorization: _sonarAuthHeader(token), Accept: "application/json" },
    }, budget);
    if (!resp.ok) {
      throw new Error(`sonar hotspots fetch failed (page ${page}): HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const hotspots = Array.isArray(data?.hotspots) ? data.hotspots : [];
    out.push(...hotspots);
    const paging = data?.paging;
    const total = typeof paging?.total === "number" ? paging.total : out.length;
    if (out.length >= total) break;
    if (hotspots.length === 0) break;
    if (budget.expired()) break;
  }
  return out;
}
function _writeSonarExport(repoRoot, prNumber, payload) {
  // Best-effort, repo-relative, containment-checked write under
  // .gc/sonar/. Returns the rel path on success, null on any failure
  // (the export is a convenience for drilldown — never a correctness
  // requirement, so failures are non-fatal).
  try {
    const relDir = ".gc/sonar";
    const fileName = `${prNumber}-${Date.now()}.json`;
    const rel = `${relDir}/${fileName}`;
    const resolved = resolveRepoRelativePath(repoRoot, rel, "sonar_export_path");
    if (!resolved.ok) return null;
    const abs = resolved.abs;
    mkdirSync(dirname(abs), { recursive: true });
    const realRepo = realpathSync(repoRoot);
    const contain = assertRealpathInRepo(realRepo, abs, "sonar_export_path");
    if (!contain.ok) return null;
    // Prune older exports before writing to cap directory size. Runs
    // BEFORE the write so a transient OOM (unlikely) doesn't leave
    // both the new file and the now-deleted old files in an
    // intermediate state.
    _pruneSonarExports(dirname(abs), SONAR_EXPORT_RETENTION);
    writeFileSync(abs, JSON.stringify(payload, null, 2));
    return rel;
  } catch {
    return null;
  }
}
function validateWatchSonarAnalysisInput({ repoPath, prNumber, initialWaitSeconds, totalTimeoutSeconds, pollIntervalSeconds }) {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return { ok: false, error: "sonar_watch_input_invalid", message: "repo_path is required" };
  }
  if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) {
    return { ok: false, error: "sonar_watch_input_invalid", message: "pr_number must be a positive integer" };
  }
  for (const [name, value] of [
    ["initial_wait_seconds", initialWaitSeconds],
    ["total_timeout_seconds", totalTimeoutSeconds],
    ["poll_interval_seconds", pollIntervalSeconds],
  ]) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return { ok: false, error: "sonar_watch_input_invalid", message: `${name} must be a non-negative integer` };
    }
  }
  return null;
}

/** The zero-finding summaries every non-evaluated envelope carries. */
function emptySonarSummaries() {
  return {
    issues_summary: { open_count: 0, by_severity: {}, by_type: {}, top_issues: [] },
    hotspots_summary: { open_count: 0, top_hotspots: [] },
    full_issue_export_path: null,
  };
}
function sonarWatchTimedOut(prNumber) {
  return {
    ok: true,
    skipped: false,
    pr_number: prNumber,
    quality_gate: "NONE",
    ...emptySonarSummaries(),
    timed_out: true,
  };
}

// Poll for the quality gate; PRs not yet analyzed return 404. Returns
// `{ qg }` once available, or `{ earlyReturn }` carrying the exact envelope
// the caller should return immediately (fetch error or overall timeout).
//
// The shared `budget` is the whole watch's deadline, not this loop's: the
// propagation wait that precedes it spends from the same allowance, and its
// sleeps are clipped to what remains rather than run in full.
async function pollSonarQualityGateUntilReady({ projectKey, prNumber, token, pollIntervalSeconds, budget }) {
  while (true) {
    if (budget.expired()) {
      return { earlyReturn: sonarWatchTimedOut(prNumber) };
    }
    let qg;
    try {
      qg = await _fetchSonarQualityGate({ projectKey, prNumber, token, budget });
    } catch (e) {
      return {
        earlyReturn: {
          ok: false,
          error: e?.sonarErrorCode ?? "sonar_watch_quality_gate_failed",
          message: e?.message ?? "sonar quality gate fetch failed",
          pr_number: prNumber,
        },
      };
    }
    if (qg.available) return { qg };
    if (budget.expired()) {
      return { earlyReturn: sonarWatchTimedOut(prNumber) };
    }
    if (pollIntervalSeconds > 0) {
      await budget.sleep(pollIntervalSeconds * 1000);
    }
  }
}
// Fetch the PR's open issues then hotspots. Returns `{ issues, hotspots }`, or
// `{ earlyReturn }` carrying the exact failure envelope the caller returns.
async function _fetchSonarIssuesAndHotspots({ projectKey, prNumber, token, qgStatus, budget }) {
  let issues = [];
  let hotspots = [];
  try {
    issues = await _fetchSonarIssues({ projectKey, prNumber, token, budget });
  } catch (e) {
    return {
      earlyReturn: {
        ok: false,
        error: "sonar_watch_issues_fetch_failed",
        message: e?.message ?? "sonar issues fetch failed",
        pr_number: prNumber,
        quality_gate: qgStatus,
      },
    };
  }
  try {
    hotspots = await _fetchSonarHotspots({ projectKey, prNumber, token, budget });
  } catch (e) {
    return {
      earlyReturn: {
        ok: false,
        error: "sonar_watch_hotspots_fetch_failed",
        message: e?.message ?? "sonar hotspots fetch failed",
        pr_number: prNumber,
        quality_gate: qgStatus,
      },
    };
  }
  return { issues, hotspots };
}
const PRODUCER_SKIPPED_MESSAGE =
  "The pull request's SonarCloud producer check concluded 'skipped', so no analysis will ever be "
  + "published for it and waiting cannot change that. Check-run metadata records the skip, not its "
  + "cause: confirm the repository's own scope contract for the changed paths before treating this "
  + "as a legitimate exclusion.";

/**
 * Can a SonarCloud analysis still appear for this pull request?
 *
 * Runs before the propagation wait and before the credential gate: a watch that
 * cannot succeed should spend neither the cap nor an operator's attention on a
 * token it never needed. Returns the terminal envelope only when the producer
 * was *skipped* — the one observation that proves nothing was published — and
 * `null` for every other state, including a producer that failed. A red
 * `SonarCloud Code Analysis` check reports a rejected quality gate, so an
 * analysis exists; stopping there would suppress the issue and hotspot read and
 * report an evaluated failure as an unevaluable gate.
 */
async function resolveSonarProducerScope({ repoRoot, repoSlug, prNumber, projectKey, selector, fetchProducerEvidence, execFile }) {
  const observed = await fetchProducerEvidence({ repoRoot, repoSlug, prNumber, execFile });
  if (observed === null) return null;

  const matched = selectSonarProducerChecks(observed.entries, selector);
  const { analysis, reason } = classifySonarProducer(matched);
  if (analysis !== "skipped") return null;

  return {
    ok: false,
    error: "sonar_watch_analysis_not_produced",
    message: PRODUCER_SKIPPED_MESSAGE,
    pr_number: prNumber,
    // The skip is observed; the *reason* for it is not proved by check metadata,
    // so this envelope terminates the watch without authorizing a scope waiver
    // at the readiness gate. Issue #1533 owns that clearance and consumes this
    // evidence rather than a caller's assertion.
    scope: "unproved",
    scope_evidence: buildSonarScopeEvidence({
      repoSlug, prNumber, headSha: observed.headSha, projectKey, selector, checks: matched, reason,
    }),
  };
}

/**
 * Read the repo's SonarCloud declaration into the watch's inputs.
 *
 * Returns `{ projectKey, selector }` when the repo opted into the gate, or
 * `{ earlyReturn }` carrying the exact envelope the caller returns: a skip for a
 * repo that declares no `sonarcloud` block, and a refusal for a declaration this
 * server could not read at all — the permissive reader turned both an
 * unparseable file and an unreadable one into `skipped: true`, which
 * `sonarGatePassed` accepts unconditionally (issue #1559).
 */
function resolveSonarDeclaration(repoRoot, prNumber) {
  const declared = readSonarCloudConfigStrict(repoRoot);
  if (declared.state === "invalid" || declared.state === "unreadable") {
    return {
      earlyReturn: {
        ok: false,
        error: "sonar_watch_config_invalid",
        message: `.ground-control.yaml could not be read as a SonarCloud declaration, so the gate produced no verdict: ${declared.errors[0]}`,
        pr_number: prNumber,
      },
    };
  }
  if (declared.state !== "configured") {
    // No sonarcloud block — skip entirely. Mirrors current /implement Step 11.
    return {
      earlyReturn: {
        ok: true,
        skipped: true,
        pr_number: prNumber,
        quality_gate: "NONE",
        ...emptySonarSummaries(),
      },
    };
  }
  return {
    projectKey: declared.config.project_key,
    selector: declared.config.analysis_check ?? null,
  };
}

/**
 * Poll the gate, then read the issue and hotspot lists behind it.
 *
 * Everything from here on needs a credential and an analysis that can exist, so
 * it is separated from the applicability checks that decide whether to get this
 * far at all.
 */
async function readSonarGate({ repoRoot, projectKey, prNumber, token, pollIntervalSeconds, budget }) {
  const pollResult = await pollSonarQualityGateUntilReady({
    projectKey, prNumber, token, pollIntervalSeconds, budget,
  });
  if (pollResult.earlyReturn) return pollResult.earlyReturn;
  const qg = pollResult.qg;

  const fetched = await _fetchSonarIssuesAndHotspots({
    projectKey, prNumber, token, qgStatus: qg.status, budget,
  });
  if (fetched.earlyReturn) return fetched.earlyReturn;
  const { issues, hotspots } = fetched;

  const exportPath = _writeSonarExport(repoRoot, prNumber, {
    pr_number: prNumber,
    quality_gate: qg.status,
    issues,
    hotspots,
    fetched_at: new Date().toISOString(),
  });

  return {
    ok: true,
    skipped: false,
    pr_number: prNumber,
    quality_gate: qg.status,
    issues_summary: summarizeSonarIssues(issues),
    hotspots_summary: summarizeSonarHotspots(hotspots),
    full_issue_export_path: exportPath,
  };
}

export async function runWatchSonarAnalysis({
  repoPath,
  prNumber,
  initialWaitSeconds = 60,
  totalTimeoutSeconds = 1800,
  pollIntervalSeconds = 30,
  fetchProducerEvidence = fetchSonarProducerEvidence,
  execFile = _execFile,
  sleepMs = _sleepMs,
  now = Date.now,
  authorizeRepoRead = authorizeWatcherRepoRead,
}) {
  const inputError = validateWatchSonarAnalysisInput({
    repoPath, prNumber, initialWaitSeconds, totalTimeoutSeconds, pollIntervalSeconds,
  });
  if (inputError) return inputError;

  // Opened before the propagation wait so `total_timeout_seconds` bounds the
  // whole watch rather than only its polling phase.
  const budget = createWatchBudget({ totalTimeoutSeconds, now, sleepMs });

  let repoRoot;
  try {
    repoRoot = await ensureGitRepo(repoPath);
  } catch (e) {
    return {
      ok: false,
      error: "sonar_watch_repo_not_found",
      message: e?.message ?? "ensureGitRepo failed",
    };
  }

  const declaration = resolveSonarDeclaration(repoRoot, prNumber);
  if (declaration.earlyReturn) return declaration.earlyReturn;
  const { projectKey, selector } = declaration;

  // The producer read spends the MCP host's GitHub credentials, so the checkout
  // has to be one this server is authorized to act on and the destination has to
  // come from that authorized identity - not from the caller's path or its
  // origin (issue #1559). Authorization gates that read alone: the Sonar watch
  // itself needs only the project key and the token, so an unauthorized or
  // unidentifiable checkout skips the pre-check and keeps the ordinary watch
  // rather than losing a gate it can still evaluate. No other repository's head
  // SHA or check metadata can leave in `scope_evidence`, because the request is
  // never made.
  const authorized = await authorizeRepoRead({ repoRoot, errorPrefix: "sonar_watch" });
  const notProduced = authorized.ok
    ? await resolveSonarProducerScope({
      repoRoot, repoSlug: authorized.repoSlug, prNumber, projectKey, selector, fetchProducerEvidence, execFile,
    })
    : null;
  if (notProduced) return notProduced;

  // Read at call time and passed only in the Authorization header - never argv,
  // a log, an export, or a returned envelope. The value reaches
  // process.env from the launch directory's .env and nowhere else
  // (lib/server-env.js), so the message names that one file: an operator, not
  // the agent, repairs this state, and it is read at startup (issue #1562).
  // Reached only once a Sonar request is actually needed, so a pull request its
  // own CI never scanned can no longer be reported as a credential fault.
  const token = process.env.SONAR_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    return {
      ok: false,
      error: "sonar_watch_token_missing",
      message: "SONAR_TOKEN is not set on the MCP host. Set it in the launch directory's .env, "
        + "then restart the MCP server; the file is read at startup.",
      pr_number: prNumber,
    };
  }

  // Initial wait for analysis propagation (Step 11's existing 60s pause),
  // clipped to the remaining budget rather than always slept in full.
  if (initialWaitSeconds > 0) {
    await budget.sleep(initialWaitSeconds * 1000);
  }

  return readSonarGate({ repoRoot, projectKey, prNumber, token, pollIntervalSeconds, budget });
}
