// The deterministic post-merge executor for Phase E (issue #1671).
//
// Before this, Phase E needed a model or agent to re-enter the workflow after a merge, so a
// delivered issue stayed open until someone invoked `/implement` again. Everything Phase E
// actually needs was already recorded at Phase D, so nothing here validates anything: this
// is a trigger and an evidence loader. It resolves the issue from a trusted pull-request
// pointer, verifies the trusted readiness record against the MERGED head, and hands the
// recorded payload to the incumbent finalizer, which keeps sole ownership of the merge
// gate, the immutable merged-revision requirement verification, the final-report marker,
// and the idempotent close.
//
// Failure is not a close path. A refusal that is bound to a known issue leaves one durable,
// idempotently keyed record on the thread and fails the job, so a maintainer can repair the
// cause and retry rather than discover a silently-closed issue.

import {
  readTrustedDeliveryPointer,
  readTrustedDeliveryReadiness,
} from "../lib/delivery-readiness.js";
import { resolveAuthorizedIssueRepository } from "../lib/authorized-issue-repository.js";
import { fetchPullRequest } from "../lib/github-rest.js";
import { bounded } from "./gate-helpers.js";
import { detectSensitiveBodyContent, extractGhErrorMessage } from "../lib/grc-legacy-compat-2.js";
import { readIssueCommentsWithAuthors } from "../lib/grc-legacy-compat-3.js";
import { execFile } from "../lib/runtime-primitives.js";
import { runImplementMechanical } from "../gc-implement-mechanical.js";

function failureMarker(prNumber, code) {
  return `<!-- gc:delivery-finalization-failed pr="${prNumber}" code="${code}" -->`;
}

function buildFailureRecord({ prNumber, recordCommentId, code, message, nextAction }) {
  return [
    failureMarker(prNumber, code),
    "",
    `## Phase E could not finalize PR #${prNumber}`,
    "",
    "The merge was detected and the delivery-readiness record was read, but finalization did",
    "not complete. **This issue is intentionally left open.**",
    "",
    `- **Reason:** \`${code}\``,
    `- **Detail:** ${bounded(message, 600)}`,
    ...(nextAction ? [`- **Repair:** \`${nextAction}\``] : []),
    ...(recordCommentId ? [`- **Readiness record:** comment ${recordCommentId}`] : []),
    "",
    "Repair the cause, then re-run the Ground Control Phase E workflow for this pull request.",
  ].join("\n");
}

// One record per (pull request, reason). An identical replay — a retried job, or a lost
// response after a successful POST — reuses it; a genuinely different failure appends.
async function recordFailure(repository, issueNumber, body, prNumber, code, deps) {
  const { repoRoot, owner, name } = repository;
  let existing = [];
  try {
    existing = await deps.readComments(repoRoot, owner, name, issueNumber);
  } catch {
    existing = [];
  }
  const marker = failureMarker(prNumber, code);
  if (existing.some((c) => typeof c.body === "string" && c.body.includes(marker))) return;
  try {
    await deps.postComment(repoRoot, owner, name, issueNumber, body);
  } catch {
    // The job still fails below; a thread write that itself fails must not mask the
    // original refusal, which is the actionable one.
  }
}

async function fail({ repository, issueNumber, prNumber, recordCommentId, code, message, nextAction }, deps) {
  const safeMessage = detectSensitiveBodyContent(message ?? "") ? "<redacted>" : bounded(message ?? code, 600);
  if (repository != null && Number.isInteger(issueNumber)) {
    await recordFailure(
      repository,
      issueNumber,
      buildFailureRecord({ prNumber, recordCommentId, code, message: safeMessage, nextAction }),
      prNumber,
      code,
      deps,
    );
  }
  return {
    ok: false,
    status: "failed",
    error: code,
    message: safeMessage,
    issue_number: issueNumber ?? null,
    pr_number: prNumber,
    next_action: nextAction ?? "repair_the_named_condition_and_rerun_phase_e",
  };
}

async function postIssueComment(repoRoot, owner, name, number, body) {
  const { stdout } = await execFile(
    "gh",
    ["api", "--method", "POST", `/repos/${owner}/${name}/issues/${number}/comments`, "-f", `body=${body}`],
    { cwd: repoRoot },
  );
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

const defaultDeps = {
  resolveRepository: (repoPath) => resolveAuthorizedIssueRepository(repoPath),
  fetchPr: (repository, prNumber) =>
    fetchPullRequest(repository.repoRoot, repository.owner, repository.name, prNumber),
  readPointer: (input) => readTrustedDeliveryPointer(input),
  readReadiness: (input) => readTrustedDeliveryReadiness(input),
  finalize: (input) => runImplementMechanical(input),
  readComments: readIssueCommentsWithAuthors,
  postComment: postIssueComment,
};

/**
 * Finish Phase E for one merged pull request.
 *
 * @returns `{ok:true, status:"finalized"}` when the finalizer accepted the merged state,
 *   `{ok:true, status:"skipped"}` when the pull request is not a Ground Control delivery,
 *   or `{ok:false, status:"failed", error}` with a durable issue-thread record.
 */
export async function runAutomatedPhaseE({ repoPath, prNumber, automationRunId = null }, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { ok: false, status: "failed", error: "phase_e_pr_number_invalid", message: "pr_number must be a positive integer", pr_number: prNumber ?? null };
  }
  const repository = await deps.resolveRepository(repoPath);
  if (!repository.ok) {
    return { ok: false, status: "failed", error: repository.error, message: repository.message, pr_number: prNumber };
  }
  const { repoRoot, owner, name } = repository;

  let pr;
  try {
    pr = await deps.fetchPr(repository, prNumber);
  } catch (error) {
    return { ok: false, status: "failed", error: "phase_e_pr_unreadable", message: extractGhErrorMessage(error), pr_number: prNumber };
  }
  // The event payload is a hint; live state is the authority. The finalizer re-checks this
  // too — the point of checking here is to avoid writing a failure record for a pull
  // request that was merely closed.
  if (!pr?.mergedAt || pr.state !== "MERGED") {
    return {
      ok: false,
      status: "failed",
      error: "phase_e_pr_not_merged",
      message: `PR #${prNumber} state=${pr?.state ?? "unknown"}, merged_at=${pr?.mergedAt ?? "null"}`,
      pr_number: prNumber,
      next_action: "run_phase_e_only_for_a_merged_pull_request",
    };
  }

  const pointer = await deps.readPointer({ repoRoot, owner, name, prNumber });
  if (!pointer.ok) {
    // Most merged pull requests in a repository are not Ground Control deliveries. Saying
    // so is a successful no-op, not a failure to record on somebody else's issue.
    return { ok: true, status: "skipped", reason: pointer.error, pr_number: prNumber };
  }
  const issueNumber = pointer.pointer.issue;

  const readiness = await deps.readReadiness({
    repoRoot, owner, name, issueNumber, prNumber, headSha: pr.headRefOid,
  });
  if (!readiness.ok) {
    return fail({
      repository, issueNumber, prNumber,
      recordCommentId: pointer.pointer.record,
      code: readiness.error,
      message: readiness.message,
      nextAction: "re_record_phase_d_readiness_for_the_merged_head_and_rerun_phase_e",
    }, deps);
  }

  const finalized = await deps.finalize({
    action: "finalize",
    lane: readiness.record.lane,
    repoPath: repoRoot,
    issueNumber,
    prNumber,
    completion: readiness.record.payload,
    automationRunId,
  });
  if (!finalized.ok) {
    return fail({
      repository, issueNumber, prNumber,
      recordCommentId: readiness.record.commentId,
      code: finalized.error ?? "phase_e_finalize_failed",
      message: finalized.message,
      nextAction: finalized.next_action,
    }, deps);
  }
  return {
    ok: true,
    status: "finalized",
    issue_number: issueNumber,
    pr_number: prNumber,
    lane: readiness.record.lane,
    already_reported: finalized.completion?.already_reported === true,
    closed: finalized.close?.closed === true || finalized.close?.already_closed === true,
  };
}
