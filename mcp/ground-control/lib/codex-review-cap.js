// Codex review cap and phase-gate enforcement (issue #1355).
//
// Extracted from runCodexReview, which had grown to 675 lines against the repo's 500-LOC
// limit. These two gates are the bulk of it and are genuinely separable: each decides
// whether a review may run at all and returns either a refusal envelope the caller returns
// verbatim, or the ownership record the run is anchored to.
//
// Each returns `{ refusal }` or `{ ownership }` so the caller branches on one shape rather
// than on a sentinel, and neither reaches into the review it guards.

import { CODEX_REVIEW_PREPUSH_HARD_CAP, deriveIssueNumberFromBranch, evaluateCodexReviewPrePushCycleCap } from "./api-requirements.js";
import { readPriorCodexReviewCycleCount } from "./close-issue.js";
import { readPriorCodexReviewPrePushCycleCount } from "./codex-verify-cap.js";
import { ReviewerCapConfigError, resolveReviewerPrePushCap } from "./codex-workflow-5.js";
import { getOwnerRepo, getPullRequestClosingIssues } from "./grc-legacy-compat-3.js";
import { getCurrentBranchName, readCompletedPhases } from "./grc-legacy-compat-4.js";
import { evaluateCodexReviewCycleCap } from "./repo-context-2.js";

/**
 * Pre-push cycle cap (#796 / ADR-029), keyed on the issue alone.
 *
 * The branch is recorded in the marker for audit context but is never part of the cap key,
 * so renaming a branch cannot reset the counter.
 */
export async function enforcePrePushReviewCap({
  repoRoot,
  baseBranch,
  uncommitted,
  issueNumber,
  overrideCap,
  overrideReason,
}) {
    // Pre-push enforcement (#796). Resolve (issueNumber, branchName) — the
    // explicit param wins; otherwise derive from the current branch name. If
    // neither resolves to a positive integer, refuse with a structured error
    // so the agent fixes the input rather than silently bypassing the cap.
    const branchName = await getCurrentBranchName(repoRoot);
    if (!branchName) {
      return { refusal: {
        repo_path: repoRoot,
        base_branch: baseBranch,
        uncommitted,
        pr_number: null,
        ok: false,
        error: "prepush_branch_unresolved",
        message:
          "gc_codex_review (uncommitted=true) requires a named branch to anchor the cycle counter, " +
          "but HEAD is detached or the branch could not be resolved. Switch to a named feature branch " +
          "(typically the one created by `gh issue develop <issue>`) and retry.",
        next_action: "checkout_named_feature_branch",
        finding_count: 0,
        comments: [],
        reviewers: [],
      } };
    }

    let effectiveIssue = Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
    if (effectiveIssue == null) {
      effectiveIssue = deriveIssueNumberFromBranch(branchName);
    }
    if (effectiveIssue == null) {
      return { refusal: {
        repo_path: repoRoot,
        base_branch: baseBranch,
        uncommitted,
        pr_number: null,
        ok: false,
        error: "prepush_issue_unresolved",
        message:
          `gc_codex_review (uncommitted=true) requires an issue number to anchor the cycle counter ` +
          `to the issue thread (per ADR-029). Branch '${branchName}' does not start with a numeric ` +
          `issue prefix (e.g. '796-...'), and no issue_number was passed. Either pass issue_number ` +
          `explicitly or switch to a branch created via 'gh issue develop <issue>'.`,
        branch: branchName,
        next_action: "pass_issue_number_or_use_numeric_branch_prefix",
        finding_count: 0,
        comments: [],
        reviewers: [],
      } };
    }

    const { owner, name } = await getOwnerRepo(repoRoot);
    const priorCount = await readPriorCodexReviewPrePushCycleCount(
      repoRoot,
      owner,
      name,
      effectiveIssue,
    );
    // Resolve the per-reviewer cap from `.ground-control.yaml` (issue #906).
    // Translate ReviewerCapConfigError into the stable JSON envelope shape
    // the parent /implement agent reads as a directive, mirroring the
    // Keep config failures distinct from reviewer execution failures.
    let effectivePrePushCap;
    try {
      effectivePrePushCap = await resolveReviewerPrePushCap(
        repoRoot,
        "codex_review",
        CODEX_REVIEW_PREPUSH_HARD_CAP,
      );
    } catch (err) {
      if (err instanceof ReviewerCapConfigError) {
        return { refusal: {
          repo_path: repoRoot,
          base_branch: baseBranch,
          uncommitted,
          pr_number: null,
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
        } };
      }
      throw err;
    }
    const decision = evaluateCodexReviewPrePushCycleCap({
      priorCount,
      issueNumber: effectiveIssue,
      branchName,
      hardCap: effectivePrePushCap,
      overrideCap,
      overrideReason,
    });
    if (!decision.ok) {
      return { refusal: {
        repo_path: repoRoot,
        base_branch: baseBranch,
        uncommitted,
        pr_number: null,
        ok: false,
        error: decision.error,
        message: decision.message,
        issue_number: decision.issue_number,
        branch: decision.branch,
        prior_cycles: decision.prior_cycles,
        cap: decision.cap,
        next_action: decision.next_action ?? null,
        finding_count: 0,
        comments: [],
        reviewers: [],
      } };
    }
    return { ownership: {
      owner,
      name,
      issueNumber: effectiveIssue,
      branchName,
      cycleNumber: decision.nextCycle,
      cap: decision.cap,
      // Effective cap also held separately so the deferred marker write at
      // the end of the run uses the same value the decision was made against
      // (issue #906). decision.cap is the resolved value; we mirror it here
      // to avoid re-reading cfg later.
      hardCap: effectivePrePushCap,
      nextAction: decision.next_action ?? null,
      override: decision.override === true,
      overrideReason: decision.override_reason ?? null,
    } };
}

/**
 * Post-push plan-before-review ordering gate, then the per-PR cycle cap (#794 MVP-1).
 */
export async function enforcePostPushReviewGate({
  repoRoot,
  baseBranch,
  uncommitted,
  effectivePr,
  overrideCap,
  overrideReason,
  overridePhaseGate,
  overridePhaseReason,
}) {
    const { owner, name } = await getOwnerRepo(repoRoot);

    // (1) Plan-before-review ordering gate. Look up the PR's closing-issues
    //     refs (from "Closes #N" syntax in the PR body); if any of them
    //     carries a `plan` phase marker, planning happened — proceed. If none
    //     do, refuse unless override_phase_gate=true with reason. PRs that
    //     close no issues skip the gate (legitimate for some refactor / chore
    //     PRs that aren't tied to an issue).
    const closingIssues = await getPullRequestClosingIssues(repoRoot, effectivePr);
    if (closingIssues.length > 0 && !overridePhaseGate) {
      let anyHasPlan = false;
      const issuesChecked = [];
      for (const issueNumber of closingIssues) {
        const completed = await readCompletedPhases(repoRoot, owner, name, issueNumber);
        issuesChecked.push({ issue_number: issueNumber, phases: [...completed] });
        if (completed.has("plan")) {
          anyHasPlan = true;
          break;
        }
      }
      if (!anyHasPlan) {
        return { refusal: {
          repo_path: repoRoot,
          base_branch: baseBranch,
          uncommitted,
          pr_number: effectivePr,
          ok: false,
          error: "phase_prerequisite_missing",
          message:
            `gc_codex_review requires a 'plan' phase marker on at least one of PR #${effectivePr}'s ` +
            `closing-issue refs (${closingIssues.map((n) => `#${n}`).join(", ")}). Run ` +
            `gc_post_implementation_plan first; if you genuinely need to skip planning (e.g., trivial ` +
            `bug fix the user approved), retry with override_phase_gate=true and ` +
            `override_phase_reason="<user authorization>".`,
          missing: ["plan"],
          closing_issues: closingIssues,
          issues_checked: issuesChecked,
          next_action: "run_gc_post_implementation_plan_first",
          finding_count: 0,
          comments: [],
          reviewers: [],
        } };
      }
    } else if (overridePhaseGate) {
      if (typeof overridePhaseReason !== "string" || overridePhaseReason.trim() === "") {
        return { refusal: {
          repo_path: repoRoot,
          base_branch: baseBranch,
          uncommitted,
          pr_number: effectivePr,
          ok: false,
          error: "phase_override_missing_reason",
          message:
            "override_phase_gate=true requires a non-empty override_phase_reason quoting the user's " +
            "authorization to skip the plan-before-review gate. Audits cannot distinguish legitimate " +
            "overrides from accidents without a reason.",
        } };
      }
    }

    // (2) Hard-cap cycle enforcement (MVP-1, cap = CODEX_REVIEW_HARD_CAP).
    //     overrideCap=true requires a non-empty overrideReason — the agent
    //     cannot self-authorize.
    const priorCount = await readPriorCodexReviewCycleCount(repoRoot, owner, name, effectivePr);
    const decision = evaluateCodexReviewCycleCap({
      priorCount,
      prNumber: effectivePr,
      overrideCap,
      overrideReason,
    });
    if (!decision.ok) {
      return { refusal: {
        repo_path: repoRoot,
        base_branch: baseBranch,
        uncommitted,
        pr_number: effectivePr,
        ok: false,
        error: decision.error,
        message: decision.message,
        prior_cycles: decision.prior_cycles,
        cap: decision.cap,
        next_action: decision.next_action ?? null,
        finding_count: 0,
        comments: [],
        reviewers: [],
      } };
    }
    return { ownership: {
      owner,
      name,
      prNumber: effectivePr,
      cycleNumber: decision.nextCycle,
      cap: decision.cap,
      nextAction: decision.next_action ?? null,
      override: decision.override === true,
      overrideReason: decision.override_reason ?? null,
    } };
}
