import { realpathSync } from "node:fs";
import { z } from "zod";
import { readRequirementByUid, findTraceabilityByArtifact } from "./lib/requirement-files.js";
import {
  ASYNC_JOB_IDEMPOTENCY_KEY_MAX,
  ASYNC_JOB_IDEMPOTENCY_KEY_RE,
  authorizeImplementMutationCheckout,
  getRepoGroundControlContext,
  runPrepareImplementBranch,
  runMarkImplementIssuePickedUp,
  runGetIssueThread,
  runSynchronizeImplementBranch,
  runWatchCiRun,
  runWatchSonarAnalysis,
  runAssertCompletion,
  runCloseIssueAfterMerge,
  EXACT_REQUIREMENT_UID_RE,
  authorizeRequestedRequirementUid,
  runImplementGitCommand,
  runImplementCommit,
  runImplementPreCommit,
  startAsyncJob,
  asyncJobInputFingerprint,
  acquireImplementPublishLock,
  resolvePublishGitDir,
  reconcileInterruptedPublish,
  writeImplementPublishJournal,
  removeImplementPublishJournal,
} from "./lib.js";
import { runFinalize, runReadiness } from "./implement/completion.js";
import { completionShape, execFileAsync, requirementShape, runBootstrap } from "./implement/gate-helpers.js";
import { runMonitor, runPublish } from "./implement/publish.js";

export { extractInScopeRequirementUids } from "./lib.js";

export const IMPLEMENT_MECHANICAL_ACTIONS = Object.freeze([
  "bootstrap",
  "publish",
  "monitor",
  "readiness",
  "finalize",
]);

export const IMPLEMENT_MECHANICAL_ASYNC_ACTIONS = Object.freeze([
  "publish",
  "monitor",
]);
export const gcImplementMechanicalZodShape = {
  action: z.enum(IMPLEMENT_MECHANICAL_ACTIONS),
  lane: z.enum(["implement", "quickfix"]).optional(),
  repo_path: z.string().min(1),
  invocation_root: z.string().min(1).optional(),
  issue_number: z.number().int().positive(),
  branch_name: z.string().min(1).max(50).optional(),
  base_branch: z.string().min(1).optional(),
  driver: z.string().regex(/^[a-z0-9._-]{1,40}$/i).optional(),
  requested_requirement_uid: z.string().regex(EXACT_REQUIREMENT_UID_RE).optional(),
  requirements: z.array(requirementShape).optional(),
  commit_message: z.string().min(1).max(200).optional(),
  synchronization: z.object({
    record_id: z.string().regex(/^[0-9a-f]{32}$/),
    pre_sync_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    fetched_base_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    outcome: z.enum(["merged_clean", "merged_conflicts_resolved"]),
  }).optional(),
  pr_number: z.number().int().positive().optional(),
  completion: completionShape.optional(),
  async: z.boolean().optional().describe(
    "When true for publish or monitor, start a background job and return a compact handle. " +
    "Poll gc_codex_job until status='done', then consume its result as the original mechanical envelope.",
  ),
  idempotency_key: z
    .string()
    .min(1)
    .max(ASYNC_JOB_IDEMPOTENCY_KEY_MAX)
    .regex(ASYNC_JOB_IDEMPOTENCY_KEY_RE)
    .optional()
    .describe(
      "Required with async=true. Reuse for transport retries of one logical attempt; use a new key after repair.",
    ),
};
export const GC_IMPLEMENT_MECHANICAL_DESCRIPTION =
  "Run coarse-grained deterministic /implement and /quickfix phases without a model turn per mechanical step. " +
  "Actions: bootstrap (issue/branch/context/pickup), " +
  "publish (stage + pre-commit + commit + push + remote-base synchronization), monitor (CI + Sonar), " +
  "readiness (pre-merge completion assertion), finalize (post-merge assertion + idempotent issue close). " +
  "Always pass action, repo_path, and issue_number. Depending on action, also pass invocation_root, branch_name, " +
  "base_branch, driver, requested_requirement_uid, requirements, commit_message, synchronization, pr_number, or completion. " +
  "bootstrap requires branch_name; for publish and monitor branch_name is OPTIONAL and defaults to the checkout's current " +
  "branch when it is this issue's branch (`<issue>-<slug>`), refusing a base/unrelated branch rather than acting on it. " +
  "Long actions publish and monitor accept async=true plus a required bounded idempotency_key; " +
  "poll the returned job_id through gc_codex_job and consume the terminal result as this tool's unchanged envelope. " +
  "Bootstrap, readiness, and finalize remain synchronous. lane defaults to implement; lane=quickfix makes bootstrap " +
  "reject requirement-backed issues before branch mutation and makes finalize post the slim quickfix outcome before close. " +
  "requested_requirement_uid names the requirement under test. Every action that can reach a repository gate resolves it " +
  "server-side against the target issue's Requirements section and refuses an unlisted UID; publish then exports " +
  "the bound value to every repo-authored gate as ACES_REQUIREMENT_UID, so a governance gate still receives requirement " +
  "identity on an issue branch that carries no UID. " +
  "A phase either completes or returns agent_required=true with a bounded repair reason; it never invokes an agent.";

function asyncTransportFailure(action, error, message, nextAction) {
  return {
    ok: false,
    action,
    error,
    message,
    agent_required: false,
    next_action: nextAction,
  };
}
const defaultDeps = {
  execFile: execFileAsync,
  authorizeRepo: authorizeImplementMutationCheckout,
  runGit: runImplementGitCommand,
  commit: runImplementCommit,
  preCommit: runImplementPreCommit,
  getContext: getRepoGroundControlContext,
  prepareBranch: runPrepareImplementBranch,
  markPickedUp: runMarkImplementIssuePickedUp,
  getIssueThread: runGetIssueThread,
  synchronize: runSynchronizeImplementBranch,
  watchCi: runWatchCiRun,
  watchSonar: runWatchSonarAnalysis,
  assertCompletion: runAssertCompletion,
  authorizeRequirementUid: authorizeRequestedRequirementUid,
  closeIssue: runCloseIssueAfterMerge,
  // Mechanical-publish recovery seams (issue #1495). Injected so tests can stub
  // the filesystem lease/journal while production holds the real per-worktree lease.
  resolvePublishGitDir,
  acquirePublishLock: acquireImplementPublishLock,
  reconcileInterruptedPublish,
  writePublishJournal: writeImplementPublishJournal,
  removePublishJournal: removeImplementPublishJournal,
};
function dispatch(args, deps) {
  switch (args.action) {
    case "bootstrap":
      return runBootstrap(args, deps);
    case "publish":
      return runPublish(args, deps);
    case "monitor":
      return runMonitor(args, deps);
    case "readiness":
      return runReadiness(args, deps);
    case "finalize":
      return runFinalize(args, deps);
    default:
      return Promise.resolve({
        ok: false,
        error: "implement_mechanical_action_invalid",
        message: `Unknown action '${args.action}'`,
        agent_required: false,
      });
  }
}
export async function runImplementMechanical(args, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  // Requirements and their traceability are repo-local files now (ADR-093, issue #1500):
  // docs/requirements/<UID>/requirement.md is the record, read straight from this run's
  // checkout — there is no backend. Bind the file reader to args.repoPath here, where the
  // canonical checkout is known; the second `project` argument the call sites still pass is
  // vestigial (a checkout is one project). Tests inject their own via `overrides`, so only
  // fill these when an override has not.
  if (!deps.getRequirement) {
    deps.getRequirement = (uid) => readRequirementByUid(args.repoPath, uid);
  }
  if (!deps.getTraceabilityByArtifact) {
    deps.getTraceabilityByArtifact = (artifactType, artifactIdentifier) =>
      findTraceabilityByArtifact(args.repoPath, artifactType, artifactIdentifier);
  }
  return dispatch(args, deps);
}
export async function gcImplementMechanicalToolHandler(args, overrides = {}) {
  const mechanicalArgs = {
    action: args.action,
    lane: args.lane,
    repoPath: args.repo_path,
    invocationRoot: args.invocation_root,
    issueNumber: args.issue_number,
    branchName: args.branch_name,
    baseBranch: args.base_branch,
    driver: args.driver,
    requestedRequirementUid: args.requested_requirement_uid,
    requirements: args.requirements,
    commitMessage: args.commit_message,
    synchronization: args.synchronization,
    prNumber: args.pr_number,
    completion: args.completion,
  };
  if (args.async !== true) {
    return runImplementMechanical(mechanicalArgs, overrides);
  }
  if (!IMPLEMENT_MECHANICAL_ASYNC_ACTIONS.includes(args.action)) {
    return asyncTransportFailure(
      args.action,
      "implement_mechanical_async_action_invalid",
      `action=${args.action} is intentionally synchronous`,
      "call_the_short_action_without_async",
    );
  }
  if (typeof args.idempotency_key !== "string" || args.idempotency_key.length === 0) {
    return asyncTransportFailure(
      args.action,
      "implement_mechanical_idempotency_key_required",
      "idempotency_key is required when async=true",
      "supply_one_bounded_key_for_this_logical_attempt_and_retry",
    );
  }

  const {
    startJob = startAsyncJob,
    canonicalizeRepoPath = realpathSync,
    ...mechanicalOverrides
  } = overrides;
  let canonicalRepoPath;
  try {
    canonicalRepoPath = canonicalizeRepoPath(args.repo_path);
  } catch {
    return asyncTransportFailure(
      args.action,
      "implement_mechanical_async_repo_invalid",
      "repo_path cannot be resolved to a canonical checkout",
      "supply_the_canonical_invocation_checkout_and_retry",
    );
  }
  const normalizedArgs = { ...mechanicalArgs, repoPath: canonicalRepoPath };
  const checkoutBound = args.action === "publish";
  return startJob(
    `implement_mechanical_${args.action}`,
    // The registry carries progress from long-running mechanical actions.
    (_signal, reportProgress) => runImplementMechanical(normalizedArgs, { ...mechanicalOverrides, reportProgress }),
    {
      idempotencyKey: args.idempotency_key,
      idempotencyNamespace:
        `repo:${canonicalRepoPath}:issue:${args.issue_number}:action:${args.action}`,
      fingerprint: asyncJobInputFingerprint(normalizedArgs),
      executionScope: checkoutBound ? `implement_mechanical_checkout:${canonicalRepoPath}` : null,
      singleFlight: checkoutBound,
      // Mechanical jobs stay non-cancellable: their full Git/GitHub/gate graph does
      // not honour abort, so advertising cancellation would be false. The publish
      // hang this issue reports is closed by the gate runner reaping its process
      // tree and by lease + journal + restart reconciliation, not by cancellation
      // (issue #1495).
      cancellable: false,
    },
  );
}
