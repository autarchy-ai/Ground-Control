// Phase D may promise automatic finalization only when the delivery base actually carries
// a Phase E consumer that can run for this pull request (issue #1702).

import { load as parseYaml } from "js-yaml";
import { resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { fetchPullRequest, ghRestJson } from "./github-rest.js";
import { PHASE_E_WORKFLOW_PATH } from "./automation-provenance.js";

const RECOVERY =
  `Run grndctl init, merge ${PHASE_E_WORKFLOW_PATH} into the delivery base branch, then retry readiness. ` +
  "For an already-merged PR with a valid delivery handoff, dispatch Ground Control Phase E with its PR number " +
  "or run grndctl finalize-merged-pr --pr <number> from the merged checkout.";

function list(value) {
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function globRegex(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  // Every regex-active character except the two supported glob operators was escaped above.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`${source}$`);
}

function matchesOrderedPatterns(branch, patterns) {
  let included = false;
  let positive = false;
  for (const raw of patterns) {
    const negative = raw.startsWith("!");
    const pattern = negative ? raw.slice(1) : raw;
    if (!pattern) return false;
    if (!negative) positive = true;
    if (globRegex(pattern).test(branch)) included = !negative;
  }
  return positive && included;
}

export function inspectPhaseEWorkflow(text, baseBranch) {
  let workflow;
  try {
    workflow = parseYaml(text);
  } catch (error) {
    return { ok: false, reason: `workflow YAML is invalid: ${error.message}` };
  }
  const pullRequest = workflow?.on?.pull_request;
  if (!pullRequest || typeof pullRequest !== "object" || Array.isArray(pullRequest)) {
    return { ok: false, reason: "workflow does not configure the pull_request event" };
  }
  const types = list(pullRequest.types);
  if (!types?.includes("closed")) {
    return { ok: false, reason: "pull_request.types does not include closed" };
  }
  const branches = pullRequest.branches == null ? null : list(pullRequest.branches);
  const ignored = pullRequest["branches-ignore"] == null ? null : list(pullRequest["branches-ignore"]);
  if (branches === null && pullRequest.branches != null) {
    return { ok: false, reason: "pull_request.branches is not a string or string list" };
  }
  if (ignored === null && pullRequest["branches-ignore"] != null) {
    return { ok: false, reason: "pull_request.branches-ignore is not a string or string list" };
  }
  if (branches && ignored) {
    return { ok: false, reason: "workflow configures both branches and branches-ignore" };
  }
  if (branches && !matchesOrderedPatterns(baseBranch, branches)) {
    return { ok: false, reason: `pull_request.branches excludes delivery base '${baseBranch}'` };
  }
  if (ignored?.some((pattern) => globRegex(pattern).test(baseBranch))) {
    return { ok: false, reason: `pull_request.branches-ignore excludes delivery base '${baseBranch}'` };
  }
  return { ok: true };
}

export async function verifyPhaseEReadiness({ repoPath, prNumber }, {
  workspaceAuthorizationResolver,
  authorize = resolveAuthorizedIssueRepository,
  readPr = fetchPullRequest,
  readJson = ghRestJson,
} = {}) {
  const repository = await authorize(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) return repository;
  const { repoRoot, owner, name } = repository;
  let pr;
  try {
    pr = await readPr(repoRoot, owner, name, prNumber);
  } catch (error) {
    return { ok: false, error: "phase_e_workflow_evidence_unavailable", message: error.message,
      next_action: "repair_phase_e_workflow_access_then_retry" };
  }
  if (!pr?.baseRefName || !pr.baseRefOid) {
    return { ok: false, error: "phase_e_workflow_evidence_unavailable",
      message: `PR #${prNumber} has no trusted base branch revision.`,
      next_action: "repair_phase_e_workflow_access_then_retry" };
  }
  const encodedPath = PHASE_E_WORKFLOW_PATH.split("/").map(encodeURIComponent).join("/");
  let file;
  try {
    file = await readJson(repoRoot,
      `/repos/${owner}/${name}/contents/${encodedPath}?ref=${encodeURIComponent(pr.baseRefOid)}`);
  } catch (error) {
    if (!/(?:HTTP 404|Not Found)/i.test(error.message)) {
      return { ok: false, error: "phase_e_workflow_evidence_unavailable", message: error.message,
        next_action: "repair_phase_e_workflow_access_then_retry" };
    }
    return { ok: false, error: "phase_e_workflow_missing",
      message: `${PHASE_E_WORKFLOW_PATH} is absent from '${pr.baseRefName}'. ${RECOVERY}`,
      next_action: "install_phase_e_workflow_on_delivery_base_then_retry" };
  }
  if (file?.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
    return { ok: false, error: "phase_e_workflow_missing",
      message: `${PHASE_E_WORKFLOW_PATH} is not a readable file on '${pr.baseRefName}'. ${RECOVERY}`,
      next_action: "install_phase_e_workflow_on_delivery_base_then_retry" };
  }
  const inspected = inspectPhaseEWorkflow(Buffer.from(file.content, "base64").toString("utf8"), pr.baseRefName);
  if (!inspected.ok) {
    return { ok: false, error: "phase_e_workflow_inapplicable",
      message: `${PHASE_E_WORKFLOW_PATH} cannot finalize PR #${prNumber}: ${inspected.reason}. ${RECOVERY}`,
      next_action: "repair_phase_e_workflow_trigger_then_retry" };
  }
  return { ok: true, base_ref: pr.baseRefName, base_sha: pr.baseRefOid, workflow_sha: file.sha ?? null };
}
