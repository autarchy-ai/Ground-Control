// gc_update_issue_requirements — the supported writer for an issue's in-scope
// requirement UID list (issue #1569).
//
// The issue body's `## Requirements` section is scope INPUT that four gates read, and
// nothing on the MCP surface could write it for an existing issue. A requirement
// introduced mid-run therefore never reached Phase E, which then verified nothing. The
// only previous way through was a hand-run `gh issue edit` from an agent session, which
// is exactly the privileged side effect ADR-027 keeps on this server.
//
// This changes scope input only. It posts no comment and writes no marker: plans,
// findings, decisions, readiness, and final reports remain append-only issue comments
// under ADR-029.

import { isAbsolute } from "node:path";
import { detectSensitiveBodyContent } from "./grc-legacy-compat-2.js";
import {
  authorizeImplementRepoRoot,
  ensureGitRepo,
  readGitIdentity,
  resolveMcpLaunchWorkspaceAuthorization,
} from "./grc-legacy-compat-4.js";
import { invalidateIssueThreadCacheEntry } from "./issue-thread.js";
import {
  applyRequirementScopeOperation,
  extractInScopeRequirementUids,
  resolveIntendedScope,
  validateRequirementScopeInput,
} from "./issue-requirements-scope.js";
import { readRequirementIdentity } from "./requirement-files.js";
import { readIssueCommentsWithAuthors, resolveExecutionObligationTrust } from "./grc-legacy-compat-3.js";
import { acquireIssueScopeLock } from "./filesystem-lease.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX, rejectReservedMarkerSequence } from "./repo-vocabulary.js";
import { GITHUB_REPO_RE, execFile } from "./runtime-primitives.js";

function refuse(error, message, nextAction) {
  return { ok: false, error, message, next_action: nextAction };
}

function validateCallerInput({ repoPath, issueNumber, operation, requirementUids, repo }) {
  // Pure shape checks first: a malformed call must not reach the filesystem or GitHub.
  const scopeInput = validateRequirementScopeInput(operation, requirementUids);
  if (scopeInput) return scopeInput;
  if (typeof repoPath !== "string" || !isAbsolute(repoPath)) {
    return refuse(
      "issue_requirements_repo_path_invalid",
      "repo_path must be an absolute path to the authorized checkout",
      "supply_the_absolute_invocation_root_and_retry",
    );
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return refuse(
      "issue_requirements_issue_number_invalid",
      "issue_number must be a positive integer",
      "supply_a_valid_issue_number_and_retry",
    );
  }
  if (repo != null && (typeof repo !== "string" || !GITHUB_REPO_RE.test(repo))) {
    return refuse(
      "issue_requirements_repo_assertion_invalid",
      "repo must be an 'owner/name' assertion when supplied",
      "supply_a_valid_owner_repo_assertion_or_omit_it_and_retry",
    );
  }
  return null;
}

// Resolve every UID that will REMAIN in the section, not only the requested
// additions: writing back an unresolvable UID that happened to be there already is
// the same defect. An explicit `remove` can still clean one up, because a removed
// UID is not part of the result.
async function resolveScopeTitles(repoRoot, uids) {
  const titleByUid = {};
  for (const uid of uids) {
    const identity = await readRequirementIdentity(repoRoot, uid);
    if (identity.unverifiable) {
      return refuse(
        "issue_requirements_identity_unverifiable",
        "requirement-file containment cannot be verified on this host (no descriptor canonicalization), so the scope write is refused",
        "run_the_mcp_server_on_a_host_that_exposes_proc_self_fd_and_retry",
      );
    }
    if (!identity.found || identity.malformed || identity.frontmatterId !== uid) {
      return refuse(
        "issue_requirements_uid_unresolved",
        "a requirement UID in the resulting scope has no repo-local requirement file whose frontmatter id matches its directory",
        "add_or_correct_the_requirement_file_or_remove_the_uid_and_retry",
      );
    }
    titleByUid[uid] = identity.requirement.title;
  }
  return { ok: true, titleByUid };
}

// Narrowing the scope every completion gate reads needs authorization the calling agent
// cannot manufacture. Filesystem evidence cannot supply it: the requirement this tool
// exists to add is, by construction, present only on the feature branch, so "absent from
// the working tree and from the integration branch" is equally true of a genuinely stale
// entry and of a brand-new requirement whose file an adversarial agent deleted for the
// duration of one call. Emptying the scope that way puts `gc_assert_completion` back on
// its `{ok:true, skip:true}` path and Phase E verifies nothing.
//
// So removal is gated on a durable authorization from a human with repository write
// access, bound to this issue and this exact UID set — the same trust mechanism the
// wontfix authorization uses. `add` needs no such gate: it can only widen scope.
export function isExactScopeRemovalAuthorization(body, issueNumber, requirementUids) {
  if (typeof body !== "string") return false;
  const parts = body.trim().split(/\s+/);
  if (parts.length !== 3 + requirementUids.length) return false;
  if (parts[0] !== "/ground-control" || parts[1] !== "authorize-scope-removal") return false;
  if (parts[2] !== String(issueNumber)) return false;
  const named = parts.slice(3);
  if (new Set(named).size !== named.length) return false;
  const requested = new Set(requirementUids);
  return named.every((uid) => requested.has(uid));
}

async function requireTrustedRemovalAuthorization(
  { repoRoot, owner, name, issueNumber, requirementUids },
  { readComments, resolveTrust },
) {
  let comments;
  try {
    comments = await readComments(repoRoot, owner, name, issueNumber);
  } catch {
    return refuse(
      "issue_requirements_removal_authorization_unverifiable",
      "the issue's comments could not be read to verify a scope-removal authorization",
      "repair_issue_access_and_retry",
    );
  }
  const candidates = comments.filter(
    (comment) => isExactScopeRemovalAuthorization(comment.body, issueNumber, requirementUids),
  );
  const unauthorized = refuse(
    "issue_requirements_removal_unauthorized",
    `removing a requirement from an issue's scope needs a comment on that issue from a user with repository write access reading exactly "/ground-control authorize-scope-removal ${issueNumber} <UID>..." for this exact UID set`,
    "have_a_repository_writer_post_the_scope_removal_authorization_and_retry",
  );
  if (candidates.length === 0) return unauthorized;
  let trust;
  try {
    trust = await resolveTrust(repoRoot, owner, name, candidates);
  } catch {
    return refuse(
      "issue_requirements_removal_authorization_unverifiable",
      "the authorizing comment's repository permission could not be verified",
      "repair_repository_permission_access_and_retry",
    );
  }
  return candidates.some((comment) => trust.isTrusted(comment)) ? null : unauthorized;
}

function rejectUnsafeBody(body) {
  const markerError = rejectReservedMarkerSequence(body, "issue body");
  if (markerError) {
    return refuse(
      "issue_requirements_reserved_marker",
      markerError,
      "remove_the_reserved_marker_from_the_issue_body_and_retry",
    );
  }
  if (detectSensitiveBodyContent(body)) {
    return refuse(
      "issue_requirements_body_rejected",
      "the resulting issue body matched a sensitive-content pattern; refusing to publish it",
      "scrub_secrets_from_the_issue_body_and_retry",
    );
  }
  if (Buffer.byteLength(body, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return refuse(
      "issue_requirements_body_too_large",
      `the resulting issue body exceeds GitHub's ${GITHUB_ISSUE_COMMENT_BODY_MAX}-byte cap`,
      "trim_the_issue_body_and_retry",
    );
  }
  return null;
}

// The read/PATCH adapter. Kept behind one seam so a conditional-request API, if
// GitHub ever offers one for issue updates, can add compare-and-swap without
// touching the parser, the transformer, or the tool schema.
function githubIssueApi(commandRunner) {
  return {
    async read(owner, name, issueNumber) {
      const { stdout } = await commandRunner("gh", ["api", `repos/${owner}/${name}/issues/${issueNumber}`]);
      return JSON.parse(stdout);
    },
    async patchBody(owner, name, issueNumber, body) {
      const { stdout } = await commandRunner("gh", [
        "api",
        `repos/${owner}/${name}/issues/${issueNumber}`,
        "--method",
        "PATCH",
        "-f",
        `body=${body}`,
      ]);
      return JSON.parse(stdout);
    },
  };
}

// A `gh` failure's Error message embeds the whole spawned command, which on the
// PATCH path contains the issue body. Diagnostics here are therefore fixed strings:
// never the exception, stderr, stdout, argv, or body.
function describesRequestedIssue(payload, issueNumber) {
  if (payload == null || typeof payload !== "object") return false;
  if (payload.pull_request != null) return false;
  if (payload.number !== issueNumber) return false;
  return typeof payload.body === "string" || payload.body === null;
}

async function readTargetIssue(api, owner, name, issueNumber) {
  let payload;
  try {
    payload = await api.read(owner, name, issueNumber);
  } catch {
    return refuse(
      "issue_requirements_issue_unreadable",
      "the target issue could not be read through the authorized repository",
      "repair_issue_access_and_retry",
    );
  }
  if (payload?.pull_request != null) {
    return refuse(
      "issue_requirements_target_not_an_issue",
      "the requested number identifies a pull request, not an issue",
      "supply_an_issue_number_and_retry",
    );
  }
  if (!describesRequestedIssue(payload, issueNumber)) {
    return refuse(
      "issue_requirements_issue_mismatch",
      "the API response does not describe the requested issue",
      "repair_issue_access_and_retry",
    );
  }
  return { ok: true, body: payload.body ?? "" };
}

async function writeAndVerify({ api, owner, name, issueNumber, repoRoot, body, intended }) {
  let updated;
  try {
    updated = await api.patchBody(owner, name, issueNumber, body);
  } catch {
    // The write outcome is unknown, so the cached hash may already describe a body
    // that no longer exists. Fail closed on the cache rather than leave a reader
    // able to accept the pre-edit content as unchanged.
    invalidateIssueThreadCacheEntry(repoRoot, issueNumber);
    return refuse(
      "issue_requirements_write_failed",
      "the issue body update did not complete; the issue's scope may or may not have changed",
      "verify_the_issue_requirements_section_and_retry",
    );
  }
  invalidateIssueThreadCacheEntry(repoRoot, issueNumber);
  // Coercing a missing body to "" would let `{}`, a null body, a pull-request payload, or
  // another issue's payload parse as an empty scope — which is exactly the intended set
  // when the last UID is removed, so a malformed response would read as verified.
  if (!describesRequestedIssue(updated, issueNumber) || typeof updated.body !== "string") {
    return refuse(
      "issue_requirements_write_unverified",
      "the update response does not describe the requested issue with a readable body",
      "inspect_the_issue_requirements_section_manually_and_retry",
    );
  }
  const readBack = extractInScopeRequirementUids(updated.body);
  if (readBack.length !== intended.length || readBack.some((uid, index) => uid !== intended[index])) {
    // No compensating overwrite: GitHub offers no precondition on this endpoint, so a
    // second write could erase an edit someone else made in between.
    return refuse(
      "issue_requirements_write_unverified",
      "the stored issue body does not read back as the intended scope",
      "inspect_the_issue_requirements_section_manually_and_retry",
    );
  }
  return { ok: true };
}

// The read-modify-write critical section. This whole sequence — fresh GET, requirement
// resolution, transform, PATCH — runs under one lease, because without it two concurrent
// `add` calls interleave: the slower one derives its complete body from a scope read
// before the faster one's write and PATCHes the other's UID away. That is a narrowing
// `add` is supposed to be structurally incapable of, and the response check cannot catch
// it because the stored body does match the slower caller's own intended set.
async function performScopeUpdate({
  repoRoot, owner, name, issueNumber, operation, requirementUids,
}, { commandRunner, readComments, resolveTrust }) {
  const api = githubIssueApi(commandRunner);
  const target = await readTargetIssue(api, owner, name, issueNumber);
  if (!target.ok) return target;

  const scope = resolveIntendedScope(target.body, { operation, requirementUids });
  if (!scope.ok) return scope;

  if (operation === "remove") {
    const unauthorized = await requireTrustedRemovalAuthorization(
      { repoRoot, owner, name, issueNumber, requirementUids },
      { readComments, resolveTrust },
    );
    if (unauthorized) return unauthorized;
  }

  const titles = await resolveScopeTitles(repoRoot, scope.intended);
  if (!titles.ok) return titles;

  if (!scope.changed) {
    // The fresh GET above may have observed a body newer than the cached hash. Leaving
    // that entry would let the next gc_get_issue_thread answer `unchanged: true` and
    // hand a reader the pre-edit body and scope this call has already superseded.
    invalidateIssueThreadCacheEntry(repoRoot, issueNumber);
    return {
      ok: true, issue_number: issueNumber, operation, changed: false, requirement_uids: scope.current,
    };
  }

  const transformed = applyRequirementScopeOperation(target.body, {
    operation,
    requirementUids,
    titleByUid: titles.titleByUid,
  });
  if (!transformed.ok) return transformed;

  const unsafe = rejectUnsafeBody(transformed.body);
  if (unsafe) return unsafe;

  const written = await writeAndVerify({
    api,
    owner,
    name,
    issueNumber,
    repoRoot,
    body: transformed.body,
    intended: transformed.requirementUids,
  });
  if (!written.ok) return written;

  return {
    ok: true,
    issue_number: issueNumber,
    operation,
    changed: true,
    requirement_uids: transformed.requirementUids,
  };
}


// Acquire the workspace-scoped lease in the per-worktree Git metadata directory, run the
// critical section, and always release. Contention is a bounded refusal, never a silent
// unserialized write. A cross-process lease cannot serialize a human editing the issue in
// GitHub's UI; nothing here claims otherwise, and the post-write round-trip check is what
// catches that case.
async function runUnderIssueScopeLease(target, deps) {
  let release;
  try {
    const { gitDir } = await readGitIdentity(target.repoRoot);
    release = await deps.acquireLock(gitDir);
  } catch (error) {
    return refuse(
      error?.code === "ELOCKED"
        ? "issue_requirements_scope_lock_contended"
        : "issue_requirements_scope_lock_unavailable",
      error?.code === "ELOCKED"
        ? "another issue-scope update is in progress for this checkout"
        : "the issue-scope update lease could not be acquired",
      "retry_after_the_in_flight_issue_scope_update_completes",
    );
  }
  try {
    return await performScopeUpdate(target, deps);
  } finally {
    await release();
  }
}

export async function runUpdateIssueRequirements(
  { repoPath, issueNumber, operation, requirementUids, repo = null },
  {
    workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
    commandRunner = execFile,
    readComments = readIssueCommentsWithAuthors,
    resolveTrust = resolveExecutionObligationTrust,
    acquireLock = acquireIssueScopeLock,
  } = {},
) {
  const invalid = validateCallerInput({ repoPath, issueNumber, operation, requirementUids, repo });
  if (invalid) return invalid;

  let repoRoot;
  try {
    repoRoot = await ensureGitRepo(repoPath);
  } catch {
    return refuse(
      "issue_requirements_repo_path_invalid",
      "repo_path is not a valid Git repository",
      "supply_the_absolute_invocation_root_and_retry",
    );
  }

  // Repository identity comes from the immutable MCP launch workspace (GC-P026 /
  // ADR-027). A caller-supplied `repo` is only an assertion against it.
  const authorization = await authorizeImplementRepoRoot(repoRoot, workspaceAuthorizationResolver);
  if (!authorization.ok) {
    return { ...authorization, next_action: "restart_the_mcp_server_from_the_authorized_checkout_and_retry" };
  }
  const { owner, name } = authorization;
  if (repo != null && repo.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
    return refuse(
      "issue_requirements_repo_mismatch",
      "the supplied repo assertion does not match the authorized checkout's repository",
      "drop_the_repo_assertion_or_match_the_authorized_repository_and_retry",
    );
  }

  return runUnderIssueScopeLease(
    { repoRoot, owner, name, issueNumber, operation, requirementUids },
    { commandRunner, readComments, resolveTrust, acquireLock },
  );
}
