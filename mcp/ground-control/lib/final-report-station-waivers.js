// How the final report accounts for waived review stations (issue #1578).
//
// A waiver lets completion proceed without a station's verdict; it must never let the report read
// as though that review ran. Everything here consumes the server-derived station evidence from the
// trusted ledger — a caller's review summary is prose and can prove nothing about a waiver.

import { resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { readTrustedExecutionObligationState } from "./grc-legacy-compat-4.js";
import { stationForReviewerLabel } from "./station-observation-evidence.js";

/**
 * Read the verified station evidence for an issue, or a bounded failure.
 *
 * Callers that already hold a launch-workspace-authorized identity pass `repository`; otherwise the
 * checkout is authorized here, so the evidence is never read from a caller-selected repository.
 */
export async function readFinalReportStationEvidence({
  repoPath, repository = null, issueNumber, workspaceAuthorizationResolver = undefined,
}) {
  try {
    const target = repository ?? (await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver));
    if (!target.ok) return { ok: false, error: target.error, message: target.message };
    const state = await readTrustedExecutionObligationState(target.repoRoot, target.owner, target.name, issueNumber);
    if (!state.ok) return { ok: false, error: state.error, message: state.message };
    return { ok: true, evidence: state.station_evidence };
  } catch (error) {
    return { ok: false, error: "final_report_obligation_state_failed", message: error.message };
  }
}

function isUnobservedWaived(evidence, station) {
  return Array.isArray(evidence?.unobserved_waived_stations)
    && evidence.unobserved_waived_stations.includes(station);
}

/**
 * The /implement lane's mandatory review-evidence gate.
 *
 * Every run needs the pre-push Codex review recorded. The single exception is a verified waiver of
 * the codex station that no later verdict superseded: then the report carries the waiver instead,
 * and a codex entry would claim a review that never ran. An empty array or a summary alone never
 * earns the exception, and an unreadable ledger keeps the original refusal.
 */
export async function checkMandatoryCodexReview({ reviews, repoPath, issueNumber, workspaceAuthorizationResolver }) {
  const list = Array.isArray(reviews) ? reviews : [];
  const hasCodex = list.some((r) => r && typeof r === "object" && r.reviewer === "codex");
  if (hasCodex) return null;
  const refusal = list.length === 0
    ? {
      ok: false,
      error: "final_report_no_reviews",
      message: "reviews[] is empty — Step 19 requires at least the pre-push Codex review summary; pass a reviews entry like { reviewer: 'codex', summary: '<cycle history + outcome>' } (or pass lane='quickfix' for the /quickfix slim path where AI reviews are opt-in)",
      issue_number: issueNumber,
      next_action: "collect_review_summaries_and_retry",
    }
    : {
      ok: false,
      error: "final_report_codex_review_missing",
      message: "reviews[] does not include a 'codex' entry — the pre-push Codex review is mandatory per ADR-029; add a reviews entry with reviewer:'codex' (or pass lane='quickfix' for the /quickfix slim path)",
      issue_number: issueNumber,
      next_action: "add_codex_review_entry_and_retry",
    };
  const read = await readFinalReportStationEvidence({ repoPath, issueNumber, workspaceAuthorizationResolver });
  return read.ok && isUnobservedWaived(read.evidence, "codex_review") ? null : refusal;
}

/** Refuse a review entry for a station the ledger says was waived and never observed. */
export function refuseWaivedStationReviewClaims({ reviews, evidence, issueNumber }) {
  const claimed = (Array.isArray(reviews) ? reviews : [])
    .map((r) => ({ reviewer: r?.reviewer, station: stationForReviewerLabel(r?.reviewer) }))
    .filter(({ station }) => station != null && isUnobservedWaived(evidence, station));
  if (claimed.length === 0) return null;
  return {
    ok: false,
    error: "final_report_waived_station_review_claimed",
    message:
      `reviews[] reports ${claimed.map((c) => `'${c.reviewer}'`).join(", ")}, but the issue thread records ` +
      `${claimed.map((c) => c.station).join(", ")} as waived with no verdict produced. Remove those entries; ` +
      "the report lists waived stations from the verified waiver record.",
    issue_number: issueNumber,
    waived_stations: claimed.map((c) => c.station),
    next_action: "remove_review_entries_for_waived_stations_and_retry",
  };
}

/** Server-rendered section naming every verified waiver. Empty when there is none. */
export function renderWaivedStationsSection(evidence) {
  const waivers = Array.isArray(evidence?.waivers) ? evidence.waivers : [];
  if (waivers.length === 0) return [];
  return [
    "### Waived review stations",
    "",
    "_No verdict was produced for these observations. A repository writer authorized continuing without them; they are not review results._",
    "",
    ...waivers.map((w) => {
      const later = w.observed_later ? "; a later cycle of this station was observed" : "";
      const author = w.source_author ? ` by \`${w.source_author}\`` : "";
      return `- \`${w.station}\` cycle ${w.cycle} (\`${w.obligation_id}\`) — no verdict; waived${author} (${w.source_comment_url})${later}`;
    }),
    "",
  ];
}
