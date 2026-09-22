// Extracted from gc-implement-mechanical.js (issue #1355).
//
// The module had reached 1,231 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md). gc-implement-mechanical.js remains the tool entry point.

import { failure, requireField } from "./gate-helpers.js";
import { mapCompletion } from "./publish.js";
import { assertDeliveryBindingCurrent, deliveredHeadRefusal, laneClaimRefusal } from "../lib.js";

// Record the delivery handoff against the pull-request head whose required hosted checks
// were verified, so Phase E can never replay a payload that describes a different tree.
// The caller supplies that head rather than this function re-reading it: a second read
// would both cost an extra GitHub round trip and open a window in which the head moves
// between the check and the binding.
async function recordHandoff(args, deps, action, { lane, headSha }) {
  const recorded = await deps.recordDeliveryReadiness({
    repoPath: args.repoPath,
    issueNumber: args.issueNumber,
    prNumber: args.prNumber,
    lane,
    headSha,
    payload: args.completion,
  });
  if (!recorded.ok) {
    return failure(
      action,
      recorded.error,
      recorded.message,
      recorded.next_action ?? "repair_delivery_readiness_payload_and_retry",
      { delivery_readiness: recorded },
    );
  }
  return { ok: true, recorded };
}

// /quickfix has no pre-merge report, so it reads the hosted-gate snapshot itself. That
// gives the lane the same eligibility bar /implement has without giving it /implement's
// requirement processing.
async function quickfixReadiness(args, deps, action) {
  const hosted = await deps.readRemoteGates({ repoPath: args.repoPath, prNumber: args.prNumber });
  if (!hosted.ok || !hosted.passed || hosted.state !== "OPEN") {
    return failure(
      action,
      hosted.error ?? "readiness_hosted_checks_not_green",
      hosted.message ?? `required hosted checks for PR #${args.prNumber} are not green on its current head`,
      hosted.next_action ?? "repair_or_wait_for_current_head_hosted_checks",
      { hosted },
    );
  }
  // The waiver belongs to the run, not to the call. The branch comes from the pull
  // request GitHub just reported, so neither side of the check is caller text
  // (issue #1679).
  const lane = await deps.readRunLane({
    repoPath: args.repoPath,
    issueNumber: args.issueNumber,
    branchName: hosted.branch,
  });
  if (!lane.ok) {
    return failure(action, lane.error, lane.message, lane.next_action ?? "repair_run_lane_evidence_and_retry", { hosted });
  }
  const refusal = laneClaimRefusal(lane, "quickfix");
  if (refusal) {
    return failure(
      action,
      "readiness_lane_mismatch",
      refusal.message,
      "record_readiness_for_the_lane_this_run_was_picked_up_under",
      { hosted },
    );
  }
  // The waiver relaxes the review and nothing else, so the head being made ready
  // must still be the head that was synchronized, under a quickfix record
  // (issue #1679). Without this a commit pushed after PR creation could be bound
  // to the handoff and finalized unsynchronized.
  const synced = await deps.readSyncRecord({
    repoPath: args.repoPath, issueNumber: args.issueNumber, branchName: hosted.branch,
  });
  if (!synced?.ok) {
    return failure(
      action,
      synced?.error ?? "readiness_synchronization_unverifiable",
      synced?.message ?? "The trusted synchronization record for this delivery could not be read.",
      synced?.next_action ?? "return_to_the_synchronization_boundary",
      { hosted },
    );
  }
  const headRefusal = deliveredHeadRefusal({
    record: synced.record, headSha: hosted.head_sha, branchName: hosted.branch, issueNumber: args.issueNumber,
  });
  if (headRefusal) {
    return failure(action, "readiness_delivery_head_unsynchronized", headRefusal,
      "return_to_the_synchronization_boundary", { hosted });
  }
  const bound = assertDeliveryBindingCurrent({
    record: synced.record, evidence: null, branchName: hosted.branch, lane: "quickfix",
  });
  if (!bound.ok) {
    return failure(action, bound.error, bound.message, bound.next_action, { hosted });
  }
  const handoff = await recordHandoff(args, deps, action, { lane: "quickfix", headSha: hosted.head_sha });
  if (!handoff.ok) return handoff;
  return {
    ok: true,
    action,
    lane: "quickfix",
    phase: "ready_for_review",
    delivery_readiness: handoff.recorded,
    next_action: "wait_for_user_to_merge_the_pr",
  };
}

export async function runReadiness(args, deps) {
  const action = "readiness";
  for (const field of ["prNumber", "completion"]) {
    const invalid = requireField(args, field, action);
    if (invalid) return invalid;
  }
  // Validate the consumer before either lane publishes a readiness record. The workflow
  // registry is insufficient: GitHub keeps entries created by closed, unmerged PRs (#1702).
  const phaseE = await deps.verifyPhaseEWorkflow({ repoPath: args.repoPath, prNumber: args.prNumber });
  if (!phaseE.ok) {
    return failure(action, phaseE.error, phaseE.message, phaseE.next_action, { phase_e: phaseE });
  }
  if (args.lane === "quickfix") return quickfixReadiness(args, deps, action);

  const result = await deps.assertCompletion(mapCompletion(args, "pre_merge"));
  if (!result.ok) {
    return failure(
      action,
      result.error,
      result.message,
      result.next_action ?? "repair_readiness_evidence_and_retry",
      { completion: result },
    );
  }
  // The handoff follows the readiness record and binds to the head that record's hosted
  // gate just verified. A retry after a failed handoff post re-posts the readiness
  // comment, which is cosmetic; binding to a head nobody checked would not be.
  const handoff = await recordHandoff(args, deps, action, { lane: "implement", headSha: result.head_sha });
  if (!handoff.ok) return handoff;
  return {
    ok: true,
    action,
    lane: "implement",
    phase: "ready_for_review",
    head_sha: result.head_sha,
    readiness_report: result.readiness_report,
    delivery_readiness: handoff.recorded,
    next_action: "wait_for_user_to_merge_the_pr",
  };
}
export async function runFinalize(args, deps) {
  const action = "finalize";
  for (const field of ["prNumber", "completion"]) {
    const invalid = requireField(args, field, action);
    if (invalid) return invalid;
  }
  const completion = await deps.assertCompletion(mapCompletion(args, "post_merge"));
  if (!completion.ok) {
    return failure(
      action,
      completion.error,
      completion.message,
      completion.next_action ?? "repair_post_merge_evidence_and_retry",
      { completion },
    );
  }
  const close = await deps.closeIssue({
    repoPath: args.repoPath,
    issueNumber: args.issueNumber,
    prNumber: args.prNumber,
    // In the finalize flow the post-merge assertion already posted the validated
    // final-report marker (bound to this PR), so the close marker gate passes. A
    // genuine bypass is authorized only by a trusted issue-thread override comment,
    // never a caller field (issue #1541 security review).
  });
  if (!close.ok) {
    return failure(
      action,
      close.error,
      close.message,
      close.next_action ?? "repair_issue_close_and_retry",
      { completion, close },
    );
  }
  return {
    ok: true,
    action,
    phase: "closed",
    completion,
    close,
    next_action: "workflow_complete",
  };
}
