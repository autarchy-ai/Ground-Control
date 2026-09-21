// Authority for a `wontfix` review disposition (issue #1679).
//
// ADR-029 allows `wontfix` only with explicit user authorization, but the
// validators checked only that `user_authorization` was a non-empty bounded
// string — a value the agent writing the disposition supplies itself. Any
// sentence claiming approval therefore closed a real reviewer finding without
// repair.
//
// Authorization is a repository fact, so it is verified against the repository:
// a durable issue-comment URL on this issue, whose comment is an exact
// `/ground-control authorize-review-wontfix <finding-id>` command from someone
// with effective write permission - the same shape the repository already uses
// for execution-obligation wontfix. Free-form prose, quotations, negations, a
// report of someone else's approval, and a URL to another issue or repository
// are all rejected, because none of them is a permission-checked act.
//
// The review-finding grammar is deliberately separate from the
// execution-obligation one (`authorize-wontfix <OBLIGATION_ID>`): the two
// domains have different identifier shapes and must not authorize each other.
// They share the low-level comment-URL parser and the permission resolver.
//
// Finding ids are positional (`codex-F1`, `security-F2`) and recur in every
// cycle, so on its own the command would let an approval given for one review
// run close a different finding with the same ordinal in a later run. The
// binding to the run is made by time rather than by anything the person types:
// an authorization counts only for a review run that was already under way when
// it was posted, so an older approval can never reach a newer run's finding.
//
// A `wontfix` can therefore only be authorized where the run is known: through
// `gc_publish_review_result`. The direct decision-record surface has no review
// run to bind to and refuses it.

import { parseIssueCommentUrl } from "./codex-workflow.js";
import { readIssueCommentsWithAuthors, resolveExecutionObligationTrust } from "./grc-legacy-compat-3.js";

export const REVIEW_WONTFIX_AUTHORIZATION_COMMAND = "/ground-control authorize-review-wontfix";

/** Whether a comment body is exactly the authorization command for this finding. */
export function isExactReviewWontfixAuthorizationCommand(body, findingId) {
  return typeof body === "string"
    && body.trim() === `${REVIEW_WONTFIX_AUTHORIZATION_COMMAND} ${findingId}`;
}

// Whether a comment was posted after the review run began. Both sides must be
// real timestamps; anything unparseable counts as not after.
function postedAfter(comment, reviewStartedAt) {
  const posted = Date.parse(comment?.createdAt ?? "");
  const started = Date.parse(reviewStartedAt ?? "");
  return Number.isFinite(posted) && Number.isFinite(started) && posted > started;
}

function unverifiable(findingId, reason) {
  return {
    ok: false,
    error: "review_wontfix_authorization_unverifiable",
    message:
      `The 'wontfix' disposition for ${findingId} is not backed by a verified authorization: ${reason}. `
      + `A repository writer must comment exactly '${REVIEW_WONTFIX_AUTHORIZATION_COMMAND} ${findingId}' `
      + "on this issue after this review ran, and user_authorization must be that comment's URL.",
    finding_id: findingId,
    next_action: "obtain_an_exact_wontfix_authorization_comment_and_retry",
  };
}

/**
 * Verify every `wontfix` disposition in a sanitized finding set.
 *
 * Returns `{ok:true}` when there is nothing to authorize, so the common path
 * spends no GitHub read. Refuses on the first finding that does not verify.
 */
export async function verifyReviewWontfixAuthorizations(
  { repoRoot, owner, name, issueNumber, reviewStartedAt = null, findings },
  { readComments = readIssueCommentsWithAuthors, resolveTrust = resolveExecutionObligationTrust } = {},
) {
  const pending = (findings ?? []).filter((finding) => finding?.decision === "wontfix");
  if (pending.length === 0) return { ok: true };

  if (typeof reviewStartedAt !== "string" || !Number.isFinite(Date.parse(reviewStartedAt))) {
    return {
      ok: false,
      error: "review_wontfix_requires_publication",
      message:
        "A 'wontfix' disposition can only be authorized against the review run it answers, and this "
        + "surface has no review run to bind it to. Record it by publishing the retained review with "
        + "gc_publish_review_result.",
      finding_id: pending[0].id ?? null,
      next_action: "publish_the_retained_review_with_gc_publish_review_result",
    };
  }

  const references = [];
  for (const finding of pending) {
    const reference = parseIssueCommentUrl(finding.user_authorization);
    if (
      reference == null
      || reference.owner.toLowerCase() !== String(owner).toLowerCase()
      || reference.name.toLowerCase() !== String(name).toLowerCase()
      || reference.issueNumber !== issueNumber
    ) {
      return unverifiable(finding.id, "it is not a comment URL on this repository's issue");
    }
    references.push({ finding, commentId: reference.commentId });
  }

  let comments;
  try {
    comments = await readComments(repoRoot, owner, name, issueNumber);
  } catch {
    return {
      ok: false,
      error: "review_wontfix_authorization_unverifiable",
      message: "The issue thread could not be read to verify a 'wontfix' authorization.",
      finding_id: pending[0].id ?? null,
      next_action: "retry_after_restoring_github_access",
    };
  }
  // Resolve trust over the referenced comments only, as the canonical
  // scope-removal verifier does, rather than over every author on the thread.
  const referenced = comments.filter((comment) => references.some(({ commentId }) => comment.id === commentId));
  let trust;
  try {
    trust = await resolveTrust(repoRoot, owner, name, referenced);
  } catch {
    return {
      ok: false,
      error: "review_wontfix_authorization_unverifiable",
      message: "The authorizing comment's repository permission could not be verified.",
      finding_id: pending[0].id ?? null,
      next_action: "retry_after_restoring_github_access",
    };
  }

  for (const { finding, commentId } of references) {
    const authorization = referenced.find((comment) => comment.id === commentId);
    if (authorization == null || !trust.isTrusted(authorization)) {
      return unverifiable(finding.id, "the referenced comment is missing or its author has no write permission");
    }
    if (!isExactReviewWontfixAuthorizationCommand(authorization.body, finding.id)) {
      return unverifiable(finding.id, "the referenced comment is not the exact authorization command for this finding");
    }
    if (!postedAfter(authorization, reviewStartedAt)) {
      return unverifiable(finding.id, "the referenced comment predates this review run, so it answered an earlier one");
    }
  }
  return { ok: true };
}
