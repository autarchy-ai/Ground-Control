// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { buildReviewCoverage, buildReviewCoverageIncompleteEnvelope, dedupFindings, getDefaultCodexReviewParallel } from "./api-controls.js";
import { CODEX_REVIEW_PREPUSH_HARD_CAP, deriveIssueNumberFromBranch, evaluateCodexReviewPrePushCycleCap } from "./api-requirements.js";
import { postCodexReviewCycleMarker, readPriorCodexReviewCycleCount } from "./close-issue.js";
import { buildCodexReviewFindingsComments, buildReviewCommentPostFailedEnvelope, collectPostFailures, mergeReviewerArchitecturalReads, renderReviewerEnvelope } from "./codex-review.js";
import { buildReviewerCommentsList, postCodexReviewFindingsComment, postCodexReviewPrePushCycleMarker, readPriorCodexReviewPrePushCycleCount, resolveFindingsRecordIssueNumber } from "./codex-verify-cap.js";
import { resolveReviewerPrePushCap } from "./codex-workflow-5.js";
import { detectSensitiveBodyContent, planReviewSlices, selectDiffMode } from "./grc-legacy-compat-2.js";
import { getOwnerRepo, getPullRequestClosingIssues, postCodexReviewFindings } from "./grc-legacy-compat-3.js";
import { autoDetectPrNumber, computeReviewDiff, ensureGitRepo, getCurrentBranchName, readCompletedPhases } from "./grc-legacy-compat-4.js";
import { buildCodexReviewCorePrompt, buildCodexSecurityReviewPrompt } from "./grc-legacy-compat-5.js";
import { runReviewerOverSlices } from "./grc-legacy-compat-6.js";
import { readVocabularyForReview } from "./plan-posting.js";
import { evaluateCodexReviewCycleCap } from "./repo-context-2.js";
import { enforcePostPushReviewGate, enforcePrePushReviewCap } from "./codex-review-cap.js";
import { buildStationVerdictMarker } from "./execution-obligation-v2.js";
import { guardStationReobservation } from "./station-observation-records.js";

export async function runCodexReview({
  repoPath,
  baseBranch = "dev",
  uncommitted = false,
  prNumber = null,
  issueNumber = null,
  overrideCap = false,
  overrideReason = null,
  overridePhaseGate = false,
  overridePhaseReason = null,
  signal = undefined,
  // Open station-observation obligations for this station, from this invocation's earlier
  // non-verdict attempts or recovered from the durable ledger (issues #1476, #1578).
  stationObservations = [],
}) {
  const repoRoot = await ensureGitRepo(repoPath);

  let effectivePr = prNumber;
  if (effectivePr == null && !uncommitted) {
    effectivePr = await autoDetectPrNumber(repoRoot);
  }

  // Hard-cap enforcement: post-push reviews use the (PR) marker family
  // (issue #794 MVP-1, cap = CODEX_REVIEW_HARD_CAP); pre-push uncommitted
  // reviews use the per-issue marker family (issue #796 / ADR-029, cap =
  // CODEX_REVIEW_PREPUSH_HARD_CAP). The pre-push key is the issue alone — the
  // branch is recorded in the marker for audit context only, never as part of
  // the cap key. Plan-before-review ordering applies to post-push only.
  let cycleOwnership = null;
  let prePushOwnership = null;

  if (uncommitted) {
    const gate = await enforcePrePushReviewCap({
      repoRoot,
      baseBranch,
      uncommitted,
      issueNumber,
      overrideCap,
      overrideReason,
    });
    if (gate.refusal) return gate.refusal;
    prePushOwnership = gate.ownership;
  }

  if (!uncommitted && effectivePr != null) {
    const gate = await enforcePostPushReviewGate({
      repoRoot,
      baseBranch,
      uncommitted,
      effectivePr,
      overrideCap,
      overrideReason,
      overridePhaseGate,
      overridePhaseReason,
    });
    if (gate.refusal) return gate.refusal;
    cycleOwnership = gate.ownership;
  }

  // Compute the diff once and reuse it across both reviewers.
  const { diffText, manifest, baseRefDescriptor, unreviewedUntrackedPaths, trackedSymlinks } = await computeReviewDiff(
    repoRoot,
    baseBranch,
    uncommitted,
  );
  const diffMode = selectDiffMode({ diffText });

  // Read the repo's architecture.vocabulary (issue #931). Sourced from a
  // trusted base ref when the PR's diff modifies .ground-control.yaml so the
  // PR cannot rewrite its own review rules (codex cycle-1 security finding F3).
  // Best-effort: null vocabulary falls through to workflow-level defaults.
  const vocabulary = await readVocabularyForReview(repoRoot, baseBranch);

  // Plan how the authoritative diff reaches the reviewers. Inline mode yields
  // exactly one slice and the prompts are byte-identical to before; manifest
  // mode yields the bounded slices the server supplies itself instead of asking
  // the reviewer to fetch per-file diffs (issue #1414).
  const slicePlan = planReviewSlices({ diffText });
  const promptArgs = {
    baseBranch,
    uncommitted,
    diffMode,
    diffManifest: manifest,
    baseRefDescriptor,
    vocabulary,
    trackedSymlinks,
  };

  // Parse each reviewer's tail independently. A malformed payload from one
  // reviewer must not lose the other reviewer's findings (per #793 the
  // durable thread is the source of truth — silently dropping findings was
  // exactly the failure mode this ADR fix is closing). Per-reviewer parse
  // errors surface in the response under `parse_errors`.
  const parseErrors = [];
  const runReviewer = (reviewerLabel, buildPrompt) =>
    runReviewerOverSlices({
      repoRoot,
      reviewerLabel,
      buildPrompt,
      promptArgs,
      slicePlan,
      parseErrors,
      signal,
    });

  // runReviewerOverSlices converts a slice engine failure into an incomplete
  // reviewer result rather than throwing, so a dead codex child lands on the
  // structured coverage-failure path below instead of escaping as an untyped
  // exception (issue #1414 codex cycle 1, F2).
  let core;
  let security;
  if (getDefaultCodexReviewParallel() === 2) {
    [core, security] = await Promise.all([
      runReviewer("core", buildCodexReviewCorePrompt),
      runReviewer("security", buildCodexSecurityReviewPrompt),
    ]);
  } else {
    core = await runReviewer("core", buildCodexReviewCorePrompt);
    security = await runReviewer("security", buildCodexSecurityReviewPrompt);
  }

  // Coverage is a server-side fact derived from the slice plan, never a
  // reviewer claim. Both reviewers must have returned a valid envelope for
  // every slice before any finding, decision record, or cycle marker is
  // written — otherwise part of the diff went unreviewed and a clean signal
  // would be the exact #1414 failure this fix removes.
  const reviewCoverage = buildReviewCoverage({
    slicePlan,
    reviewerResults: [core, security],
    unreviewedUntrackedPaths,
  });
  if (!reviewCoverage.complete) {
    return buildReviewCoverageIncompleteEnvelope({
      repoRoot,
      baseBranch,
      uncommitted,
      effectivePr,
      prePushOwnership,
      diffMode,
      reviewCoverage,
      parseErrors,
      core,
      security,
    });
  }

  // Resolve owner/name once if any posting could happen. The pre-push and
  // gate paths above also resolved owner/name; cycleOwnership/prePushOwnership
  // already carry them, so we reuse them when available to avoid a second
  // `gh repo view` round-trip.
  let owner = cycleOwnership?.owner ?? prePushOwnership?.owner ?? null;
  let name = cycleOwnership?.name ?? prePushOwnership?.name ?? null;
  const willPost =
    effectivePr != null && (core.findings.length > 0 || security.findings.length > 0);
  if (willPost && (owner == null || name == null)) {
    ({ owner, name } = await getOwnerRepo(repoRoot));
  }

  // Server-side post each reviewer's findings. The poster never throws on a
  // per-finding POST failure — partial-write conditions surface in the
  // response under `post_failures` so callers can act on them (per ADR-027
  // Privileged Side-Effect Boundary).
  const corePostResults = await postCodexReviewFindings({
    repoRoot,
    owner,
    name,
    prNumber: effectivePr,
    reviewerLabel: "core",
    findings: core.findings,
  });
  const securityPostResults = await postCodexReviewFindings({
    repoRoot,
    owner,
    name,
    prNumber: effectivePr,
    reviewerLabel: "security",
    findings: security.findings,
  });

  const postFailures = collectPostFailures([
    { reviewer: "core", results: corePostResults },
    { reviewer: "security", results: securityPostResults },
  ]);

  // Build the agent-facing comments list from the SUCCESSFUL POSTs. Codex's
  // findings without a corresponding GitHub comment id (no PR, or the POST
  // failed) are still surfaced, but with comment_id=null — the post_failures
  // array carries the per-finding error envelope.
  const coreComments = await buildReviewerCommentsList({
    repoRoot,
    owner,
    name,
    prNumber: effectivePr,
    postResults: corePostResults,
    findings: core.findings,
    reviewer: "core",
  });
  const securityComments = await buildReviewerCommentsList({
    repoRoot,
    owner,
    name,
    prNumber: effectivePr,
    postResults: securityPostResults,
    findings: security.findings,
    reviewer: "security",
  });

  const comments = dedupFindings([...coreComments, ...securityComments]);

  // Compute partialFailure here (used to shape the final response). A run
  // with parse_errors or post_failures is NOT a completed review — the
  // response carries ok=false so the agent doesn't treat it as durable.
  const partialFailure = parseErrors.length > 0 || postFailures.length > 0;
  // The cycle marker is a different question: it gates retries against the
  // hard-cap budget. Suppress it ONLY when no comments landed on the PR
  // (so a retry doesn't double-spend a cycle that produced nothing). When
  // any post succeeded, the comments are durable and a retry would
  // duplicate them on the PR thread — treat the cycle as consumed (closes
  // a gap flagged in #793 post-push review cycle 2).
  const successfulPostCount =
    corePostResults.filter((r) => r.ok).length +
    securityPostResults.filter((r) => r.ok).length;
  const cycleConsumed = successfulPostCount > 0 || !partialFailure;

  const cycleSource = cycleOwnership ?? prePushOwnership ?? null;

  // Issue #804 (and #804 review-cycle-1 finding 1): the durable findings
  // record is posted BEFORE the cycle marker. If the record fails, no
  // cycle is consumed — a retry is free. If the record succeeds, the
  // cycle marker write follows; a marker-write failure for post-push is
  // non-fatal (warning), but for pre-push the marker IS the cap surface
  // and a failure must surface so the cap is honored.
  //
  // Skip the record when the cycle wasn't consumed (no comments landed)
  // or when no issue thread is resolvable (post-push PR closes no issues
  // — same convention as the plan-gate's "PRs closing no issues skip the
  // gate"). In the skip case, proceed straight to the cycle-marker write
  // because there is no record to wait for.
  let findingsCommentUrl = null;
  let recordIssueNumber = null;
  // One shape for every "the durable record did not land" exit below. Each of them means the same
  // thing — no cycle marker was written, so the cap is untouched and re-running is safe.
  const postFailed = (message, postError) => buildReviewCommentPostFailedEnvelope({
    repoRoot, baseBranch, uncommitted, effectivePr, prePushOwnership, recordIssueNumber,
    message, postError, cycleSource, comments, postFailures, parseErrors, core, security,
  });
  if (cycleConsumed && cycleSource != null) {
    recordIssueNumber = await resolveFindingsRecordIssueNumber({
      repoRoot,
      uncommitted,
      effectivePr,
      prePushOwnership,
    });
    if (recordIssueNumber != null) {
      const findingsBodies = buildCodexReviewFindingsComments({
        cycleNumber: cycleSource.cycleNumber,
        cap: cycleSource.cap,
        mode: uncommitted ? "pre-push" : "post-push",
        issueNumber: recordIssueNumber,
        prNumber: uncommitted ? null : effectivePr,
        branch: prePushOwnership ? prePushOwnership.branchName : null,
        coreReviewText: renderReviewerEnvelope(core),
        securityReviewText: renderReviewerEnvelope(security),
        postedComments: comments,
        diffMode,
        reviewCoverage,
        // Only a complete pre-push verdict is observation evidence for the station ledger.
        stationVerdictMarker: uncommitted
          ? buildStationVerdictMarker({
            issueNumber: recordIssueNumber,
            stationId: "codex_review",
            logicalCycle: cycleSource.cycleNumber,
          })
          : null,
      });
      // #804 review-cycle-1 finding 2: route the rendered body through the
      // same sensitive-content filter the inline poster uses, so reviewer-
      // controlled prose can't exfiltrate workspace contents under the host
      // identity. Reject before we POST. Filter every body — secret content
      // could land in any continuation chunk, not just the primary.
      for (const body of findingsBodies) {
        const sensitiveError = detectSensitiveBodyContent(body);
        if (sensitiveError) {
          return postFailed(
            `gc_codex_review refused to post the findings record to issue #${recordIssueNumber}: ` +
            `${sensitiveError}. The reviewer text would have published model-controlled content ` +
            `that matched the host-side guardrail; no cycle marker has been written, so a retry ` +
            `is safe once codex emits a clean review.`,
            sensitiveError,
          );
        }
      }
      // Post all bodies in order: the primary first, then continuations.
      // findings_comment_url surfaces the primary URL — continuations
      // are reachable via the issue thread.
      try {
        for (let i = 0; i < findingsBodies.length; i++) {
          const apiResponse = await postCodexReviewFindingsComment({
            repoRoot,
            owner: cycleSource.owner,
            name: cycleSource.name,
            issueNumber: recordIssueNumber,
            body: findingsBodies[i],
          });
          if (i === 0) {
            findingsCommentUrl = apiResponse?.html_url ?? null;
          }
        }
      } catch (postError) {
        return postFailed(
          `gc_codex_review ran successfully but failed to post the findings record to issue ` +
          `#${recordIssueNumber}: ${postError.message}. The issue thread is the durable record ` +
          `per ADR-029; no cycle marker has been written so a retry is safe. Fix the underlying ` +
          `GitHub issue (network, gh auth, repo permissions) and retry.`,
          postError.message,
        );
      }
    }
  }

  // Re-observation resolution, bound to the record just posted, BEFORE the cap marker (#1476).
  const failedReobservation = await guardStationReobservation({
    stationObservations: uncommitted ? stationObservations : [],
    observedCycle: cycleSource?.cycleNumber, findingsCommentUrl, repoRoot,
    issueNumber: recordIssueNumber, owner: cycleSource?.owner, name: cycleSource?.name,
    buildFailure: postFailed,
  });
  if (failedReobservation) return failedReobservation;

  // Findings record landed (or was skipped). Now write the cycle marker so
  // the next invocation honors the hard cap. Marker-post failures are
  // non-fatal for post-push (the durable record is on the issue thread; an
  // off-by-one cap is recoverable). For pre-push the marker IS the cap
  // surface and a failure surfaces as prepush_cycle_record_failed.
  if (cycleOwnership != null && cycleConsumed) {
    try {
      await postCodexReviewCycleMarker(
        repoRoot,
        cycleOwnership.owner,
        cycleOwnership.name,
        cycleOwnership.prNumber,
        cycleOwnership.cycleNumber,
        { override: cycleOwnership.override, overrideReason: cycleOwnership.overrideReason },
      );
    } catch (markerError) {
      // Surface as warning text; do not throw.
      // eslint-disable-next-line no-console
      console.error(
        `[gc_codex_review] cycle marker post failed for PR #${cycleOwnership.prNumber}: ${markerError.message}`,
      );
    }
  }

  if (prePushOwnership != null && cycleConsumed) {
    try {
      await postCodexReviewPrePushCycleMarker(
        repoRoot,
        prePushOwnership.owner,
        prePushOwnership.name,
        prePushOwnership.issueNumber,
        prePushOwnership.branchName,
        prePushOwnership.cycleNumber,
        {
          override: prePushOwnership.override,
          overrideReason: prePushOwnership.overrideReason,
          hardCap: prePushOwnership.hardCap,
        },
      );
    } catch (markerError) {
      return {
        repo_path: repoRoot,
        base_branch: baseBranch,
        uncommitted,
        pr_number: null,
        issue_number: prePushOwnership.issueNumber,
        branch: prePushOwnership.branchName,
        ok: false,
        error: "prepush_cycle_record_failed",
        message:
          `gc_codex_review (uncommitted=true) ran successfully but failed to record the pre-push ` +
          `cycle marker on issue #${prePushOwnership.issueNumber} (branch ` +
          `'${prePushOwnership.branchName}'): ${markerError.message}. The cap is not durable for ` +
          `this run; do not treat as a completed cycle. Findings (if any) are returned below for ` +
          `review, but the workflow must not proceed past Step 6.5 until a successful run records ` +
          `the marker. Retry once the underlying issue (network, gh auth, repo permissions) is ` +
          `resolved.`,
        next_action: "fix_underlying_marker_post_failure_and_retry",
        cycle_record_error: markerError.message,
        attempted_cycle: prePushOwnership.cycleNumber,
        cap: prePushOwnership.cap,
        diff_mode: diffMode,
        review_coverage: reviewCoverage,
        finding_count: comments.length,
        comments,
        post_failures: postFailures,
        parse_errors: parseErrors,
        core_review_text: core.body,
        security_review_text: security.body,
        reviewers: [
          { name: "core", finding_count: core.findings.length },
          { name: "security", finding_count: security.findings.length },
        ],
      };
    }
  }

  // When the cycle returned 0 findings AND no reviewer's tail failed to
  // parse AND every POST landed, the cap-evaluator's pre-run next_action
  // ("fix_all_findings_..." / "fix_all_findings_then_summarize_...") is
  // misleading — there is nothing to fix. Override to a clean signal so the
  // caller proceeds (and so cycle 2 doesn't carry the cycle-2 escalation cue
  // when there are no findings to summarize). Refusal envelopes (returned
  // earlier with their own next_action) and override-cycle metadata are
  // unaffected.
  //
  // Parse failures and post failures are explicitly NOT treated as "clean":
  // a malformed reviewer payload or a failed-to-land comment is a partial
  // failure of the review tool itself — the run is not durable, no cycle
  // marker is written above, and the cycle/cap fields read null so the
  // agent treats the run as incomplete (closes gaps flagged in #793 review
  // cycles 1, 2, and 3).
  let effectiveNextAction = cycleSource ? cycleSource.nextAction : null;
  if (partialFailure) {
    effectiveNextAction = "address_parse_or_post_failures";
  } else if (cycleSource != null && comments.length === 0) {
    effectiveNextAction = "proceed_clean";
  }
  return {
    repo_path: repoRoot,
    base_branch: baseBranch,
    uncommitted,
    pr_number: effectivePr,
    issue_number: prePushOwnership ? prePushOwnership.issueNumber : null,
    branch: prePushOwnership ? prePushOwnership.branchName : null,
    ok: !partialFailure,
    error: partialFailure ? "review_partial_failure" : undefined,
    // Transport (did the complete diff fit one prompt?) and coverage (how much
    // of it was actually reviewed) are reported separately — a manifest is
    // routing metadata, never review evidence (issue #1414).
    diff_mode: diffMode,
    review_coverage: reviewCoverage,
    finding_count: comments.length,
    comments,
    // architectural_read merges both reviewers' reads for the decision record
    // (issue #966). `verdict` is intentionally NOT surfaced for the cycle
    // wrapper: the decision-record consistency validator keys structural
    // blocking on `classification === "class"` only, so a codex `don't-ship`
    // justified by a one-off structural_blocker would fail validation. The
    // findings list already conveys the outcome.
    architectural_read: mergeReviewerArchitecturalReads(core, security),
    post_failures: postFailures,
    parse_errors: parseErrors,
    core_review_text: core.body,
    security_review_text: security.body,
    reviewers: [
      { name: "core", finding_count: core.findings.length },
      { name: "security", finding_count: security.findings.length },
    ],
    // Cycle is consumed iff at least one comment landed on the PR or there
    // were no failures at all (see cycleConsumed above). When suppressed,
    // surface cycle/cap as null so the agent doesn't act on a counter
    // that wasn't incremented.
    cycle: cycleConsumed && cycleSource ? cycleSource.cycleNumber : null,
    cap: cycleConsumed && cycleSource ? cycleSource.cap : null,
    next_action: effectiveNextAction,
    override: cycleSource && cycleSource.override === true ? true : false,
    override_reason: cycleSource ? cycleSource.overrideReason : null,
    findings_comment_url: findingsCommentUrl,
  };
}
