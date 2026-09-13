// Replay-time verification of station-observation resolutions (issues #1476, #1578).
//
// A station-observation obligation is the one obligation kind that can close without a problem
// being fixed: `reobserved` says the gate was later observed, `waived` says a repository writer
// authorized continuing without a verdict. Both are therefore only believed when the thread itself
// proves them. An issue thread is writable by anyone who can comment, so every resolution that
// fails verification is dropped — its obligation stays open and completion stays blocked — rather
// than raised as an error that anyone could use to wedge the run.
//
// Ordering is evidence too. Obligation ids are deterministic and reused when the same station and
// cycle reopen, so a resolution is bound to the obligation's LATEST opening: its evidence must sit
// after that opening and before the resolution marker in thread order.

import {
  STATION_OBSERVATION_DISPOSITION,
  STATION_WAIVER_DISPOSITION,
  hasVerifiedStationReobservation,
  parseLeadingStationVerdictMarker,
  parseStationWaiverCommand,
} from "./execution-obligation-v2.js";

function isStationResolution(event) {
  return event.event === "resolved"
    && (event.disposition === STATION_OBSERVATION_DISPOSITION
      || event.disposition === STATION_WAIVER_DISPOSITION);
}

function sameLogin(comment, trustedLogin) {
  return typeof trustedLogin === "string"
    && trustedLogin.trim() !== ""
    && comment?.authorLogin?.toLowerCase() === trustedLogin.toLowerCase();
}

/**
 * Whether `evidenceIndex` lies strictly between the obligation's latest opening and the marker.
 *
 * An obligation with no recorded opening has nothing a resolution could bind to.
 */
function isBetween(openedIndex, evidenceIndex, markerIndex) {
  return Number.isInteger(openedIndex)
    && Number.isInteger(evidenceIndex)
    && evidenceIndex > openedIndex
    && evidenceIndex < markerIndex;
}

/**
 * Every trusted validated verdict on the thread, in thread order.
 *
 * A verdict is the station-owned findings record: authored by the trusted MCP posting identity and
 * led by a `gc:station-verdict` marker for this issue. A cycle marker, an `ok: true` envelope, or a
 * decision summary is not a verdict.
 */
export function findVerifiedStationVerdicts(comments, issueNumber, trustedLogin) {
  const verdicts = [];
  (comments || []).forEach((comment, index) => {
    if (!sameLogin(comment, trustedLogin)) return;
    const verdict = parseLeadingStationVerdictMarker(comment.body);
    if (verdict == null || verdict.issue_number !== issueNumber) return;
    verdicts.push({ station: verdict.station, cycle: verdict.cycle, comment_id: comment.id, index });
  });
  return verdicts;
}

function verifyReobservation({ event, markerComment, markerIndex, openedIndex, comments, positions, trustedLogin }) {
  // A resolution without `observed_cycle` predates #1578 and keeps its exact original check.
  if (event.observed_cycle == null) {
    return hasVerifiedStationReobservation(event, markerComment, comments, trustedLogin);
  }
  if (!sameLogin(markerComment, trustedLogin)) return false;
  if (event.observation_record_id === markerComment.id) return false;
  const recordIndex = positions.get(event.observation_record_id);
  const record = comments[recordIndex];
  if (record == null || !sameLogin(record, trustedLogin)) return false;
  if (!isBetween(openedIndex, recordIndex, markerIndex)) return false;
  const verdict = parseLeadingStationVerdictMarker(record.body);
  return verdict != null
    && verdict.issue_number === event.issue_number
    && verdict.station === event.station
    && verdict.cycle === event.observed_cycle
    && event.observed_cycle >= event.cycle;
}

function verifyWaiver({ event, markerComment, markerIndex, openedIndex, comments, positions, trust, trustedLogin }) {
  // The waiver record is posted by the server that verified the command; the command itself is the
  // authority, re-read on every replay so an edited or deleted source withdraws the waiver.
  if (!sameLogin(markerComment, trustedLogin)) return false;
  if (event.authorization_comment_id === markerComment.id) return false;
  const sourceIndex = positions.get(event.authorization_comment_id);
  const source = comments[sourceIndex];
  if (source == null || !trust.isTrusted(source)) return false;
  if (!isBetween(openedIndex, sourceIndex, markerIndex)) return false;
  const command = parseStationWaiverCommand(source.body);
  return command != null
    && command.station === event.station
    && command.obligation_ids.includes(event.obligation_id);
}

/**
 * Drop every station resolution the thread does not prove.
 *
 * `markerComments` is `[{ comment, events }]` in thread order and `comments` the whole authored
 * thread in the same order. Returns the surviving events plus each obligation's latest opening
 * index, which completion needs to tell a later verdict from an earlier one.
 *
 * The trusted login is resolved only when a station resolution is present, so the common path
 * keeps its current number of GitHub calls.
 */
export async function filterAttestedStationResolutions({
  markerComments,
  comments,
  trust,
  resolveTrustedLogin,
}) {
  const positions = new Map();
  (comments || []).forEach((comment, index) => {
    if (Number.isInteger(comment?.id)) positions.set(comment.id, index);
  });
  const hasStationResolution = markerComments.some(({ events }) => events.some(isStationResolution));
  const trustedLogin = hasStationResolution ? await resolveTrustedLogin() : null;
  const openedIndex = new Map();
  const events = [];
  for (const { comment, events: parsed } of markerComments) {
    const markerIndex = positions.get(comment.id);
    for (const event of parsed) {
      if (event.event === "opened") openedIndex.set(event.obligation_id, markerIndex);
      if (!isStationResolution(event)) {
        events.push(event);
        continue;
      }
      const verify = event.disposition === STATION_WAIVER_DISPOSITION ? verifyWaiver : verifyReobservation;
      const attested = verify({
        event,
        markerComment: comment,
        markerIndex,
        openedIndex: openedIndex.get(event.obligation_id),
        comments,
        positions,
        trust,
        trustedLogin,
      });
      if (attested) events.push(event);
    }
  }
  return { events, openedIndex, trustedLogin };
}
