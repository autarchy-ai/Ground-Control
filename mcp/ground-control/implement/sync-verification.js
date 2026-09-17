import {
  readImplementGitOid,
  runImplementFinalTreeGates,
  runImplementGit,
} from "../lib/codex-workflow-2.js";
import { resolveVerificationReuse } from "../lib/verification-gates.js";
import { GIT_OBJECT_ID_RE } from "../lib/codex-workflow.js";

export function validateBaseSyncCompletionInput(input) {
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

export async function prepareCommittedRetryCompletion({ repoRoot, commandRunner }) {
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

export async function runCommittedRetryGates({
  repoRoot, input, context, commandRunner, authorizedRequirement,
  repoAuthorization, attestationReader, committedTreeSha,
}) {
  try {
    const reuse = await resolveVerificationReuse({
      context, repoRoot, owner: repoAuthorization.owner, name: repoAuthorization.name,
      issueNumber: input.issueNumber, branchName: input.branchName, baseSha: input.fetchedBaseSha,
      requirementUid: authorizedRequirement.requirementUid, commandRunner, attestationReader,
      treeOid: committedTreeSha,
    });
    if (reuse.reused) {
      return {
        treeOid: committedTreeSha,
        toolchainDigest: reuse.attestation.tool,
        verificationDecision: "reused",
        verificationReason: "trusted_attestation_match",
        broadGatesExecuted: 0,
      };
    }
    const phaseKey = reuse.attestation
      ? `${repoAuthorization.owner}/${repoAuthorization.name}:${reuse.attestation.id}`
      : null;
    const { treeOid, toolchainDigest, timings } = await runImplementFinalTreeGates(
      repoRoot,
      context,
      commandRunner,
      authorizedRequirement.requirementUid,
      phaseKey,
    );
    return {
      treeOid,
      toolchainDigest,
      verificationDecision: "executed",
      verificationReason: reuse.active ? "trusted_attestation_miss" : "verification_reuse_disabled",
      broadGatesExecuted: timings.filter(({ outcome }) => outcome !== "reused").length,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.code ?? "implement_base_sync_gate_failed",
      message: `The committed merge retry did not pass its completion boundary: ${error.message}`,
      next_action: "fix_the_preserved_checkout_and_retry_completion",
    };
  }
}
