// Extracted from gc-implement-mechanical.js (issue #1355).
//
// The module had reached 1,231 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md). gc-implement-mechanical.js remains the tool entry point.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PHASE_E_WORKFLOW_PATH } from "../lib/phase-e-workflow.js";
import { failure, requireField } from "./gate-helpers.js";
import { mapCompletion } from "./publish.js";

// Record the delivery handoff against the pull-request head whose required hosted checks
// were verified, so Phase E can never replay a payload that describes a different tree.
// The caller supplies that head rather than this function re-reading it: a second read
// would both cost an extra GitHub round trip and open a window in which the head moves
// between the check and the binding.
async function recordHandoff(args, deps, action, { lane, headSha }) {
  // Whether this repository can finish on its own, checked on the delivery path rather than
  // left to whoever runs `grndctl doctor`. APTL passed Phase D, merged, and stalled with no
  // report and no failure record, because the absent file is the thing that would have
  // failed (issue #1688). The handoff is still recorded — it is what a manual
  // `finalize-merged-pr` replays — but the record says which of the two will happen.
  const executorPresent = existsSync(join(args.repoPath, PHASE_E_WORKFLOW_PATH));
  const recorded = await deps.recordDeliveryReadiness({
    repoPath: args.repoPath,
    issueNumber: args.issueNumber,
    prNumber: args.prNumber,
    lane,
    headSha,
    payload: args.completion,
    executorPresent,
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
  return { ok: true, recorded, executorPresent };
}

// /quickfix has no pre-merge report, so it reads the hosted-gate snapshot itself. That
// gives the lane the same eligibility bar /implement has without giving it /implement's
// requirement and review gates.
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
