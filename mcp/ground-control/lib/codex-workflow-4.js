// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { realpathSync } from "node:fs";
import { assertImplementSyncCheckout, fetchImplementBase, isImplementAncestor, readImplementGitOid, readImplementIndexTreeOid, readImplementTreeOid, runImplementGit } from "./codex-workflow-2.js";
import { assertImplementMergeAttemptUnchanged } from "./implement-publish-recovery.js";
import { runImplementCommit } from "./implement-commit.js";
import { authorizeRequestedRequirementUid } from "./codex-workflow-3.js";
import { validateImplementBranchName } from "./codex-workflow.js";
import { IMPLEMENT_BASE_SYNC_ACTIONS, IMPLEMENT_BASE_SYNC_NO_PUBLICATION, newImplementSyncRecordId } from "./implement-sync-record.js";
import { assertSafeImplementCheckoutConfiguration, authorizeImplementRepoRoot, ensureGitRepo, resolveMcpLaunchWorkspaceAuthorization } from "./grc-legacy-compat-4.js";
import { runGetIssueThread } from "./issue-thread.js";
import { postImplementBaseSyncRecord, readTrustedImplementSyncRecord, verifyPublishedImplementHead } from "./knowledge-capture.js";
import { isSafeGitRefName } from "./repo-context.js";
import { getRepoGroundControlContext } from "./repo-vocabulary-2.js";
import { execFile } from "./runtime-primitives.js";
import { prepareCommittedRetryCompletion, validateBaseSyncCompletionInput } from "../implement/sync-inputs.js";
import { resolveDeliveryBinding } from "./delivery-binding.js";
import { readTrustedReviewPublicationEvidence } from "./review-publication-evidence.js";
import { readTrustedRunLane } from "./run-lane-evidence.js";
import { readLatestTrustedImplementSyncRecord } from "./knowledge-capture.js";

// Validate the shared boundary input, then the branch name. Returns the
// input-invalid envelope, or the branch-name validation result (terminal to the
// caller only when `ok` is false).
function validateBaseSyncInput(input) {
  if (
    input == null
    || !IMPLEMENT_BASE_SYNC_ACTIONS.includes(input.action)
    || !Number.isInteger(input.issueNumber)
    || input.issueNumber <= 0
  ) {
    return {
      ok: false,
      error: "implement_base_sync_input_invalid",
      message: "action and a positive issueNumber are required",
    };
  }
  return validateImplementBranchName(input.branchName, input.issueNumber);
}

export async function runSynchronizeImplementBranch(input, {
  workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
  commandRunner = execFile,
  contextResolver = getRepoGroundControlContext,
  syncRecordReader = readTrustedImplementSyncRecord,
  issueThreadReader = (args) => runGetIssueThread(args, { workspaceAuthorizationResolver }),
  reviewEvidenceReader = readTrustedReviewPublicationEvidence,
  laneReader = readTrustedRunLane,
  latestSyncRecordReader = readLatestTrustedImplementSyncRecord,
} = {}) {
  const inputValidation = validateBaseSyncInput(input);
  if (!inputValidation.ok) return inputValidation;
  let repoRoot;
  let context;
  try {
    repoRoot = realpathSync(await ensureGitRepo(input.repoPath));
    context = await contextResolver(repoRoot);
  } catch (error) {
    return {
      ok: false,
      error: "implement_base_sync_context_failed",
      message: error.message,
      next_action: "repair_repository_context_and_retry",
    };
  }
  // An unreadable or invalid `.ground-control.yaml` must not fall through to
  // defaults: the base branch comes from it, and a
  // silent default here would fetch and merge against the wrong
  // contract (issue #1429).
  if (context?.status !== "ok") {
    return {
      ok: false,
      error: "implement_base_sync_context_invalid",
      message: "The repository Ground Control context is invalid",
      next_action: "repair_ground_control_configuration_and_retry",
    };
  }
  const repoAuthorization = await authorizeImplementRepoRoot(
    repoRoot,
    workspaceAuthorizationResolver,
  );
  if (!repoAuthorization.ok) return repoAuthorization;
  // This tool is directly callable, so it cannot rely on bootstrap having bound
  // the requested identity to the issue. The binding runs only after workspace
  // authorization and canonical repo-root resolution, and reads the issue
  // through the authorized identity: an earlier lookup would let a caller who
  // is not authorized for this workspace make the server read an arbitrary
  // repository's issue thread, and the distinct authorized/out-of-scope
  // outcomes would then reveal whether a guessed UID appears in a private
  // issue (issue #1434).
  const authorizedRequirement = await authorizeRequestedRequirementUid({
    repoPath: repoRoot,
    issueNumber: input.issueNumber,
    requestedRequirementUid: input.requestedRequirementUid,
  }, { issueThreadReader });
  if (!authorizedRequirement.ok) return authorizedRequirement;
  const baseBranch = context?.workflow?.base_branch ?? "dev";
  if (!isSafeGitRefName(baseBranch)) {
    return {
      ok: false,
      error: "implement_base_sync_base_invalid",
      message: "The configured integration branch is not a safe Git ref name",
    };
  }
  try {
    await assertSafeImplementCheckoutConfiguration(repoRoot);
    const checkout = await assertImplementSyncCheckout({
      repoRoot,
      issueNumber: input.issueNumber,
      branchName: input.branchName,
      commandRunner,
      allowMergeState: input.action === "complete",
    });
    if (!checkout.ok) return checkout;
    const common = {
      repoRoot, input, context, baseBranch, commandRunner,
      repoAuthorization, authorizedRequirement,
      reviewEvidenceReader, laneReader, latestSyncRecordReader,
    };
    if (input.action === "start") return await runBaseSyncStart(common);
    return await runBaseSyncComplete({ ...common, syncRecordReader });
  } catch {
    return {
      ok: false,
      error: input.action === "start"
        ? "implement_base_sync_failed"
        : "implement_base_sync_completion_failed",
      message:
        "Pre-PR synchronization failed; inspect the preserved checkout state before retrying",
      next_action: "inspect_preserved_git_state_and_retry_the_same_boundary",
    };
  }
}

// `action === "start"`: fetch the configured base, then dispatch on ancestry. An
// already-current head is recorded; otherwise a merge is staged.
async function runBaseSyncStart(args) {
  const { repoRoot, baseBranch, commandRunner } = args;
  const preSyncSha = await readImplementGitOid(repoRoot, "HEAD", commandRunner);
  let fetched;
  try {
    fetched = await fetchImplementBase(repoRoot, baseBranch, commandRunner);
  } catch {
    return {
      ok: false,
      error: "implement_base_sync_fetch_failed",
      message: `Unable to fetch origin/${baseBranch}; no local base ref can satisfy this boundary`,
      next_action: "repair_remote_access_and_retry_the_synchronization_boundary",
    };
  }
  const { remoteRef, fetchedBaseSha } = fetched;
  const recordId = newImplementSyncRecordId();
  const startArgs = { ...args, preSyncSha, remoteRef, fetchedBaseSha, recordId };
  if (await isImplementAncestor(repoRoot, fetchedBaseSha, preSyncSha, commandRunner)) {
    return runBaseSyncAlreadyCurrent(startArgs);
  }
  return runBaseSyncMerge(startArgs);
}

// The base is already merged into the feature head. Confirm the local head is
// published, then record its Git identity.
async function runBaseSyncAlreadyCurrent(args) {
  const {
    repoRoot, input, baseBranch, commandRunner,
    repoAuthorization,
    preSyncSha, remoteRef, fetchedBaseSha, recordId,
  } = args;
  if (!await verifyPublishedImplementHead(repoRoot, input.branchName, preSyncSha, commandRunner)) {
    return {
      ok: false,
      error: "implement_base_sync_feature_not_published",
      message: "The local and origin feature heads must match before synchronization can complete",
      next_action: "push_the_feature_branch_without_force_and_retry",
    };
  }
  const binding = await resolveSyncDeliveryBinding(args, preSyncSha);
  if (!binding.ok) return binding;
  const record = {
    recordId, issueNumber: input.issueNumber, branchName: input.branchName,
    baseBranch, remoteRef, preSyncSha, fetchedBaseSha,
    outcome: "already_current", resultingFeatureSha: preSyncSha,
    verifiedTreeSha: await readImplementTreeOid(repoRoot, "HEAD", commandRunner),
    ...binding.binding,
  };
  const posted = await postImplementBaseSyncRecord(
    repoRoot, repoAuthorization.owner, repoAuthorization.name, record, commandRunner,
  );
  return {
    ok: true, status: "complete", ...record, ...posted,
  };
}

// The base is not yet in the feature head: stage a `--no-ff --no-commit` merge.
// A clean stage returns `merge_ready`; a conflicted-but-preserved merge whose
// MERGE_HEAD matches the fetched base returns `conflicts`. Any other failure is
// re-thrown to the outer boundary mapping.
async function runBaseSyncMerge(args) {
  const { repoRoot, input, baseBranch, commandRunner, remoteRef, fetchedBaseSha, preSyncSha, recordId } = args;
  try {
    await runImplementGit(
      repoRoot,
      ["merge", "--no-ff", "--no-commit", remoteRef],
      commandRunner,
    );
    return {
      ok: true,
      status: "merge_ready",
      recordId,
      issueNumber: input.issueNumber,
      branchName: input.branchName,
      baseBranch,
      remoteRef,
      preSyncSha,
      fetchedBaseSha,
      outcome: "merged_clean",
      next_action: "complete_sync_then_observe_ci",
    };
  } catch (error) {
    const { stdout: unmerged } = await runImplementGit(
      repoRoot,
      ["ls-files", "--unmerged"],
      commandRunner,
    );
    const mergeHead = await readImplementGitOid(repoRoot, "MERGE_HEAD", commandRunner)
      .catch(() => null);
    if (unmerged.trim() !== "" && mergeHead === fetchedBaseSha) {
      return {
        ok: true,
        status: "conflicts",
        recordId,
        issueNumber: input.issueNumber,
        branchName: input.branchName,
        baseBranch,
        remoteRef,
        preSyncSha,
        fetchedBaseSha,
        outcome: "merged_conflicts_resolved",
        next_action: "resolve_every_conflict_run_proportionate_checks_then_complete_sync",
      };
    }
    throw error;
  }
}

// A staged merge (MERGE_HEAD present) is committed here. The compare-and-swap
// protects merge control state while the index tree is bound to the commit.
async function prepareMergeHeadCompletion(args) {
  const {
    repoRoot, input, baseBranch, commandRunner,
  } = args;
  const preGate = await assertImplementMergeAttemptUnchanged(repoRoot, input, commandRunner);
  if (preGate) return preGate;
  const { stdout: status } = await runImplementGit(repoRoot,
    ["status", "--porcelain=v1", "--untracked-files=normal"], commandRunner);
  if (status.split(/\r?\n/).some((line) => line && line[1] !== " ")) {
    return { ok: false, error: "implement_base_sync_worktree_not_staged",
      message: "Stage or revert every merge change before completing synchronization" };
  }
  const verifiedTreeSha = await readImplementIndexTreeOid(repoRoot, commandRunner);
  const preCommit = await assertImplementMergeAttemptUnchanged(repoRoot, input, commandRunner);
  if (preCommit) return preCommit;
  const committed = await runImplementCommit(repoRoot, ["-m", `Merge origin/${baseBranch} into ${input.branchName}`], commandRunner);
  if (!committed.ok) return { ...committed, next_action: "repair_the_host_commit_signing_key_or_agent_and_retry_completion" };
  const resultingFeatureSha = await readImplementGitOid(repoRoot, "HEAD", commandRunner);
  return { resultingFeatureSha, verifiedTreeSha };
}

// The delivery binding this record carries (issue #1679). The settled tree is the
// tree of the pre-synchronization feature head: the work this delivery produced,
// before a base merge changes it. Computed here, once, because this boundary is
// the last place that holds both the review evidence and the local commits.
async function resolveSyncDeliveryBinding(args, preSyncSha) {
  const { repoRoot, input, commandRunner, repoAuthorization } = args;
  const readEvidence = args.reviewEvidenceReader ?? readTrustedReviewPublicationEvidence;
  const readLane = args.laneReader ?? readTrustedRunLane;
  const readLatestRecord = args.latestSyncRecordReader ?? readLatestTrustedImplementSyncRecord;
  const identity = {
    repoRoot,
    owner: repoAuthorization.owner,
    name: repoAuthorization.name,
    issueNumber: input.issueNumber,
  };
  const [evidence, lane, prior] = await Promise.all([
    readEvidence(identity),
    readLane({ ...identity, branchName: input.branchName }),
    // The record this completion follows, not one it may already have posted:
    // a retry must carry forward exactly what the first attempt did.
    readLatestRecord(repoRoot, repoAuthorization.owner, repoAuthorization.name, input.issueNumber,
      input.branchName, { before: input.recordId }),
  ]);
  if (prior?.ok === false) return { ...prior, next_action: "return_to_the_synchronization_boundary" };
  return resolveDeliveryBinding({
    evidence,
    lane,
    settledTreeSha: await resolveSettledTree(args, preSyncSha, prior?.record ?? null, { evidence, lane }),
  });
}

// Whether the previous record's binding still describes the live one: same lane,
// and for /implement the same review publication and revision. An unchanged
// feature head is not an unchanged binding - a replacement review, or a lane
// switch, has to be able to establish its own (issue #1679).
function priorBindingStillCurrent(priorRecord, { evidence, lane }) {
  if (lane?.ok !== true || priorRecord.lane !== lane.lane) return false;
  if (lane.lane === "quickfix") return priorRecord.reviewPublicationId === IMPLEMENT_BASE_SYNC_NO_PUBLICATION;
  return evidence?.ok === true && evidence.published === true
    && evidence.publication_id === priorRecord.reviewPublicationId
    && evidence.revision_digest === priorRecord.reviewRevisionDigest;
}

/**
 * The tree this delivery's own work produced.
 *
 * Normally the tree of the pre-synchronization head. But a base merge moves that
 * head, so a second synchronization - which happens whenever the base advances
 * again before the pull request is created - would otherwise offer the merged
 * tree as the settlement and be refused against the reviewed one, demanding
 * another review cycle for a routine base update. The previous settlement is
 * carried forward only when the feature head is exactly where that
 * synchronization left it *and* its binding is still the live one; a new review
 * of the merged head, or a lane switch, is derived fresh so it can take effect.
 */
async function resolveSettledTree({ repoRoot, commandRunner }, preSyncSha, priorRecord, live) {
  if (priorRecord != null
    && priorRecord.resultingFeatureSha === preSyncSha
    && priorBindingStillCurrent(priorRecord, live)) {
    return priorRecord.settledTreeSha;
  }
  return readImplementTreeOid(repoRoot, preSyncSha, commandRunner);
}

// Read or post the durable synchronization record, then build the terminal
// completion envelope. An existing record must match field for field.
async function finalizeBaseSyncRecord(args) {
  const {
    repoRoot, input, commandRunner, repoAuthorization, record, syncRecordReader,
  } = args;
  const existing = await syncRecordReader(
    repoRoot,
    repoAuthorization.owner,
    repoAuthorization.name,
    input.issueNumber,
    input.recordId,
  );
  let posted;
  if (existing.ok) {
    const fields = [
      "recordId", "issueNumber", "branchName", "baseBranch", "remoteRef",
      "preSyncSha", "fetchedBaseSha", "outcome", "resultingFeatureSha",
      "verifiedTreeSha", "settledTreeSha", "reviewPublicationId",
      "reviewRevisionDigest", "lane",
    ];
    if (fields.some((field) => existing.record[field] !== record[field])) {
      return {
        ok: false,
        error: "implement_base_sync_existing_record_mismatch",
        message: "The existing synchronization record does not match this completion",
        next_action: "inspect_the_issue_thread_and_preserved_checkout",
      };
    }
    posted = {
      commentId: existing.commentId ?? null,
      commentUrl: existing.commentUrl ?? null,
    };
  } else if (existing.error === "implement_pr_sync_record_missing") {
    posted = await postImplementBaseSyncRecord(
      repoRoot,
      repoAuthorization.owner,
      repoAuthorization.name,
      record,
      commandRunner,
    );
  } else {
    return {
      ...existing,
      next_action: "inspect_the_issue_thread_and_preserved_checkout",
    };
  }
  return {
    ok: true,
    status: "complete",
    ...record,
    ...posted,

  };
}

// `action === "complete"`: commit or adopt the staged/committed merge, validate
// the merge graph and verified tree, attest, push, confirm the head, and record.
async function runBaseSyncComplete(args) {
  const {
    repoRoot, input, baseBranch, commandRunner,
  } = args;
  const inputError = validateBaseSyncCompletionInput(input);
  if (inputError) return inputError;
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const mergeHead = await readImplementGitOid(repoRoot, "MERGE_HEAD", commandRunner)
    .catch(() => null);
  const prepared = mergeHead == null
    ? await prepareCommittedRetryCompletion(args)
    : await prepareMergeHeadCompletion(args);
  if (prepared.ok === false) return prepared;
  const { resultingFeatureSha } = prepared;
  let { verifiedTreeSha } = prepared;
  const { stdout: parentsOutput } = await runImplementGit(
    repoRoot,
    ["show", "-s", "--format=%P", resultingFeatureSha],
    commandRunner,
  );
  const parents = parentsOutput.trim().split(/\s+/);
  if (
    parents.length < 2
    || !parents.includes(input.preSyncSha)
    || !parents.includes(input.fetchedBaseSha)
  ) {
    return {
      ok: false,
      error: "implement_base_sync_graph_invalid",
      message: "The resulting commit does not preserve both feature and fetched-base parents",
      next_action: "inspect_the_merge_graph_without_rewriting_history",
    };
  }
  const committedTreeSha = await readImplementTreeOid(repoRoot, resultingFeatureSha, commandRunner);
  if (mergeHead == null) verifiedTreeSha = committedTreeSha;
  if (committedTreeSha !== verifiedTreeSha) {
    return {
      ok: false,
      error: "implement_base_sync_verified_tree_mismatch",
      message: "The merge commit tree does not equal the synchronized index tree",
      next_action: "inspect_the_merge_graph_without_rewriting_history",
    };
  }
  await runImplementGit(
    repoRoot,
    ["push", "origin", `refs/heads/${input.branchName}:refs/heads/${input.branchName}`],
    commandRunner,
  );
  if (!await verifyPublishedImplementHead(repoRoot, input.branchName, resultingFeatureSha, commandRunner)) {
    return {
      ok: false,
      error: "implement_base_sync_publish_mismatch",
      message: "The published feature head does not equal the synchronized merge result",
      next_action: "repair_the_ordinary_push_and_retry_completion",
    };
  }
  const binding = await resolveSyncDeliveryBinding(args, input.preSyncSha);
  if (!binding.ok) return binding;
  const record = {
    recordId: input.recordId, issueNumber: input.issueNumber, branchName: input.branchName,
    baseBranch, remoteRef, preSyncSha: input.preSyncSha, fetchedBaseSha: input.fetchedBaseSha,
    outcome: input.outcome, resultingFeatureSha, verifiedTreeSha, ...binding.binding,
  };
  return finalizeBaseSyncRecord({
    ...args,
    record,
  });
}
export const CONTROL_TEST_METHODOLOGIES = ["INQUIRY", "OBSERVATION", "INSPECTION", "RE_PERFORMANCE"];
export const CONTROL_TEST_CONCLUSIONS = ["EFFECTIVE", "INEFFECTIVE", "NOT_TESTED"];
