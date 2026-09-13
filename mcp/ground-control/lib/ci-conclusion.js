// CI run conclusion classification shared with Sonar producer discovery.
//
// The distinction this file exists to hold: a *verdict* is CI inspecting the change and rejecting
// it. A run that timed out, never started, or sat in the queue inspected nothing — it produced no
// verdict at all. Sonar scope discovery uses that distinction to decide whether an analysis may
// still arrive; it never treats infrastructure failure as a code finding.

/** Conclusions where CI inspected the change and rejected it. */
const VERDICT_FAIL = new Set(["failure"]);

/** Deliberate stop. Distinct from a failure, and the station vocabulary has its own value for it. */
const VERDICT_CANCELLED = new Set(["cancelled"]);

/**
 * The run did not render a verdict: infrastructure, scheduling, or a manual approval gate.
 *
 * `action_required` is here rather than under fail because it means the run is waiting on a human,
 * not that the change was rejected.
 */
const NOT_EVALUABLE = new Set([
  "timed_out",
  "startup_failure",
  "queued_too_long",
  "stale",
  "action_required",
]);

/** CI ran nothing to inspect. Coverage, not a pass. */
const SKIPPED = new Set(["skipped", "neutral"]);

/**
 * Classify an observed CI conclusion onto the closed gate-observation axis.
 *
 * @param {string|null|undefined} conclusion GitHub's run conclusion, or nullish if none was observed
 * @returns {string} a member of the closed station-result vocabulary
 */
export function ciStationResult(conclusion) {
  const value = typeof conclusion === "string" ? conclusion.trim().toLowerCase() : "";
  if (value === "success") return "pass";
  if (VERDICT_FAIL.has(value)) return "fail";
  if (VERDICT_CANCELLED.has(value)) return "cancelled";
  if (SKIPPED.has(value)) return "skipped_station";
  if (NOT_EVALUABLE.has(value)) return "not_evaluable";
  // An unknown conclusion is an unrecognized observation, not a defect. Widening `fail` to the
  // default is what made this wrong the first time.
  return "not_evaluable";
}
