// Station-observation evidence completion reports account for (issue #1578).
//
// `clear` alone cannot tell a gate that was observed from one a user waived. The final report and
// the PR attestation must never let a waived station read as a completed review, so they consume
// this normalized, server-derived view of the verified ledger rather than any caller claim.

import { STATION_WAIVER_DISPOSITION } from "./execution-obligation-v2.js";
import { findVerifiedStationVerdicts } from "./station-observation-replay.js";

export const EMPTY_STATION_EVIDENCE = Object.freeze({
  waivers: Object.freeze([]),
  unobserved_waived_stations: Object.freeze([]),
});

/**
 * Normalize verified waivers and whether each station was observed afterwards.
 *
 * A waived station counts as observed only when a verified verdict for it sits after the waived
 * obligation's opening. Until then it is reported as unobserved: no verdict produced,
 * continuation authorized.
 */
export function deriveStationObservationEvidence({
  obligations,
  openedIndex,
  comments,
  issueNumber,
  trustedLogin,
  owner,
  name,
}) {
  const waived = (obligations || []).filter(
    (o) => o.kind === "station_observation"
      && o.status === "resolved"
      && o.disposition === STATION_WAIVER_DISPOSITION,
  );
  if (waived.length === 0) return EMPTY_STATION_EVIDENCE;
  const verdicts = findVerifiedStationVerdicts(comments, issueNumber, trustedLogin);
  const waivers = waived.map((o) => {
    const sourceId = o.resolution?.authorization_comment_id ?? null;
    const source = (comments || []).find((c) => c.id === sourceId);
    const opened = openedIndex?.get(o.obligation_id);
    return {
      obligation_id: o.obligation_id,
      station: o.station,
      cycle: o.cycle,
      source_comment_id: sourceId,
      source_comment_url: `https://github.com/${owner}/${name}/issues/${issueNumber}#issuecomment-${sourceId}`,
      source_author: source?.authorLogin ?? null,
      observed_later: verdicts.some((v) => v.station === o.station && v.index > opened),
    };
  });
  const unobserved = [...new Set(waivers.filter((w) => !w.observed_later).map((w) => w.station))].sort();
  return { waivers, unobserved_waived_stations: unobserved };
}

/** Pre-push review station for a free-text reviewer label, or null when it names none. */
export function stationForReviewerLabel(reviewer) {
  const normalized = String(reviewer ?? "").toLowerCase().replaceAll(/[^a-z]/g, "");
  if (normalized === "codex" || normalized === "codexreview") return "codex_review";
  if (normalized === "testquality" || normalized === "testqualityreview") return "test_quality_review";
  return null;
}
