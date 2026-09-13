// Maintainer PR-review lane tool registrations (issue #1535).
//
// Two capability-separated tools back the `/review` skill: a read-only context
// reader and an authorization-gated remediation surface. They are separate tools
// by design (preflight architecture note) so a review-only caller cannot reach a
// mutation by flipping an action field. Handlers stay thin: validate shape with
// zod, delegate to the lib, wrap with ok/err.

import { z } from "zod";
import { runGetPrReviewContext, runRemediatePullRequest } from "../lib.js";
import { ok, err } from "./respond.js";

export function registerPrReview(server) {
  server.tool(
    "gc_get_pr_review_context",
    "Read-only maintainer PR-review context. Returns one bounded evidence snapshot of a pull request — identity (base/head refs+OIDs, cross-repo flag, merge state), the complete changed-file inventory with bounded patches and explicit truncation/unavailable flags, checks bound to the head OID, linked and closing-issue candidates (distinguishing closing references from mere cross-references), and review metadata — with completeness flags so a large/binary/access-limited diff is never presented as fully reviewed. Every read is REST except the optional unresolved-review-thread summary, which GitHub exposes only over GraphQL; when that read fails (for example an exhausted GraphQL budget) `discussions.available` is false and every other field is still populated. Mutates nothing: no git fetch, no branch switch, no object-database write, no comment. Use it for the review phase and for post-merge issue selection.",
    {
      repo_path: z.string().describe("Absolute path to the invocation checkout"),
      pr_number: z.number().int().positive().describe("Pull request number"),
      repo: z.string().optional().describe("Optional '<owner>/<name>' assertion, checked against the checkout origin; never an alternate destination"),
      max_files: z.number().int().positive().optional().describe("Narrow the changed-file cap below the default 300; a larger value is clamped to 300"),
      max_patch_bytes: z.number().int().positive().optional().describe("Narrow the per-file patch byte cap below the default 65536; a larger value is clamped to 65536"),
    },
    async ({ repo_path, pr_number, repo, max_files, max_patch_bytes }) => {
      try {
        return ok(JSON.stringify(
          await runGetPrReviewContext({ repoPath: repo_path, prNumber: pr_number, repo, maxFiles: max_files, maxPatchBytes: max_patch_bytes }),
          null, 2,
        ));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    "gc_remediate_pull_request",
    "Authorization-gated maintainer PR remediation on the existing PR branch in the invocation checkout. Trusted-host confirmation the model cannot forge is required: a maintainer with write access must submit a PR review against the CURRENT head whose body contains 'gc-review: remediation-approved' (the lane exposes no tool that submits a review, and GitHub binds the review to the head commit_id, so it cannot be forged or reused for a later head). The server verifies that review before any mutation. The `authorization` field records the user's change request as human-readable intent, not as the proof. The reviewed PR identity is re-validated against the LIVE pull request by object id before anything is touched, remediation is same-repository only (a fork PR is refused), and only an open pull request is remediable (a merged or closed PR is refused). action=sync_base first checks the PR base matches the configured integration branch (mismatch is a consultation stop), then updates a stale branch with a real `git merge --no-ff` (never rebase/reset/force/worktree; conflicts are surfaced for manual resolution). action=publish stages the working tree itself, re-fetches the base immediately before the push, commits the staged tree, and pushes with a compare-and-swap lease bound to the reviewed remote head (a fast-forward that lands only if the remote is unchanged - never a history rewrite). publish does NOT run the repo's gate commands locally against the contributor tree (a credential-exfiltration surface); verification is the PR's own isolated CI, surfaced by gc_get_pr_review_context. If `comment_body` is supplied, publish posts at most one scrubbed, neutral PR comment after the successful push, bound to it. The user still owns the merge; this tool never merges, approves, closes, or relabels.",
    {
      repo_path: z.string().describe("Absolute path to the invocation checkout"),
      pr_number: z.number().int().positive().describe("Pull request number"),
      action: z.enum(["sync_base", "publish"]).describe("Remediation action"),
      authorization: z.string().describe("The user's explicit change request, recorded as human-readable intent (not the proof)"),
      reviewed_identity: z.object({
        base_ref: z.string(),
        head_ref: z.string(),
        base_oid: z.string(),
        head_oid: z.string(),
        cross_repository: z.boolean(),
      }).describe("The reviewed PR identity from gc_get_pr_review_context, re-validated against the live PR"),
      commit_message: z.string().optional().describe("Imperative commit message for action=publish (no attribution)"),
      comment_body: z.string().optional().describe("Optional neutral change summary for action=publish; posted only after the successful push"),
    },
    async ({ repo_path, pr_number, action, authorization, reviewed_identity, commit_message, comment_body }) => {
      try {
        return ok(JSON.stringify(
          await runRemediatePullRequest({
            repoPath: repo_path, prNumber: pr_number, action, authorization,
            reviewedIdentity: reviewed_identity, commitMessage: commit_message, commentBody: comment_body,
          }),
          null, 2,
        ));
      } catch (e) { return err(e); }
    },
  );
}
