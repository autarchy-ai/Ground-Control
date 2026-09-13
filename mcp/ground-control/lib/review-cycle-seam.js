// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { runCodexReview } from "./codex-review-runner.js";
import { runPostDecisionRecord } from "./decision-records.js";
import { _statusForReviewerAction, buildAutoFixDecisionFindings, normalizeReviewCycleNextAction, reviewCycleFindings, summarizeReviewFindings } from "./knowledge-capture.js";
import { verifyAutoDispositionGrant } from "./review-cap-disposition-2.js";
import { runTestQualityReview } from "./test-quality-runner-2.js";
import { _decorateUnobservedStation, _runStationWithObservationLedger } from "./station-observation-seam.js";

async function _runReviewCycleShared({
  reviewer,
  reviewResult,
  repoPath,
  issueNumber,
}) {
  // Non-ok review results pass straight through; the cycle tool does
  // not paper over reviewer boundary errors with a decision record. The
  // compact envelope is the orchestrator's contract, so a boundary error
  // still carries a `status` it can branch on (issue #1414).
  if (!reviewResult || reviewResult.ok !== true) {
    if (!reviewResult) return reviewResult;
    return { ...reviewResult, reviewer, status: reviewResult.status ?? "post_failed" };
  }

  const cycle =
    typeof reviewResult.cycle === "number" ? reviewResult.cycle : null;
  const cap = typeof reviewResult.cap === "number" ? reviewResult.cap : null;
  const findings = reviewCycleFindings(reviewResult);
  const nextAction =
    typeof reviewResult.next_action === "string" ? reviewResult.next_action : "";
  const status = _statusForReviewerAction(nextAction, findings.length > 0);

  const summary = summarizeReviewFindings(findings);
  // Diff transport + coverage travel with every cycle envelope so the
  // orchestrator can weight a review by how the diff reached the reviewer,
  // instead of seeing a clean cycle with no signal at all (issue #1414).
  const diffFields = {
    ...(typeof reviewResult.diff_mode === "string" ? { diff_mode: reviewResult.diff_mode } : {}),
    ...(reviewResult.review_coverage != null
      ? { review_coverage: reviewResult.review_coverage }
      : {}),
  };
  const findingsRecordUrl =
    typeof reviewResult.findings_comment_url === "string"
      ? reviewResult.findings_comment_url
      : typeof reviewResult.findings_record_url === "string"
        ? reviewResult.findings_record_url
        : null;

  // Cap-refused: the underlying review did NOT consume a cycle (the
  // marker was not written). The agent must escalate to the user.
  // No decision record is posted.
  if (status === "capped") {
    return {
      ok: true,
      reviewer,
      cycle,
      cap,
      status: "capped",
      next_action: normalizeReviewCycleNextAction(nextAction, "capped"),
      findings_summary: summary,
      findings_record_url: findingsRecordUrl,
      decision_record_url: null,
      ...diffFields,
    };
  }

  // Otherwise: post the auto-fix decision record. The cycle was
  // consumed by the review, so the decision record must be posted —
  // failure here means the durable record is incomplete and the
  // workflow contract is violated (ADR-029).
  const decisionFindings = buildAutoFixDecisionFindings(findings);
  let drResult;
  try {
    drResult = await runPostDecisionRecord({
      repoPath,
      issueNumber,
      cycle: cycle ?? 1,
      reviewer,
      findings: decisionFindings,
      // Forward the reviewer's architectural read so the decision record
      // carries the review's reasoning, not just a finding count (issue #966).
      // Omitted when absent so the record falls back to the legacy shape.
      ...(typeof reviewResult.architectural_read === "string"
        && reviewResult.architectural_read.trim() !== ""
        ? { architectural_read: reviewResult.architectural_read }
        : {}),
    });
  } catch (e) {
    return {
      ok: false,
      reviewer,
      cycle,
      cap,
      status: "post_failed",
      error: "review_cycle_decision_record_post_failed",
      message: e?.message ?? "runPostDecisionRecord threw",
      findings_summary: summary,
      findings_record_url: findingsRecordUrl,
      decision_record_url: null,
      ...diffFields,
    };
  }
  if (!drResult || drResult.ok !== true) {
    return {
      ok: false,
      reviewer,
      cycle,
      cap,
      status: "post_failed",
      error: drResult?.error ?? "review_cycle_decision_record_post_failed",
      message: drResult?.message ?? "runPostDecisionRecord returned ok=false",
      findings_summary: summary,
      findings_record_url: findingsRecordUrl,
      decision_record_url: null,
      ...diffFields,
    };
  }

  return {
    ok: true,
    reviewer,
    cycle,
    cap,
    status,
    next_action: normalizeReviewCycleNextAction(nextAction, status),
    findings_summary: summary,
    findings_record_url: findingsRecordUrl,
    decision_record_url: drResult.comment_url ?? null,
    ...diffFields,
  };
}
export async function runCodexReviewCycle({
  repoPath,
  issueNumber,
  baseBranch = null,
  uncommitted = true,
  overrideCap = false,
  overrideReason = null,
  autoGrant = false,
  signal = undefined,
}) {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return {
      ok: false,
      error: "codex_review_cycle_input_invalid",
      message: "repo_path is required",
    };
  }
  if (
    typeof issueNumber !== "number" ||
    !Number.isInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    return {
      ok: false,
      error: "codex_review_cycle_input_invalid",
      message: "issue_number must be a positive integer",
    };
  }
  if (uncommitted !== true) {
    return {
      ok: false,
      error: "codex_review_cycle_input_invalid",
      message:
        "gc_codex_review_cycle is the pre-push entrypoint only; uncommitted must be true. " +
        "Post-push direct callers should use gc_codex_review with pr_number.",
    };
  }

  // Auto-grant path (gc_review_cap_disposition). Only active when the caller
  // explicitly opts in. The existing human override_cap path is untouched.
  let effectiveOverrideCap = overrideCap;
  let effectiveOverrideReason = overrideReason;
  if (autoGrant === true) {
    const grant = await verifyAutoDispositionGrant({
      repoPath,
      issueNumber,
      reviewer: "codex",
    });
    if (!grant || grant.authorized !== true) {
      return {
        ok: false,
        reviewer: "codex",
        error: "auto_grant_unauthorized",
        message: grant?.reason
          ? `auto_grant requested but not authorized: ${grant.reason}`
          : "auto_grant requested but no valid auto-disposition grant exists",
        next_action: "post_summary_and_escalate_to_user",
      };
    }
    effectiveOverrideCap = true;
    effectiveOverrideReason = `auto-disposition grant #${grant.grant_number} (gc_review_cap_disposition one_more_cycle for codex)`;
  }

  const run = await _runStationWithObservationLedger({
    reviewer: "codex",
    repoPath,
    issueNumber,
    signal,
    invokeReview: ({ stationObservation }) => runCodexReview({
      repoPath,
      baseBranch: baseBranch ?? "dev",
      uncommitted: true,
      issueNumber,
      overrideCap: effectiveOverrideCap,
      overrideReason: effectiveOverrideReason,
      stationObservation,
      signal,
    }),
  });

  if (!run.observed && run.exhaustedNonVerdict) {
    return {
      ..._decorateUnobservedStation(run.envelope, run),
      reviewer: "codex",
      status: "post_failed",
    };
  }

  return _runReviewCycleShared({
    reviewer: "codex",
    reviewResult: run.envelope,
    repoPath,
    issueNumber,
  });
}
export async function runTestQualityReviewCycle({
  repoPath,
  issueNumber,
  baseBranch = null,
  overrideCap = false,
  overrideReason = null,
  autoGrant = false,
  model = undefined,
  signal = undefined,
}) {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return {
      ok: false,
      error: "test_quality_review_cycle_input_invalid",
      message: "repo_path is required",
    };
  }
  if (
    typeof issueNumber !== "number" ||
    !Number.isInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    return {
      ok: false,
      error: "test_quality_review_cycle_input_invalid",
      message: "issue_number must be a positive integer",
    };
  }

  // Auto-grant path (gc_review_cap_disposition). Only active when the caller
  // explicitly opts in. The existing human override_cap path is untouched.
  let effectiveOverrideCap = overrideCap;
  let effectiveOverrideReason = overrideReason;
  if (autoGrant === true) {
    const grant = await verifyAutoDispositionGrant({
      repoPath,
      issueNumber,
      reviewer: "test-quality",
    });
    if (!grant || grant.authorized !== true) {
      return {
        ok: false,
        reviewer: "test-quality",
        error: "auto_grant_unauthorized",
        message: grant?.reason
          ? `auto_grant requested but not authorized: ${grant.reason}`
          : "auto_grant requested but no valid auto-disposition grant exists",
        next_action: "post_summary_and_escalate_to_user",
      };
    }
    effectiveOverrideCap = true;
    effectiveOverrideReason = `auto-disposition grant #${grant.grant_number} (gc_review_cap_disposition one_more_cycle for test-quality)`;
  }

  const run = await _runStationWithObservationLedger({
    reviewer: "test-quality",
    repoPath,
    issueNumber,
    signal,
    invokeReview: ({ stationObservation }) => {
      const reviewParams = {
        repoPath,
        baseBranch,
        issueNumber,
        overrideCap: effectiveOverrideCap,
        overrideReason: effectiveOverrideReason,
        stationObservation,
        signal,
      };
      if (model !== undefined) reviewParams.model = model;
      return runTestQualityReview(reviewParams);
    },
  });

  if (!run.observed && run.exhaustedNonVerdict) {
    return {
      ..._decorateUnobservedStation(run.envelope, run),
      reviewer: "test-quality",
      status: "post_failed",
    };
  }

  return _runReviewCycleShared({
    reviewer: "test-quality",
    reviewResult: run.envelope,
    repoPath,
    issueNumber,
  });
}
