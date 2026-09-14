// Durable records for station-observation obligations (issue #1476).
//
// Separate from the v2 codec because these do IO, and separate from the reviewer runners because
// both of them need the same three writes: open the obligation when a station renders no verdict,
// resolve it when a later attempt does, escalate it when the bounded re-attempts are spent.
//
// Every body here is machine-composed from closed enums and integers. Nothing a reviewer, engine,
// or diff produced reaches an obligation comment — only stable failure codes — so the durable
// record cannot become an exfiltration path for prompts, stderr, or filesystem paths.

import {
  buildExecutionObligationV2Marker,
  buildStationObservationObligationId,
} from "./execution-obligation-v2.js";
import { boundedOutputTail } from "./command-failure-diagnostics.js";
import { detectSensitiveBodyContent, extractGhErrorMessage } from "./grc-legacy-compat-2.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX } from "./repo-vocabulary.js";
import { execFile } from "./runtime-primitives.js";

/** Human-readable station names for the record prose. Closed set, never caller-supplied. */
const STATION_LABELS = Object.freeze({
  codex_review: "codex review",
  test_quality_review: "test-quality review",
});

async function postComment({ repoRoot, owner, name, issueNumber, body }) {
  const sensitive = detectSensitiveBodyContent(body);
  if (sensitive) return { ok: false, message: `sensitive-content guardrail: ${sensitive}` };
  if (Buffer.byteLength(body, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return { ok: false, message: "record exceeds the GitHub issue-comment body cap" };
  }
  try {
    const { stdout } = await execFile(
      "gh",
      [
        "api",
        `/repos/${owner}/${name}/issues/${issueNumber}/comments`,
        "-f",
        `body=${body}`,
        "--jq",
        ".html_url",
      ],
      { cwd: repoRoot },
    );
    return { ok: true, url: stdout.trim() };
  } catch (err) {
    // stderr, not the Error message: the message repeats the whole argv, body included.
    return { ok: false, message: boundedOutputTail(extractGhErrorMessage(err))?.text ?? "gh api failed" };
  }
}

/** The numeric comment id GitHub encodes in an issue-comment permalink. */
export function commentIdFromUrl(url) {
  const match = typeof url === "string" ? url.match(/#issuecomment-(\d+)$/) : null;
  return match == null ? null : Number(match[1]);
}

function header(stationId, logicalCycle, eventLabel) {
  const label = STATION_LABELS[stationId] ?? stationId;
  return `## Station observation — ${label} cycle ${logicalCycle} — ${eventLabel}`;
}

/**
 * Open the obligation the first time a station renders no verdict at this logical cycle.
 *
 * Idempotent by the deterministic obligation id: a repeated open for the same station and cycle
 * replays onto the same obligation rather than stranding a second one nobody can resolve.
 */
export async function postStationObservationOpened({
  repoRoot, owner, name, issueNumber, stationId, logicalCycle, failureClass, attemptOrdinal,
}) {
  const obligationId = buildStationObservationObligationId({ stationId, logicalCycle });
  const body = [
    buildExecutionObligationV2Marker({
      issueNumber,
      obligationId,
      event: "opened",
      kind: "station_observation",
      stationId,
      logicalCycle,
    }),
    "",
    header(stationId, logicalCycle, "Opened"),
    "",
    "**Observed state:** the station ran but rendered no verdict, so this gate is unobserved.  ",
    `**Failure class:** \`${failureClass}\`  `,
    `**Attempt:** ${attemptOrdinal}  `,
    "**Impact:** the review cap was not consumed and no findings record exists for this cycle.  ",
    "**Current obligation:** observe this station before the run completes.",
    "",
    "This is a missing observation, not a defect. It is resolved by observing the station, not by",
    "dispositioning a finding.",
  ].join("\n");
  const posted = await postComment({ repoRoot, owner, name, issueNumber, body });
  return { ...posted, obligation_id: obligationId };
}

/**
 * How the verdict behind a re-observation was established. Closed set: the corrective-action prose
 * is chosen here, never supplied by a caller.
 */
const REOBSERVATION_SOURCES = Object.freeze({
  cycle_wrapper: "a re-attempt of this station at this logical cycle rendered a verdict.",
  reconciliation:
    "the server matched this station's verdict record and cycle marker for this logical cycle, " +
    "posted after the obligation opened, and recorded the resolution the cycle wrapper did not.",
});

/**
 * Resolve the obligation against the record proving a later attempt rendered a verdict.
 *
 * `reobserved` states only that the gate was finally observed. A re-observed verdict that found
 * problems still leaves every one of those findings under the existing disposition rules.
 */
export async function postStationReobservation({
  repoRoot, owner, name, issueNumber, recordUrl, stationObservation, source = "cycle_wrapper",
}) {
  const observationRecordId = commentIdFromUrl(recordUrl);
  if (!Number.isInteger(observationRecordId)) {
    return { ok: false, message: `could not derive a comment id from '${recordUrl}'` };
  }
  const correctiveAction = REOBSERVATION_SOURCES[source];
  if (correctiveAction == null) {
    return { ok: false, message: `unknown re-observation source '${source}'` };
  }
  const { obligationId, stationId, logicalCycle } = stationObservation;
  const body = [
    buildExecutionObligationV2Marker({
      issueNumber,
      obligationId,
      event: "resolved",
      kind: "station_observation",
      stationId,
      logicalCycle,
      disposition: "reobserved",
      observationRecordId,
    }),
    "",
    header(stationId, logicalCycle, "Re-observed"),
    "",
    "**Disposition:** reobserved  ",
    `**Corrective action:** ${correctiveAction}  `,
    `**Evidence:** ${recordUrl}`,
    "",
    "### Verification",
    "",
    "- The linked findings record is this station's validated verdict for this logical cycle.",
    "- Re-observation closes only the missing-observation obligation. Any findings in that record",
    "  remain subject to the existing `fix` / `wontfix` / `not-applicable` rules.",
  ].join("\n");
  return postComment({ repoRoot, owner, name, issueNumber, body });
}

/**
 * Resolve an open observation obligation for codex, between its findings record and cycle marker.
 *
 * Returns null when there is nothing to do or the resolution landed, and the caller's structured
 * post-failure envelope otherwise. Keeping the guard here leaves the runner a single branch, and
 * leaves the write-ordering rule stated in one place for both stations.
 */
export async function guardStationReobservation({
  stationObservation, findingsCommentUrl, repoRoot, issueNumber, owner, name, buildFailure,
}) {
  if (stationObservation == null || findingsCommentUrl == null) return null;
  const resolution = await postStationReobservation({
    repoRoot, owner, name, issueNumber, recordUrl: findingsCommentUrl, stationObservation,
  });
  if (resolution.ok) return null;
  return buildFailure(
    `the findings record posted but the open station-observation obligation ` +
    `'${stationObservation.obligationId}' could not be resolved: ${resolution.message}. No cycle ` +
    `marker has been written, so the cap is untouched and re-running is safe.`,
    resolution.message,
  );
}

/**
 * Escalate when the bounded re-attempts are spent and the station is still unobserved.
 *
 * `hard_external_dependency`, never a `wontfix` decision request: there is no defect to accept,
 * and asking an operator to authorize one for a gate that never ran is the conflation this issue
 * exists to remove. The obligation stays open, so both completion phases keep refusing.
 */
export async function postStationObservationEscalation({
  repoRoot, owner, name, issueNumber, stationId, logicalCycle, failureClasses, attemptCount,
}) {
  const obligationId = buildStationObservationObligationId({ stationId, logicalCycle });
  const label = STATION_LABELS[stationId] ?? stationId;
  const classes = [...new Set(failureClasses.filter(Boolean))].map((c) => `\`${c}\``).join(", ");
  const body = [
    buildExecutionObligationV2Marker({
      issueNumber,
      obligationId,
      event: "escalated",
      kind: "station_observation",
      stationId,
      logicalCycle,
    }),
    "",
    header(stationId, logicalCycle, "Escalated"),
    "",
    "**Pause class:** hard_external_dependency  ",
    `**Unobserved station:** \`${stationId}\` (${label})  `,
    `**Attempts:** ${attemptCount}  `,
    `**Failure classes:** ${classes || "`unreadable_envelope`"}  `,
    "**Decision request:** restore the ability to observe this station, then re-run the review.",
    "",
    "This is not a request to accept a defect. Nothing was measured, so there is no finding to",
    "disposition — the gate itself could not be run to completion. Restoring the station and",
    "re-running it resolves this obligation on the evidence.",
    "",
    "This obligation remains open while the decision is pending.",
  ].join("\n");
  const posted = await postComment({ repoRoot, owner, name, issueNumber, body });
  return { ...posted, obligation_id: obligationId };
}
