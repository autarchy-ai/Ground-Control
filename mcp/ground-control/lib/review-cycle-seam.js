// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
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
  workspaceAuthorizationResolver,
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
    }, { workspaceAuthorizationResolver });
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
function _reviewCycleInputError(repoPath, issueNumber) {
  if (typeof repoPath !== "string" || repoPath.length === 0) return "repo_path is required";
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return "issue_number must be a positive integer";
  return null;
}

// Shared cycle entry: input validation, the launch-workspace pin (issue #1583), and the opt-in
// auto-grant path (gc_review_cap_disposition). Returns `{ earlyReturn }` or the authorized checkout
// plus the effective cap override. The existing human override_cap path is untouched.
async function _prepareReviewCycle({
  reviewer,
  errorPrefix,
  repoPath,
  issueNumber,
  extraInputError = null,
  overrideCap,
  overrideReason,
  autoGrant,
  workspaceAuthorizationResolver,
}) {
  const inputError = _reviewCycleInputError(repoPath, issueNumber) ?? extraInputError;
  if (inputError) {
    return { earlyReturn: { ok: false, error: `${errorPrefix}_input_invalid`, message: inputError } };
  }
  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    return {
      earlyReturn: {
        ...issueRepositoryNotAuthorized(errorPrefix, repository, { issue_number: issueNumber }),
        reviewer,
        status: "post_failed",
      },
    };
  }
  const authorizedRepoPath = repository.repoRoot;
  if (autoGrant !== true) {
    return { authorizedRepoPath, overrideCap, overrideReason };
  }
  const grant = await verifyAutoDispositionGrant(
    { repoPath: authorizedRepoPath, issueNumber, reviewer },
    { workspaceAuthorizationResolver },
  );
  if (!grant || grant.authorized !== true) {
    return {
      earlyReturn: {
        ok: false,
        reviewer,
        error: "auto_grant_unauthorized",
        message: grant?.reason
          ? `auto_grant requested but not authorized: ${grant.reason}`
          : "auto_grant requested but no valid auto-disposition grant exists",
        next_action: "post_summary_and_escalate_to_user",
      },
    };
  }
  return {
    authorizedRepoPath,
    overrideCap: true,
    overrideReason: `auto-disposition grant #${grant.grant_number} (gc_review_cap_disposition one_more_cycle for ${reviewer})`,
  };
}
// Every attempt rendered no verdict: report the unobserved station; otherwise record the cycle.
function _finishReviewCycle({ reviewer, run, authorizedRepoPath, issueNumber, workspaceAuthorizationResolver }) {
  if (!run.observed && run.exhaustedNonVerdict) {
    return {
      ..._decorateUnobservedStation(run.envelope, run),
      reviewer,
      status: "post_failed",
    };
  }
  return _runReviewCycleShared({
    reviewer,
    reviewResult: run.envelope,
    repoPath: authorizedRepoPath,
    issueNumber,
    workspaceAuthorizationResolver,
  });
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
}, { workspaceAuthorizationResolver = undefined } = {}) {
  const prepared = await _prepareReviewCycle({
    reviewer: "codex",
    errorPrefix: "codex_review_cycle",
    repoPath,
    issueNumber,
    extraInputError: uncommitted === true
      ? null
      : "gc_codex_review_cycle is the pre-push entrypoint only; uncommitted must be true. " +
        "Post-push direct callers should use gc_codex_review with pr_number.",
    overrideCap,
    overrideReason,
    autoGrant,
    workspaceAuthorizationResolver,
  });
  if (prepared.earlyReturn) return prepared.earlyReturn;
  const { authorizedRepoPath } = prepared;

  const run = await _runStationWithObservationLedger({
    reviewer: "codex",
    repoPath: authorizedRepoPath,
    issueNumber,
    signal,
    invokeReview: ({ stationObservation }) => runCodexReview({
      repoPath: authorizedRepoPath,
      baseBranch: baseBranch ?? "dev",
      uncommitted: true,
      issueNumber,
      overrideCap: prepared.overrideCap,
      overrideReason: prepared.overrideReason,
      stationObservation,
      signal,
    }, { workspaceAuthorizationResolver }),
  });

  return _finishReviewCycle({ reviewer: "codex", run, authorizedRepoPath, issueNumber, workspaceAuthorizationResolver });
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
}, { workspaceAuthorizationResolver = undefined } = {}) {
  const prepared = await _prepareReviewCycle({
    reviewer: "test-quality",
    errorPrefix: "test_quality_review_cycle",
    repoPath,
    issueNumber,
    overrideCap,
    overrideReason,
    autoGrant,
    workspaceAuthorizationResolver,
  });
  if (prepared.earlyReturn) return prepared.earlyReturn;
  const { authorizedRepoPath } = prepared;

  const run = await _runStationWithObservationLedger({
    reviewer: "test-quality",
    repoPath: authorizedRepoPath,
    issueNumber,
    signal,
    invokeReview: ({ stationObservation }) => {
      const reviewParams = {
        repoPath: authorizedRepoPath,
        baseBranch,
        issueNumber,
        overrideCap: prepared.overrideCap,
        overrideReason: prepared.overrideReason,
        stationObservation,
        signal,
      };
      if (model !== undefined) reviewParams.model = model;
      return runTestQualityReview(reviewParams, { workspaceAuthorizationResolver });
    },
  });

  return _finishReviewCycle({ reviewer: "test-quality", run, authorizedRepoPath, issueNumber, workspaceAuthorizationResolver });
}
