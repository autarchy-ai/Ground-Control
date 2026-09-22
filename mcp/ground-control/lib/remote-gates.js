// CI is the authoritative broad verification boundary (issues #1628/#1629).
import { fetchPullRequest, fetchCommitCheckRollup, ghRestJson } from "./github-rest.js";
import { ghConditionalGet } from "./github-conditional.js";
import { resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";

// The last full snapshot per watched pull request, so an unchanged tick can answer from it
// (issue #1671). Bounded: a long-lived server watches many pull requests.
const SNAPSHOT_CACHE_MAX = 64;
const _snapshotCache = new Map();

function rememberSnapshot(cache, key, snapshot) {
  if (!cache.has(key) && cache.size >= SNAPSHOT_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, snapshot);
}

/**
 * Ask whether anything this snapshot depends on has changed, without spending quota.
 *
 * Every read is conditional, so an unchanged tick answers `304` and costs ~nothing against
 * the primary rate limit. A `true` here means the caller may reuse the previous snapshot; a
 * `false`, or any doubt at all, falls through to the ordinary full read.
 */
async function nothingChanged({ repoRoot, slug, prNumber, previous }, conditionalGet) {
  if (!previous?.head_sha || !previous?.base_ref) return false;
  const paths = [
    `/repos/${slug}/pulls/${prNumber}`,
    `/repos/${slug}/commits/${previous.head_sha}/check-runs?per_page=100`,
    `/repos/${slug}/commits/${previous.head_sha}/status`,
    `/repos/${slug}/branches/${encodeURIComponent(previous.base_ref)}/protection/required_status_checks`,
  ];
  for (const path of paths) {
    let result;
    try {
      result = await conditionalGet(repoRoot, path);
    } catch {
      // A probe that cannot answer is not evidence of stability.
      return false;
    }
    if (result.changed) return false;
    // A later page could have changed while the first did not, and this probe only ever
    // revalidates the first. Re-read in full rather than guess.
    if (result.paginated) return false;
  }
  return true;
}

export function evaluateRemoteChecks(checks, required) {
  const failures = checks.filter((check) =>
    ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]
      .includes(check.conclusion ?? check.state));
  const passed = (check) => check.__typename === "StatusContext"
    ? check.state === "SUCCESS"
    : check.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion);
  const missing = required.filter(({ context, app_id }) => !checks.some((check) =>
    (check.name ?? check.context) === context && (app_id == null || app_id === -1 || check.appId === app_id)));
  const pending = checks.filter((check) => !passed(check) && !failures.includes(check));
  return { passed: required.length > 0 && missing.length === 0 && pending.length === 0 && failures.length === 0,
    failures, pending, missing };
}

export async function readRemoteGateSnapshot({ repoPath, prNumber }, {
  workspaceAuthorizationResolver,
  authorize = resolveAuthorizedIssueRepository,
  readPr = fetchPullRequest,
  readChecks = fetchCommitCheckRollup,
  readJson = ghRestJson,
  conditionalGet = ghConditionalGet,
  snapshotCache = _snapshotCache,
} = {}) {
  const repository = await authorize(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) return repository;
  const { repoRoot, owner, name } = repository;
  const slug = `${owner}/${name}`;
  const cacheKey = `${repoRoot}\u0000${prNumber}`;
  const previous = snapshotCache.get(cacheKey);
  if (previous && await nothingChanged({ repoRoot, slug, prNumber, previous }, conditionalGet)) {
    return { ...previous, unchanged: true };
  }
  try {
    const pr = await readPr(repoRoot, owner, name, prNumber);
    if (!pr?.headRefOid || !pr.baseRefName) throw new Error("PR head or base is unavailable");
    const [checks, protection] = await Promise.all([
      readChecks(repoRoot, slug, pr.headRefOid),
      readJson(repoRoot, `/repos/${slug}/branches/${encodeURIComponent(pr.baseRefName)}/protection/required_status_checks`),
    ]);
    const required = Array.isArray(protection?.checks) && protection.checks.length
      ? protection.checks : (protection?.contexts ?? []).map((context) => ({ context }));
    const current = await readPr(repoRoot, owner, name, prNumber);
    if (current?.headRefOid !== pr.headRefOid || current?.baseRefName !== pr.baseRefName) {
      return { ok: false, error: "remote_gate_head_changed", next_action: "monitor_the_current_pr_head" };
    }
    const snapshot = { ok: true, head_sha: pr.headRefOid, branch: pr.headRefName, state: pr.state,
      base_ref: pr.baseRefName, merge_state: pr.mergeStateStatus ?? null,
      checks, required, ...evaluateRemoteChecks(checks, required) };
    rememberSnapshot(snapshotCache, cacheKey, snapshot);
    return { ...snapshot, unchanged: false };
  } catch (error) {
    return { ok: false, error: "remote_gate_evidence_unavailable", message: error.message,
      next_action: "repair_hosted_check_access_then_retry" };
  }
}
