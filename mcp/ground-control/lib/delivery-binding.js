// Binding a delivery to its synchronized branch and trusted lane. Review is
// workflow observability only; it does not participate in this authority check
// (issue #1693). The binding is computed once at synchronization and reused by
// PR creation and completion rather than re-derived from a local checkout.

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
