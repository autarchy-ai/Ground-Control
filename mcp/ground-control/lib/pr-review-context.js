// Maintainer PR-review lane — read-only context tool (issue #1535).
//
// `runGetPrReviewContext` returns one bounded, evidence-oriented snapshot of a
// pull request and mutates nothing: no git fetch, no branch switch, no
// object-database write, no comment. Every field the maintainer review needs to
// judge the change — identity, the real changed-file inventory with patches,
// head-OID-bound checks, linked/closing issues, and review metadata — comes back
// with explicit completeness flags so a large, binary, or access-limited diff is
// never silently presented as fully reviewed.
//
// Every read is REST (issue #1586). GraphQL's hourly budget is shared by every
// agent on the token and drains without warning, so the one GraphQL read left —
// unresolved review threads, which REST does not expose — is optional: its
// failure marks `discussions` unavailable and never fails the snapshot.

import { realpathSync } from "node:fs";
import {
  deriveReviewDecision,
  fetchCommitCheckRollup,
  fetchPullRequest,
  ghRestJson,
  parseClosingIssueReferences,
} from "./github-rest.js";
import { authorizeImplementRepoRoot, ensureGitRepo, resolveMcpLaunchWorkspaceAuthorization } from "./grc-legacy-compat-4.js";
import { execFile } from "./runtime-primitives.js";
import {
  PR_REVIEW_FILE_CAP,
  PR_REVIEW_LINKED_ISSUE_CAP,
  PR_REVIEW_PATCH_BYTE_CAP,
  assertRepoAssertionMatches,
  ghFailure,
  refusal,
  runReviewGhJson,
  runReviewGhPaginated,
  validatePrNumber,
  validateRepoAssertion,
  validateRepoPath,
} from "./pr-review-shared.js";

// The PR body is premise evidence; bound it so a huge body cannot bloat the
// snapshot, and report truncation as an incompleteness reason.
const PR_REVIEW_BODY_BYTE_CAP = 16384;

function capPatch(file, maxPatchBytes) {
  if (typeof file.patch !== "string") {
    return {
      patch: null,
      patch_truncated: false,
      // Binary, renamed-without-content, or too-large-for-the-API files carry no
      // patch. That is missing evidence, reported honestly — not a clean file.
      patch_unavailable_reason: file.status === "renamed" && file.changes === 0
        ? "pure_rename"
        : "no_patch_from_api",
    };
  }
  const bytes = Buffer.byteLength(file.patch, "utf8");
  if (bytes > maxPatchBytes) {
    return {
      patch: Buffer.from(file.patch, "utf8").subarray(0, maxPatchBytes).toString("utf8"),
      patch_truncated: true,
      patch_unavailable_reason: null,
    };
  }
  return { patch: file.patch, patch_truncated: false, patch_unavailable_reason: null };
}

async function collectFiles(repoRoot, owner, name, prNumber, maxFiles, maxPatchBytes, commandRunner) {
  let raw;
  try {
    raw = await runReviewGhPaginated(
      repoRoot,
      `/repos/${owner}/${name}/pulls/${prNumber}/files`,
      commandRunner,
    );
  } catch (error) {
    return { error: ghFailure(error, "pr_review_files_unavailable", "The PR file inventory could not be read") };
  }
  const all = Array.isArray(raw) ? raw : [];
  const returned = all.slice(0, maxFiles);
  const entries = returned.map((file) => ({
    path: file.filename,
    previous_path: file.previous_filename ?? null,
    status: file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    ...capPatch(file, maxPatchBytes),
  }));
  const patchesMissing = entries.some((e) => e.patch_unavailable_reason === "no_patch_from_api" || e.patch_truncated);
  return {
    files: {
      total: all.length,
      returned: entries.length,
      truncated: all.length > returned.length,
      file_cap: maxFiles,
      patch_byte_cap: maxPatchBytes,
      entries,
    },
    incomplete_reasons: [
      ...(all.length > returned.length ? ["file_list_truncated"] : []),
      ...(patchesMissing ? ["some_patches_unavailable_or_truncated"] : []),
    ],
  };
}

function summarizeChecks(rollup, headOid) {
  const nodes = Array.isArray(rollup) ? rollup : [];
  const checks = nodes.map((node) => ({
    name: node.name ?? node.context ?? "(unnamed)",
    // A check run reports status+conclusion; a legacy commit status reports state.
    status: node.status ?? node.state ?? null,
    conclusion: node.conclusion ?? null,
    is_stale: node.__typename === "CheckRun" && node.status === "COMPLETED" && node.conclusion == null,
  }));
  const failing = checks.filter((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]
    .includes(String(c.conclusion ?? c.status).toUpperCase()));
  const pending = checks.filter((c) => ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"]
    .includes(String(c.status).toUpperCase()));
  return {
    head_oid: headOid,
    checks,
    failing_count: failing.length,
    pending_count: pending.length,
  };
}

// Checks bound to the head OID. An unreadable rollup is missing evidence
// (→ incomplete), never an empty, passing check set.
async function collectChecks(repoRoot, owner, name, headOid, commandRunner) {
  if (headOid == null) return { ...summarizeChecks([], null), checks_available: false };
  try {
    const rollup = await fetchCommitCheckRollup(repoRoot, `${owner}/${name}`, headOid, { execFile: commandRunner });
    return { ...summarizeChecks(rollup, headOid), checks_available: true };
  } catch {
    return { ...summarizeChecks([], headOid), checks_available: false };
  }
}

async function collectReviews(repoRoot, owner, name, prNumber, commandRunner) {
  try {
    const raw = await ghRestJson(
      repoRoot,
      `/repos/${owner}/${name}/pulls/${prNumber}/reviews?per_page=100`,
      { execFile: commandRunner, paginate: true },
    );
    // A PENDING review is the viewer's unsubmitted draft, invisible to everyone else.
    const submitted = raw.filter((r) => r?.state !== "PENDING");
    return {
      available: true,
      decision: deriveReviewDecision(submitted),
      entries: submitted.map((r) => ({
        author: r.user?.login ?? null,
        state: r.state ?? null,
        submitted_at: r.submitted_at ?? null,
      })),
    };
  } catch {
    return { available: false, decision: null, entries: [] };
  }
}

async function collectRequiredContexts(repoRoot, owner, name, baseRef, commandRunner) {
  try {
    const data = await runReviewGhJson(
      repoRoot,
      ["api", `/repos/${owner}/${name}/branches/${baseRef}/protection/required_status_checks`],
      commandRunner,
    );
    const contexts = Array.isArray(data?.contexts) ? data.contexts : [];
    return { required_contexts: contexts, required_contexts_available: true };
  } catch {
    // Branch protection is admin-gated; a caller without that scope cannot see
    // the required set. Report it as unavailable (→ incomplete), never as none.
    return { required_contexts: null, required_contexts_available: false };
  }
}

function crossReferencedIssueNumbers(body, closingNumbers) {
  if (typeof body !== "string") return [];
  const found = new Set();
  for (const match of body.matchAll(/(?:^|[^\w/])#(\d+)\b/g)) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isInteger(n) && n > 0 && !closingNumbers.has(n)) found.add(n);
  }
  return [...found];
}

async function enrichIssue(repoRoot, owner, name, number, relationship, commandRunner) {
  try {
    const data = await runReviewGhJson(
      repoRoot,
      ["api", `/repos/${owner}/${name}/issues/${number}`,
        "--jq", "{number,title,body,state,labels:[.labels[].name],pull_request:(.pull_request!=null)}"],
      commandRunner,
    );
    if (data.pull_request) return null; // a #N that is a PR, not an issue
    return {
      number: data.number,
      title: data.title ?? null,
      body: data.body ?? null,
      state: data.state ?? null,
      labels: Array.isArray(data.labels) ? data.labels : [],
      relationship,
    };
  } catch {
    return { number, title: null, body: null, state: null, labels: [], relationship, unavailable: true };
  }
}

async function collectLinkedIssues(repoRoot, owner, name, body, commandRunner) {
  // Closing references are GitHub's closing keywords in the PR body, the same
  // rule GitHub applies at merge. Issues linked only through the PR sidebar are
  // visible solely to GraphQL and are not listed. Each candidate is post-merge
  // closure input the maintainer classifies, never an automatic close.
  const closingNumbers = new Set(parseClosingIssueReferences(body, owner, name));
  const crossRefs = crossReferencedIssueNumbers(body, closingNumbers);
  const plan = [
    ...[...closingNumbers].map((n) => [n, "closing_reference"]),
    ...crossRefs.map((n) => [n, "cross_reference"]),
  ].slice(0, PR_REVIEW_LINKED_ISSUE_CAP);

  const issues = [];
  for (const [number, relationship] of plan) {
    const issue = await enrichIssue(repoRoot, owner, name, number, relationship, commandRunner);
    if (issue != null) issues.push(issue);
  }
  // An unreadable individual issue is missing evidence and must surface in
  // completeness (codex cycle-3 F4).
  const incompleteReasons = [
    ...(issues.some((i) => i.unavailable) ? ["some_linked_issues_unavailable"] : []),
    ...(closingNumbers.size + crossRefs.length > plan.length ? ["linked_issue_list_truncated"] : []),
  ];
  return {
    linked_issues: issues,
    truncated: closingNumbers.size + crossRefs.length > plan.length,
    incomplete_reasons: incompleteReasons,
  };
}

// Unresolved review-thread evidence (the outstanding discussion the reviewer
// must weigh). Bounded; an unavailable read participates in completeness rather
// than being silently dropped (codex cycle-2 F3, #1535). Thread resolution state
// exists only in GraphQL, so this is the lane's one GraphQL read, and a failure
// (including an exhausted GraphQL budget) degrades to `available: false`.
async function collectDiscussions(repoRoot, owner, name, prNumber, commandRunner) {
  const query = "query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){"
    + "pullRequest(number:$pr){reviewThreads(first:100){totalCount nodes{isResolved isOutdated "
    + "comments(first:1){nodes{path author{login}}}}}}}}";
  try {
    const data = await runReviewGhJson(
      repoRoot,
      ["api", "graphql", "-f", `query=${query}`, "-F", `o=${owner}`, "-F", `n=${name}`, "-F", `pr=${prNumber}`],
      commandRunner,
    );
    const threads = data?.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) return { available: false };
    const nodes = Array.isArray(threads.nodes) ? threads.nodes : [];
    const unresolved = nodes.filter((t) => t?.isResolved === false);
    return {
      available: true,
      total_count: threads.totalCount ?? nodes.length,
      returned: nodes.length,
      truncated: typeof threads.totalCount === "number" && threads.totalCount > nodes.length,
      unresolved_count: unresolved.length,
      unresolved: unresolved.slice(0, 50).map((t) => ({
        path: t.comments?.nodes?.[0]?.path ?? null,
        author: t.comments?.nodes?.[0]?.author?.login ?? null,
        outdated: t.isOutdated === true,
      })),
    };
  } catch {
    return { available: false };
  }
}

// A caller may only NARROW an evidence cap, never exceed the repository maximum,
// or the advertised bounds could be disabled (codex cycle-3 F3).
function clampCap(value, max) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : max;
}

// Validate the inputs and bind the read to the immutable MCP launch checkout and
// its origin identity. Without this, a caller could point repo_path at any other
// checkout the server process can reach and read that repository's private PR
// data with the server's GitHub credentials (codex F5, #1535).
async function resolveReviewCheckout(input, workspaceAuthorizationResolver) {
  const { repoPath, prNumber, repo = null } = input ?? {};
  for (const check of [validateRepoPath(repoPath), validatePrNumber(prNumber), validateRepoAssertion(repo)]) {
    if (!check.ok) return check;
  }
  let repoRoot;
  try {
    repoRoot = realpathSync(await ensureGitRepo(repoPath));
  } catch (error) {
    return refusal("pr_review_repo_path_invalid", error.message);
  }
  const auth = await authorizeImplementRepoRoot(repoRoot, workspaceAuthorizationResolver);
  if (!auth.ok) return auth;
  const assertion = assertRepoAssertionMatches(repo, auth.owner, auth.name);
  if (!assertion.ok) return assertion;
  return { ok: true, repoRoot, owner: auth.owner, name: auth.name };
}

async function fetchPrView(repoRoot, owner, name, prNumber, commandRunner) {
  let pr;
  try {
    pr = await fetchPullRequest(repoRoot, owner, name, prNumber, { execFile: commandRunner });
  } catch (error) {
    return ghFailure(error, "pr_review_pr_unavailable", `Pull request #${prNumber} could not be read`);
  }
  if (pr == null) return refusal("pr_review_pr_unavailable", `Pull request #${prNumber} could not be read`);
  return { ok: true, pr };
}

function buildPrIdentity(pr, owner, name, prNumber, headOid, reviewDecision) {
  return {
    repo: `${owner}/${name}`,
    pr_number: prNumber,
    url: pr.url ?? null,
    title: pr.title ?? null,
    author: pr.author?.login ?? null,
    state: pr.state ?? null,
    merged_at: pr.mergedAt ?? null,
    merge_state_status: pr.mergeStateStatus ?? null,
    base: { ref: pr.baseRefName ?? null, oid: pr.baseRefOid ? pr.baseRefOid.toLowerCase() : null },
    head: {
      ref: pr.headRefName ?? null,
      oid: headOid,
      repository: pr.headRepository?.name ?? null,
      owner: pr.headRepositoryOwner?.login ?? null,
    },
    cross_repository: pr.isCrossRepository === true,
    head_repository_deleted: pr.headRepository == null,
    maintainer_can_modify: pr.maintainerCanModify === true,
    review_decision: reviewDecision,
    captured_at: new Date().toISOString(),
  };
}

// The PR body is the change's stated premise; return it (bounded) as inert
// evidence data, never as an instruction.
function boundBody(body) {
  const raw = typeof body === "string" ? body : "";
  const truncated = Buffer.byteLength(raw, "utf8") > PR_REVIEW_BODY_BYTE_CAP;
  const value = truncated
    ? Buffer.from(raw, "utf8").subarray(0, PR_REVIEW_BODY_BYTE_CAP).toString("utf8")
    : raw;
  return { prBody: value, bodyTruncated: truncated };
}

function computeIncompleteReasons({ fileResult, headOid, checks, required, linked, reviews, bodyTruncated, discussions }) {
  return [
    ...fileResult.incomplete_reasons,
    ...(headOid == null ? ["head_oid_unresolved"] : []),
    ...(checks.checks_available ? [] : ["checks_unavailable"]),
    ...(required.required_contexts_available ? [] : ["required_check_set_unavailable"]),
    ...(reviews.available ? [] : ["reviews_unavailable"]),
    ...linked.incomplete_reasons,
    ...(bodyTruncated ? ["pr_body_truncated"] : []),
    ...(discussions.available ? [] : ["review_discussions_unavailable"]),
    ...(discussions.truncated ? ["review_discussions_truncated"] : []),
  ];
}

export async function runGetPrReviewContext(input, {
  commandRunner = execFile,
  workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
} = {}) {
  const resolved = await resolveReviewCheckout(input, workspaceAuthorizationResolver);
  if (!resolved.ok) return resolved;
  const { repoRoot, owner, name } = resolved;
  const prNumber = input.prNumber;
  const maxFiles = clampCap(input?.maxFiles, PR_REVIEW_FILE_CAP);
  const maxPatchBytes = clampCap(input?.maxPatchBytes, PR_REVIEW_PATCH_BYTE_CAP);

  const prResult = await fetchPrView(repoRoot, owner, name, prNumber, commandRunner);
  if (!prResult.ok) return prResult;
  const { pr } = prResult;

  const headOid = typeof pr.headRefOid === "string" ? pr.headRefOid.toLowerCase() : null;

  const fileResult = await collectFiles(repoRoot, owner, name, prNumber, maxFiles, maxPatchBytes, commandRunner);
  if (fileResult.error) return fileResult.error;

  const checks = await collectChecks(repoRoot, owner, name, headOid, commandRunner);
  const required = await collectRequiredContexts(repoRoot, owner, name, pr.baseRefName, commandRunner);
  const linked = await collectLinkedIssues(repoRoot, owner, name, pr.body, commandRunner);
  const reviews = await collectReviews(repoRoot, owner, name, prNumber, commandRunner);
  const identity = buildPrIdentity(pr, owner, name, prNumber, headOid, reviews.decision);
  const discussions = await collectDiscussions(repoRoot, owner, name, prNumber, commandRunner);
  const { prBody, bodyTruncated } = boundBody(pr.body);
  const incompleteReasons = computeIncompleteReasons({
    fileResult, headOid, checks, required, linked, reviews, bodyTruncated, discussions,
  });

  return {
    ok: true,
    action: "review_context",
    repo: `${owner}/${name}`,
    pr_number: prNumber,
    identity,
    pr_body: prBody,
    files: fileResult.files,
    checks: { ...checks, ...required },
    linked_issues: linked.linked_issues,
    reviews: reviews.entries,
    discussions,
    completeness: { complete: incompleteReasons.length === 0, reasons: incompleteReasons },
  };
}
