// Extracted from gc-implement-mechanical.js (issue #1355).
//
// The module had reached 1,231 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md). gc-implement-mechanical.js remains the tool entry point.

import { commandFailure, failure, resolveIssueBranch } from "./gate-helpers.js";
import { isSensitivePublishPath, readPublishPaths, validateCommitMessage } from "./publish-inputs.js";

export async function runPublish(args, deps) {
  const action = "publish";
  const authorization = await deps.authorizeRepo(args.repoPath);
  if (!authorization.ok) {
    return failure(
      action,
      authorization.error,
      authorization.message,
      "repair_authorized_checkout_and_retry",
    );
  }
  const repoRoot = authorization.repoRoot;
  // The pre-publish hook command is repository configuration, so a broken
  // .ground-control.yaml must refuse here rather than silently fall back to
  // the default boundary command.
  const context = await deps.getContext(args.repoPath);
  if (context?.status !== "ok") {
    return failure(
      action,
      "implement_mechanical_context_invalid",
      context?.errors?.join("; ") ?? "Ground Control repository context is unavailable",
      "repair_ground_control_context_and_retry",
    );
  }
  const authorized = await deps.authorizeRequirementUid({
    repoPath: args.repoPath,
    issueNumber: args.issueNumber,
    requestedRequirementUid: args.requestedRequirementUid,
  });
  if (!authorized.ok) {
    return failure(action, authorized.error, authorized.message, authorized.next_action);
  }
  const { stdout: activeBranch } = await deps.runGit(
    repoRoot,
    ["branch", "--show-current"],
    deps.execFile,
  );
  const resolved = resolveIssueBranch({
    branchName: args.branchName,
    activeBranch,
    issueNumber: args.issueNumber,
    action,
  });
  if (!resolved.ok) return resolved.failure;
  const branchName = resolved.branchName;
  const publishPaths = await readPublishPaths(
    repoRoot,
    deps.runGit,
    deps.execFile,
  );
  const sensitivePath = publishPaths.find(isSensitivePublishPath);
  if (sensitivePath) {
    return failure(
      action,
      "implement_mechanical_sensitive_path_present",
      `Refusing to publish sensitive path '${sensitivePath}'`,
      "remove_the_sensitive_path_from_the_change_and_retry",
    );
  }
  // Cross-process mutation lease + write-ahead recovery journal (issue #1495).
  // The lease (per-worktree Git metadata, distinct from /integrate's repo-wide
  // lock) is held across every checkout mutation; the journal lets a later
  // attempt reconcile an interrupted publish instead of blindly re-staging it.
  const leaseDir = await resolvePublishLeaseDir(action, deps, repoRoot);
  if (leaseDir.failure) return leaseDir.failure;
  const gitDir = leaseDir.path;
  let releaseLease;
  try {
    releaseLease = await deps.acquirePublishLock(gitDir);
  } catch (error) {
    if (error?.code === "ELOCKED") {
      return failure(
        action,
        "implement_publish_lease_contended",
        "Another publish is already mutating this checkout",
        "wait_for_the_active_publish_to_finish_or_recover_it",
      );
    }
    return commandFailure(action, "lease", error);
  }
  try {
    // The synchronization-input (retry) path is the caller explicitly completing
    // a known staged merge, so reconciliation — which refuses on a staged merge —
    // runs only on the fresh path where a staged merge means an interrupted run.
    if (!args.synchronization) {
      const reconciled = await deps.reconcileInterruptedPublish({
        repoRoot,
        gitDir,
        branchName,
        issueNumber: args.issueNumber,
        commandRunner: deps.execFile,
      });
      if (reconciled.resolved) return reconciled.resolved;
      // The write-ahead journal is a precondition for mutating the checkout, not a
      // best-effort aid: if it cannot be established, refuse before touching the
      // tree so any later interruption always has an attributable recovery record.
      const journalError = recordPublishJournal(deps, gitDir, {
        issue_number: args.issueNumber,
        branch: branchName,
        base_branch: context?.workflow?.base_branch ?? "dev",
        pre_publish_head: await readPublishHead(deps, repoRoot),
        phase: "initializing",
      });
      if (journalError) return journalError;
    }
    const result = await runPublishMutation(args, deps, { repoRoot, branchName, context, authorized, publishPaths, gitDir });
    await finalizePublishJournal(deps, gitDir, repoRoot, result);
    return result;
  } finally {
    await releaseLease();
  }
}

// Resolve the per-worktree Git directory the lease and journal live under, mapping
// a resolution failure to a bounded refusal instead of throwing out of publish.
async function resolvePublishLeaseDir(action, deps, repoRoot) {
  try {
    return { path: await deps.resolvePublishGitDir(repoRoot, deps.execFile) };
  } catch (error) {
    return { failure: commandFailure(action, "resolve_git_dir", error) };
  }
}

async function readPublishHead(deps, repoRoot) {
  try {
    const { stdout } = await deps.runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], deps.execFile);
    const head = stdout.trim().toLowerCase();
    return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  } catch {
    // A brand-new branch may not have a HEAD commit yet.
    return null;
  }
}

// Advance the write-ahead journal before/after a mutating step. Returns null on
// success, or a bounded failure envelope when the journal cannot be written — the
// caller refuses to mutate (or to proceed) without an attributable recovery
// record rather than swallowing the failure (issue #1495).
function recordPublishJournal(deps, gitDir, fields) {
  try {
    deps.writePublishJournal(gitDir, fields);
    return null;
  } catch {
    return failure(
      "publish",
      "implement_publish_journal_write_failed",
      "Could not establish the write-ahead recovery journal in the Git metadata directory",
      "repair_the_git_metadata_directory_permissions_and_retry",
    );
  }
}

// Close the journal on a settled publish. A success clears it. A failure that left
// an interrupted merge (MERGE_HEAD present) keeps it for reconciliation; any other
// failure is ordinary repair-and-retry territory — a pre-commit failure, or a
// committed-but-unpushed feature — so the journal is cleared instead of poisoning
// the next attempt's reconciliation (issue #1495).
async function finalizePublishJournal(deps, gitDir, repoRoot, result) {
  if (result.ok) {
    deps.removePublishJournal(gitDir);
    return;
  }
  let mergeInProgress = false;
  try {
    const { stdout } = await deps.runGit(
      repoRoot,
      ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      deps.execFile,
    );
    mergeInProgress = stdout.trim() !== "";
  } catch {
    // `rev-parse --verify --quiet MERGE_HEAD` exits non-zero when no merge is in
    // progress — the ordinary, non-interrupted case.
    mergeInProgress = false;
  }
  if (!mergeInProgress) deps.removePublishJournal(gitDir);
}

function publishComplete(synchronization) {
  return {
    ok: true,
    action: "publish",
    phase: "publish_complete",
    synchronization,
    next_action: "render_and_create_the_synchronized_pr",
  };
}

function baseSyncFailure(sync) {
  return failure(
    "publish",
    sync.error,
    sync.message,
    sync.next_action ?? "repair_base_synchronization_and_retry",
    { synchronization: sync },
  );
}

async function runPublishMutation(args, deps, ctx) {
  if (args.synchronization) return runPublishSyncRetry(args, deps, ctx);
  const staged = await stageCommitAndPushFeature(args, deps, ctx);
  if (staged) return staged;
  return runFeatureBaseSync(args, deps, ctx);
}

// The synchronization-input path: the caller is completing a merge the previous
// attempt already staged, so this only re-stages, completes the sync, and returns.
async function runPublishSyncRetry(args, deps, { repoRoot, branchName, authorized, publishPaths }) {
  if (publishPaths.length > 0) {
    await deps.runGit(repoRoot, ["add", "-A"], deps.execFile);
  }
  const completed = await deps.synchronize({
    repoPath: repoRoot,
    issueNumber: args.issueNumber,
    branchName,
    action: "complete",
    recordId: args.synchronization.record_id,
    preSyncSha: args.synchronization.pre_sync_sha,
    fetchedBaseSha: args.synchronization.fetched_base_sha,
    outcome: args.synchronization.outcome,
    requestedRequirementUid: authorized.requirementUid,
  });
  if (!completed.ok) return baseSyncFailure(completed);
  return publishComplete(completed);
}

// Stage + pre-commit + commit the feature work (when there is any), then push it,
// journalling each mutating phase. Returns a bounded failure envelope on any gate
// failure, or null when the feature is committed and pushed.
async function stageCommitAndPushFeature(args, deps, { repoRoot, branchName, context, authorized, publishPaths, gitDir }) {
  const action = "publish";
  if (publishPaths.length > 0) {
    const messageError = validateCommitMessage(args.commitMessage);
    if (messageError) {
      return failure(action, "implement_mechanical_commit_message_invalid", messageError, "supply_a_safe_imperative_commit_message_and_retry");
    }
    await deps.runGit(repoRoot, ["add", "-A"], deps.execFile);
    const { stdout: stagedPaths } = await deps.runGit(repoRoot, ["diff", "--cached", "--name-only"], deps.execFile);
    if (stagedPaths.split(/\r?\n/).filter(Boolean).length === 0) {
      return failure(action, "implement_mechanical_nothing_to_commit", "No staged content changes are available to publish", "inspect_the_change_before_publishing");
    }
    try {
      await deps.preCommit(repoRoot, deps.execFile, context, authorized.requirementUid);
    } catch (error) {
      return commandFailure(action, "precommit", error);
    }
    let committed;
    try {
      committed = await deps.commit(repoRoot, ["-m", args.commitMessage], deps.execFile);
    } catch (error) {
      return commandFailure(action, "commit", error);
    }
    if (!committed.ok) {
      return failure(action, committed.error, committed.message, committed.next_action, { failed_stage: "commit" });
    }
    const committedJournal = recordPublishJournal(deps, gitDir, { phase: "feature_committed" });
    if (committedJournal) return committedJournal;
  }
  try {
    await deps.runGit(repoRoot, ["push", "-u", "origin", branchName], deps.execFile);
  } catch (error) {
    return commandFailure(action, "push", error);
  }
  return recordPublishJournal(deps, gitDir, {
    published_pre_sync_head: await readPublishHead(deps, repoRoot),
    phase: "feature_pushed",
  });
}

// Run base synchronization: start it, journal a staged merge, then complete it.
async function runFeatureBaseSync(args, deps, { repoRoot, branchName, authorized, gitDir }) {
  const action = "publish";
  const started = await deps.synchronize({
    repoPath: repoRoot,
    issueNumber: args.issueNumber,
    branchName,
    action: "start",
    requestedRequirementUid: authorized.requirementUid,
  });
  if (!started.ok) return baseSyncFailure(started);
  if (started.status === "complete") return publishComplete(started);
  if (started.status === "conflicts") {
    return failure(
      action,
      "implement_mechanical_merge_conflicts",
      "The freshly fetched integration branch conflicts with the feature branch",
      "resolve_every_conflict_then_retry_publish_completion",
      {
        synchronization: started,
        retry_input: {
          record_id: started.recordId,
          pre_sync_sha: started.preSyncSha,
          fetched_base_sha: started.fetchedBaseSha,
          outcome: started.outcome,
        },
      },
    );
  }
  if (started.status !== "merge_ready") {
    return failure(action, "implement_mechanical_sync_state_unknown", `Unexpected synchronization state '${started.status}'`, "inspect_the_preserved_synchronization_state", { synchronization: started });
  }
  // Record the staged-merge identities before the completion gates run, so an
  // interruption between here and the merge commit is recoverable through the
  // base-sync retry contract rather than an unattributable staged merge (#1495).
  const mergeStagedJournal = recordPublishJournal(deps, gitDir, {
    record_id: started.recordId,
    published_pre_sync_head: started.preSyncSha,
    fetched_base_sha: started.fetchedBaseSha,
    expected_merge_head: started.fetchedBaseSha,
    phase: "merge_staged",
  });
  if (mergeStagedJournal) return mergeStagedJournal;
  const completed = await deps.synchronize({
    repoPath: repoRoot,
    issueNumber: args.issueNumber,
    branchName,
    action: "complete",
    recordId: started.recordId,
    preSyncSha: started.preSyncSha,
    fetchedBaseSha: started.fetchedBaseSha,
    outcome: started.outcome,
    requestedRequirementUid: authorized.requirementUid,
  });
  if (!completed.ok) return baseSyncFailure(completed);
  return publishComplete(completed);
}
export { runMonitor } from "./monitor.js";
export { mapCompletion } from "../lib/completion-mapping.js";
