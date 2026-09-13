// Execution-obligation marker family v2 (issue #1476).
//
// v1 could not simply gain a `reobserved` disposition. Its regex pins a closed disposition set, so
// a reader running older code would not match the resolution marker at all — it would see the
// obligation as permanently open and block completion forever, which is the failure this issue is
// removing. A new schema id makes the incompatibility explicit: old readers ignore v2 records
// entirely rather than misreading them, and v1 obligations keep their exact current semantics.
//
// v2 exists to carry what a re-observation must be verified against: the obligation kind, the
// canonical station, the logical review cycle, and the durable record proving a later attempt
// actually rendered a verdict. A disposition that clears an obligation without user authorization
// is only safe if it is bound to evidence, and prose cannot be that binding.
//
// This module is the v2 codec only. `parseExecutionObligationMarkers` and
// `evaluateExecutionObligations` in codex-workflow.js remain the single parse and replay entry
// points for both families; it lives in its own file because codex-workflow.js is near the
// repo's 500-LOC limit (docs/CODING_STANDARDS.md, Sonar S104).

export const EXECUTION_OBLIGATION_SCHEMA_V2 = "gc.implement.execution-obligation/v2";

/** v2 obligation kinds. `station_observation` is "the gate did not render a verdict". */
export const EXECUTION_OBLIGATION_KINDS = Object.freeze(["station_observation"]);

/**
 * The disposition that resolves a station-observation obligation.
 *
 * Deliberately absent from EXECUTION_OBLIGATION_DISPOSITIONS: that constant is the agent-facing
 * surface of `gc_record_execution_obligation`, and only the station-owning cycle wrapper may
 * attest a re-observation.
 */
export const STATION_OBSERVATION_DISPOSITION = "reobserved";

/**
 * The disposition that records an explicit user waiver of a missing observation (issue #1578).
 *
 * Station-only and tool-posted, like `reobserved`: it states that no verdict was produced and that
 * a repository writer authorized continuing without one. It never means clean, passed, fixed, or
 * reviewed, and it is not a finding disposition.
 */
export const STATION_WAIVER_DISPOSITION = "waived";

/** Every disposition a v2 marker may carry, agent-selectable or tool-attested. */
export const EXECUTION_OBLIGATION_V2_DISPOSITIONS = Object.freeze([
  "fix",
  "wontfix",
  "not-applicable",
  STATION_OBSERVATION_DISPOSITION,
  STATION_WAIVER_DISPOSITION,
]);

// Wire compatibility (issue #1578): `observed_cycle`, `authorization_comment_id`, and `waived` are
// additive. A reader built before them does not match such a resolution at all, so it keeps the
// obligation open and keeps blocking — an unknown resolution can never confer clearance.
const V2_MARKER_RE =
  /<!--\s*gc:execution-obligation\s+schema="gc\.implement\.execution-obligation\/v2"\s+issue="(\d+)"\s+id="([A-Z0-9][A-Z0-9._-]{0,63})"\s+event="(opened|escalated|resolved)"\s+kind="(station_observation)"\s+station="([a-z][a-z0-9_]{0,63})"\s+cycle="(\d+)"(?:\s+disposition="(fix|wontfix|not-applicable|reobserved|waived)")?(?:\s+observation_record_id="(\d+)")?(?:\s+observed_cycle="(\d+)")?(?:\s+authorization_comment_id="(\d+)")?\s*-->/g;

export const STATION_VERDICT_SCHEMA = "gc.implement.station-verdict/v1";

// Anchored to the start of the body: a findings record carries reviewer-authored text after its
// first line, and only the server-written first line may name the verdict it records.
const LEADING_STATION_VERDICT_RE =
  /^<!--\s*gc:station-verdict\s+schema="gc\.implement\.station-verdict\/v1"\s+issue="(\d+)"\s+station="([a-z][a-z0-9_]{0,63})"\s+cycle="(\d+)"\s*-->/;

const STATION_WAIVER_COMMAND_RE =
  /^\/ground-control waive-station ([a-z][a-z0-9_]{0,63})((?: [A-Z0-9][A-Z0-9._-]{0,63}){1,10})$/;

/**
 * Deterministic obligation id for one station's missing observation at one logical cycle.
 *
 * Branch-independent on purpose: the same run renamed onto another branch must update the same
 * obligation rather than stranding the first one open. Every transport re-attempt of the same
 * logical cycle maps here, so repeated failures update one record instead of opening one per try.
 */
export function buildStationObservationObligationId({ stationId, logicalCycle }) {
  const station = String(stationId).toUpperCase().replace(/_/g, "-");
  return `STATION-OBS-${station}-C${logicalCycle}`;
}

export function buildExecutionObligationV2Marker({
  issueNumber,
  obligationId,
  event,
  kind,
  stationId,
  logicalCycle,
  disposition = null,
  observationRecordId = null,
  observedCycle = null,
  authorizationCommentId = null,
}) {
  const attribute = (key, value) => (value == null ? "" : ` ${key}="${value}"`);
  return (
    `<!-- gc:execution-obligation schema="${EXECUTION_OBLIGATION_SCHEMA_V2}" ` +
    `issue="${issueNumber}" id="${obligationId}" event="${event}" kind="${kind}" ` +
    `station="${stationId}" cycle="${logicalCycle}"` +
    attribute("disposition", disposition) +
    attribute("observation_record_id", observationRecordId) +
    attribute("observed_cycle", observedCycle) +
    attribute("authorization_comment_id", authorizationCommentId) +
    " -->"
  );
}

/** First line of a station's validated findings record: the verdict it is evidence of. */
export function buildStationVerdictMarker({ issueNumber, stationId, logicalCycle }) {
  return (
    `<!-- gc:station-verdict schema="${STATION_VERDICT_SCHEMA}" issue="${issueNumber}" ` +
    `station="${stationId}" cycle="${logicalCycle}" -->`
  );
}

/** The verdict a record's leading marker names, or null when the record carries none. */
export function parseLeadingStationVerdictMarker(body) {
  const match = typeof body === "string" ? body.match(LEADING_STATION_VERDICT_RE) : null;
  if (match == null) return null;
  return { issue_number: Number(match[1]), station: match[2], cycle: Number(match[3]) };
}

/** The exact user command that authorizes waiving named observations of one station. */
export function buildStationWaiverCommand({ stationId, obligationIds }) {
  return `/ground-control waive-station ${stationId} ${obligationIds.join(" ")}`;
}

/**
 * Parse an exact waiver command, or null.
 *
 * The whole trimmed body must be the command: approval prose, quotations, questions, and reports
 * of someone else's approval are never authority. Duplicate ids make the scope ambiguous and fail.
 */
export function parseStationWaiverCommand(body) {
  const match = typeof body === "string" ? body.trim().match(STATION_WAIVER_COMMAND_RE) : null;
  if (match == null) return null;
  const obligationIds = match[2].trim().split(" ");
  if (new Set(obligationIds).size !== obligationIds.length) return null;
  return { station: match[1], obligation_ids: obligationIds };
}

/** Parse v2 events out of one comment body. Shape matches the v1 events, plus the v2 fields. */
export function parseExecutionObligationV2Markers(body, issueNumber) {
  const events = [];
  if (typeof body !== "string") return events;
  for (const match of body.matchAll(V2_MARKER_RE)) {
    if (Number(match[1]) !== issueNumber) continue;
    events.push({
      issue_number: issueNumber,
      obligation_id: match[2],
      event: match[3],
      schema_version: 2,
      kind: match[4],
      station: match[5],
      cycle: Number(match[6]),
      disposition: match[7] ?? null,
      observation_record_id: match[8] == null ? null : Number(match[8]),
      observed_cycle: match[9] == null ? null : Number(match[9]),
      authorization_comment_id: match[10] == null ? null : Number(match[10]),
    });
  }
  return events;
}

/**
 * Whether a `reobserved` marker is attested by the tool rather than asserted by an agent.
 *
 * Two independent facts must hold, because an issue thread is writable by anyone who can comment:
 *
 * 1. The marker's author is the trusted MCP posting identity — not merely someone with repository
 *    write permission. Write permission is the bar for recording a problem obligation; attesting
 *    that a gate was observed is a claim only the server that ran the gate can make.
 * 2. The referenced observation record exists, was posted by that same identity, and is a
 *    different comment from the marker. Self-reference would let one forged comment vouch for
 *    itself, which is no evidence at all.
 *
 * Deliberately station-agnostic: the codex findings record carries no `gc:` marker of its own, so
 * requiring a per-station marker would bind only one reviewer and silently pass the other.
 */
export function hasVerifiedStationReobservation(event, markerComment, comments, trustedLogin) {
  if (typeof trustedLogin !== "string" || trustedLogin.trim() === "") return false;
  const trusted = trustedLogin.toLowerCase();
  if (markerComment?.authorLogin?.toLowerCase() !== trusted) return false;
  if (!Number.isInteger(event?.observation_record_id)) return false;
  if (event.observation_record_id === markerComment.id) return false;
  const record = (comments || []).find((c) => c.id === event.observation_record_id);
  return record != null && record.authorLogin?.toLowerCase() === trusted;
}

/**
 * Whether a `reobserved` resolution may close the obligation state it is being replayed against.
 *
 * Fails closed on every mismatch. A resolution that does not bind to an open station-observation
 * for the same station and logical cycle, carrying the id of the record that proves a verdict was
 * rendered, leaves the obligation open — and completion stays blocked.
 */
export function canReobservationClose(current, event) {
  return (
    bindsToStationObservation(current, event)
    && Number.isInteger(event.observation_record_id)
    && (event.observed_cycle == null || event.observed_cycle >= current.cycle)
  );
}

/** Whether a `waived` resolution names the obligation it replays against and cites authority. */
export function canStationWaiverClose(current, event) {
  return (
    bindsToStationObservation(current, event)
    && event.observation_record_id == null
    && Number.isInteger(event.authorization_comment_id)
  );
}

/** The only resolutions that terminate a station-observation obligation. */
export function canStationResolutionClose(current, event) {
  if (event.disposition === STATION_OBSERVATION_DISPOSITION) {
    return canReobservationClose(current, event);
  }
  if (event.disposition === STATION_WAIVER_DISPOSITION) return canStationWaiverClose(current, event);
  return false;
}

function bindsToStationObservation(current, event) {
  return (
    current?.kind === "station_observation"
    && current.schema_version === 2
    && event.schema_version === 2
    && event.kind === "station_observation"
    && event.station === current.station
    && event.cycle === current.cycle
  );
}
