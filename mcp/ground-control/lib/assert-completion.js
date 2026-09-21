// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { runPostFinalReport } from "./doc-coverage-2.js";
import { readTrustedExecutionObligationState } from "./grc-legacy-compat-4.js";
import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { findRecoverableStationObservations } from "./station-observation-reconcile.js";
import { validateFinalReportInput } from "./plan-posting.js";
import { readRemoteGateSnapshot } from "./remote-gates.js";
import {
  applyObservedMergedRequirements,
  assertLinkedPrMerged,
  runPostMergeCompletion,
  verifyMergedRequirements,
} from "./assert-completion-post-merge.js";
import { readTrustedReviewPublicationEvidence } from "./review-publication-evidence.js";
import { readLatestTrustedImplementSyncRecord } from "./knowledge-capture.js";
import { assertDeliveryBindingCurrent, deliveredHeadRefusal } from "./delivery-binding.js";
import { laneClaimRefusal, readTrustedRunLane } from "./run-lane-evidence.js";

// Read and gate on the trusted execution-obligation state. Returns `{ ok: true }`
// when no obligation is open, or `{ earlyReturn }` carrying the exact envelope the
// caller must return. Extracted to keep runAssertCompletion under the length cap.
async function _readCompletionObligationState(repository, issueNumber, assertions) {
  const obligationState = await readTrustedExecutionObligationState(
    repository.repoRoot,
    repository.owner,
    repository.name,
    issueNumber,
  );
  if (!obligationState.ok) {
    return {
      earlyReturn: {
        ok: false,
        error: obligationState.error,
        message: obligationState.message,
        issue_number: issueNumber,
        assertions,
        final_report: null,
        next_action: "repair_execution_obligation_record_and_retry",
      },
    };
  }
  if (!obligationState.clear) {
    // A station observation whose verdict is already on the thread is not work left to do; only its
    // resolution is missing (issue #1582). Name it, and the tool that records it, so the refusal
    // does not read as a gate nobody can clear.
    const recoverable = await findRecoverableStationObservations({
      repoRoot: repository.repoRoot,
      owner: repository.owner,
      name: repository.name,
      issueNumber,
      openObligations: obligationState.open_obligations,
    });
    const allRecoverable = recoverable.length === obligationState.open_obligation_ids.length;
    return {
      earlyReturn: {
        ok: false,
        error: "completion_open_execution_obligations",
        message:
          `gc_assert_completion refuses readiness/completion while execution obligations remain open: ` +
          obligationState.open_obligation_ids.join(", ") +
          (recoverable.length > 0
            ? `. Already re-observed but unresolved: ${recoverable.map((r) => r.obligation_id).join(", ")} ` +
              "- record each with gc_reconcile_station_observation"
            : ""),
        issue_number: issueNumber,
        open_obligation_ids: obligationState.open_obligation_ids,
        recoverable_station_observations: recoverable,
        assertions,
        final_report: null,
        next_action: allRecoverable
          ? "reconcile_station_observations_then_retry"
          : "fix_and_resolve_open_obligations_then_retry",
      },
    };
  }
  return { ok: true };
}

// The delivery a completion phase is about: the branch the pull request carries
// and the head it currently points at. Branch equality alone does not establish
// that this is the delivery that was synchronized - another commit can land on
// the same branch after the pull request was created (issue #1679, core-F2).
async function _assertDeliveredHeadSynchronized(repository, issueNumber, assertions, delivered) {
  const latest = await readLatestTrustedImplementSyncRecord(
    repository.repoRoot, repository.owner, repository.name, issueNumber, delivered.branch,
  );
  const refuse = (message, nextAction) => ({
    refusal: {
    ok: false,
    error: "completion_delivery_head_unsynchronized",
    message,
    issue_number: issueNumber,
    assertions,
    final_report: null,
    next_action: nextAction,
    },
  });
  if (latest?.ok !== true) {
    return refuse(
      latest?.message ?? "The trusted synchronization record for this delivery could not be read.",
      "return_to_the_synchronization_boundary",
    );
  }
  const headRefusal = deliveredHeadRefusal({
    record: latest.record, headSha: delivered.headSha, branchName: delivered.branch, issueNumber,
  });
  if (headRefusal) return refuse(headRefusal, "return_to_the_synchronization_boundary");
  assertions.push({
    name: "delivery_head_synchronized",
    ok: true,
    head_sha: delivered.headSha,
    settled_tree_oid: latest.record.settledTreeSha,
    synchronization_record_id: latest.record.recordId,
  });
  return { record: latest.record };
}

// Which lane this completion is for. It decides whether the delivery chain
// applies at all, so it is derived from trusted evidence for the branch the pull
// request actually delivers, and the caller's lane must agree with it - the same
// rule PR creation and readiness apply (issue #1679). Taking it from the caller
// let finalize skip every delivery check by stating lane='quickfix'.
async function _resolveCompletionLane(repository, issueNumber, branchName, claimedLane, assertions, laneReader) {
  const refuse = (error, message, nextAction) => ({ refusal: {
    ok: false, error, message, issue_number: issueNumber, assertions, final_report: null, next_action: nextAction,
  } });
  if (typeof branchName !== "string" || branchName === "") {
    return refuse(
      "completion_lane_unverifiable",
      "The pull request's head branch could not be read, so the run's lane cannot be derived.",
      "retry_after_restoring_github_access",
    );
  }
  const derived = await laneReader({
    repoRoot: repository.repoRoot, owner: repository.owner, name: repository.name, issueNumber, branchName,
  });
  if (!derived?.ok) {
    return refuse(
      derived?.error ?? "completion_lane_unverifiable",
      derived?.message ?? "The run's lane could not be derived from trusted evidence.",
      derived?.next_action ?? "retry_after_restoring_github_access",
    );
  }
  const claim = laneClaimRefusal(derived, claimedLane);
  if (claim) {
    return refuse("completion_lane_mismatch", claim.message, "complete_under_the_lane_this_run_was_picked_up_under");
  }
  return { lane: derived.lane };
}

// The delivery chain, asserted as one thing rather than three (issue #1679).
//
// Checking the synchronized head and the published review independently accepts
// a pair that never belonged together: a publication posted on the same branch
// *after* the delivery was synchronized satisfies the branch check while naming
// a different revision and candidate tree than the record the head check
// approved. The record already carries which publication it was bound to, so the
// binding is what closes that gap.
async function _assertDeliveryChain(repository, issueNumber, assertions, delivered, lane) {
  // Head synchronization applies to every lane. The quickfix waiver relaxes the
  // review publication and nothing else, so a quickfix delivery is still bound to
  // the head that was synchronized: a commit pushed after that is refused here
  // exactly as it would be for /implement (issue #1679).
  const head = await _assertDeliveredHeadSynchronized(repository, issueNumber, assertions, delivered);
  if (head.refusal) return head.refusal;
  let evidence = null;
  if (lane !== "quickfix") {
    const review = await _assertReviewPublished(repository, issueNumber, assertions, delivered.branch);
    if (review.refusal) return review.refusal;
    evidence = review.evidence;
  }
  // `lane` is the one derived from trusted evidence. Passing the record's own
  // lane here compared the record with itself and could never refuse.
  const bound = assertDeliveryBindingCurrent({
    record: head.record,
    evidence,
    branchName: delivered.branch,
    lane,
  });
  if (!bound.ok) {
    return {
      ok: false,
      error: bound.error,
      message: bound.message,
      issue_number: issueNumber,
      assertions,
      final_report: null,
      next_action: bound.next_action ?? "return_to_the_synchronization_boundary",
    };
  }
  assertions.push({
    name: "delivery_binding_current",
    ok: true,
    review_publication_id: head.record.reviewPublicationId,
    review_revision_digest: head.record.reviewRevisionDigest,
  });
  return null;
}

async function _assertReviewPublished(repository, issueNumber, assertions, deliveredBranch) {
  const evidence = await readTrustedReviewPublicationEvidence({
    repoRoot: repository.repoRoot,
    owner: repository.owner,
    name: repository.name,
    issueNumber,
  });
  if (evidence.ok && evidence.published) {
    // Naming the reviewed revision is not the same as checking it. Recording the
    // fields without comparing them let a publication from another branch satisfy
    // both completion phases (issue #1679, core-F1). The branch is the part a
    // completion phase can check on its own: it comes from the pull request
    // GitHub reports, and the reviewed branch comes from the trusted cycle
    // marker. The tree binding stays where the delivery is authorized - the
    // synchronization boundary and PR creation - because only those hold the
    // settled tree.
    // A delivery whose branch cannot be read is a delivery that cannot be checked,
    // so it refuses rather than skipping the comparison.
    if (evidence.branch !== deliveredBranch) {
      return { refusal: {
        ok: false,
        error: "completion_review_branch_mismatch",
        message:
          `The trusted review publication for issue #${issueNumber} ran on branch `
          + `'${evidence.branch}', but this pull request delivers '${deliveredBranch ?? "an unreadable branch"}'. `
          + "A review of other work cannot authorize this delivery.",
        issue_number: issueNumber,
        assertions,
        final_report: null,
        next_action: "publish_a_review_for_this_branch_and_retry",
      } };
    }
    assertions.push({
      name: "codex_review_published",
      ok: true,
      comment_id: evidence.comment_id,
      revision_digest: evidence.revision_digest,
      candidate_tree_oid: evidence.candidate_tree_oid,
      findings_count: evidence.findings_count,
      branch: evidence.branch,
    });
    return { evidence };
  }
  return { refusal: {
    ok: false,
    error: evidence.error ?? "completion_review_publication_missing",
    message: evidence.message ?? "A trusted published Codex decision record is required before readiness or completion.",
    issue_number: issueNumber,
    assertions,
    final_report: null,
    next_action: "publish_the_retained_review_or_run_the_automatic_review_cycle",
  } };
}

// Phase D terminal (phase="pre_merge"): post the readiness record and return its
// envelope. Extracted from runAssertCompletion (length cap).
async function _runPreMergeReadiness({ subInput, repoPath, issueNumber, prNumber, headSha, assertions, workspaceAuthorizationResolver }) {
  const readiness = await runPostFinalReport({
    ...subInput,
    repoPath,
    issueNumber,
    prNumber,
    phase: "pre_merge",
  }, { workspaceAuthorizationResolver });
  if (!readiness.ok) {
    return {
      ok: false,
      error: readiness.error,
      message: readiness.message,
      issue_number: issueNumber,
      assertions,
      final_report: null,
      next_action: readiness.next_action ?? null,
    };
  }
  return {
    ok: true,
    repo_path: readiness.repo_path,
    issue_number: issueNumber,
    pr_number: prNumber,
    phase: "pre_merge",
    head_sha: headSha,
    assertions,
    readiness_report: {
      comment_url: readiness.comment_url,
      comment_id: readiness.comment_id,
    },
    final_report: null,
  };
}

function completionSubInput(input) {
  const {
    issueNumber,
    prNumber,
    requirements = [],
    files,
    reviews,
    traceability,
    ciStatus,
    sonarStatus,
    planCommentUrl,
    summary,
    plainEnglishOutcome,
    documentation_outcome,
    lane = "implement",
    automationRunId = null,
  } = input;
  return {
    issueNumber,
    prNumber,
    requirements: requirements.map((r) => ({
      uid: r.uid,
      title: r.title ?? r.uid,
      status: r.status ?? r.statusIntent ?? "ACTIVE",
      note: r.note ?? undefined,
    })),
    files: files ?? {},
    reviews: reviews ?? [],
    traceability: traceability ?? {},
    ciStatus,
    sonarStatus,
    planCommentUrl: planCommentUrl ?? null,
    summary: summary ?? null,
    plainEnglishOutcome: plainEnglishOutcome ?? null,
    documentation_outcome: documentation_outcome ?? null,
    lane,
    // Present only when the deterministic post-merge finalizer is the author; it is
    // provenance to be VERIFIED at the close gate, never authority on its own (#1671).
    automationRunId,
  };
}

async function runPreMergeCompletion({
  subInput, repository, issueNumber, prNumber, assertions, workspaceAuthorizationResolver, laneReader,
}) {
  if (subInput.ciStatus !== "green") {
    return { ok: false, error: "final_report_ci_not_green", assertions, final_report: null };
  }
  const repoPath = repository.repoRoot;
  const hosted = await readRemoteGateSnapshot({ repoPath, prNumber }, { workspaceAuthorizationResolver });
  if (!hosted.ok || !hosted.passed || hosted.state !== "OPEN") {
    return { ok: false, error: "completion_hosted_checks_not_green", hosted,
      next_action: "repair_or_wait_for_current_head_hosted_checks", assertions, final_report: null };
  }
  const delivered = { branch: hosted.branch ?? null, headSha: hosted.head_sha ?? null };
  const lane = await _resolveCompletionLane(
    repository, issueNumber, delivered.branch, subInput.lane, assertions, laneReader,
  );
  if (lane.refusal) return lane.refusal;
  const chainRefusal = await _assertDeliveryChain(repository, issueNumber, assertions, delivered, lane.lane);
  if (chainRefusal) return chainRefusal;
  return _runPreMergeReadiness({
    subInput, repoPath, issueNumber, prNumber, headSha: hosted.head_sha, assertions, workspaceAuthorizationResolver,
  });
}

export async function runAssertCompletion(input, {
  workspaceAuthorizationResolver = undefined,
  laneReader = readTrustedRunLane,
} = {}) {
  const { repoPath, issueNumber, prNumber, requirements = [], lane = "implement", phase = "post_merge" } = input;
  const assertions = [];
  // Fail-fast: validate the final-report sub-input BEFORE any side effects.
  const subInput = completionSubInput(input);
  const validation = validateFinalReportInput(subInput);
  if (!validation.ok) {
    return {
      ok: false,
      error: "completion_final_report_input_invalid",
      message: validation.errors.join("; "),
      issue_number: issueNumber,
      assertions,
      final_report: null,
    };
  }

  // Every read and record below — the obligation ledger, the merged PR, the issue scope, and the
  // report itself — is bound to the launch-workspace-authorized repository (issues #1578, #1583).
  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    return {
      ...issueRepositoryNotAuthorized("completion", repository, { issue_number: issueNumber }),
      assertions,
      final_report: null,
    };
  }
  const authorizedRepoPath = repository.repoRoot;

  // A discovered real problem is a durable obligation of the current
  // /implement run. Both the Phase D readiness record and Phase E completion
  // fail closed while a trusted issue-thread obligation remains open. Cached
  // arrays and caller summaries are intentionally ignored.
  const obligationCheck = await _readCompletionObligationState(repository, issueNumber, assertions);
  if (obligationCheck.earlyReturn) return obligationCheck.earlyReturn;

  // Phase D terminal (phase="pre_merge", issue #963): post the ready-for-review
  // record only. Requirement status and traceability are proposed in the delivery
  // PR, not authoritative until merged. Every hosted and publication gate still
  // applies; this path posts no `gc:final-report` marker.
  if (phase === "pre_merge") {
    return runPreMergeCompletion({
      subInput, repository, issueNumber, prNumber, assertions, workspaceAuthorizationResolver, laneReader,
    });
  }

  // Phase E (phase="post_merge", default): the reconciled completion record is
  // merge-gated (issue #963). Refuse to run the assertions or post the final
  // report unless the linked PR is actually merged — this is the structural
  // guarantee that Ground Control state (ACTIVE transitions, IMPLEMENTS/TESTS
  // links, the durable final report) never lands ahead of shipped code, mirroring
  // gc_close_issue_after_merge. resolvePrForClose validates a supplied pr_number
  // is linked to the issue and otherwise resolves the merged PR from the timeline;
  // its `close_*` resolver errors are re-mapped to `completion_*` here.
  const mergeCheck = await assertLinkedPrMerged({ repository, issueNumber, prNumber, assertions });
  if (mergeCheck.earlyReturn) return mergeCheck.earlyReturn;

  // Requirement transitions and traceability edits are now reviewed and merged in the
  // delivery PR (issue #1541, superseding the #963 post-merge mutation ordering). Phase
  // E is validation-only: re-derive scope from the issue, then verify each in-scope
  // requirement AT THE IMMUTABLE MERGE REVISION — never the active checkout or
  // caller-supplied status. A mismatch fails closed before the final report, so the
  // report can never claim a lifecycle state absent from the merged target branch.
  // Requirement-free runs skip this and keep prior behavior. runPostFinalReport still
  // enforces CI green, Sonar pass-or-legit-skipped, the mandatory Codex review, and the
  // sensitive/defer/reserved-marker scrubs.
  const verify = await verifyMergedRequirements({
    repository, issueNumber, mergedPr: mergeCheck.mergedPr, requirements, assertions, workspaceAuthorizationResolver,
  });
  if (verify.earlyReturn) return verify.earlyReturn;
  // Render OBSERVED merged values, not caller-supplied status/title (issue #1541).
  applyObservedMergedRequirements(subInput, verify);
  const delivered = {
    branch: mergeCheck.mergedPr?.headRefName ?? null,
    headSha: mergeCheck.mergedPr?.headRefOid ?? null,
  };
  const derivedLane = await _resolveCompletionLane(
    repository, issueNumber, delivered.branch, lane, assertions, laneReader,
  );
  if (derivedLane.refusal) return derivedLane.refusal;
  const chainRefusal = await _assertDeliveryChain(repository, issueNumber, assertions, delivered, derivedLane.lane);
  if (chainRefusal) return chainRefusal;
  return runPostMergeCompletion({
    subInput, repository, repoPath: authorizedRepoPath, issueNumber, prNumber, assertions, workspaceAuthorizationResolver,
  });
}
