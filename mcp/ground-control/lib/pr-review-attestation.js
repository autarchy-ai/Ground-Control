// PR-body review attestation checked against the station ledger (issue #1578).
//
// The Ground Control Checks section states whether the pre-push reviews ran. The renderer cannot
// know whether a station was waived, so the synchronized PR writer — the only canonical PR-write
// path — checks the attestation against the verified issue-thread ledger immediately before the
// privileged write. A body may not say the reviews completed while a station stands waived and
// unobserved, and may not claim a waiver the thread does not prove.

import {
  PR_BODY_REVIEW_CHECK_LINE_COMPLETED,
  PR_BODY_REVIEW_CHECK_LINE_NOT_RUN,
  PR_BODY_REVIEW_CHECK_LINE_WAIVED,
} from "./pr-body-policy.js";

function refuse(message, extra = {}) {
  return {
    ok: false,
    error: "implement_pr_review_attestation_inaccurate",
    message,
    next_action: "rerender_the_pr_body_with_the_accurate_pre_push_reviews_state_and_retry",
    ...extra,
  };
}

export async function assertPrBodyReviewAttestationMatchesLedger({ body, issueNumber, stationEvidenceReader }) {
  const read = await stationEvidenceReader({ issueNumber });
  if (!read?.ok) {
    return {
      ok: false,
      error: "implement_pr_station_evidence_unverifiable",
      message: `The issue-thread execution-obligation ledger could not be verified: ${read?.message ?? "unknown failure"}`,
      next_action: "repair_execution_obligation_record_and_retry",
    };
  }
  const unobserved = read.evidence?.unobserved_waived_stations ?? [];
  const claimsWaiver = typeof body === "string" && body.includes(PR_BODY_REVIEW_CHECK_LINE_WAIVED);
  const claimsRun = typeof body === "string"
    && (body.includes(PR_BODY_REVIEW_CHECK_LINE_COMPLETED) || body.includes(PR_BODY_REVIEW_CHECK_LINE_NOT_RUN));
  if (unobserved.length > 0 && (claimsRun || !claimsWaiver)) {
    return refuse(
      `The issue thread records waived, unobserved review stations (${unobserved.join(", ")}); ` +
      "render the PR body with pre_push_reviews='waived'.",
      { waived_stations: unobserved },
    );
  }
  if (unobserved.length === 0 && claimsWaiver) {
    return refuse("The PR body claims a waived review station, but the issue thread records no verified waiver.");
  }
  return { ok: true };
}
