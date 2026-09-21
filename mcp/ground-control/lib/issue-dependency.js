// GitHub issue "blocked by" dependencies for the MCP tool surface (issue #1673).
//
// Sequencing between issues lived only in issue prose, where nothing could read it back. GitHub's
// issue-dependencies REST API models it natively, and ADR-027 puts every privileged `gh` call on
// this server rather than in an agent sandbox, so the relationship belongs here.
//
// Two things about the endpoints drive the shape below. They key on the blocking issue's numeric
// REST `id` — not its number and not its GraphQL `node_id` — so callers stay in issue-number
// vocabulary and this module resolves the id itself. And an HTTP status alone never settles
// idempotency: 422 covers duplicate, invalid, unauthorized, and rejected alike, and 404 covers
// missing and inaccessible alike. Replay safety therefore comes from reading the current
// relationship set, never from mapping a status code to success.
//
// The relationship is GitHub-native operational metadata. It is not a requirement-DAG edge, a
// sub-issue relation, or an issue-thread record, and nothing here gates a phase.

import { isAbsolute } from "node:path";
import { ghRestJson } from "./github-rest.js";
import { GITHUB_REPO_RE } from "./runtime-primitives.js";
import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { extractGhErrorMessage } from "./grc-legacy-compat-2.js";

export const ISSUE_DEPENDENCY_ACTIONS = Object.freeze(["read", "add", "remove"]);

const GITHUB_HOST = "github.com";
const CALL_TIMEOUT_MS = 30_000;
const REPOSITORY_URL_RE = /\/repos\/([^/]+\/[^/]+)$/;
const HTTP_STATUS_RE = /\(HTTP (\d{3})\)/;

function refuse(error, message, nextAction) {
  return { ok: false, error: `issue_dependency_${error}`, message, next_action: nextAction };
}

const malformed = (what) =>
  refuse("malformed_response", `GitHub returned ${what}`, "retry_and_report_if_it_persists");

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

function validateCallerInput({ repoPath, action, blockedIssueNumber, blockingIssueNumber, repo }) {
  // Pure shape checks first: a malformed call must not reach the filesystem, a process, or GitHub.
  if (!ISSUE_DEPENDENCY_ACTIONS.includes(action)) {
    return refuse(
      "action_invalid",
      `action must be one of ${ISSUE_DEPENDENCY_ACTIONS.join(", ")}`,
      "supply_a_supported_action_and_retry",
    );
  }
  if (typeof repoPath !== "string" || !isAbsolute(repoPath)) {
    return refuse(
      "repo_path_invalid",
      "repo_path must be an absolute path to the authorized checkout",
      "supply_the_absolute_invocation_root_and_retry",
    );
  }
  if (!isPositiveInteger(blockedIssueNumber)) {
    return refuse(
      "issue_number_invalid",
      "blocked_issue_number must be a positive integer",
      "supply_a_valid_issue_number_and_retry",
    );
  }
  const mutating = action !== "read";
  if (mutating && !isPositiveInteger(blockingIssueNumber)) {
    return refuse(
      "blocking_issue_number_invalid",
      "blocking_issue_number must be a positive integer for add and remove",
      "supply_the_blocking_issue_number_and_retry",
    );
  }
  if (!mutating && blockingIssueNumber != null) {
    return refuse(
      "blocking_issue_number_invalid",
      "read takes no blocking_issue_number; it returns both directions for the named issue",
      "drop_the_blocking_issue_number_and_retry",
    );
  }
  if (repo != null && (typeof repo !== "string" || !GITHUB_REPO_RE.test(repo))) {
    return refuse(
      "repo_assertion_invalid",
      "repo must be an 'owner/name' assertion when supplied",
      "supply_a_valid_owner_repo_assertion_or_omit_it_and_retry",
    );
  }
  if (mutating && blockedIssueNumber === blockingIssueNumber) {
    return refuse(
      "self_dependency",
      "an issue cannot block itself",
      "name_two_different_issues_and_retry",
    );
  }
  return null;
}

function notFound(role) {
  switch (role) {
    case "blocking":
      return refuse(
        "blocking_issue_not_found",
        "the blocking issue was not found or is not accessible in this repository",
        "name_an_existing_issue_in_this_repository_and_retry",
      );
    case "relationship":
      return refuse(
        "rejected",
        "GitHub rejected this dependency relationship",
        "read_the_dependencies_again_and_retry_with_a_valid_relationship",
      );
    default:
      return refuse(
        "blocked_issue_not_found",
        "the blocked issue was not found or is not accessible in this repository",
        "name_an_existing_issue_in_this_repository_and_retry",
      );
  }
}

/**
 * Map an expected `gh` failure onto a stable refusal.
 *
 * Messages stay bounded and content-free: raw argv, stderr, and API error bodies never reach the
 * caller. GitHub answers 404 for a private resource the credential cannot see, so the message
 * says "not accessible" while the code stays role-specific.
 */
function classifyFailure(error, role) {
  if (error instanceof SyntaxError) return malformed("a response that is not valid JSON");
  const status = Number(HTTP_STATUS_RE.exec(extractGhErrorMessage(error))?.[1] ?? 0);
  if (status === 404) return notFound(role);
  if (status === 401 || status === 403) {
    return refuse(
      "forbidden",
      "the GitHub credential may not read or change this issue's dependencies",
      "grant_issues_access_to_the_host_credential_and_retry",
    );
  }
  if (status === 400 || status === 409 || status === 422) {
    return refuse(
      "rejected",
      "GitHub rejected this dependency relationship",
      "read_the_dependencies_again_and_retry_with_a_valid_relationship",
    );
  }
  return refuse(
    "transport_unavailable",
    "the GitHub API could not be reached",
    "retry_when_github_is_reachable",
  );
}

/**
 * A REST issue record reduced to the identity this module trusts.
 *
 * Returns null for anything missing a usable identity, so a malformed payload can never become
 * write authority or a silently wrong membership answer.
 */
function normalizeIssue(record) {
  const repository = REPOSITORY_URL_RE.exec(String(record?.repository_url ?? ""))?.[1];
  if (repository === undefined) return null;
  if (!isPositiveInteger(record.number) || !isPositiveInteger(record.id)) return null;
  if (typeof record.html_url !== "string" || record.html_url === "") return null;
  return {
    id: record.id,
    repository,
    number: record.number,
    title: typeof record.title === "string" ? record.title : null,
    state: typeof record.state === "string" ? record.state : null,
    url: record.html_url,
    isPullRequest: record.pull_request != null,
  };
}

/** The repository-bound dependency endpoints. Every path segment is server-derived or numeric. */
function dependencyApi({ repoRoot, slug, execFile }) {
  const issues = `/repos/${slug}/issues`;
  const call = (path, options) =>
    ghRestJson(repoRoot, path, { hostname: GITHUB_HOST, timeout: CALL_TIMEOUT_MS, execFile, ...options });
  return {
    readIssue: (number) => call(`${issues}/${number}`),
    listBlockedBy: (number) => call(`${issues}/${number}/dependencies/blocked_by?per_page=100`, { paginate: true }),
    listBlocking: (number) => call(`${issues}/${number}/dependencies/blocking?per_page=100`, { paginate: true }),
    addBlocker: (number, blockingId) =>
      call(`${issues}/${number}/dependencies/blocked_by`, { method: "POST", typedFields: { issue_id: blockingId } }),
    removeBlocker: (number, blockingId) =>
      call(`${issues}/${number}/dependencies/blocked_by/${blockingId}`, { method: "DELETE" }),
  };
}

async function resolveIssue(read, number, slugKey, role) {
  let record;
  try {
    record = await read(number);
  } catch (error) {
    return classifyFailure(error, role);
  }
  const issue = normalizeIssue(record);
  if (issue === null || issue.number !== number || issue.repository.toLowerCase() !== slugKey) {
    return malformed(`a record that does not describe issue #${number} in this repository`);
  }
  if (issue.isPullRequest) {
    return refuse(
      "not_an_issue",
      `#${number} is a pull request; issue dependencies apply to issues`,
      "name_an_issue_and_retry",
    );
  }
  return { ok: true, issue };
}

async function readDependencies(list, number) {
  let records;
  try {
    records = await list(number);
  } catch (error) {
    return classifyFailure(error, "dependencies");
  }
  if (!Array.isArray(records)) return malformed("a dependency list that is not an array");
  const entries = [];
  for (const record of records) {
    const issue = normalizeIssue(record);
    if (issue === null) return malformed("a dependency record without a usable issue identity");
    entries.push(issue);
  }
  return { ok: true, entries };
}

// Repository identity plus REST id, never the number alone: issue numbers repeat across
// repositories, and a dependency list can name one GitHub created elsewhere.
const hasBlocker = (entries, slugKey, blockingId) =>
  entries.some((entry) => entry.id === blockingId && entry.repository.toLowerCase() === slugKey);

/**
 * The caller-facing dependency views, scoped to the authorized repository.
 *
 * A relationship created outside this tool can name an issue in another repository the host
 * credential happens to read, and returning that record whole would turn a caller confined to one
 * checkout into a cross-repository read deputy. Such an entry keeps only the edge — the
 * relationship recorded on this repository's issue — and has its content redacted. Redacted rather
 * than dropped, because a blocker hidden from the response reads as no blocker at all.
 */
const views = (entries, slugKey) =>
  entries.map((entry) => (entry.repository.toLowerCase() === slugKey
    ? {
      repository: entry.repository,
      number: entry.number,
      title: entry.title,
      state: entry.state,
      url: entry.url,
      in_authorized_repository: true,
    }
    : {
      repository: entry.repository,
      number: entry.number,
      title: null,
      state: null,
      url: null,
      in_authorized_repository: false,
    }));

async function runMutation({ api, action, blockedIssueNumber, blocking, slug, slugKey }) {
  const desired = action === "add";
  const before = await readDependencies(api.listBlockedBy, blockedIssueNumber);
  if (!before.ok) return before;

  const base = {
    ok: true,
    action,
    repository: slug,
    blocked_issue_number: blockedIssueNumber,
    blocking_issue_number: blocking.number,
  };
  if (hasBlocker(before.entries, slugKey, blocking.id) === desired) {
    return { ...base, outcome: "already_satisfied", blocked_by: views(before.entries, slugKey) };
  }

  let writeError = null;
  try {
    await (desired
      ? api.addBlocker(blockedIssueNumber, blocking.id)
      : api.removeBlocker(blockedIssueNumber, blocking.id));
  } catch (error) {
    writeError = error;
  }

  // The terminal state is what GitHub reports afterwards, not what the write claimed. A write that
  // failed against state another client had already established is `reconciled`, because this
  // process cannot know who changed it.
  const after = await readDependencies(api.listBlockedBy, blockedIssueNumber);
  if (!after.ok) return after;
  if (hasBlocker(after.entries, slugKey, blocking.id) === desired) {
    return { ...base, outcome: writeError === null ? "changed" : "reconciled", blocked_by: views(after.entries, slugKey) };
  }
  if (writeError !== null) return classifyFailure(writeError, "relationship");
  return refuse(
    "rejected",
    "GitHub accepted the request but the dependency is not present afterwards",
    "read_the_dependencies_again_and_retry_with_a_valid_relationship",
  );
}

/**
 * Read, add, or remove a GitHub "blocked by" dependency for an issue in the authorized checkout.
 *
 * `repo` is an assertion against the checkout's repository, never an alternate destination, so a
 * cross-repository reference is a named refusal rather than a redirected write.
 */
export async function runIssueDependency(
  { repoPath, action, blockedIssueNumber, blockingIssueNumber = null, repo = null },
  { workspaceAuthorizationResolver, execFile } = {},
) {
  const invalid = validateCallerInput({ repoPath, action, blockedIssueNumber, blockingIssueNumber, repo });
  if (invalid) return invalid;

  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    if (repository.error === "implement_repo_not_git") {
      return refuse(
        "repo_path_invalid",
        "repo_path is not a valid Git repository",
        "supply_the_absolute_invocation_root_and_retry",
      );
    }
    return issueRepositoryNotAuthorized("issue_dependency", repository, {
      action,
      blocked_issue_number: blockedIssueNumber,
    });
  }

  const slug = `${repository.owner}/${repository.name}`;
  const slugKey = slug.toLowerCase();
  if (repo != null && repo.toLowerCase() !== slugKey) {
    return refuse(
      "repo_mismatch",
      "the supplied repo assertion does not match the authorized checkout's repository",
      "drop_the_repo_assertion_or_match_the_authorized_repository_and_retry",
    );
  }

  const api = dependencyApi({ repoRoot: repository.repoRoot, slug, execFile });
  const blocked = await resolveIssue(api.readIssue, blockedIssueNumber, slugKey, "blocked");
  if (!blocked.ok) return blocked;

  if (action === "read") {
    const blockedBy = await readDependencies(api.listBlockedBy, blockedIssueNumber);
    if (!blockedBy.ok) return blockedBy;
    const blocking = await readDependencies(api.listBlocking, blockedIssueNumber);
    if (!blocking.ok) return blocking;
    return {
      ok: true,
      action,
      repository: slug,
      blocked_issue_number: blockedIssueNumber,
      blocked_by: views(blockedBy.entries, slugKey),
      blocking: views(blocking.entries, slugKey),
    };
  }

  // Both operands are validated before any membership decision, so removing a blocker that is not
  // set stays a no-op while naming an issue that does not exist stays a refusal.
  const blocking = await resolveIssue(api.readIssue, blockingIssueNumber, slugKey, "blocking");
  if (!blocking.ok) return blocking;
  return runMutation({ api, action, blockedIssueNumber, blocking: blocking.issue, slug, slugKey });
}
