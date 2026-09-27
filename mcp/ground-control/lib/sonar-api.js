// The SonarCloud Web API reads the watcher makes: retry, authentication failure, and the
// request shape. Split from sonar-watcher.js for the 500-line limit (docs/CODING_STANDARDS.md).

import { SONAR_BASE_URL, SONAR_RETRY_DELAYS_MS, _sonarAuthHeader, shouldRetrySonarStatus } from "./repo-vocabulary.js";

/**
 * One SonarCloud API URL. An organization-scoped token is refused (HTTP 400) on a
 * search that does not name its organization, so the declared one always goes along;
 * a repository that declares none keeps the unscoped form a user token accepts.
 */
export function sonarApiUrl(path, organization, params) {
  const url = new URL(path, SONAR_BASE_URL);
  if (organization) url.searchParams.set("organization", organization);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
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
export async function _fetchSonarQualityGate({ projectKey, organization, prNumber, token, budget }) {
  const url = sonarApiUrl("/api/qualitygates/project_status", organization, { projectKey, pullRequest: prNumber });
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
async function _fetchSonarIssues({ projectKey, organization, prNumber, token, budget, maxPages = 20 }) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = sonarApiUrl("/api/issues/search", organization, {
      componentKeys: projectKey, pullRequest: prNumber, resolved: "false", ps: 500, p: page,
    });
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
async function _fetchSonarHotspots({ projectKey, organization, prNumber, token, budget, maxPages = 20 }) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = sonarApiUrl("/api/hotspots/search", organization, {
      projectKey, pullRequest: prNumber, status: "TO_REVIEW", ps: 500, p: page,
    });
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
// Fetch the PR's open issues then hotspots. Returns `{ issues, hotspots }`, or
// `{ earlyReturn }` carrying the exact failure envelope the caller returns.
export async function _fetchSonarIssuesAndHotspots({ projectKey, organization, prNumber, token, qgStatus, budget }) {
  let issues = [];
  let hotspots = [];
  try {
    issues = await _fetchSonarIssues({ projectKey, organization, prNumber, token, budget });
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
    hotspots = await _fetchSonarHotspots({ projectKey, organization, prNumber, token, budget });
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
