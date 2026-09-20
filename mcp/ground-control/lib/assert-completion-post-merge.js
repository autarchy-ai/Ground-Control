// Phase E post-merge validation and publication (issue #1671).
//
// Split out of lib/assert-completion.js when the idempotent-publication check pushed that
// module past the repo's 500-line limit (docs/CODING_STANDARDS.md, Sonar S104). The seam is
// the phase boundary the module already had: everything here runs only after the linked
// pull request has merged — the merge gate, fetching the immutable merge revision, the
// trusted override, verifying requirement state at that revision, rendering the observed
// values, and posting the report. runAssertCompletion remains the single entry point.

import { readTrustedMergeStateOverride, resolvePrForClose } from "./close-issue.js";
import { extractInScopeRequirementUids } from "./issue-requirements-scope.js";
import { findTrustedFinalReportMarker } from "./final-report-marker.js";
import { runGetIssueThread } from "./issue-thread.js";
import { runPostFinalReport } from "./doc-coverage-2.js";
import { verifyMergedRequirementState } from "./merged-requirement-state.js";
import { execFile } from "./runtime-primitives.js";

const FULL_GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Phase E merge gate: resolve the linked PR and refuse unless it is merged.
// Returns `{ ok: true }` when merged, or `{ earlyReturn }` with the caller's exact
// envelope. Extracted from runAssertCompletion (length cap).
export async function assertLinkedPrMerged({ repository, issueNumber, prNumber, assertions }) {
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
export async function verifyMergedRequirements({ repository, issueNumber, mergedPr, requirements, assertions, workspaceAuthorizationResolver }) {
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
//
// Publication is idempotent (issue #1671). A replayed delivery — a retried Actions job, a
// lost response after a successful POST, or an agent re-run — must converge on the one
// record rather than stack a second final report on the thread. The trusted marker is the
// same evidence the close gate reads, through the same helper.
export async function runPostMergeCompletion({ subInput, repository, repoPath, issueNumber, prNumber, assertions, workspaceAuthorizationResolver }) {
  const existing = await findTrustedFinalReportMarker({
    repoRoot: repository.repoRoot, owner: repository.owner, name: repository.name, issueNumber, prNumber,
  });
  if (existing.found) {
    return {
      ok: true,
      repo_path: repository.repoRoot,
      issue_number: issueNumber,
      pr_number: prNumber,
      assertions,
      already_reported: true,
      final_report: { comment_url: null, comment_id: existing.commentId },
    };
  }
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


export function applyObservedMergedRequirements(subInput, verify) {
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
  if (verify.overridden) subInput.requirementStateOverrideReason = verify.reason;
}
