// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { readTrustedMergeStateOverride, resolvePrForClose } from "./close-issue.js";
import { extractInScopeRequirementUids } from "./issue-requirements-scope.js";
import { runPostFinalReport } from "./doc-coverage-2.js";
import { readTrustedExecutionObligationState } from "./grc-legacy-compat-4.js";
import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { runGetIssueThread } from "./issue-thread.js";
import { findRecoverableStationObservations } from "./station-observation-reconcile.js";
import { verifyMergedRequirementState } from "./merged-requirement-state.js";
import { validateFinalReportInput } from "./plan-posting.js";
import { execFile } from "./runtime-primitives.js";

const FULL_GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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

// Phase D terminal (phase="pre_merge"): post the readiness record and return its
// envelope. Extracted from runAssertCompletion (length cap).
async function _runPreMergeReadiness({ subInput, repoPath, issueNumber, prNumber, assertions, workspaceAuthorizationResolver }) {
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
    assertions,
    readiness_report: {
      comment_url: readiness.comment_url,
      comment_id: readiness.comment_id,
    },
    final_report: null,
  };
}

// Phase E merge gate: resolve the linked PR and refuse unless it is merged.
// Returns `{ ok: true }` when merged, or `{ earlyReturn }` with the caller's exact
// envelope. Extracted from runAssertCompletion (length cap).
async function _assertLinkedPrMerged({ repository, issueNumber, prNumber, assertions }) {
  const resolvedPr = await resolvePrForClose({
    repoRoot: repository.repoRoot,
    owner: repository.owner,
    name: repository.name,
    issueNumber,
    prNumber,
  });
  if (resolvedPr.earlyReturn) {
    return {
      earlyReturn: {
        ok: false,
        error: String(resolvedPr.earlyReturn.error).replace(/^close_/, "completion_"),
        message: resolvedPr.earlyReturn.message,
        issue_number: issueNumber,
        assertions,
        final_report: null,
        next_action: resolvedPr.earlyReturn.next_action ?? null,
      },
    };
  }
  const mergedPr = resolvedPr.pr;
  if (!mergedPr?.mergedAt || mergedPr.state !== "MERGED") {
    return {
      earlyReturn: {
        ok: false,
        error: "completion_pr_not_merged",
        message:
          `gc_assert_completion refuses to post the reconciled completion record for issue #${issueNumber}: ` +
          `linked PR #${mergedPr?.number ?? "?"} state=${mergedPr?.state ?? "unknown"}, merged_at=${mergedPr?.mergedAt ?? "null"}. ` +
          `The Phase E completion gate requires merged_at non-null AND state='MERGED'.`,
        issue_number: issueNumber,
        pr_state: mergedPr?.state ?? null,
        pr_merged_at: mergedPr?.mergedAt ?? null,
        assertions,
        final_report: null,
        next_action: "wait_for_user_to_merge_the_pr",
      },
    };
  }
  // Carry the resolved PR (incl. mergeCommit.oid + baseRefName) so the post-merge
  // requirement-state verification can read the immutable merged tree (issue #1541).
  return { ok: true, mergedPr };
}

// Ensure the merge revision's commit object is present locally so `git show <oid>:…`
// can read the immutable tree. Right after the user merges on GitHub, the invocation
// checkout does not yet have the merge commit; fetch the base ref (the merge commit is
// reachable from its tip) — and, as a fallback, the commit id directly. Best-effort:
// an unreachable/offline origin leaves the object absent and the caller fails closed.
async function _ensureRevisionPresent(repoRoot, oid, baseRef) {
  const present = async () => {
    try {
      await execFile("git", ["cat-file", "-e", `${oid}^{commit}`], { cwd: repoRoot });
      return true;
    } catch {
      return false;
    }
  };
  if (await present()) return true;
  if (typeof baseRef === "string" && baseRef.trim() !== "") {
    try {
      await execFile("git", ["fetch", "origin", baseRef], { cwd: repoRoot });
    } catch { /* origin unreachable/offline — fail closed below */ }
    if (await present()) return true;
  }
  try {
    await execFile("git", ["fetch", "origin", oid], { cwd: repoRoot });
  } catch { /* server may disallow fetching an arbitrary sha */ }
  return present();
}

// Resolve the trusted merge-state override for this PR. Authority is a repo-write
// human's issue-thread comment, never a caller DTO field (issue #1541 security review);
// the comment is itself the durable record of the bypass.
async function _resolveMergeStateOverride({ repoRoot, owner, name }, issueNumber, mergedPr) {
  const prNumber = mergedPr?.number ?? null;
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { authorized: false, reason: null };
  try {
    return await readTrustedMergeStateOverride(repoRoot, owner, name, issueNumber, prNumber);
  } catch {
    return { authorized: false, reason: null };
  }
}

// Phase E requirement-state verification (issue #1541). Re-derives the in-scope UID
// set from the issue thread (caller `requirements[]` is an expectation, not authority),
// requires an exact match, then validates each requirement at the immutable merge
// revision. Returns `{ ok, skip?, observed?, revision?, overridden?, reason? }` on
// success or `{ earlyReturn }` with the caller's exact refusal envelope. The only
// bypass is a trusted issue-thread override authorization (see _resolveMergeStateOverride).
async function _verifyMergedRequirements({ repository, issueNumber, mergedPr, requirements, assertions, workspaceAuthorizationResolver }) {
  const thread = await runGetIssueThread({ repoPath: repository.repoRoot, issueNumber }, { workspaceAuthorizationResolver });
  if (!thread.ok) {
    return { earlyReturn: {
      ok: false, error: "completion_issue_thread_unavailable",
      message: thread.message ?? "could not read the issue thread to derive in-scope requirements",
      issue_number: issueNumber, assertions, final_report: null,
      next_action: "repair_issue_access_and_retry",
    } };
  }
  const inScope = extractInScopeRequirementUids(thread.body ?? "");
  const callerUids = (requirements ?? []).map((r) => r.uid);
  // Genuine requirement-free run only when BOTH the issue's Requirements section AND
  // the caller carry no UIDs. An empty DERIVED scope must never bypass a non-empty
  // caller scope: otherwise editing the issue body to drop its Requirements section
  // would downgrade a requirement-backed delivery to verification-free (issue #1541
  // security review). Any disagreement falls through to the exact-match refusal.
  if (inScope.length === 0 && callerUids.length === 0) {
    return { ok: true, skip: true };
  }
  const derived = new Set(inScope);
  const caller = new Set(callerUids);
  const missingFromCaller = inScope.filter((u) => !caller.has(u));
  const notInScope = callerUids.filter((u) => !derived.has(u));
  if (missingFromCaller.length > 0 || notInScope.length > 0 || callerUids.length !== caller.size) {
    return { earlyReturn: {
      ok: false, error: "completion_scope_mismatch",
      message:
        "caller requirements[] must exactly match the issue's in-scope UID set; " +
        `missing_from_caller=${JSON.stringify(missingFromCaller)} not_in_scope=${JSON.stringify(notInScope)}`,
      issue_number: issueNumber, missing_from_caller: missingFromCaller, not_in_scope: notInScope,
      assertions, final_report: null, next_action: "align_requirements_with_issue_scope_and_retry",
    } };
  }
  const oid = mergedPr?.mergeCommit?.oid ?? null;
  const { repoRoot } = repository;
  const revisionUsable =
    typeof oid === "string" && FULL_GIT_OID_RE.test(oid) &&
    (await _ensureRevisionPresent(repoRoot, oid, mergedPr?.baseRefName));
  if (!revisionUsable) {
    const override = await _resolveMergeStateOverride(repository, issueNumber, mergedPr);
    if (override.authorized) return { ok: true, overridden: true, reason: override.reason };
    return { earlyReturn: {
      ok: false, error: "completion_merge_revision_unavailable",
      message:
        `could not resolve or fetch the linked PR's immutable merge revision for issue #${issueNumber}; ` +
        "requirement state cannot be validated against the merged tree",
      issue_number: issueNumber, assertions, final_report: null,
      next_action: "ensure_the_pr_merge_commit_is_fetchable_or_post_a_trusted_override",
    } };
  }
  const expectations = requirements.map((r) => ({ uid: r.uid, statusIntent: r.status ?? r.statusIntent ?? "ACTIVE" }));
  const verification = await verifyMergedRequirementState({ repoRoot, revision: oid, expectations });
  if (!verification.ok) {
    const override = await _resolveMergeStateOverride(repository, issueNumber, mergedPr);
    if (override.authorized) return { ok: true, overridden: true, revision: oid, reason: override.reason };
    return { earlyReturn: {
      ok: false, error: "completion_requirement_state_unverified",
      message:
        `merged requirement state at ${oid} does not match the reported state for issue #${issueNumber}; ` +
        "fix the requirement files in the delivery PR and re-merge, or post a trusted override authorization",
      issue_number: issueNumber, revision: oid, requirement_failures: verification.failures,
      assertions, final_report: null,
      next_action: "align_requirement_files_in_the_pr_and_remerge_or_post_a_trusted_override",
    } };
  }
  return { ok: true, revision: oid, observed: verification.results };
}

// Phase E post-merge completion: post the final report and return its envelope.
// Extracted from runAssertCompletion (length cap).
async function _runPostMergeCompletion({ subInput, repoPath, issueNumber, prNumber, assertions, workspaceAuthorizationResolver }) {
  const report = await runPostFinalReport({
    ...subInput,
    repoPath,
    issueNumber,
    prNumber,
  }, { workspaceAuthorizationResolver });
  if (!report.ok) {
    return {
      ok: false,
      error: report.error,
      message: report.message,
      issue_number: issueNumber,
      assertions,
      final_report: null,
      next_action: report.next_action ?? null,
    };
  }
  return {
    ok: true,
    repo_path: report.repo_path,
    issue_number: issueNumber,
    pr_number: prNumber,
    assertions,
    final_report: {
      comment_url: report.comment_url,
      comment_id: report.comment_id,
    },
  };
}

export async function runAssertCompletion(input, { workspaceAuthorizationResolver = undefined } = {}) {
  const {
    repoPath,
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
    phase = "post_merge",
  } = input;

  const assertions = [];

  // Fail-fast: validate the final-report sub-input BEFORE any side effects.
  const subInput = {
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
    lane: "implement",
  };
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
  // record only. The requirement-status transition and traceability
  // reconciliation have NOT run yet — they are Phase E work that lands after the
  // PR merges — so this path skips that assertion and posts no `gc:final-report`
  // marker. Every input gate (CI green, Sonar pass/legit-skip, codex review
  // present, sensitive/reserved/defer scrubs) still runs inside runPostFinalReport.
  // Traceability reconciliation is deliberately NOT asserted here — it depends
  // on the post-merge DRAFT→ACTIVE transition and is verified by the
  // phase="post_merge" completion.
  if (phase === "pre_merge") {
    return _runPreMergeReadiness({
      subInput, repoPath: authorizedRepoPath, issueNumber, prNumber, assertions, workspaceAuthorizationResolver,
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
  const mergeCheck = await _assertLinkedPrMerged({ repository, issueNumber, prNumber, assertions });
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
  const verify = await _verifyMergedRequirements({
    repository, issueNumber, mergedPr: mergeCheck.mergedPr, requirements, assertions, workspaceAuthorizationResolver,
  });
  if (verify.earlyReturn) return verify.earlyReturn;
  // Render OBSERVED merged values, not caller-supplied status/title (issue #1541).
  if (verify.ok && !verify.skip && Array.isArray(verify.observed)) {
    const observedByUid = new Map(verify.observed.map((o) => [o.uid, o]));
    subInput.requirements = subInput.requirements.map((r) => {
      const observed = observedByUid.get(r.uid);
      return observed
        ? { ...r, title: observed.observed_title ?? r.title, status: observed.observed_status ?? r.status }
        : r;
    });
  }
  subInput.mergeRevision = verify.revision ?? null;
  // The override reason is the trusted authorization comment itself, so recording it in
  // the final report keeps the durable record self-consistent.
  if (verify.overridden) subInput.requirementStateOverrideReason = verify.reason;
  return _runPostMergeCompletion({
    subInput, repoPath: authorizedRepoPath, issueNumber, prNumber, assertions, workspaceAuthorizationResolver,
  });
}
