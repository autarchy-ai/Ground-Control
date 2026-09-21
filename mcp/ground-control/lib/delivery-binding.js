// Binding a delivery to the review that authorized it (issue #1679).
//
// Three identities are involved and they are deliberately distinct:
//
//   - the *review revision*  — what the reviewers received;
//   - the *settled tree*     — where the delivery work ended, i.e. the tree of
//                              the feature head before base synchronization;
//   - the *delivered head*   — what was pushed after synchronization.
//
// The PR-creation gate used to ask only "does a complete trusted publication
// tuple exist for this issue", and the evidence reader dropped the tuple's
// revision digest entirely, so a clean review could authorize an unrelated tree.
//
// What can honestly be enforced depends on the review's own outcome, and
// ADR-099 draws the line: a cycle that reported findings is *expected* to be
// followed by repairs, so its settled tree is recorded without claiming Codex
// reviewed it. A cycle that reported no findings had nothing to repair, so any
// later tree is unreviewed work and the binding is exact.
//
// The binding is computed once, at the synchronization boundary, and recorded in
// the trusted issue-thread synchronization record. PR creation and both
// completion phases re-read that one record rather than growing three copies of
// the policy or re-deriving it from a local checkout that may no longer hold the
// commits.

import { IMPLEMENT_BASE_SYNC_NO_PUBLICATION } from "./implement-sync-record.js";

function refuse(error, message, nextAction) {
  return { ok: false, error, message, next_action: nextAction };
}

/**
 * Resolve the delivery binding for a synchronization record.
 *
 * `settledTreeSha` is the tree of the pre-synchronization feature head — the
 * tree the delivery work produced, before a base merge changes it.
 */
export async function resolveDeliveryBinding({ evidence, lane, settledTreeSha }) {
  if (!lane.ok) return lane;
  // The quickfix lane runs no mandatory review (ADR-029, issue #906), so it has
  // no publication to bind against. Its waiver is checked where it is granted;
  // here it simply records that no publication authorized this delivery.
  if (lane.lane === "quickfix") {
    return {
      ok: true,
      binding: {
        settledTreeSha,
        reviewPublicationId: IMPLEMENT_BASE_SYNC_NO_PUBLICATION,
        reviewRevisionDigest: IMPLEMENT_BASE_SYNC_NO_PUBLICATION,
        lane: lane.lane,
      },
    };
  }
  if (evidence?.ok !== true || evidence.published !== true) {
    return refuse(
      "implement_base_sync_review_publication_missing",
      evidence?.message
        ?? "A complete trusted review publication is required before the delivery can be synchronized.",
      "publish_the_retained_review_and_retry",
    );
  }
  if (evidence.findings_count === 0 && evidence.candidate_tree_oid !== settledTreeSha) {
    return refuse(
      "implement_base_sync_reviewed_tree_changed",
      "The last published review reported no findings, so it authorized exactly the tree it read. "
      + `The delivery carries a different tree (${settledTreeSha}), which no review has seen. `
      + "Run and publish a review cycle on the current revision.",
      "rerun_review_on_the_current_revision_and_retry",
    );
  }
  return {
    ok: true,
    binding: {
      settledTreeSha,
      reviewPublicationId: evidence.publication_id,
      reviewRevisionDigest: evidence.revision_digest,
      lane: lane.lane,
    },
  };
}

/**
 * Whether the head being delivered is the head the trusted synchronization record
 * bound. Returns null when it is, or the reason it is not.
 *
 * Shared by both completion phases and quickfix readiness (issue #1679): a head
 * pushed after synchronization carries work nothing was bound to, in any lane.
 */
export function deliveredHeadRefusal({ record, headSha, branchName, issueNumber }) {
  if (record == null) {
    return `No trusted synchronization record binds branch '${branchName}' of issue #${issueNumber} to a delivery.`;
  }
  if (record.resultingFeatureSha !== headSha) {
    return `This pull request's head is ${headSha ?? "unreadable"}, but the delivery that was synchronized ended at `
      + `${record.resultingFeatureSha}. Work pushed after synchronization is not bound to anything.`;
  }
  return null;
}

/**
 * Re-check a recorded binding against the live thread, for a consumer downstream
 * of synchronization (PR creation, readiness, post-merge completion).
 *
 * The record is trusted, but it is not fresh: a review published after it, or a
 * publication that has since become ambiguous, must not pass on the strength of
 * a stale row.
 */
export function assertDeliveryBindingCurrent({ record, evidence, branchName, lane }) {
  // The record's lane decides which checks apply below, so a record from another
  // lane cannot be the one this delivery is judged against. Without this, a
  // quickfix record taken into an implement run reaches the quickfix early return
  // and skips every implement check - review evidence, branch and tree alike
  // (issue #1679). A lane transition re-synchronizes and binds a new record.
  if (lane != null && record.lane !== lane) {
    return refuse(
      "implement_delivery_binding_lane_mismatch",
      `This run is an /${lane} delivery, but its synchronization record was written for an /${record.lane} one. `
      + "Re-synchronize so the record binds this run's review evidence.",
      "return_to_the_synchronization_boundary",
    );
  }
  if (record.lane === "quickfix") {
    return record.reviewPublicationId === IMPLEMENT_BASE_SYNC_NO_PUBLICATION
      ? { ok: true }
      : refuse(
        "implement_delivery_binding_inconsistent",
        "A quickfix synchronization record names a review publication, which that lane does not produce.",
        "return_to_the_synchronization_boundary",
      );
  }
  if (evidence?.ok !== true || evidence.published !== true) {
    return refuse(
      "implement_pr_review_publication_missing",
      evidence?.message ?? "A complete trusted review publication is required before PR creation.",
      "publish_the_retained_review_and_retry",
    );
  }
  if (evidence.publication_id !== record.reviewPublicationId
    || evidence.revision_digest !== record.reviewRevisionDigest) {
    return refuse(
      "implement_delivery_binding_stale",
      "The synchronization record was bound to a different review publication than the one the issue now carries.",
      "return_to_the_synchronization_boundary",
    );
  }
  // Only the review that ran on this branch can authorize this branch's delivery.
  if (evidence.branch !== branchName) {
    return refuse(
      "implement_delivery_binding_branch_mismatch",
      `The authorizing review ran on branch '${evidence.branch}', not on '${branchName}'.`,
      "rerun_review_on_this_branch_and_retry",
    );
  }
  if (evidence.findings_count === 0 && evidence.candidate_tree_oid !== record.settledTreeSha) {
    return refuse(
      "implement_delivery_binding_tree_mismatch",
      "The authorizing review reported no findings, so it authorized exactly the tree it read, "
      + "and the synchronized delivery carries a different one.",
      "rerun_review_on_the_current_revision_and_retry",
    );
  }
  return { ok: true };
}
