// The /integrate lane's readiness watcher adapters.
//
// Split out of exec-file-async.js under issue #1679, which pushed that module
// past the repo's 500-line limit (docs/CODING_STANDARDS.md, Sonar S104). These
// two functions are the whole seam between the lib.js watcher envelopes and the
// prepare loop's hook contract, and they are the lane's fail-closed boundary, so
// they read better with the contract stated once at the top of their own file.

import { runWatchCiRun, runWatchSonarAnalysis } from "../lib.js";

// ---------------------------------------------------------------------------
// Watcher adapters
//
// The hook contract for the prepare loop is:
//   (pr, ctx, deps) => Promise<{conclusion: "success"|"failure"|"skipped"|"unverified"|"queued_too_long"|"timed_out", details_url?}>
//
// The real lib.js watchers have their own return envelopes.  These two
// adapter functions translate between the watcher envelope and the hook
// contract so the prepare loop stays simple.
// ---------------------------------------------------------------------------

/**
 * Production CI watcher adapter.  Calls runWatchCiRun from lib.js and maps
 * its envelope to the hook contract.
 *
 * runWatchCiRun returns:
 *   {ok, conclusion: "success"|"failure"|"queued_too_long"|"timed_out"|..., url?, ...}
 *
 * Mapping:
 *   conclusion "success"          → {conclusion: "success"}
 *   conclusion "failure"          → {conclusion: "failure", details_url: url}
 *   conclusion "queued_too_long"  → {conclusion: "queued_too_long"}
 *   conclusion "timed_out"        → {conclusion: "timed_out"}
 *   any other / error             → {conclusion: "unverified", reason} (blocking)
 *
 * `unverified` is deliberately not `skipped` (issue #1679). Every non-ok
 * envelope this watcher returns is a refusal to answer for the bound head — no
 * run registered for it, a run that built a different commit, an unresolvable
 * tip, a lookup or authorization failure — and the readiness gate does not
 * block on `skipped`. Converting a refusal into a skip let a rebased PR be
 * marked ready with no build for the commit it now carries. An explicit CI
 * `skipped` conclusion lands here too: GC-O011(c) requires the CI signal to be
 * watched before a PR is ready, and a skipped run observes nothing. Sonar's
 * separately configured absence rule stays its own thing and is not generalised
 * into a CI exception.
 *
 * `watchCi` is injected only by this adapter's own tests; without a seam the
 * mapping below is reachable only through a full integration run, which is how
 * it went unexercised.
 */
export async function defaultRunCiWatcher(pr, ctx, _deps, watchCi = runWatchCiRun) {
  const result = await watchCi({
    repoPath: ctx.repoRoot,
    branch: pr.head_ref,
    // The rebased commit this lane just force-pushed. Without it the watch
    // would bind to whatever the branch tip read back as, and the pre-rebase
    // run's green could stand in for a rebase nobody has built yet (#1365).
    expectedHeadSha: pr.pushed_head_sha ?? null,
  });

  if (!result.ok) {
    return {
      conclusion: "unverified",
      reason: result.error,
      head_sha: result.head_sha ?? pr.pushed_head_sha ?? null,
    };
  }

  const c = result.conclusion;
  if (c === "success") return { conclusion: "success" };
  if (c === "failure") return { conclusion: "failure", details_url: result.url };
  if (c === "queued_too_long") return { conclusion: "queued_too_long" };
  if (c === "timed_out") return { conclusion: "timed_out" };
  return {
    conclusion: "unverified",
    reason: `ci_conclusion_${typeof c === "string" && c.length > 0 ? c : "unknown"}`,
    head_sha: result.head_sha ?? pr.pushed_head_sha ?? null,
  };
}

/**
 * Production Sonar watcher adapter.  Calls runWatchSonarAnalysis from lib.js
 * and maps its envelope to the hook contract.
 *
 * runWatchSonarAnalysis returns:
 *   {ok, skipped?, quality_gate: "OK"|"ERROR"|"WARN"|"NONE", ...}
 *
 * Mapping:
 *   skipped:true                  → {conclusion: "skipped"}
 *   quality_gate "OK"             → {conclusion: "success"}
 *   quality_gate "ERROR"/"WARN"   → {conclusion: "failure"}
 *   any error / other             → {conclusion: "skipped"} (non-fatal)
 *
 * A non-ok envelope still halts the queue when sonarcloud is configured, but it
 * used to arrive with its reason and evidence discarded, so the lane reported a
 * configuration problem for a scan that was never produced and dropped the
 * repository/PR/head/check facts the diagnosis needs (issue #1559). Both travel
 * with the conclusion now; neither grants a new bypass.
 */
export async function defaultRunSonarWatcher(pr, ctx, _deps, watchSonar = runWatchSonarAnalysis) {
  // `watchSonar` is injected only by this adapter's own tests. Without a seam the
  // mapping below could only be reached through a full integration run, so every
  // test faked the adapter's *output* instead and the mapping itself — the actual
  // /integrate half of issue #1559 — was never exercised.
  const result = await watchSonar({
    repoPath: ctx.repoRoot,
    prNumber: pr.pr_number,
    expectedHeadSha: pr.pushed_head_sha ?? null,
  });

  if (!result.ok) {
    return {
      conclusion: "skipped",
      reason: result.error,
      ...(result.scope_evidence ? { scope_evidence: result.scope_evidence } : {}),
    };
  }
  if (result.skipped) {
    return { conclusion: "skipped" };
  }

  const qg = result.quality_gate;
  if (qg === "OK") return { conclusion: "success" };
  if (qg === "ERROR" || qg === "WARN") return { conclusion: "failure" };
  // NONE or other — treat as skipped
  return { conclusion: "skipped" };
}
