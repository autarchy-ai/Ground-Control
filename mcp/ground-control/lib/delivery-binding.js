// Binding a delivery to the synchronized branch and lane (issue #1679).
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

function refuse(error, message, nextAction) {
  return { ok: false, error, message, next_action: nextAction };
}

/**
 * Resolve the delivery binding for a synchronization record.
 *
 * `settledTreeSha` is the tree of the pre-synchronization feature head — the
 * tree the delivery work produced, before a base merge changes it.
 */
export async function resolveDeliveryBinding({ lane, settledTreeSha }) {
  if (!lane.ok) return lane;
  return {
    ok: true,
    binding: {
      settledTreeSha,
      // Retained only for v2 record compatibility; no consumer treats these as
      // authorization or requires review evidence.
      reviewPublicationId: IMPLEMENT_BASE_SYNC_NO_PUBLICATION,
      reviewRevisionDigest: IMPLEMENT_BASE_SYNC_NO_PUBLICATION,
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
export function assertDeliveryBindingCurrent({ record, lane }) {
  // The record's lane decides which checks apply below, so a record from another
  // lane cannot be the one this delivery is judged against. Without this, a
  // quickfix record taken into an implement run reaches the quickfix early return
  // and skips every implement check - review evidence, branch and tree alike
  // (issue #1679). A lane transition re-synchronizes and binds a new record.
  if (lane != null && record.lane !== lane) {
    return refuse(
      "implement_delivery_binding_lane_mismatch",
      `This run is an /${lane} delivery, but its synchronization record was written for an /${record.lane} one. `
      + "Re-synchronize so the record binds this run's lane.",
      "return_to_the_synchronization_boundary",
    );
  }
  return { ok: true };
}
import { IMPLEMENT_BASE_SYNC_NO_PUBLICATION } from "./implement-sync-record.js";
