// CI is the authoritative broad verification boundary (issues #1628/#1629).
import { fetchPullRequest, fetchCommitCheckRollup, ghRestJson } from "./github-rest.js";
import { resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";

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
} = {}) {
  const repository = await authorize(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) return repository;
  const { repoRoot, owner, name } = repository;
  const slug = `${owner}/${name}`;
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
    return { ok: true, head_sha: pr.headRefOid, branch: pr.headRefName, state: pr.state,
      checks, required, ...evaluateRemoteChecks(checks, required) };
  } catch (error) {
    return { ok: false, error: "remote_gate_evidence_unavailable", message: error.message,
      next_action: "repair_hosted_check_access_then_retry" };
  }
}
