// Extracted from gc-implement-mechanical.js (issue #1355).
//
// The module had reached 1,231 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md). gc-implement-mechanical.js remains the tool entry point.

import { currentPickupLane, detectSensitiveBodyContent, extractInScopeRequirementUids, getAuthenticatedGitHubLogin, requestedRequirementUidAuthorization } from "../lib.js";
import { z } from "zod";

export { execFile as execFileAsync } from "../lib/runtime-primitives.js";
export const requirementShape = z.object({
  uid: z.string().min(1),
  status_intent: z.string().min(1).optional(),
});
export const completionRequirementShape = z.object({
  uid: z.string().min(1),
  title: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  status_intent: z.string().min(1).optional(),
  note: z.string().optional(),
});
export const completionShape = z.object({
  requirements: z.array(completionRequirementShape),
  files: z.object({
    added: z.array(z.string()).optional(),
    modified: z.array(z.string()).optional(),
    renamed: z.array(z.string()).optional(),
    deleted: z.array(z.string()).optional(),
  }),
  reviews: z.array(z.object({
    reviewer: z.string().min(1),
    summary: z.string().min(1),
  })),
  traceability: z.object({
    added: z.array(z.string()).optional(),
    updated: z.array(z.string()).optional(),
    deleted: z.array(z.string()).optional(),
    notes: z.string().optional(),
  }).optional(),
  ci_status: z.string().min(1),
  sonar_status: z.string().min(1),
  plan_comment_url: z.string().url().nullable().optional(),
  summary: z.string().min(1).optional(),
  plain_english_outcome: z.string().min(1).optional(),
  touched_files: z.array(z.string()).optional(),
  project: z.string().min(1).optional(),
});
export function bounded(value, max = 1200) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
export function failure(action, error, message, nextAction, extra = {}) {
  const safeMessage = bounded(message);
  return {
    ok: false,
    action,
    error,
    message: detectSensitiveBodyContent(safeMessage) ? "<redacted>" : safeMessage,
    agent_required: true,
    next_action: nextAction,
    ...extra,
  };
}
export function requireField(args, field, action) {
  if (args[field] == null || args[field] === "") {
    return failure(
      action,
      "implement_mechanical_input_invalid",
      `${field} is required for action=${action}`,
      "supply_the_required_structured_input_and_retry",
    );
  }
  return null;
}
/**
 * Resolve the issue branch for publish/monitor. `branchName` is OPTIONAL: when
 * the caller omits it, it is derived from the checkout's current branch, but
 * only when that branch belongs to THIS issue (bootstrap names branches
 * `<issue>-<slug>`). This keeps the "am I on the branch I intend?" guard — an
 * explicit `branchName` is still asserted to match the checkout, and a derived
 * branch that is not this issue's branch (a base branch like dev/main, a
 * detached HEAD, or an unrelated branch) is refused rather than silently pushed
 * or watched. The redundant handoff the /implement orchestrator hit — bootstrap
 * already created and checked out the branch, yet publish/monitor demanded it
 * be re-declared — becomes a safe default instead of a hard input error.
 *
 * @returns {{ok: true, branchName: string} | {ok: false, failure: object}}
 */
export function resolveIssueBranch({ branchName, activeBranch, issueNumber, action }) {
  const active = typeof activeBranch === "string" ? activeBranch.trim() : "";
  const explicit = typeof branchName === "string" ? branchName.trim() : "";
  if (explicit !== "") {
    if (active !== explicit) {
      return {
        ok: false,
        failure: failure(
          action,
          "implement_mechanical_branch_mismatch",
          `Active branch is '${active}', expected '${explicit}'`,
          "return_to_the_issue_branch_and_retry",
        ),
      };
    }
    return { ok: true, branchName: explicit };
  }
  const issuePrefix = `${issueNumber}-`;
  if (!active.startsWith(issuePrefix)) {
    return {
      ok: false,
      failure: failure(
        action,
        "implement_mechanical_branch_unresolved",
        `branch_name was not supplied and the active branch '${active}' is not issue #${issueNumber}'s branch `
          + `(expected '${issuePrefix}<slug>'); check out the issue branch or pass branch_name.`,
        "checkout_the_issue_branch_or_supply_branch_name_and_retry",
      ),
    };
  }
  return { ok: true, branchName: active };
}
export function commandFailure(action, stage, error) {
  const detail =
    typeof error?.stderr === "string" && error.stderr.trim() !== ""
      ? error.stderr
      : error?.message;
  return failure(
    action,
    `implement_mechanical_${stage}_failed`,
    detail ?? `${stage} failed`,
    `repair_${stage}_and_retry`,
    { failed_stage: stage },
  );
}

// Load the in-scope requirement records and the issue's traceability links for
// bootstrap. Returns a bounded failure envelope when either read throws, so the
// caller can surface it unchanged instead of unwinding through a thrown error.
async function loadIssueRequirementContext(args, deps, context, requirementUids, action) {
  try {
    const requirements = await Promise.all(requirementUids.map(async (uid) => {
      const requirement = await deps.getRequirement(uid, context.project);
      return {
        id: requirement.id,
        uid: requirement.uid,
        title: requirement.title,
        statement: requirement.statement,
        status: requirement.status,
        wave: requirement.wave,
      };
    }));
    const issueTraceabilityLinks = await deps.getTraceabilityByArtifact(
      "GITHUB_ISSUE",
      String(args.issueNumber),
      context.project,
    );
    return { ok: true, requirements, issueTraceabilityLinks };
  } catch (error) {
    return failure(
      action,
      "implement_mechanical_issue_context_failed",
      error.message,
      "repair_requirement_or_traceability_access_and_retry",
    );
  }
}

// Record the lane-specific pickup comment unless the thread already carries one for
// this branch. Returns the pickup record on success (reused or freshly written)
// or a bounded failure envelope; both carry `ok`, so the caller branches on it.
async function ensureIssuePickup(args, deps, thread, branch, action) {
  const lane = args.lane === "quickfix" ? "quickfix" : "implement";
  // The shared lane reader accepts only exact records by repository-write
  // authors. Reusing its result keeps bootstrap and every later gate aligned.
  const derived = await deps.readRunLane({
    repoPath: args.repoPath,
    issueNumber: args.issueNumber,
    branchName: branch,
  });
  if (!derived.ok) {
    return failure(action, derived.error, derived.message, derived.next_action);
  }
  // Release reservation is deliberately bound to this server's `/implement`
  // pickup. Keep that separate ownership evidence when a different trusted
  // author established the lane record.
  const ownImplementPickup = lane === "implement" && currentPickupLane(
    (thread.comments ?? []).map((comment) => ({ id: comment?.id, body: comment?.body, authorLogin: comment?.author })),
    await (deps.authenticatedLogin ?? getAuthenticatedGitHubLogin)(args.repoPath),
    branch,
  ) === "implement";
  if (derived.pickup_found && derived.lane === lane && (lane !== "implement" || ownImplementPickup)) {
    return { ok: true, reused: true };
  }
  const pickup = await deps.markPickedUp({
    repoPath: args.repoPath,
    issueNumber: args.issueNumber,
    driver: args.driver,
    branchName: branch,
    lane,
  });
  if (!pickup.ok) {
    return failure(action, pickup.error, pickup.message, "repair_pickup_record_and_retry");
  }
  return pickup;
}
export async function runBootstrap(args, deps) {
  const action = "bootstrap";
  for (const field of ["invocationRoot", "branchName", "driver"]) {
    const invalid = requireField(args, field, action);
    if (invalid) return invalid;
  }
  const context = await deps.getContext(args.repoPath);
  if (context?.status !== "ok") {
    return failure(
      action,
      "implement_mechanical_context_invalid",
      context?.errors?.join("; ") ?? "Ground Control repository context is unavailable",
      "repair_ground_control_context_and_retry",
    );
  }
  const thread = await deps.getIssueThread({
    repoPath: args.repoPath,
    issueNumber: args.issueNumber,
  });
  if (!thread.ok) {
    return failure(action, thread.error, thread.message, "repair_issue_access_and_retry");
  }
  const requirementUids = extractInScopeRequirementUids(thread.body);
  if (args.lane === "quickfix" && requirementUids.length > 0) {
    return failure(
      action,
      "quickfix_requirements_in_scope",
      `Issue #${args.issueNumber} has requirements in scope and cannot use the requirement-free quickfix lane`,
      "use_implement_for_this_issue",
      { requirement_uids: requirementUids },
    );
  }
  // Bootstrap already holds the authoritative thread, so it binds against that
  // body directly rather than re-reading it.
  const authorized = requestedRequirementUidAuthorization(
    thread.body,
    args.requestedRequirementUid,
  );
  if (!authorized.ok) {
    return failure(action, authorized.error, authorized.message, authorized.next_action);
  }
  const prepared = await deps.prepareBranch({
    repoPath: args.repoPath,
    invocationRoot: args.invocationRoot,
    issueNumber: args.issueNumber,
    branchName: args.branchName,
    baseBranch: args.baseBranch ?? context.workflow?.base_branch ?? "dev",
    checkoutMode: "same_checkout",
  });
  if (!prepared.ok) {
    return failure(action, prepared.error, prepared.message, prepared.next_action ?? "repair_branch_and_retry");
  }
  const requirementContext = await loadIssueRequirementContext(args, deps, context, requirementUids, action);
  if (!requirementContext.ok) return requirementContext;
  const { requirements, issueTraceabilityLinks } = requirementContext;
  const pickup = await ensureIssuePickup(args, deps, thread, prepared.branch, action);
  if (!pickup.ok) return pickup;
  return {
    ok: true,
    action,
    phase: "bootstrap_complete",
    repo_path: prepared.repo_path,
    branch: prepared.branch,
    project: context.project,
    config: context,
    issue: {
      number: args.issueNumber,
      title: thread.title,
      body: thread.body,
      labels: thread.labels,
      comments: thread.comments,
      url: thread.url,
      hash: thread.hash,
    },
    requirement_uids: requirementUids,
    in_scope_requirements: requirements,
    issue_traceability_links: issueTraceabilityLinks,
    pickup,
    next_action: args.lane === "quickfix"
      ? "implement_the_bounded_fix_and_run_targeted_tests"
      : "run_agent_architecture_assessment_and_plan",
  };
}
