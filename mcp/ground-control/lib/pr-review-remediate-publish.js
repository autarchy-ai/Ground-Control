// Maintainer PR-review lane - publish remediation action (issue #1535).
//
// Split from pr-review-remediate.js for the 500-LOC limit (ADR-092). `publish`
// owns staging (the skill never runs git - codex F2), stages the exact tree it
// commits (codex F4/F8), re-fetches the base immediately before the push (codex
// cycle-2 F4), pushes with an explicit compare-and-swap bound to the reviewed
// remote head (a lease-guarded fast-forward - codex cycle-3 F1), and - because
// the checkout holds contributor-authored content - does NOT run the repo's gate
// commands in the privileged host (codex cycle-2 F5); verification is the PR's
// own isolated CI. The optional remediation comment is posted BY this same call
// after a successful push, so it is causally bound to the publish (a server-owned
// receipt) rather than a caller-echoed claim (codex cycle-3 F1).

import {
  fetchImplementBase,
  isImplementAncestor,
  readImplementGitOid,
  runImplementGit,
} from "./codex-workflow-2.js";
import { runImplementCommit } from "./implement-commit.js";
import { detectSensitiveBodyContent, extractGhErrorMessage } from "./grc-legacy-compat-2.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX, rejectReservedMarkerSequence } from "./repo-vocabulary.js";
import { refusal, runReviewGh, runReviewGhPaginated } from "./pr-review-shared.js";

const COMMIT_MESSAGE_MAX = 500;

// Public text and commit messages are model-controlled. Scrub for secrets,
// reserved markers, and size before they reach Git history or the issue thread.
function validatePublicText(text, field, code, maxBytes) {
  if (typeof text !== "string" || text.trim() === "") {
    return refusal(`${code}_missing`, `${field} is required`);
  }
  const marker = rejectReservedMarkerSequence(text, field);
  if (marker != null) return refusal(`${code}_rejected`, marker);
  const sensitive = detectSensitiveBodyContent(text);
  if (sensitive != null) return refusal(`${code}_rejected`, sensitive);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return refusal(`${code}_too_large`, `${field} exceeds the ${maxBytes}-byte limit`);
  }
  return { ok: true };
}

async function hasStagedChanges(repoRoot, commandRunner) {
  const { stdout } = await runImplementGit(repoRoot, ["status", "--porcelain=v1"], commandRunner);
  return stdout.split(/\r?\n/).some((line) => line !== "" && line[0] !== " " && line[0] !== "?");
}

async function readMergeInProgress(repoRoot, commandRunner) {
  try {
    await readImplementGitOid(repoRoot, "MERGE_HEAD", commandRunner);
    return true;
  } catch {
    return false;
  }
}

// Best-effort content idempotency: if this exact summary is already on the PR, a
// re-run does not double-post (codex F3). Read paginated so busy PRs work.
async function findExistingComment(repoRoot, owner, name, prNumber, body, commandRunner) {
  try {
    const comments = await runReviewGhPaginated(repoRoot, `/repos/${owner}/${name}/issues/${prNumber}/comments`, commandRunner);
    if (!Array.isArray(comments)) return null;
    return comments.find((c) => typeof c?.body === "string" && c.body === body) ?? null;
  } catch {
    return null;
  }
}

// Post the optional remediation summary. Called only after a successful push, so
// the comment is bound to the publish that produced it.
async function postBoundComment(repoRoot, owner, name, prNumber, body, commandRunner) {
  const bodyCheck = validatePublicText(body, "comment_body", "pr_remediation_comment", GITHUB_ISSUE_COMMENT_BODY_MAX);
  if (!bodyCheck.ok) return { ok: false, error: bodyCheck.error, message: bodyCheck.message };
  const existing = await findExistingComment(repoRoot, owner, name, prNumber, body, commandRunner);
  if (existing) return { ok: true, comment_url: existing.html_url ?? null, comment_id: existing.id ?? null, idempotent: true };
  try {
    const { stdout } = await runReviewGh(
      repoRoot,
      ["api", "--method", "POST", `/repos/${owner}/${name}/issues/${prNumber}/comments`, "-f", `body=${body}`],
      commandRunner,
    );
    const posted = JSON.parse(stdout);
    return { ok: true, comment_url: posted.html_url ?? null, comment_id: posted.id ?? null };
  } catch (error) {
    return { ok: false, error: "pr_remediation_comment_failed", detail: extractGhErrorMessage(error).slice(0, 300) };
  }
}

export async function runRemediationPublish({ repoRoot, owner, name, prNumber, input, reviewed, live, commandRunner }) {
  const messageCheck = validatePublicText(input?.commitMessage, "commit_message", "pr_remediation_commit_message", COMMIT_MESSAGE_MAX);
  if (!messageCheck.ok) return messageCheck;
  // Validate the optional comment up front so a bad summary fails before the push.
  if (input?.commentBody != null) {
    const bodyCheck = validatePublicText(input.commentBody, "comment_body", "pr_remediation_comment", GITHUB_ISSUE_COMMENT_BODY_MAX);
    if (!bodyCheck.ok) return bodyCheck;
  }

  if (await readMergeInProgress(repoRoot, commandRunner)) {
    return refusal("pr_remediation_merge_incomplete",
      "An integration merge is still in progress; finish it through sync_base before publishing",
      { next_action: "complete_sync_base_first" });
  }

  // MCP-owned staging: the skill never runs git. Staging the entire working tree
  // makes the pushed commit exactly the tree the maintainer produced (codex F2/F4/F8).
  await runImplementGit(repoRoot, ["add", "-A"], commandRunner);
  if (!(await hasStagedChanges(repoRoot, commandRunner))) {
    return refusal("pr_remediation_nothing_to_publish", "No changes to publish; apply the fixes first",
      { next_action: "apply_the_fixes" });
  }

  // Re-fetch the integration branch immediately before the push; if it advanced,
  // the branch is stale (codex cycle-2 F4).
  let fetched;
  try {
    fetched = await fetchImplementBase(repoRoot, reviewed.base_ref, commandRunner);
  } catch (error) {
    return refusal("pr_remediation_base_fetch_failed", `The integration branch could not be re-fetched: ${error.message}`);
  }
  const localHeadBefore = await readImplementGitOid(repoRoot, "HEAD", commandRunner);
  if (!(await isImplementAncestor(repoRoot, fetched.fetchedBaseSha, localHeadBefore, commandRunner))) {
    return refusal("pr_remediation_base_moved",
      "The integration branch advanced since sync_base; re-synchronize before publishing",
      { next_action: "call_sync_base_again" });
  }

  let committed;
  try {
    committed = await runImplementCommit(repoRoot, ["-m", input.commitMessage], commandRunner);
  } catch (error) {
    return refusal("pr_remediation_commit_failed", error.message);
  }
  if (!committed.ok) return committed;
  const headAfter = await readImplementGitOid(repoRoot, "HEAD", commandRunner);

  // Fork PRs are refused before publish, so the destination is the authorized
  // origin. Explicit compare-and-swap: the push carries the reviewed head as the
  // expected remote OID (lease), so it lands only if the remote is still where it
  // was reviewed; local HEAD descends from that OID, so this is a fast-forward,
  // never a history rewrite (codex cycle-3 F1).
  try {
    await runImplementGit(
      repoRoot,
      ["push", `--force-with-lease=refs/heads/${reviewed.head_ref}:${reviewed.head_oid}`, "origin", `HEAD:refs/heads/${reviewed.head_ref}`],
      commandRunner,
    );
  } catch (error) {
    return refusal("pr_remediation_push_rejected",
      "The compare-and-swap push was rejected (the remote head moved since review); re-review and re-synchronize",
      { detail: extractGhErrorMessage(error).slice(0, 300), next_action: "re_review_the_pull_request" });
  }

  const result = {
    ok: true, action: "publish", pr_number: prNumber,
    head_oid_after: headAfter, pushed_ref: reviewed.head_ref, pushed_remote: "origin",
    verification: "deferred_to_pull_request_ci",
  };
  // Optional bound comment, posted only after the successful push.
  if (input?.commentBody != null && live?.state === "OPEN") {
    result.comment = await postBoundComment(repoRoot, owner, name, prNumber, input.commentBody, commandRunner);
  }
  return result;
}
