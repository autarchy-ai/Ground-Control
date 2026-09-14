// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { parseCodexReviewPrePushCycleMarkers } from "./api-requirements.js";
import { collectDispositionSignals, effectiveReviewerCap, runDispositionJudge } from "./codex-verify-cap.js";
import { detectSensitiveBodyContent, extractGhErrorMessage, selectDiffMode } from "./grc-legacy-compat-2.js";
import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { getAuthenticatedGitHubLogin, readIssueCommentBodies, readIssueCommentsWithAuthors } from "./grc-legacy-compat-3.js";
import { computeReviewDiff } from "./grc-legacy-compat-4.js";
import { getRepoGroundControlContext } from "./repo-vocabulary-2.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX, rejectReservedMarkerSequence } from "./repo-vocabulary.js";
import { REVIEW_DISPOSITIONS, REVIEW_DISPOSITION_NEXT_ACTION, _emptyReviewDispositionConfigForRunner, _isHighRiskSnapshot, buildReviewAutoDispositionRecord, evaluateAutoDispositionGrant, parseChangedPathsFromManifest, scoreDisposition } from "./review-cap-disposition.js";
import { execFile } from "./runtime-primitives.js";
import { parseTestQualityReviewCycleMarkers } from "./test-quality-runner.js";

export async function runReviewCapDisposition({
  repoPath,
  issueNumber,
  reviewer,
  cycle,
  cap,
  findingsSummary = null,
  baseBranch = null,
  uncommitted = true,
  judgeVerdict = null,
  signal = undefined,
}, { workspaceAuthorizationResolver = undefined } = {}) {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return { ok: false, error: "review_cap_disposition_input_invalid", message: "repo_path is required" };
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { ok: false, error: "review_cap_disposition_input_invalid", message: "issue_number must be a positive integer" };
  }
  if (reviewer !== "codex" && reviewer !== "test-quality") {
    return { ok: false, error: "review_cap_disposition_input_invalid", message: "reviewer must be 'codex' or 'test-quality'" };
  }
  if (!Number.isInteger(cycle) || cycle <= 0) {
    return { ok: false, error: "review_cap_disposition_input_invalid", message: "cycle must be a positive integer" };
  }
  if (!Number.isInteger(cap) || cap <= 0) {
    return { ok: false, error: "review_cap_disposition_input_invalid", message: "cap must be a positive integer" };
  }

  // The disposition record can mint an over-cap grant a later review cycle consumes, so it is
  // written only to the launch workspace's issue thread (issue #1583).
  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    return issueRepositoryNotAuthorized("review_cap_disposition", repository, { issue_number: issueNumber });
  }
  const { repoRoot, owner, name } = repository;

  let config = null;
  let workflow = null;
  try {
    const ctx = await getRepoGroundControlContext(repoRoot);
    workflow = ctx?.workflow ?? null;
    config = workflow?.review_disposition ?? null;
  } catch {
    config = null;
  }
  if (!config || typeof config !== "object") config = _emptyReviewDispositionConfigForRunner();
  if (config.enabled !== true) {
    return { ok: true, skipped: true, disposition: null };
  }
  const maxAuto = Number.isInteger(config.max_auto_overrides) ? config.max_auto_overrides : 1;
  const mode = config.mode === "authoritative" ? "authoritative" : "shadow";
  // Authoritative cap boundary comes from config, not the caller's `cap`.
  const effectiveCap = effectiveReviewerCap(workflow, reviewer);

  const commentBodies = await readIssueCommentBodies(repoRoot, owner, name, issueNumber);
  // Prior over-cap count is derived from DURABLE cycle markers (how many review
  // cycles actually ran beyond the cap), not from the grant-marker count or the
  // caller's `cycle` — so a caller cannot under-report prior overrides.
  const cyclesRun =
    reviewer === "codex"
      ? parseCodexReviewPrePushCycleMarkers(commentBodies, issueNumber)
      : parseTestQualityReviewCycleMarkers(commentBodies, issueNumber);
  // Reject out-of-sequence calls: the disposition is only meaningful once the
  // last in-cap review cycle has actually run. A call before the boundary cannot
  // be allowed to mint an auto-grant.
  if (cyclesRun < effectiveCap) {
    return {
      ok: false,
      error: "disposition_before_cap_boundary",
      message: `review-cap disposition requires the cap boundary to be reached: ${cyclesRun} ${reviewer} cycle(s) have run but the effective cap is ${effectiveCap}`,
      next_action: "run_remaining_in_cap_cycles_first",
      effective_cap: effectiveCap,
      cycles_run: cyclesRun,
    };
  }
  const priorAutoOverrides = Math.max(0, cyclesRun - effectiveCap);

  const diff = await computeReviewDiff(repoRoot, baseBranch ?? "dev", uncommitted);
  const changedPaths = parseChangedPathsFromManifest(diff.manifest);

  const signalsSnapshot = collectDispositionSignals({
    reviewer,
    findingsSummary,
    diffManifest: diff.manifest,
    changedPaths,
    priorAutoOverrides,
    repoRoot,
    // Re-derived here with the same selector the review used, against the
    // post-fix tree. The caller cannot assert it (issue #1414).
    diffMode: selectDiffMode({ diffText: diff.diffText }),
  });

  let scored = scoreDisposition(signalsSnapshot, config);

  // Judge resolution for the gray zone.
  if (scored.decided_by === "judge_needed") {
    if (config.judge?.enabled === true) {
      let verdict = judgeVerdict;
      if (verdict == null) {
        try {
          verdict = await runDispositionJudge({ repoRoot, signalsSnapshot, config, reviewer, issueNumber, cycle, cap, signal });
        } catch {
          verdict = null;
        }
      }
      if (verdict && typeof verdict.disposition === "string" && REVIEW_DISPOSITIONS.includes(verdict.disposition)) {
        scored = {
          disposition: verdict.disposition,
          next_action: REVIEW_DISPOSITION_NEXT_ACTION[verdict.disposition],
          rationale:
            typeof verdict.rationale === "string" && verdict.rationale.trim() !== ""
              ? verdict.rationale
              : scored.rationale,
          decided_by: "judge",
          risk_score: scored.risk_score,
        };
      } else {
        scored = {
          disposition: "escalate_to_human",
          next_action: REVIEW_DISPOSITION_NEXT_ACTION.escalate_to_human,
          rationale: "judge produced no usable verdict; safe default is escalate",
          decided_by: "judge",
          risk_score: scored.risk_score,
        };
      }
    } else {
      scored = {
        ...scored,
        disposition: "escalate_to_human",
        next_action: REVIEW_DISPOSITION_NEXT_ACTION.escalate_to_human,
        decided_by: "judge_needed",
      };
    }
  }

  // Re-clamp the ceiling: a judge can never produce a 2nd over-cap grant.
  let overCapGrantNumber = null;
  if (scored.disposition === "one_more_cycle") {
    if (priorAutoOverrides >= maxAuto) {
      scored = _isHighRiskSnapshot(signalsSnapshot)
        ? {
            disposition: "escalate_to_human",
            next_action: REVIEW_DISPOSITION_NEXT_ACTION.escalate_to_human,
            rationale: "auto-override ceiling reached; escalating to a human",
            decided_by: "ceiling",
            risk_score: scored.risk_score,
          }
        : {
            disposition: "proceed",
            next_action: REVIEW_DISPOSITION_NEXT_ACTION.proceed,
            rationale: "auto-override ceiling reached; residual risk low, proceeding",
            decided_by: "ceiling",
            risk_score: scored.risk_score,
          };
    } else {
      overCapGrantNumber = priorAutoOverrides + 1;
    }
  }

  // Shadow clamp: in shadow mode the disposition is recorded for agreement data
  // but it must NOT drive control flow — a consumer following the envelope's
  // next_action could otherwise advance past the cap stop. Force the returned
  // next_action to escalation. The scored disposition is still recorded in the
  // durable marker (under mode="shadow", which the verifier treats as
  // non-authorizing), so shadow markers can never become consumable grants.
  const returnedNextAction =
    mode === "authoritative" ? scored.next_action : REVIEW_DISPOSITION_NEXT_ACTION.escalate_to_human;

  // Guard caller/model-derived free text before embedding.
  const rmErr = rejectReservedMarkerSequence(scored.rationale, "rationale");
  if (rmErr) {
    return {
      ok: false,
      error: "disposition_record_reserved_marker",
      message: rmErr,
      disposition: scored.disposition,
      next_action: "remove_reserved_marker_prefix_and_retry",
    };
  }

  const body = buildReviewAutoDispositionRecord({
    issueNumber,
    reviewer,
    cycle: cyclesRun,
    cap: effectiveCap,
    mode,
    disposition: scored.disposition,
    rationale: scored.rationale,
    signalsSnapshot,
    grantNumber: overCapGrantNumber,
  });

  const sensitiveError = detectSensitiveBodyContent(body);
  if (sensitiveError) {
    return {
      ok: false,
      error: "disposition_record_body_rejected",
      message: sensitiveError,
      disposition: scored.disposition,
      next_action: "scrub_secrets_and_retry",
    };
  }
  if (Buffer.byteLength(body, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return {
      ok: false,
      error: "disposition_record_body_too_large",
      message: `rendered body is ${Buffer.byteLength(body, "utf8")} bytes; GitHub's issue-comment body cap is ${GITHUB_ISSUE_COMMENT_BODY_MAX} bytes`,
      disposition: scored.disposition,
      next_action: "reduce_record_size_and_retry",
    };
  }

  let apiResponse = null;
  try {
    const { stdout } = await execFile(
      "gh",
      ["api", "--method", "POST", `/repos/${owner}/${name}/issues/${issueNumber}/comments`, "-f", `body=${body}`],
      { cwd: repoRoot },
    );
    try {
      apiResponse = JSON.parse(stdout);
    } catch {
      apiResponse = null;
    }
  } catch (error) {
    // A failed post authorizes nothing: the durable grant record never landed.
    return {
      ok: false,
      error: "disposition_record_post_failed",
      message: extractGhErrorMessage(error),
      disposition: scored.disposition,
      next_action: returnedNextAction,
      mode,
      effective_cap: effectiveCap,
      signals_snapshot: signalsSnapshot,
      over_cap_grant_number: null,
      decision_record_url: null,
    };
  }

  return {
    ok: true,
    disposition: scored.disposition,
    next_action: returnedNextAction,
    mode,
    effective_cap: effectiveCap,
    rationale: scored.rationale,
    decided_by: scored.decided_by,
    risk_score: scored.risk_score,
    signals_snapshot: signalsSnapshot,
    over_cap_grant_number: overCapGrantNumber,
    decision_record_url:
      apiResponse && typeof apiResponse.html_url === "string" ? apiResponse.html_url : null,
  };
}
export async function verifyAutoDispositionGrant(
  { repoPath, issueNumber, reviewer },
  { workspaceAuthorizationResolver = undefined } = {},
) {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return { ok: false, error: "verify_auto_disposition_input_invalid", message: "repo_path is required" };
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { ok: false, error: "verify_auto_disposition_input_invalid", message: "issue_number must be a positive integer" };
  }
  if (reviewer !== "codex" && reviewer !== "test-quality") {
    return { ok: false, error: "verify_auto_disposition_input_invalid", message: "reviewer must be 'codex' or 'test-quality'" };
  }

  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    const refusal = issueRepositoryNotAuthorized("verify_auto_disposition", repository, { issue_number: issueNumber });
    return { ...refusal, authorized: false, reason: refusal.error };
  }
  const { repoRoot, owner, name } = repository;
  let config = null;
  let workflow = null;
  try {
    const ctx = await getRepoGroundControlContext(repoRoot);
    workflow = ctx?.workflow ?? null;
    config = workflow?.review_disposition ?? null;
  } catch {
    config = null;
  }
  // Cheap exits before any GitHub I/O.
  if (config?.enabled !== true) {
    return { ok: true, authorized: false, reason: "review_disposition_disabled" };
  }
  if (config.mode !== "authoritative") {
    return { ok: true, authorized: false, reason: "review_disposition_mode_not_authoritative" };
  }
  // The effective cap boundary is derived from config server-side, never from a
  // caller — the grant must bind to it.
  const effectiveCap = effectiveReviewerCap(workflow, reviewer);

  const trustedLogin = await getAuthenticatedGitHubLogin(repoRoot);
  const authored = await readIssueCommentsWithAuthors(repoRoot, owner, name, issueNumber);
  // Count cycle-run markers from ALL comment bodies (not just trusted): a forged
  // cycle marker can only make the grant look MORE consumed, which fails safe
  // toward denial.
  const allBodies = authored.map((c) => c.body);
  const cyclesRun =
    reviewer === "codex"
      ? parseCodexReviewPrePushCycleMarkers(allBodies, issueNumber)
      : parseTestQualityReviewCycleMarkers(allBodies, issueNumber);

  const decision = evaluateAutoDispositionGrant({ config, trustedLogin, authored, issueNumber, reviewer, cyclesRun, effectiveCap });
  return { ok: true, ...decision };
}
