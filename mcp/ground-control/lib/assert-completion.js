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

async function _assertReviewPublished(repository, issueNumber, assertions) {
  const evidence = await readTrustedReviewPublicationEvidence({
    repoRoot: repository.repoRoot,
    owner: repository.owner,
    name: repository.name,
    issueNumber,
  });
  if (evidence.ok && evidence.published) {
    assertions.push({ name: "codex_review_published", ok: true, comment_id: evidence.comment_id });
    return null;
  }
  return {
    ok: false,
    error: evidence.error ?? "completion_review_publication_missing",
    message: evidence.message ?? "A trusted published Codex decision record is required before readiness or completion.",
    issue_number: issueNumber,
    assertions,
    final_report: null,
    next_action: "publish_the_retained_review_or_run_the_automatic_review_cycle",
  };
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

async function runPreMergeCompletion({ subInput, repository, issueNumber, prNumber, assertions, workspaceAuthorizationResolver }) {
  if (subInput.ciStatus !== "green") {
    return { ok: false, error: "final_report_ci_not_green", assertions, final_report: null };
  }
  const repoPath = repository.repoRoot;
  const hosted = await readRemoteGateSnapshot({ repoPath, prNumber }, { workspaceAuthorizationResolver });
  if (!hosted.ok || !hosted.passed || hosted.state !== "OPEN") {
    return { ok: false, error: "completion_hosted_checks_not_green", hosted,
      next_action: "repair_or_wait_for_current_head_hosted_checks", assertions, final_report: null };
  }
  if (subInput.lane !== "quickfix") {
    const reviewRefusal = await _assertReviewPublished(repository, issueNumber, assertions);
    if (reviewRefusal) return reviewRefusal;
  }
  return _runPreMergeReadiness({
    subInput, repoPath, issueNumber, prNumber, headSha: hosted.head_sha, assertions, workspaceAuthorizationResolver,
  });
}

export async function runAssertCompletion(input, { workspaceAuthorizationResolver = undefined } = {}) {
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
    return runPreMergeCompletion({ subInput, repository, issueNumber, prNumber, assertions, workspaceAuthorizationResolver });
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
  if (lane !== "quickfix") {
    const reviewRefusal = await _assertReviewPublished(repository, issueNumber, assertions);
    if (reviewRefusal) return reviewRefusal;
  }
  return runPostMergeCompletion({
    subInput, repository, repoPath: authorizedRepoPath, issueNumber, prNumber, assertions, workspaceAuthorizationResolver,
  });
}
