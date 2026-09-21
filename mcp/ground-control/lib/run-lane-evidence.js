// Which lane a run belongs to, derived from the issue thread (issue #1679).
//
// A bare `lane` argument used to control review-related delivery behavior. The
// lane is now a run property for workflow reporting and delivery consistency.
//
// A lane is now a property of the run, recorded before it takes effect. The MCP
// server posts a pickup comment when a run is bootstrapped, naming the lane and
// branch. The run's lane is the lane of the newest exact record by a repository-
// write author for its branch, so switching lanes is itself recorded: when
// the maintainer tells an agent to move on without a review, the agent
// bootstraps the same branch as `/quickfix` and the thread says so. Every gate
// that depends on the selected workflow lane reads it from here, and a caller
// that states a different lane is refused.
//
// Deliberately, no further human signal is required. Choosing the lane is the
// maintainer's instruction to the agent; the durable pickup record makes that
// choice visible at merge, which is the single human touchpoint, rather than
// adding a ceremony in front of it.

import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { readIssueCommentsWithAuthors, resolveExecutionObligationTrust } from "./grc-legacy-compat-3.js";

export const RUN_LANES = Object.freeze(["implement", "quickfix"]);

// The exact record `gc_mark_implement_issue_picked_up` writes. Anchored at both
// ends so pickup-shaped prose inside a longer comment is not evidence.
const RUN_PICKUP_RE =
  /^🛠️ Picked up by \/(implement|quickfix) - driver [A-Za-z0-9._-]{1,40}, branch `([a-z0-9-]{1,50})`, \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/;

/** The lane and branch a pickup comment records, or null when it is not one. */
export function parseRunPickupRecord(body) {
  const match = typeof body === "string" ? RUN_PICKUP_RE.exec(body.trim()) : null;
  return match == null ? null : { lane: match[1], branch: match[2] };
}

function authoredBy(comment, login) {
  return typeof login === "string" && login !== ""
    && comment?.authorLogin?.toLowerCase() === login.toLowerCase();
}

/**
 * The lane of the newest pickup record this server wrote for the branch, or null.
 *
 * This is retained for the separate release-identity contract, which deliberately
 * binds its records to the server identity. Lane derivation uses the trusted
 * predicate below instead.
 */
export function currentPickupLane(comments, login, branch) {
  let newest = null;
  for (const [index, comment] of (comments ?? []).entries()) {
    const record = parseRunPickupRecord(comment?.body);
    if (record == null || record.branch !== branch || !authoredBy(comment, login)) continue;
    const order = Number.isInteger(comment.id) ? comment.id : index;
    if (newest == null || order > newest.order) newest = { order, lane: record.lane };
  }
  return newest?.lane ?? null;
}

/** The lane from the newest exact pickup record written by a trusted author. */
export function currentTrustedPickupLane(comments, trust, branch) {
  let newest = null;
  for (const [index, comment] of (comments ?? []).entries()) {
    const record = parseRunPickupRecord(comment?.body);
    if (record == null || record.branch !== branch || !trust?.isTrusted(comment)) continue;
    const order = Number.isInteger(comment.id) ? comment.id : index;
    if (newest == null || order > newest.order) newest = { order, lane: record.lane };
  }
  return newest?.lane ?? null;
}

/** Whether this server's GitHub identity recorded `/implement` ownership of the branch. */
export function implementPickupRecordedBy(comments, login, branch) {
  return (comments ?? []).some((comment) => {
    const record = parseRunPickupRecord(comment?.body);
    return record?.lane === "implement" && record.branch === branch && authoredBy(comment, login);
  });
}

/**
 * Derive the lane for an issue branch from trusted pickup records.
 *
 * Returns `{ok:true, lane, pickup_found}`. A branch with no trusted pickup
 * record is an `/implement` branch, so the absence of evidence never waives
 * anything. An unreadable thread or unavailable trust resolution refuses.
 */
export async function readTrustedRunLane(
  { repoRoot, owner, name, issueNumber, branchName },
  { readComments = readIssueCommentsWithAuthors, resolveTrust = resolveExecutionObligationTrust } = {},
) {
  let comments;
  let trust;
  try {
    comments = await readComments(repoRoot, owner, name, issueNumber);
    trust = await resolveTrust(repoRoot, owner, name, comments);
  } catch {
    return {
      ok: false,
      error: "run_lane_unverifiable",
      message: "The issue thread could not be read to derive which lane this run belongs to.",
      next_action: "retry_after_restoring_github_access",
    };
  }
  if ((comments ?? []).some((comment) => {
    const record = parseRunPickupRecord(comment?.body);
    return record?.branch === branchName && trust?.isResolved?.(comment) === false;
  })) {
    return {
      ok: false,
      error: "run_lane_unverifiable",
      message: "Pickup author permission could not be resolved to derive this run's lane.",
      next_action: "retry_after_restoring_github_access",
    };
  }
  const pickupLane = currentTrustedPickupLane(comments, trust, branchName);
  return { ok: true, lane: pickupLane ?? "implement", pickup_found: pickupLane != null };
}

/**
 * Whether a caller's stated lane agrees with the lane the thread records.
 *
 * Every consumer that relaxes a gate for `/quickfix` - synchronization, PR
 * creation, readiness, completion - applies this one rule: a stated lane is an
 * assertion, never authority, and a disagreement refuses. The remedy is to
 * bootstrap the branch in the intended lane, which records the switch. Returns
 * null on agreement, or a message the consumer maps into its own vocabulary.
 */
export function laneClaimRefusal(derived, claimedLane) {
  if (claimedLane == null || claimedLane === derived.lane) return null;
  return {
    reason: "lane_mismatch",
    message:
      `This run's branch was last picked up as /${derived.lane}, but the call states lane='${claimedLane}'. `
      + `To continue as /${claimedLane}, bootstrap the branch in that lane first; the switch is recorded on the issue.`,
  };
}

/**
 * The same derivation for callers that hold a `repo_path` rather than a resolved
 * repository. The repository identity comes from the MCP launch workspace, not
 * from the caller's path (ADR-027).
 */
export async function resolveTrustedRunLane(
  { repoPath, issueNumber, branchName },
  { workspaceAuthorizationResolver, ...overrides } = {},
) {
  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository?.ok) return issueRepositoryNotAuthorized("run_lane", repository ?? {}, {});
  return readTrustedRunLane({
    repoRoot: repository.repoRoot,
    owner: repository.owner,
    name: repository.name,
    issueNumber,
    branchName,
  }, overrides);
}
