// Extracted from gc-implement-mechanical.js (issue #1355).
//
// The module had reached 1,231 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md). gc-implement-mechanical.js remains the tool entry point.

import { failure, requireField } from "./gate-helpers.js";
import { mapCompletion } from "./publish.js";

export async function runReadiness(args, deps) {
  const action = "readiness";
  if (args.lane === "quickfix") {
    return failure(
      action,
      "quickfix_readiness_not_applicable",
      "The quickfix lane has no pre-merge final-report phase",
      "wait_for_user_merge_then_run_finalize",
    );
  }
  for (const field of ["prNumber", "completion"]) {
    const invalid = requireField(args, field, action);
    if (invalid) return invalid;
  }
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
  return {
    ok: true,
    action,
    phase: "ready_for_review",
    readiness_report: result.readiness_report,
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
