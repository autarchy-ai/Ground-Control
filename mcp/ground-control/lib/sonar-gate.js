// SonarCloud watcher envelope to station result and driver next action (issue #946).
//
// The same distinction lib/ci-conclusion.js exists to hold, on the other remote
// gate: a *verdict* is SonarCloud inspecting the change and rejecting it. An
// envelope the watcher could not produce - no host credential, an unreachable
// API, an analysis that never appeared within the cap - inspected nothing. It
// carries no finding to repair, and re-running it changes nothing until an
// operator acts.
//
// The monitor previously folded every non-passing envelope into one branch and
// answered all of them with "fix the SonarCloud findings". For a Codex-spawned
// MCP host, which carries no SONAR_TOKEN, that was guidance no driver could act
// on: it named code defects that had never been read, and the run terminated in
// an escalated execution obligation every time.

const TOKEN_MISSING = "sonar_watch_token_missing";

// Repairs for the conditions the watcher can actually name. An error absent from
// this table is a condition nothing has diagnosed, so it routes to diagnosis
// rather than to the nearest-looking repair — the failure mode issue #1559
// records, where a scan the repo's own CI skipped was reported as a missing
// credential and an operator provisioned a token that changed nothing.
const NEXT_ACTION_BY_ERROR = new Map([
  [TOKEN_MISSING, "provision_sonar_token_on_mcp_host_then_rerun_monitor"],
  ["sonar_watch_authentication_failed", "repair_sonar_credential_then_rerun_monitor"],
  ["sonar_watch_config_invalid", "repair_ground_control_config_then_rerun_monitor"],
  ["sonar_watch_analysis_not_produced", "diagnose_sonar_scan_scope_then_rerun_monitor"],
]);

/** Whether the gate was actually evaluated. `skipped` counts: the repo declares no sonarcloud block. */
export function sonarGateEvaluable(sonar) {
  if (!sonar?.ok) return false;
  if (sonar.skipped === true) return true;
  return sonar.timed_out !== true;
}

/** Whether an evaluated gate cleared: quality gate OK with no open issue and no open hotspot. */
export function sonarGatePassed(sonar) {
  if (!sonarGateEvaluable(sonar)) return false;
  if (sonar.skipped === true) return true;
  return sonar.quality_gate === "OK"
    && sonar.issues_summary?.open_count === 0
    && sonar.hotspots_summary?.open_count === 0;
}

/**
 * Describe why a non-passing gate failed, in terms the driver can act on.
 *
 * @returns {{sonar_gate: string, error: string, message: string, next_action: string}}
 */
export function classifySonarGateFailure(sonar) {
  if (sonar?.ok && sonar.timed_out === true) {
    return {
      sonar_gate: "not_evaluable",
      error: "sonar_watch_analysis_timed_out",
      message: sonar.message
        ?? "SonarCloud published no analysis for this pull request within the watch window",
      next_action: "rerun_monitor_after_sonar_analysis_completes",
    };
  }
  if (!sonar?.ok) {
    const error = sonar?.error ?? "sonar_watch_unavailable";
    return {
      sonar_gate: "not_evaluable",
      error,
      message: sonar?.message ?? "SonarCloud could not be read, so the gate produced no verdict",
      // Only a condition the watcher confirmed carries its own repair; anything
      // else needs diagnosis before a repair can honestly be named.
      next_action: NEXT_ACTION_BY_ERROR.get(error) ?? "diagnose_sonar_watch_failure_then_rerun_monitor",
    };
  }
  return {
    sonar_gate: "findings_open",
    error: "sonar_findings_open",
    message: sonar.message ?? "SonarCloud has an incomplete gate, open issue, or open hotspot",
    next_action: "fix_sonar_findings_then_rerun_publish_and_monitor",
  };
}
