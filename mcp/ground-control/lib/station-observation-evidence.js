// Binding a station-observation obligation to the durable verdict that observed it (issue #1582).
//
// A `reobserved` resolution is written by the cycle wrapper that renders the verdict. When that
// wrapper did not know the obligation was open — the obligation was opened by an earlier call, and
// the later successful call carried no in-memory state — the verdict landed with no resolution and
// the obligation stranded: the generic obligation tool cannot emit `reobserved` by design.
//
// This module is the pure half of the recovery: it decides, from the issue thread alone, whether a
// trusted findings record and its cycle marker prove that the obligation's station rendered a
// verdict for the obligation's logical cycle after the obligation was opened. It performs no IO so
// the binding rules are testable without GitHub.

import {
  STATION_OBSERVATION_DISPOSITION,
  parseExecutionObligationV2Markers,
} from "./execution-obligation-v2.js";
import { parseCodexReviewPrePushCycleMarkerEntries } from "./api-requirements.js";
import { parseCodexPrePushFindingsHeader } from "./codex-review.js";
import {
  parseTestQualityReviewCycleMarkerEntries,
  parseTestQualityReviewFindingsMarker,
} from "./test-quality-runner.js";

/**
 * How each station's verdict is recognized on the thread. Closed set: a station with no entry here
 * cannot be reconciled, which fails closed rather than accepting an unrecognized record.
 */
const STATION_EVIDENCE = Object.freeze({
  codex_review: {
    parseRecord: parseCodexPrePushFindingsHeader,
    parseCycleMarkers: parseCodexReviewPrePushCycleMarkerEntries,
  },
  test_quality_review: {
    parseRecord: parseTestQualityReviewFindingsMarker,
    parseCycleMarkers: parseTestQualityReviewCycleMarkerEntries,
  },
});

function isTrustedAuthor(comment, trusted) {
  return typeof comment?.authorLogin === "string" && comment.authorLogin.toLowerCase() === trusted;
}

function eventsOf(comment, issueNumber, obligationId) {
  return parseExecutionObligationV2Markers(comment.body, issueNumber)
    .filter((event) => event.obligation_id === obligationId);
}

/**
 * Index of the most recent `opened` event for this obligation, or -1.
 *
 * Not author-filtered: the caller's trusted-ledger read already authorized every obligation marker
 * through effective repository permission. Requiring today's MCP login here would add a second
 * authorization rule for the opening and strand runs across a credential rotation.
 */
function lastOpenedIndex(comments, issueNumber, obligation) {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const opened = eventsOf(comments[i], issueNumber, obligation.obligation_id).some(
      (event) => event.event === "opened"
        && event.kind === "station_observation"
        && event.station === obligation.station
        && event.cycle === obligation.cycle,
    );
    if (opened) return i;
  }
  return -1;
}

/**
 * Every trusted verdict record and cycle marker for the obligation's station, issue, and cycle,
 * in thread order after `from`.
 */
function collectVerdictEvidence(comments, from, evidence, { issueNumber, cycle, trusted }) {
  const records = [];
  const markers = [];
  for (let i = from; i < comments.length; i += 1) {
    if (!isTrustedAuthor(comments[i], trusted)) continue;
    const record = evidence.parseRecord(comments[i].body);
    if (record != null && record.issueNumber === issueNumber && record.cycle === cycle) {
      records.push({ index: i, branch: record.branch });
    }
    for (const entry of evidence.parseCycleMarkers(comments[i].body, issueNumber)) {
      if (entry.cycle === cycle) markers.push({ index: i, branch: entry.branch });
    }
  }
  return { records, markers };
}

/** The latest record before `marker` on the marker's branch, or null. */
function recordConsumedBy(marker, records) {
  const eligible = records.filter(
    (record) => record.index < marker.index && (record.branch == null || record.branch === marker.branch),
  );
  return eligible.at(-1) ?? null;
}

/** Where a caller-named comment sits relative to the opening, or null when it is eligible by position. */
function namedRecordPositionError(comments, openedAt, recordId) {
  const index = comments.findIndex((comment) => comment.id === recordId);
  if (index < 0) return "record_not_found";
  return index <= openedAt ? "record_precedes_opened_event" : null;
}

/**
 * Whether an open station-observation obligation is provably re-observed by durable records.
 *
 * The pairing is derived from the thread, never chosen by the caller:
 * 1. an `opened` event for this obligation's id, station, and logical cycle (the most recent one);
 * 2. after it, this station's cycle marker for the same issue and logical cycle, authored by the
 *    trusted MCP posting identity — the proof the verdict was consumed as that cycle;
 * 3. the verdict that marker consumed: the latest primary findings record for the same station,
 *    issue, cycle, and branch between the opening and the marker, by the same identity.
 *
 * Several markers must all consume the same record, or the history is ambiguous and nothing binds.
 * When `recordId` is given it must be exactly the derived record.
 *
 * `comments` must be in thread order, as the issue-comments endpoint returns them.
 *
 * @returns {{ok: true, record: object, cycleMarker: object} | {ok: false, reason: string}}
 */
export function findStationObservationEvidence({
  comments, issueNumber, obligation, trustedLogin, recordId = null,
}) {
  if (typeof trustedLogin !== "string" || trustedLogin.trim() === "") {
    return { ok: false, reason: "trusted_identity_unresolved" };
  }
  const evidence = STATION_EVIDENCE[obligation?.station];
  if (obligation?.kind !== "station_observation" || obligation.schema_version !== 2 || !evidence) {
    return { ok: false, reason: "not_a_station_observation" };
  }
  const list = Array.isArray(comments) ? comments : [];
  const openedAt = lastOpenedIndex(list, issueNumber, obligation);
  if (openedAt < 0) return { ok: false, reason: "opened_event_not_found" };
  const positionError = recordId == null ? null : namedRecordPositionError(list, openedAt, recordId);
  if (positionError) return { ok: false, reason: positionError };

  const { records, markers } = collectVerdictEvidence(list, openedAt + 1, evidence, {
    issueNumber, cycle: obligation.cycle, trusted: trustedLogin.toLowerCase(),
  });
  if (markers.length === 0) {
    return { ok: false, reason: records.length === 0 ? "verdict_record_not_found" : "cycle_marker_not_found" };
  }
  const consumed = markers.map((marker) => recordConsumedBy(marker, records));
  if (consumed.some((record) => record == null)) return { ok: false, reason: "verdict_record_not_found" };
  if (new Set(consumed.map((record) => record.index)).size > 1) {
    return { ok: false, reason: "ambiguous_verdict_history" };
  }
  const record = list[consumed[0].index];
  if (recordId != null && record.id !== recordId) return { ok: false, reason: "record_is_not_the_consumed_verdict" };
  return { ok: true, record, cycleMarker: list[markers[0].index] };
}

/**
 * Whether a trusted `reobserved` resolution already binds this obligation to this exact record.
 *
 * Binding-exact on purpose: a repeat call is a no-op only when it would have written the same
 * resolution. A resolution bound to a different record is not this call's success to report.
 */
export function hasTrustedReobservation({
  comments, issueNumber, obligationId, station, cycle, recordId, trustedLogin,
}) {
  if (typeof trustedLogin !== "string" || trustedLogin.trim() === "") return false;
  const trusted = trustedLogin.toLowerCase();
  return (comments || []).some(
    (comment) => isTrustedAuthor(comment, trusted)
      && eventsOf(comment, issueNumber, obligationId).some(
        (event) => event.event === "resolved"
          && event.disposition === STATION_OBSERVATION_DISPOSITION
          && event.station === station
          && event.cycle === cycle
          && event.observation_record_id === recordId,
      ),
  );
}
