// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { deriveIssueNumberFromBranch } from "./api-requirements.js";
import { TEST_QUALITY_REVIEW_DEFAULT_MODEL } from "./ci-watcher.js";
import { resolveReviewerPrePushCap, runSingleClaudeTestQualityReview } from "./codex-workflow-5.js";
import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { getCurrentBranchName } from "./grc-legacy-compat-4.js";
import { readVocabularyForReview } from "./plan-posting.js";
import { getRepoGroundControlContext } from "./repo-vocabulary-2.js";
import { rejectReservedMarkerSequence } from "./repo-vocabulary.js";
import { REVIEW_ENGINE_AUTH_MISSING } from "./runtime-primitives.js";
import { buildTestQualityReviewPrompt, parseTestQualityReviewFindings } from "./test-quality-prompt.js";
import { ReviewerCapConfigError, TEST_QUALITY_REVIEW_HARD_CAP, buildTestQualityReviewFindingsComment, evaluateTestQualityReviewCycleCap, findChangedTestFiles, postFindingsRecordAndCycleMarker, readPriorTestQualityReviewCycleCount } from "./test-quality-runner.js";

/**
 * Split a `claude` invocation failure into the two things it can be.
 *
 * Undeclared review-engine auth is a provisioning fault the operator repairs in
 * the launch directory's `.env`; it gets a code lib/review-reattempt.js does not
 * classify as a free non-verdict retry, because re-running it cannot change the
 * outcome (issue #1562). Everything else keeps the engine-failure code and its
 * one free retry.
 */
export function testQualityReviewEngineFailure(err) {
  if (err?.code === REVIEW_ENGINE_AUTH_MISSING) {
    return {
      error: "test_quality_review_auth_missing",
      message: err.message,
      next_action: "provision_review_engine_auth_in_launch_root_env",
    };
  }
  return {
    error: "test_quality_review_engine_failed",
    message: `claude CLI invocation failed: ${err.message}`,
    next_action: "fix_engine_issue_and_retry",
  };
}

export async function runTestQualityReview({
  repoPath,
  baseBranch = null,
  issueNumber = null,
  prNumber = null,
  overrideCap = false,
  overrideReason = null,
  model = TEST_QUALITY_REVIEW_DEFAULT_MODEL,
  signal = undefined,
  // Pending station-observation obligation from an earlier non-verdict attempt at this same
  // logical cycle (issue #1476). Forwarded to the durable writer so the resolution lands between
  // the findings record and the cycle marker.
  stationObservation = null,
}, { workspaceAuthorizationResolver = undefined } = {}) {
  // The findings record and cycle marker are gate inputs, so they are written only to the launch
  // workspace's issue thread; a caller-named checkout is refused first (issue #1583).
  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    return issueRepositoryNotAuthorized("test_quality_review", repository, {
      issue_number: issueNumber ?? null,
      finding_count: 0,
      findings: [],
    });
  }
  const { repoRoot, owner, name } = repository;

  // Resolve base_branch: caller wins; otherwise pull from
  // .ground-control.yaml; otherwise "dev". Preserves the legacy
  // standalone-Skill behavior (which read the YAML directly).
  let effectiveBaseBranch = baseBranch;
  if (effectiveBaseBranch == null || effectiveBaseBranch === "") {
    try {
      const ctx = await getRepoGroundControlContext(repoRoot);
      effectiveBaseBranch =
        ctx?.workflow?.base_branch && ctx.workflow.base_branch.trim() !== ""
          ? ctx.workflow.base_branch
          : "dev";
    } catch {
      effectiveBaseBranch = "dev";
    }
  }

  const branchName = await getCurrentBranchName(repoRoot);
  if (!branchName) {
    return {
      ok: false,
      error: "test_quality_review_branch_unresolved",
      message:
        "gc_test_quality_review requires a named branch to anchor the cycle counter; HEAD is detached or branch unresolved.",
      next_action: "checkout_named_feature_branch",
      finding_count: 0,
      findings: [],
    };
  }

  let effectiveIssue = Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
  if (effectiveIssue == null) {
    effectiveIssue = deriveIssueNumberFromBranch(branchName);
  }
  if (effectiveIssue == null) {
    return {
      ok: false,
      error: "test_quality_review_issue_unresolved",
      message:
        `gc_test_quality_review requires an issue number to anchor the cycle counter (per ADR-029). ` +
        `Branch '${branchName}' does not start with a numeric issue prefix; pass issue_number explicitly.`,
      branch: branchName,
      next_action: "pass_issue_number_or_use_numeric_branch_prefix",
      finding_count: 0,
      findings: [],
    };
  }

  // Cycle cap enforcement. Count existing test-quality cycle markers on
  // the issue thread; refuse cycle hardCap+1 unless override_cap=true
  // with a non-empty reason.
  const priorCount = await readPriorTestQualityReviewCycleCount(
    repoRoot,
    owner,
    name,
    effectiveIssue,
  );
  // Resolve the per-reviewer cap from `.ground-control.yaml` (issue #906).
  // ReviewerCapConfigError (invalid cfg) is the one expected configuration
  // failure; translate it into the stable JSON envelope shape the parent
  // /implement agent reads as a directive, otherwise the MCP wrapper would
  // surface it as an unstructured tool error (codex cycle-2 F4).
  let effectiveCap;
  try {
    effectiveCap = await resolveReviewerPrePushCap(
      repoRoot,
      "test_quality_review",
      TEST_QUALITY_REVIEW_HARD_CAP,
    );
  } catch (err) {
    if (err instanceof ReviewerCapConfigError) {
      return {
        ok: false,
        error: "reviewer_cap_config_invalid",
        message: err.message,
        block: err.blockName,
        config_errors: err.configErrors,
        issue_number: effectiveIssue,
        branch: branchName,
        next_action: "fix_ground_control_yaml_and_retry",
        finding_count: 0,
        findings: [],
      };
    }
    throw err;
  }
  const decision = evaluateTestQualityReviewCycleCap({
    priorCount,
    issueNumber: effectiveIssue,
    branchName,
    hardCap: effectiveCap,
    overrideCap,
    overrideReason,
  });
  if (!decision.ok) {
    return {
      ok: false,
      error: decision.error,
      message: decision.message,
      issue_number: decision.issue_number ?? effectiveIssue,
      branch: decision.branch ?? branchName,
      prior_cycles: decision.prior_cycles,
      cap: decision.cap,
      next_action: decision.next_action ?? null,
      finding_count: 0,
      findings: [],
    };
  }

  // Find changed test files. Zero files is a legitimate zero-findings
  // result — no need to spin up a Claude call. Pre-push placement (#906)
  // requires `includeUncommitted: true` to catch staged + unstaged + untracked
  // test edits; without it the pre-push call sees only what HEAD already has,
  // which is the empty set on the first cycle.
  const changedTestFiles = await findChangedTestFiles({
    repoRoot,
    baseBranch: effectiveBaseBranch,
    includeUncommitted: true,
  });
  if (changedTestFiles.length === 0) {
    // Still record a cycle so the cap counts correctly. Preserve override
    // metadata in both the marker and the envelope so an authorized
    // cycle 4 with no changed tests still leaves a durable audit trail.
    const recordBody = buildTestQualityReviewFindingsComment({
      cycleNumber: decision.nextCycle,
      cap: decision.cap,
      issueNumber: effectiveIssue,
      branch: branchName,
      findings: [],
      model,
    });
    const markerWriteResult = await postFindingsRecordAndCycleMarker({
      repoRoot,
      owner,
      name,
      issueNumber: effectiveIssue,
      branchName,
      cycleNumber: decision.nextCycle,
      override: decision.override === true,
      overrideReason: decision.override_reason ?? null,
      recordBody,
      hardCap: effectiveCap,
      stationObservation,
    });
    if (!markerWriteResult.ok) return markerWriteResult.envelope;
    return {
      ok: true,
      issue_number: effectiveIssue,
      branch: branchName,
      pr_number: prNumber,
      cycle: decision.nextCycle,
      cap: decision.cap,
      finding_count: 0,
      findings: [],
      next_action: "post_clean_decision_record_and_advance_to_phase_c",
      findings_comment_url: markerWriteResult.recordUrl,
      changed_test_files: [],
      override: decision.override === true,
      override_reason: decision.override_reason ?? null,
      model,
    };
  }

  // Vocabulary sourced from trusted base ref when the PR touches the policy
  // file (#931 codex cycle-1 security finding F3). Same pattern as runCodexReview.
  const vocabulary = await readVocabularyForReview(repoRoot, effectiveBaseBranch);
  const prompt = buildTestQualityReviewPrompt({
    baseBranch: effectiveBaseBranch,
    changedTestFiles,
    vocabulary,
  });
  let stdout;
  try {
    stdout = await runSingleClaudeTestQualityReview({
      repoRoot,
      prompt,
      model,
      signal,
    });
  } catch (err) {
    return {
      ok: false,
      ...testQualityReviewEngineFailure(err),
      issue_number: effectiveIssue,
      branch: branchName,
      finding_count: 0,
      findings: [],
    };
  }

  let parsed;
  try {
    parsed = parseTestQualityReviewFindings(stdout);
  } catch (err) {
    return {
      ok: false,
      error: "test_quality_review_parse_failed",
      message: `parsing claude output failed: ${err.message}`,
      raw_output: stdout.slice(0, 2000),
      issue_number: effectiveIssue,
      branch: branchName,
      next_action: "inspect_engine_output_and_retry",
      finding_count: 0,
      findings: [],
    };
  }

  const findings = parsed.findings;

  // Disarm caller-controlled fields against reserved marker injection
  // (codex cycle-3 security finding F10: prompt-injected test files
  // could otherwise place `<!-- gc:... -->` syntax into a finding's
  // location/problem/fix and forge workflow markers that the next
  // parser would count as real state). Mirrors the
  // rejectReservedMarkerSequence pattern used by gc_post_decision_record.
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    for (const [k, v] of [
      ["location", f.location],
      ["problem", f.problem],
      ["why_it_matters", f.why_it_matters],
      ["fix", f.fix],
    ]) {
      const e = rejectReservedMarkerSequence(v, `findings[${i}].${k}`);
      if (e) {
        return {
          ok: false,
          error: "test_quality_review_reserved_marker",
          message: e,
          issue_number: effectiveIssue,
          branch: branchName,
          next_action: "scrub_findings_and_retry",
          finding_count: findings.length,
          findings,
        };
      }
    }
  }

  // Build the durable findings record and the cycle marker; post both
  // to the issue thread. The wrapper enforces the body-size cap +
  // sensitive-content scrub + ordered posts before either write so a
  // marker-only or record-only partial state cannot be produced.
  const recordBody = buildTestQualityReviewFindingsComment({
    cycleNumber: decision.nextCycle,
    cap: decision.cap,
    issueNumber: effectiveIssue,
    branch: branchName,
    findings,
    model,
  });

  const markerWriteResult = await postFindingsRecordAndCycleMarker({
    repoRoot,
    owner,
    name,
    issueNumber: effectiveIssue,
    branchName,
    cycleNumber: decision.nextCycle,
    override: decision.override === true,
    overrideReason: decision.override_reason ?? null,
    recordBody,
    findingCount: findings.length,
    findings,
    hardCap: effectiveCap,
    stationObservation,
  });
  if (!markerWriteResult.ok) return markerWriteResult.envelope;

  const nextAction =
    findings.length === 0
      ? "post_clean_decision_record_and_advance_to_phase_c"
      : decision.next_action;

  return {
    ok: true,
    issue_number: effectiveIssue,
    branch: branchName,
    pr_number: prNumber,
    cycle: decision.nextCycle,
    cap: decision.cap,
    finding_count: findings.length,
    findings,
    architectural_read: parsed.envelope?.architectural_read,
    next_action: nextAction,
    findings_comment_url: markerWriteResult.recordUrl,
    changed_test_files: changedTestFiles,
    override: decision.override === true,
    override_reason: decision.override_reason ?? null,
    model,
  };
}
