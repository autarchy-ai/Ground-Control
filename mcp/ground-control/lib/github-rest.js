// GitHub REST reads and writes for the MCP server (issue #1584).
//
// `gh pr view`, `gh pr list`, `gh pr create`, `gh issue view|create|develop`, `gh repo view`, and
// `gh api graphql` all spend the account's GraphQL budget: 5,000 points an hour, separate from REST
// and shared by every agent on the same token. When concurrent agents drain it, each of those calls
// fails while REST keeps working — and GitHub's rate-limit endpoint still reports GraphQL as
// available, so it cannot warn us. Every read or write that has a REST equivalent goes through here
// instead. Only operations GitHub exposes solely over GraphQL (review-thread ids, resolution state,
// and resolution) keep using it; issue #1586 moved the maintainer review lane onto these helpers.
//
// Pull requests are normalized to the field names the GraphQL-era callers already consume, so the
// safety checks built on those fields are unchanged.

import { execFile as defaultExecFile } from "./runtime-primitives.js";

/** Call a REST endpoint through `gh api` and parse its JSON response. */
export async function ghRestJson(repoRoot, path, {
  method = "GET",
  fields = null,
  paginate = false,
  execFile = defaultExecFile,
} = {}) {
  const args = ["api", "--method", method];
  if (paginate) args.push("--paginate", "--slurp");
  args.push(path);
  for (const [key, value] of Object.entries(fields ?? {})) args.push("-f", `${key}=${value}`);
  const { stdout } = await execFile("gh", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (!paginate) return parsed;
  // --slurp wraps each page in an outer array; list endpoints return arrays per page.
  return Array.isArray(parsed) ? parsed.flatMap((page) => (Array.isArray(page) ? page : [page])) : [];
}

// REST `mergeable_state` is GraphQL's `mergeStateStatus` vocabulary in lower case. It is present only
// on the single-PR endpoint; list endpoints omit it.
const MERGE_STATE_STATUSES = new Set(["behind", "blocked", "clean", "dirty", "draft", "has_hooks", "unknown", "unstable"]);

function crossRepository(headRepo, baseRepo) {
  if (baseRepo == null) return null;
  // REST nulls `head.repo` only when the head repository was deleted. A same-repository PR cannot
  // outlive its repository, so a missing head repository is a deleted fork, as GraphQL reports it.
  if (headRepo == null) return true;
  return headRepo.full_name?.toLowerCase() !== baseRepo.full_name?.toLowerCase();
}

/** A REST pull request in the field shape the GraphQL-era callers consume. */
export function normalizeRestPullRequest(pr) {
  if (pr == null || !Number.isInteger(pr.number)) return null;
  const mergedAt = pr.merged_at ?? null;
  let state = "OPEN";
  if (mergedAt) state = "MERGED";
  else if (pr.state === "closed") state = "CLOSED";
  const headRepo = pr.head?.repo ?? null;
  const baseRepo = pr.base?.repo ?? null;
  return {
    number: pr.number,
    url: pr.html_url ?? null,
    state,
    mergedAt,
    title: pr.title ?? null,
    body: pr.body ?? "",
    author: { login: pr.user?.login ?? null },
    baseRefName: pr.base?.ref ?? null,
    baseRefOid: pr.base?.sha ?? null,
    headRefName: pr.head?.ref ?? null,
    headRefOid: pr.head?.sha ?? null,
    mergeCommit: mergedAt && pr.merge_commit_sha ? { oid: pr.merge_commit_sha } : null,
    mergeStateStatus: MERGE_STATE_STATUSES.has(pr.mergeable_state) ? pr.mergeable_state.toUpperCase() : null,
    maintainerCanModify: pr.maintainer_can_modify === true,
    headRepository: headRepo ? { name: headRepo.name } : null,
    headRepositoryOwner: headRepo?.owner ? { login: headRepo.owner.login } : null,
    isCrossRepository: crossRepository(headRepo, baseRepo),
  };
}

const DECISIVE_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * GraphQL's `reviewDecision`, derived from a pull request's REST reviews.
 *
 * Each reviewer's latest approval, change request, or dismissal stands; a later comment-only review
 * leaves it in place, as on GitHub. The reviews endpoint lists reviews oldest first. REST cannot see
 * whether branch protection requires a review, so "no standing decision" reads `REVIEW_REQUIRED`
 * where GraphQL would report `null` for a base without that rule.
 */
export function deriveReviewDecision(reviews) {
  const standing = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const login = review?.user?.login;
    if (typeof login === "string" && DECISIVE_REVIEW_STATES.has(review.state)) standing.set(login, review.state);
  }
  const states = new Set(standing.values());
  if (states.has("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (states.has("APPROVED")) return "APPROVED";
  return "REVIEW_REQUIRED";
}

const upper = (value) => (typeof value === "string" && value !== "" ? value.toUpperCase() : null);

function actionsRunId(checkRun) {
  const match = /\/actions\/runs\/(\d+)\//.exec(String(checkRun?.details_url ?? ""));
  return match ? match[1] : null;
}

async function resolveWorkflowNames(rest, checkRuns) {
  const names = new Map();
  for (const runId of new Set(checkRuns.map(actionsRunId).filter(Boolean))) {
    try {
      const run = await rest(`/actions/runs/${runId}`);
      if (typeof run?.name === "string" && run.name.trim() !== "") names.set(runId, run.name);
    } catch {
      // A missing workflow name only narrows a name selector to check names; it never widens it.
    }
  }
  return names;
}

/**
 * A commit's check runs and legacy status contexts as `statusCheckRollup` entries.
 *
 * Entries keep the GraphQL shape (`__typename`, upper-case status enums). The check-runs endpoint
 * already returns only the latest run of each check, and the combined status the latest state of
 * each context, so the result matches the rollup. `withWorkflowNames` adds each Actions check run's
 * workflow name, at one extra read per workflow run.
 */
export async function fetchCommitCheckRollup(repoRoot, repoSlug, sha, { withWorkflowNames = false, ...options } = {}) {
  const rest = (path, paginate = false) => ghRestJson(repoRoot, `/repos/${repoSlug}${path}`, { ...options, paginate });
  const pages = await rest(`/commits/${sha}/check-runs?per_page=100`, true);
  const checkRuns = pages.flatMap((page) => (Array.isArray(page?.check_runs) ? page.check_runs : []));
  const status = await rest(`/commits/${sha}/status`);
  const workflowNames = withWorkflowNames ? await resolveWorkflowNames(rest, checkRuns) : new Map();
  return [
    ...checkRuns.map((run) => ({
      __typename: "CheckRun",
      name: run.name,
      workflowName: workflowNames.get(actionsRunId(run)) ?? null,
      status: upper(run.status),
      conclusion: upper(run.conclusion),
      completedAt: run.completed_at ?? null,
    })),
    ...(Array.isArray(status?.statuses) ? status.statuses : [])
      .map((entry) => ({ __typename: "StatusContext", context: entry.context, state: upper(entry.state) })),
  ];
}

export async function fetchPullRequest(repoRoot, owner, name, prNumber, options = {}) {
  return normalizeRestPullRequest(
    await ghRestJson(repoRoot, `/repos/${owner}/${name}/pulls/${prNumber}`, options),
  );
}

/** Open (or `state`) pull requests in this repository whose head is `branch`. */
export async function listPullRequestsForHead(repoRoot, owner, name, branch, {
  state = "open",
  ...options
} = {}) {
  const query = new URLSearchParams({ head: `${owner}:${branch}`, state, per_page: "100" });
  const prs = await ghRestJson(repoRoot, `/repos/${owner}/${name}/pulls?${query}`, options);
  return (Array.isArray(prs) ? prs : []).map(normalizeRestPullRequest).filter(Boolean);
}

/**
 * Numbers of same-repository pull requests that cross-reference an issue, from its timeline.
 *
 * Same-repository only: a PR in another repository cannot merge code into this one, so it can
 * never satisfy a merge gate for this repository's issue.
 */
export async function listIssueCrossReferencedPullNumbers(repoRoot, owner, name, issueNumber, options = {}) {
  const events = await ghRestJson(
    repoRoot,
    `/repos/${owner}/${name}/issues/${issueNumber}/timeline?per_page=100`,
    { ...options, paginate: true },
  );
  const fullName = `${owner}/${name}`.toLowerCase();
  const numbers = [];
  for (const event of events) {
    const source = event?.event === "cross-referenced" ? event.source?.issue : null;
    if (source?.pull_request == null || !Number.isInteger(source.number)) continue;
    if (source.repository?.full_name?.toLowerCase() !== fullName) continue;
    if (!numbers.includes(source.number)) numbers.push(source.number);
  }
  return numbers;
}

// GitHub's closing keywords, each followed by a `#N` or `owner/name#N` reference. The reference is
// parsed as plain text below, which keeps the pattern itself small.
const CLOSING_REFERENCE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]+([\w./-]*#\d+)\b/gi;

/** Issue numbers a pull request body closes with GitHub's closing keywords, in this repository. */
export function parseClosingIssueReferences(body, owner, name) {
  const thisRepo = `${owner}/${name}`.toLowerCase();
  const numbers = [];
  for (const match of String(body ?? "").matchAll(CLOSING_REFERENCE_RE)) {
    const [repoPart, digits] = match[1].split("#");
    const number = Number.parseInt(digits, 10);
    if ((repoPart === "" || repoPart.toLowerCase() === thisRepo) && number > 0 && !numbers.includes(number)) {
      numbers.push(number);
    }
  }
  return numbers;
}
