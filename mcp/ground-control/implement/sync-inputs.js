import {
  readImplementGitOid,
  runImplementGit,
} from "../lib/codex-workflow-2.js";
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
