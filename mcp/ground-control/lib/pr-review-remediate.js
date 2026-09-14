// Maintainer PR-review lane — authorized same-checkout remediation (issue #1535).
//
// This is the ONLY mutation surface of the review lane, and it is a separate
// tool from the read-only context reader by design: a review-only caller cannot
// reach a mutation by flipping an action field. Every action requires an
// explicit `authorization` (the user's change request) and echoes the reviewed
// PR identity, which is re-validated against the LIVE pull request and the local
// checkout before anything is touched. There is no durable state between calls;
// the reviewed OIDs plus a live re-read are the binding, so a stale or
// mistargeted authorization is refused rather than applied.
//
// Invariants (preflight architecture/notes/maintainer-pr-review-skill-preflight.md):
// stay in the invocation checkout on the existing PR branch; update a stale
// branch with a real `--no-ff` merge of the integration branch; never rebase,
// reset, squash, force-push, create a worktree, or auto-pick a conflict side;
// push non-force to the same branch bound to the reviewed remote head; and post
// at most one succinct neutral PR comment only after a successful push.

import { getRepoGroundControlContext } from "./repo-vocabulary-2.js";
import {
  authorizeImplementMutationCheckout,
  fetchImplementBase,
  isImplementAncestor,
  readImplementGitOid,
  runImplementGit,
} from "./codex-workflow-2.js";
import { runImplementCommit } from "./implement-commit.js";
import { fetchPullRequest } from "./github-rest.js";
import { getOwnerRepo } from "./grc-legacy-compat-3.js";
import { resolveMcpLaunchWorkspaceAuthorization } from "./grc-legacy-compat-4.js";
import { execFile } from "./runtime-primitives.js";
import {
  PR_REVIEW_ACTIONS,
  refusal,
  validateAuthorization,
  validatePrNumber,
  validateRepoPath,
  validateReviewedIdentity,
} from "./pr-review-shared.js";
import { runRemediationPublish } from "./pr-review-remediate-publish.js";
import { assertRemediationConfirmed, resolveActorRepoPermission } from "./pr-review-confirm.js";

// Read the live PR over REST through the injected runner (issue #1586: the
// shared GraphQL budget must not gate remediation). Returns a normalized
// identity or a structured refusal — never a raw gh error.
export async function readLivePullRequest(repoRoot, owner, name, prNumber, commandRunner) {
  let pr = null;
  try {
    pr = await fetchPullRequest(repoRoot, owner, name, prNumber, { execFile: commandRunner });
  } catch {
    pr = null;
  }
  if (pr == null) {
    return { ok: false, refusal: refusal("pr_remediation_pr_unavailable", `Pull request #${prNumber} could not be read`) };
  }
  return {
    ok: true,
    live: {
      state: pr.state ?? null,
      head_ref: pr.headRefName ?? null,
      head_oid: typeof pr.headRefOid === "string" ? pr.headRefOid.toLowerCase() : null,
      base_ref: pr.baseRefName ?? null,
      base_oid: typeof pr.baseRefOid === "string" ? pr.baseRefOid.toLowerCase() : null,
      cross_repository: pr.isCrossRepository === true,
      head_repository_deleted: pr.headRepository == null,
      maintainer_can_modify: pr.maintainerCanModify === true,
      merged_at: pr.mergedAt ?? null,
      url: pr.url ?? null,
    },
  };
}

// Only an open PR is remediable. Pushing to the head branch of a merged or
// closed PR changes nothing that will ship and would strand the commits.
export function assertPullRequestOpen(live) {
  if (live.state === "OPEN") return { ok: true };
  return refusal(
    "pr_remediation_pr_not_open",
    `The pull request is ${String(live.state).toLowerCase()}; only an open pull request can be remediated`,
    { pr_state: live.state, next_action: "stop_the_pull_request_is_not_open" },
  );
}

// The reviewed branch/base/cross-repo identity must still describe the live PR
// (applies to every action). A branch name is a stale-prone alias; it is checked
// alongside the OID bindings below.
export function assertReviewedRefsCurrent(reviewed, live) {
  if (live.head_ref !== reviewed.head_ref || live.base_ref !== reviewed.base_ref) {
    return refusal(
      "pr_remediation_stale_authorization",
      "The PR's base or head branch changed since the review; re-review before remediating",
      { next_action: "re_review_the_pull_request" },
    );
  }
  if (live.cross_repository !== reviewed.cross_repository) {
    return refusal("pr_remediation_stale_authorization", "The PR cross-repository status changed since the review");
  }
  return { ok: true };
}

// Compare-and-swap the reviewed remote head against the live PR. Applies to
// sync_base and publish, where the remote head must NOT have advanced since the
// review (someone else pushing is a re-review trigger). It does NOT apply to
// comment, which legitimately runs after publish advanced the head and proves a
// landed remediation through its own publish-evidence check.
export function assertReviewedHeadUnchanged(reviewed, live) {
  if (live.head_oid !== reviewed.head_oid) {
    return refusal(
      "pr_remediation_remote_head_moved",
      "The PR head advanced since the review; re-review the new commits before remediating",
      { next_action: "re_review_the_pull_request" },
    );
  }
  return { ok: true };
}

// Fork gate. In-place remediation is supported only for same-repository PRs.
// A cross-repository (fork) PR is refused: safely binding a push to the
// contributor's fork requires resolving and verifying the exact head-repository
// remote, and the reviewed checkout's configured remotes cannot be trusted to
// point there (codex F1/F7, #1535). A same-repo checkout writes only to the
// authorized origin. Fork PRs are merged manually or the contributor applies the
// change; this mirrors the /integrate first-slice `fork_pr_unsupported` contract.
export function assertHeadWritable(live) {
  if (!live.cross_repository) return { ok: true };
  return refusal(
    "pr_remediation_fork_pr_unsupported",
    "In-place remediation is not supported for cross-repository (fork) pull requests; "
      + "merge the PR manually or ask the contributor to apply the change",
    { next_action: "merge_manually_or_ask_the_contributor" },
  );
}

// The checkout must be on the reviewed PR head branch and on the reviewed
// lineage: the reviewed head OID must equal or be an ancestor of the local HEAD.
// Equality is the pristine start; a descendant is a checkout the remediation
// itself already advanced (a committed integration merge). Anything off that
// lineage is a different or wrong checkout and is refused. Working-tree
// cleanliness is NOT asserted here — `publish` legitimately carries staged fixes
// — it is enforced only for a fresh `sync_base` merge.
export async function assertRemediationCheckout(repoRoot, reviewed, commandRunner) {
  let activeBranch;
  try {
    const { stdout } = await runImplementGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], commandRunner);
    activeBranch = stdout.trim();
  } catch {
    return refusal("pr_remediation_detached_head", "The checkout is in a detached-HEAD state; check the PR branch out first",
      { next_action: "checkout_the_pr_branch" });
  }
  if (activeBranch !== reviewed.head_ref) {
    return refusal(
      "pr_remediation_wrong_branch",
      `The checkout is on '${activeBranch}', not the PR head branch '${reviewed.head_ref}'`,
      { next_action: "checkout_the_pr_branch" },
    );
  }
  let localHead;
  try {
    localHead = await readImplementGitOid(repoRoot, "HEAD", commandRunner);
  } catch (error) {
    return refusal("pr_remediation_local_head_unreadable", error.message);
  }
  if (!(await isImplementAncestor(repoRoot, reviewed.head_oid, localHead, commandRunner))) {
    return refusal(
      "pr_remediation_local_head_mismatch",
      "The checked-out commit is not on the reviewed PR head lineage; check the PR branch out at its head before remediating",
      { next_action: "checkout_the_pr_branch_at_its_head" },
    );
  }
  return { ok: true };
}

// {inProgress, unmergedPaths} — is there an uncommitted merge, and does it still
// have conflicts?
export async function readMergeState(repoRoot, commandRunner) {
  let inProgress = false;
  try {
    await readImplementGitOid(repoRoot, "MERGE_HEAD", commandRunner);
    inProgress = true;
  } catch {
    inProgress = false;
  }
  const { stdout } = await runImplementGit(repoRoot, ["ls-files", "--unmerged"], commandRunner);
  const unmergedPaths = [...new Set(
    stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split("\t").pop()),
  )];
  return { inProgress, unmergedPaths };
}

// Resolves `{ headAfter }`, or `{ failure }` when a host-required signature could
// not be produced (issue #1580); the merge state stays preserved for a retry.
async function commitMerge(repoRoot, commandRunner) {
  const committed = await runImplementCommit(repoRoot, ["--no-edit"], commandRunner);
  if (!committed.ok) return { failure: committed };
  return { headAfter: await readImplementGitOid(repoRoot, "HEAD", commandRunner) };
}

async function runSyncBase(repoRoot, reviewed, live, commandRunner, contextResolver) {
  // The PR base must match the repository's configured integration branch when
  // one is configured; a PR targeting another branch is a consultation stop, not
  // a silent merge of an arbitrary branch (codex cycle-2 F1, #1535).
  let context;
  try {
    context = await contextResolver(repoRoot);
  } catch (error) {
    return refusal("pr_remediation_context_unavailable", error.message);
  }
  const configuredBase = context?.status === "ok" ? context?.workflow?.base_branch : null;
  if (typeof configuredBase === "string" && configuredBase !== "" && configuredBase !== reviewed.base_ref) {
    return refusal(
      "pr_remediation_base_branch_mismatch",
      `The PR targets '${reviewed.base_ref}', not the configured integration branch '${configuredBase}'; `
        + "resolve the base mismatch before remediating",
      { configured_base_branch: configuredBase, pr_base_ref: reviewed.base_ref, next_action: "consult_the_maintainer_about_the_pr_base" },
    );
  }

  const merge = await readMergeState(repoRoot, commandRunner);
  if (merge.inProgress) {
    if (merge.unmergedPaths.length > 0) {
      return refusal(
        "pr_remediation_merge_conflicts",
        "The in-progress integration merge still has conflicts to resolve in the working tree",
        { unmerged_files: merge.unmergedPaths, next_action: "resolve_conflicts_stage_them_then_call_sync_base_again" },
      );
    }
    const merged = await commitMerge(repoRoot, commandRunner);
    if (merged.failure) return merged.failure;
    return { ok: true, action: "sync_base", outcome: "merged_conflicts_resolved", head_oid_after: merged.headAfter };
  }

  // A fresh integration merge needs a clean tree: merging over unrelated
  // in-progress work would entangle it with the merge commit.
  const { stdout: status } = await runImplementGit(
    repoRoot, ["status", "--porcelain=v1", "--untracked-files=normal"], commandRunner,
  );
  if (status.trim() !== "") {
    return refusal("pr_remediation_dirty_tree", "The checkout has uncommitted changes; commit or stash them before synchronizing",
      { next_action: "clean_the_working_tree" });
  }

  let fetched;
  try {
    fetched = await fetchImplementBase(repoRoot, reviewed.base_ref, commandRunner);
  } catch (error) {
    return refusal("pr_remediation_base_fetch_failed", `The integration branch '${reviewed.base_ref}' could not be fetched: ${error.message}`);
  }
  const localHead = await readImplementGitOid(repoRoot, "HEAD", commandRunner);
  if (await isImplementAncestor(repoRoot, fetched.fetchedBaseSha, localHead, commandRunner)) {
    return { ok: true, action: "sync_base", outcome: "already_current", head_oid_after: localHead, fetched_base_sha: fetched.fetchedBaseSha };
  }
  try {
    await runImplementGit(repoRoot, ["merge", "--no-ff", "--no-commit", fetched.remoteRef], commandRunner);
  } catch (error) {
    const after = await readMergeState(repoRoot, commandRunner);
    if (after.inProgress && after.unmergedPaths.length > 0) {
      return refusal(
        "pr_remediation_merge_conflicts",
        "Merging the integration branch produced conflicts to resolve in the working tree",
        { unmerged_files: after.unmergedPaths, next_action: "resolve_conflicts_stage_them_then_call_sync_base_again" },
      );
    }
    return refusal("pr_remediation_merge_failed", `The integration merge failed: ${error.message}`);
  }
  const merged = await commitMerge(repoRoot, commandRunner);
  if (merged.failure) return merged.failure;
  return {
    ok: true, action: "sync_base", outcome: "merged_clean",
    head_oid_after: merged.headAfter, fetched_base_sha: fetched.fetchedBaseSha,
  };
}

export async function runRemediatePullRequest(input, {
  commandRunner = execFile,
  workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
  contextResolver = getRepoGroundControlContext,
  permissionResolver = resolveActorRepoPermission,
} = {}) {
  const { repoPath, prNumber, action, authorization, reviewedIdentity } = input ?? {};

  if (!PR_REVIEW_ACTIONS.includes(action)) {
    return refusal("pr_remediation_action_invalid", `action must be one of: ${PR_REVIEW_ACTIONS.join(", ")}`);
  }
  for (const check of [
    validateRepoPath(repoPath),
    validatePrNumber(prNumber),
    validateAuthorization(authorization),
    validateReviewedIdentity(reviewedIdentity),
  ]) {
    if (!check.ok) return check;
  }

  const auth = await authorizeImplementMutationCheckout(repoPath, { workspaceAuthorizationResolver });
  if (!auth.ok) return auth;
  const { repoRoot } = auth;
  let owner;
  let name;
  try {
    ({ owner, name } = await getOwnerRepo(repoRoot, { allowGhFallback: false }));
  } catch (error) {
    return refusal("pr_remediation_repo_identity_unverifiable", `Repository identity could not be verified: ${error.message}`);
  }

  const liveResult = await readLivePullRequest(repoRoot, owner, name, prNumber, commandRunner);
  if (!liveResult.ok) return liveResult.refusal;
  const { live } = liveResult;

  const open = assertPullRequestOpen(live);
  if (!open.ok) return open;

  const refsCurrent = assertReviewedRefsCurrent(reviewedIdentity, live);
  if (!refsCurrent.ok) return refsCurrent;

  // Trusted-host confirmation: a write-permission PR review bound to the reviewed
  // head OID (by GitHub's trusted commit_id) that the model cannot forge gates
  // every mutation (codex F6 / cycle-3 F5, #1535). The `authorization` string
  // remains as recorded human-readable intent, not as the proof.
  const confirmed = await assertRemediationConfirmed({
    repoRoot, owner, name, prNumber, reviewedHeadOid: reviewedIdentity.head_oid,
    commandRunner, permissionResolver,
  });
  if (!confirmed.ok) return confirmed;

  const headUnchanged = assertReviewedHeadUnchanged(reviewedIdentity, live);
  if (!headUnchanged.ok) return headUnchanged;

  const writable = assertHeadWritable(live);
  if (!writable.ok) return writable;

  const checkout = await assertRemediationCheckout(repoRoot, reviewedIdentity, commandRunner);
  if (!checkout.ok) return checkout;

  if (action === "sync_base") {
    return runSyncBase(repoRoot, reviewedIdentity, live, commandRunner, contextResolver);
  }
  // action === "publish" (also posts the optional bound comment after the push).
  return runRemediationPublish({
    repoRoot, owner, name, prNumber, input, reviewed: reviewedIdentity, live, commandRunner,
  });
}
