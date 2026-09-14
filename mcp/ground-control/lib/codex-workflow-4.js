// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { realpathSync } from "node:fs";
import { assertImplementSyncCheckout, fetchImplementBase, isImplementAncestor, readImplementGitOid, readImplementTreeOid, runImplementFinalTreeGates, runImplementGit } from "./codex-workflow-2.js";
import { assertImplementMergeAttemptUnchanged } from "./implement-publish-recovery.js";
import { authorizeRequestedRequirementUid } from "./codex-workflow-3.js";
import { GIT_OBJECT_ID_RE, IMPLEMENT_BASE_SYNC_ACTIONS, newImplementSyncRecordId, validateImplementBranchName } from "./codex-workflow.js";
import { assertSafeImplementCheckoutConfiguration, authorizeImplementRepoRoot, ensureGitRepo, resolveMcpLaunchWorkspaceAuthorization } from "./grc-legacy-compat-4.js";
import { runGetIssueThread } from "./issue-thread.js";
import { postImplementBaseSyncRecord, postImplementVerificationAttestation, readTrustedImplementSyncRecord, readTrustedImplementVerificationAttestations, verifyPublishedImplementHead } from "./knowledge-capture.js";
import { isSafeGitRefName, resolveWorkflowPolicyCommand } from "./repo-context.js";
import { getRepoGroundControlContext } from "./repo-vocabulary-2.js";
import { execFile } from "./runtime-primitives.js";
import { postFreshVerificationAttestation, resolveVerificationReuse } from "./verification-gates.js";

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
  attestationReader = readTrustedImplementVerificationAttestations,
  attestationWriter = postImplementVerificationAttestation,
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
  // defaults: the base branch and the policy command both come from it, and a
  // silent default here would fetch, merge, and gate against the wrong
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
      repoAuthorization, authorizedRequirement, attestationReader, attestationWriter,
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
// already-current head takes the reuse path; otherwise a merge is staged.
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
// published, reuse or refresh the attestation, then post the record.
async function runBaseSyncAlreadyCurrent(args) {
  const {
    repoRoot, input, context, baseBranch, commandRunner,
    repoAuthorization, authorizedRequirement, attestationReader, attestationWriter,
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
  // Tiered verification reuse (issue #1497). An already-current tree may
  // skip the authoritative gates only when a trusted attestation proves
  // THIS exact tree passed them. Feature-off keeps the prior behavior; a
  // miss (e.g. a post-verify review fix) re-runs full verification here
  // rather than trusting an unverified tree, then attests the result.
  const reuse = await resolveVerificationReuse({
    context, repoRoot, owner: repoAuthorization.owner, name: repoAuthorization.name,
    issueNumber: input.issueNumber, branchName: input.branchName, baseSha: fetchedBaseSha,
    requirementUid: authorizedRequirement.requirementUid, commandRunner, attestationReader,
  });
  if (reuse.active && !reuse.reused) {
    let verifiedTree;
    let verifiedToolchain;
    try {
      ({ treeOid: verifiedTree, toolchainDigest: verifiedToolchain } =
        await runImplementFinalTreeGates(repoRoot, context, commandRunner, authorizedRequirement.requirementUid));
    } catch (error) {
      return {
        ok: false,
        error: error.code ?? "implement_base_sync_gate_failed",
        message: `The already-current feature tree did not pass verification: ${error.message}`,
        next_action: "fix_the_checkout_and_retry_completion",
      };
    }
    // Attest the tree and toolchain the boundary just proved stable — never
    // recomputed here — so the record binds exactly the content that passed.
    await postFreshVerificationAttestation({
      context, repoRoot, owner: repoAuthorization.owner, name: repoAuthorization.name,
      issueNumber: input.issueNumber, branchName: input.branchName, baseSha: fetchedBaseSha,
      treeOid: verifiedTree, toolchainDigest: verifiedToolchain,
      requirementUid: authorizedRequirement.requirementUid,
      commandRunner, attestationReader, attestationWriter,
    });
  }
  const record = {
    recordId, issueNumber: input.issueNumber, branchName: input.branchName,
    baseBranch, remoteRef, preSyncSha, fetchedBaseSha,
    outcome: "already_current", resultingFeatureSha: preSyncSha,
    verifiedTreeSha: await readImplementTreeOid(repoRoot, "HEAD", commandRunner),
  };
  const posted = await postImplementBaseSyncRecord(
    repoRoot, repoAuthorization.owner, repoAuthorization.name, record, commandRunner,
  );
  return { ok: true, status: "complete", ...record, ...posted };
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
      next_action: "run_final_tree_gates_then_complete_sync",
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

// Validate the completion input echoed back from `start`. Returns a terminal
// envelope on any malformed field, or null when the completion may proceed.
function validateBaseSyncCompletionInput(input) {
  if (
    typeof input.recordId !== "string"
    || !/^[0-9a-f]{32}$/.test(input.recordId)
    || !GIT_OBJECT_ID_RE.test(input.preSyncSha ?? "")
    || !GIT_OBJECT_ID_RE.test(input.fetchedBaseSha ?? "")
    || !["merged_clean", "merged_conflicts_resolved"].includes(input.outcome)
  ) {
    return {
      ok: false,
      error: "implement_base_sync_completion_input_invalid",
      message: "complete requires the record ID, pre-sync SHA, fetched base SHA, and merge outcome returned by start",
    };
  }
  return null;
}

// A staged merge (MERGE_HEAD present) is committed here. The compare-and-swap
// runs before the gates AND again immediately before the commit; the final-tree
// gates run between. Returns the head plus verified tree/toolchain, or a terminal envelope.
async function prepareMergeHeadCompletion(args) {
  const { repoRoot, input, context, baseBranch, commandRunner, authorizedRequirement } = args;
  const preGate = await assertImplementMergeAttemptUnchanged(repoRoot, input, commandRunner);
  if (preGate) return preGate;
  let verifiedTreeSha;
  let verifiedToolchainDigest;
  try {
    ({ treeOid: verifiedTreeSha, toolchainDigest: verifiedToolchainDigest } =
      await runImplementFinalTreeGates(repoRoot, context, commandRunner, authorizedRequirement.requirementUid));
  } catch (error) {
    return {
      ok: false,
      error: error.code ?? "implement_base_sync_gate_failed",
      message: `The final merged tree did not pass its completion boundary: ${error.message}`,
      next_action: "fix_the_preserved_merge_tree_and_retry_completion",
    };
  }
  // The final-tree gates run for minutes. Re-read the merge control state
  // immediately before the commit so an external recovery that aborted this
  // merge and staged a different one — same tree, different parents — under
  // the boundary is refused without mutation (issue #1495).
  const preCommit = await assertImplementMergeAttemptUnchanged(repoRoot, input, commandRunner);
  if (preCommit) return preCommit;
  await runImplementGit(
    repoRoot,
    ["commit", "-m", `Merge origin/${baseBranch} into ${input.branchName}`],
    commandRunner,
  );
  const resultingFeatureSha = await readImplementGitOid(repoRoot, "HEAD", commandRunner);
  return { resultingFeatureSha, verifiedTreeSha, verifiedToolchainDigest };
}

// No MERGE_HEAD: the completion is resuming a merge already committed by an
// earlier attempt. The checkout must be clean. Returns the resulting head, or a
// terminal envelope; the final-tree gates run later, after the parents validate.
async function prepareCommittedRetryCompletion({ repoRoot, commandRunner }) {
  const resultingFeatureSha = await readImplementGitOid(repoRoot, "HEAD", commandRunner);
  const { stdout: status } = await runImplementGit(
    repoRoot,
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    commandRunner,
  );
  if (status.trim() !== "") {
    return {
      ok: false,
      error: "implement_base_sync_retry_tree_dirty",
      message: "A committed synchronization retry requires a clean checkout",
      next_action: "inspect_the_preserved_checkout_and_retry",
    };
  }
  return { resultingFeatureSha };
}

// Run the final-tree gates for the committed-retry path. Returns the verified
// tree/toolchain, or a terminal envelope (`ok === false`).
async function runCommittedRetryGates({ repoRoot, context, commandRunner, authorizedRequirement }) {
  try {
    const { treeOid, toolchainDigest } =
      await runImplementFinalTreeGates(repoRoot, context, commandRunner, authorizedRequirement.requirementUid);
    return { treeOid, toolchainDigest };
  } catch (error) {
    return {
      ok: false,
      error: error.code ?? "implement_base_sync_gate_failed",
      message: `The committed merge retry did not pass its completion boundary: ${error.message}`,
      next_action: "fix_the_preserved_checkout_and_retry_completion",
    };
  }
}

// Read or post the durable synchronization record, then build the terminal
// completion envelope. An existing record must match field for field.
async function finalizeBaseSyncRecord(args) {
  const { repoRoot, input, context, commandRunner, repoAuthorization, record, syncRecordReader } = args;
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
      "verifiedTreeSha",
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
    // Name the gate that actually ran. `policy_command` is repository
    // configuration, so a caller/operator can see when a branch has pointed
    // the mandatory gate somewhere other than the repository default. Kept
    // out of `record` deliberately: the durable issue-thread marker carries
    // Git identity, not command text.
    policyCommand: resolveWorkflowPolicyCommand(context),
  };
}

// `action === "complete"`: commit or adopt the staged/committed merge, validate
// the merge graph and verified tree, attest, push, confirm the head, and record.
async function runBaseSyncComplete(args) {
  const {
    repoRoot, input, context, baseBranch, commandRunner,
    repoAuthorization, authorizedRequirement, attestationReader, attestationWriter,
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
  let { resultingFeatureSha, verifiedTreeSha, verifiedToolchainDigest } = prepared;
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
  if (mergeHead == null) {
    const gates = await runCommittedRetryGates(args);
    if (gates.ok === false) return gates;
    ({ treeOid: verifiedTreeSha, toolchainDigest: verifiedToolchainDigest } = gates);
  }
  if (committedTreeSha !== verifiedTreeSha) {
    return {
      ok: false,
      error: "implement_base_sync_verified_tree_mismatch",
      message: "The merge commit tree does not equal the tree that passed the final gates",
      next_action: "inspect_the_merge_graph_without_rewriting_history",
    };
  }
  // Attest the merged tree that just passed the shared full-verification path
  // (issue #1497), so a retry or re-invocation reuses it instead of gating the
  // identical tree again. Best-effort and gated on the feature being active.
  await postFreshVerificationAttestation({
    context, repoRoot, owner: repoAuthorization.owner, name: repoAuthorization.name,
    issueNumber: input.issueNumber, branchName: input.branchName, baseSha: input.fetchedBaseSha,
    treeOid: verifiedTreeSha, toolchainDigest: verifiedToolchainDigest,
    requirementUid: authorizedRequirement.requirementUid,
    commandRunner, attestationReader, attestationWriter,
  });
  await runImplementGit(
    repoRoot,
    ["push", "origin", `refs/heads/${input.branchName}:refs/heads/${input.branchName}`],
    commandRunner,
  );
  if (!await verifyPublishedImplementHead(repoRoot, input.branchName, resultingFeatureSha, commandRunner)) {
    return {
      ok: false,
      error: "implement_base_sync_publish_mismatch",
      message: "The published feature head does not equal the verified merge result",
      next_action: "repair_the_ordinary_push_and_retry_completion",
    };
  }
  const record = {
    recordId: input.recordId, issueNumber: input.issueNumber, branchName: input.branchName,
    baseBranch, remoteRef, preSyncSha: input.preSyncSha, fetchedBaseSha: input.fetchedBaseSha,
    outcome: input.outcome, resultingFeatureSha, verifiedTreeSha,
  };
  return finalizeBaseSyncRecord({ ...args, record });
}
export const CONTROL_TEST_METHODOLOGIES = ["INQUIRY", "OBSERVATION", "INSPECTION", "RE_PERFORMANCE"];
export const CONTROL_TEST_CONCLUSIONS = ["EFFECTIVE", "INEFFECTIVE", "NOT_TESTED"];
