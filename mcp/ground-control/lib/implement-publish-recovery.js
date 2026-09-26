// Bounded, attributable mechanical-publish recovery primitives (issue #1495).
//
// The async publish base-sync holds a staged merge across multi-minute
// final-tree gates. This module carries the compare-and-swap that keeps a
// resumed or restarted attempt from committing, pushing, or attributing a merge
// whose recorded identity no longer matches the checkout. It is the ref-level
// protection for the synchronization boundary:
// an external recovery can stage a different merge whose tree matches but whose
// parents do not, and only the refs reveal that.

import { readImplementGitOid, runImplementGit } from "./codex-workflow-2.js";
import { readImplementPublishJournal, removeImplementPublishJournal } from "./implement-recovery-journal.js";
import { execFileBounded } from "./bounded-exec.js";

// Compare the staged merge control state — MERGE_HEAD, the feature HEAD, and the
// unmerged index set — against the attempt the completion boundary is about to
// commit. Returns null when the state still matches the persisted attempt, or a
// bounded terminal failure envelope when it diverged. Runs before every mutating
// step so a checkout that changed under a long gate (or was recovered by an
// operator while the job was interrupted) is detected before, never after, a
// commit.
export async function assertImplementMergeAttemptUnchanged(
  repoRoot,
  { preSyncSha, fetchedBaseSha },
  commandRunner = execFileBounded,
) {
  const mergeHead = await readImplementGitOid(repoRoot, "MERGE_HEAD", commandRunner).catch(() => null);
  if (mergeHead !== fetchedBaseSha) {
    return {
      ok: false,
      error: "implement_base_sync_merge_head_mismatch",
      message: "MERGE_HEAD does not match the fetched integration commit",
      next_action: "return_to_the_synchronization_boundary",
    };
  }
  if ((await readImplementGitOid(repoRoot, "HEAD", commandRunner)) !== preSyncSha) {
    return {
      ok: false,
      error: "implement_base_sync_pre_merge_head_mismatch",
      message: "The merge started from a different feature commit",
      next_action: "inspect_the_preserved_merge_state",
    };
  }
  const { stdout: unmerged } = await runImplementGit(repoRoot, ["ls-files", "--unmerged"], commandRunner);
  if (unmerged.trim() !== "") {
    return {
      ok: false,
      error: "implement_base_sync_conflicts_unresolved",
      message: "Every merge conflict must be resolved before synchronization can complete",
      next_action: "resolve_every_conflict_and_retry",
    };
  }
  return null;
}

// The authorized per-worktree Git metadata directory. The publish lease and the
// recovery journal both live here, so a linked worktree is isolated from the
// common directory instead of serializing on it.
export async function resolvePublishGitDir(repoRoot, commandRunner = execFileBounded) {
  const { stdout } = await runImplementGit(repoRoot, ["rev-parse", "--absolute-git-dir"], commandRunner);
  const gitDir = stdout.trim();
  if (gitDir === "") throw new Error("Unable to resolve the per-worktree Git directory");
  return gitDir;
}

// Inspect a recovery journal left by an interrupted publish and decide, from Git
// state, whether it is safe to proceed. Conservative by construction: it never
// adopts a staged merge or deletes a mismatched or corrupt journal. Returns
// `{ proceed: true }` when there is nothing to recover (clearing a spent
// same-attempt journal on the way), or `{ resolved }` with a bounded terminal
// envelope the caller returns unchanged (issue #1495).
export async function reconcileInterruptedPublish({ repoRoot, gitDir, branchName, issueNumber, commandRunner = execFileBounded }) {
  const journal = readImplementPublishJournal(gitDir);
  if (!journal.ok) {
    return { resolved: {
      ok: false,
      action: "publish",
      error: "implement_publish_recovery_journal_corrupt",
      message: `A publish recovery journal is present but unreadable (${journal.error}); it is preserved for inspection`,
      agent_required: true,
      next_action: "inspect_the_preserved_publish_recovery_journal",
    } };
  }
  if (!journal.present) return { proceed: true };
  const record = journal.record;
  if (record.issue_number !== issueNumber || record.branch !== branchName) {
    return { resolved: {
      ok: false,
      action: "publish",
      error: "implement_publish_recovery_journal_foreign",
      message: "A publish recovery journal for a different issue or branch is present; refusing to act on another attempt's checkout",
      agent_required: true,
      next_action: "inspect_the_preserved_publish_recovery_journal",
    } };
  }
  const mergeHead = await readImplementGitOid(repoRoot, "MERGE_HEAD", commandRunner).catch(() => null);
  if (mergeHead != null) {
    const head = await readImplementGitOid(repoRoot, "HEAD", commandRunner).catch(() => null);
    // A staged merge that matches the recorded attempt exactly can be completed
    // through the existing base-sync retry contract; hand back the retry handle so
    // the caller resumes it. base-sync completion still re-validates HEAD,
    // MERGE_HEAD, the merge parents, and the final tree, so the handle cannot skip
    // any check. Any mismatch is a bounded refusal that preserves the checkout.
    if (
      record.record_id != null
      && record.published_pre_sync_head != null
      && record.fetched_base_sha === mergeHead
      && record.expected_merge_head === mergeHead
      && head === record.published_pre_sync_head
    ) {
      return { resolved: {
        ok: false,
        action: "publish",
        error: "implement_publish_interrupted_merge_present",
        message: "An interrupted publish left its recorded staged merge; complete it through the synchronization retry contract",
        agent_required: true,
        next_action: "complete_the_preserved_synchronization_then_retry_publish",
        retry_input: {
          record_id: record.record_id,
          pre_sync_sha: record.published_pre_sync_head,
          fetched_base_sha: record.fetched_base_sha,
          outcome: "merged_conflicts_resolved",
        },
        recovery: { merge_head_present: true, matches_recorded_attempt: true },
      } };
    }
    return { resolved: {
      ok: false,
      action: "publish",
      error: "implement_publish_interrupted_merge_present",
      message: "An interrupted publish left a staged merge that does not match its recovery journal; resolve it by hand, then remove the recovery journal",
      agent_required: true,
      next_action: "resolve_the_preserved_merge_then_retry_publish",
      recovery: { merge_head_present: true, matches_recorded_attempt: false },
    } };
  }
  // No operation head remains. A dirty-but-not-merging tree is ordinary
  // repair-and-retry territory — the user's own uncommitted work, or a committed
  // feature that was never pushed — not an interrupted merge. Refusing it would
  // poison the normal retry flow (a pre-commit failure leaves exactly this state),
  // so clear the spent journal and let a fresh publish proceed. The base-sync
  // dirty-tree guard and compare-and-swap remain the authoritative safety net if
  // real interrupted state is actually present.
  removeImplementPublishJournal(gitDir);
  return { proceed: true };
}
