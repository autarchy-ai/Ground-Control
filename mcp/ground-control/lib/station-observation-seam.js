// Station-observation orchestration for the review cycle seam (issue #1476).
//
// Split from review-cycle-seam.js, which the retry/ledger wiring pushed past the repo's 500-LOC
// limit (docs/CODING_STANDARDS.md, Sonar S104). The seam still owns the cycle contract; this file
// owns what happens around one station's bounded attempts.

import { buildStationObservationObligationId } from "./execution-obligation-v2.js";
import { resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { readTrustedExecutionObligationState } from "./grc-legacy-compat-4.js";
import { getRepoGroundControlContext } from "./repo-vocabulary-2.js";
import { readPriorCodexReviewPrePushCycleCount } from "./codex-verify-cap.js";
import { readPriorTestQualityReviewCycleCount } from "./test-quality-runner.js";
import { resolveNonVerdictRetryLimit, runStationWithNonVerdictRetry } from "./review-reattempt.js";
import {
  postStationObservationEscalation,
  postStationObservationOpened,
} from "./station-observation-records.js";

/** `.ground-control.yaml` block name for each reviewer. */
const REVIEWER_CONFIG_BLOCK = Object.freeze({
  codex: "codex_review",
  "test-quality": "test_quality_review",
});
export const REVIEW_STATION_BY_REVIEWER = Object.freeze({
  codex: "codex_review",
  "test-quality": "test_quality_review",
});

/**
 * Run one review station through its bounded re-attempts, keeping the obligation ledger honest.
 *
 * A station that renders no verdict used to leave exactly one exit: a repository writer posting an
 * exact `wontfix` authorization for a defect nobody had observed. Here the free retry is actually
 * consumed (a non-verdict failure writes no cycle marker, so the cap is untouched), each attempt is
 * measured on its own, and the obligation is opened, resolved, or escalated on evidence.
 */
export async function _runStationWithObservationLedger({
  reviewer,
  repoPath,
  issueNumber,
  invokeReview,
  signal,
  readOpenStationObservations = readOpenStationObservationsFromLedger,
}) {
  const stationId = REVIEW_STATION_BY_REVIEWER[reviewer];
  let context = null;
  try {
    context = await getRepoGroundControlContext(repoPath);
  } catch {
    // Configuration unavailable falls back to the canonical default rather than failing the
    // review: retry depth is an operational knob, not a gate.
  }
  const maxReattempts = resolveNonVerdictRetryLimit(
    context?.workflow?.[REVIEWER_CONFIG_BLOCK[reviewer]],
  );

  // Resolved lazily, on the first attempt that renders no verdict: the common path is a station
  // that works, and it should not pay a GitHub round-trip for a ledger it never writes to.
  //
  // Derived from the durable cycle markers, which a non-verdict attempt never writes — so it is
  // stable across every re-attempt of the same logical cycle, and repeated failures update one
  // obligation instead of opening one per transport attempt.
  let logicalCycle = null;
  let obligationId = null;
  let ledger = null;
  let observationOpened = false;

  // Obligations an EARLIER invocation left open for this station. Without them a verdict rendered
  // after a restart resolves nothing, and completion stays blocked on a gate that has since been
  // observed (issue #1578). Recovered from the durable ledger, never from in-memory state.
  const recovered = (await readOpenStationObservations({ repoPath, issueNumber, stationId }))
    .filter((o) => o.stationId === stationId);

  const run = await runStationWithNonVerdictRetry({
    stationId,
    maxReattempts,
    signal,
    invoke: (attemptOrdinal) =>
      invokeReview({
        // This invocation's own obligation joins only once it was durably opened: passing it
        // earlier would post a resolution for an obligation that never existed.
        stationObservations: observationOpened
          ? mergePendingObservations(recovered, { obligationId, stationId, logicalCycle })
          : recovered,
        attemptOrdinal,
      }),
    onAttempt: async (attempt) => {
      if (attempt.station_result !== "not_evaluable") return;
      if (observationOpened) return;
      ledger = await _resolveLedgerTarget(repoPath, ledger);
      if (ledger == null) return;
      logicalCycle = await _resolveLogicalCycle(ledger, issueNumber, reviewer);
      obligationId = buildStationObservationObligationId({ stationId, logicalCycle });
      const opened = await postStationObservationOpened({
        ...ledger,
        issueNumber,
        stationId,
        logicalCycle,
        failureClass: attempt.failure_class,
        attemptOrdinal: attempt.attempt_ordinal,
      });
      // A failed open leaves nothing durable; the escalation below still records the outage.
      observationOpened = opened.ok === true;
    },
  });

  // Every attempt rendered no verdict for a retryable reason: the station is genuinely unobserved.
  // Note this independently of whether the durable open succeeded — a GitHub outage must not
  // downgrade the escalation back to "fix the engine and retry", which names no real repair.
  const exhaustedNonVerdict = !run.observed
    && run.attempts.length > 0
    && run.attempts.every((a) => a.station_result === "not_evaluable");

  if (exhaustedNonVerdict && observationOpened) {
    ledger = await _resolveLedgerTarget(repoPath, ledger);
    if (ledger != null) {
      await postStationObservationEscalation({
        ...ledger,
        issueNumber,
        stationId,
        logicalCycle,
        failureClasses: run.attempts.map((a) => a.failure_class),
        attemptCount: run.attempts.length,
      });
    }
  }

  return { ...run, stationId, logicalCycle, obligationId, observationOpened, exhaustedNonVerdict };
}

function mergePendingObservations(recovered, opened) {
  return recovered.some((o) => o.obligationId === opened.obligationId)
    ? recovered
    : [...recovered, opened];
}

/**
 * Open station-observation obligations for one station, read from the trusted ledger.
 *
 * Fails open to "none": this read only decides which obligations a verdict may resolve. If it
 * cannot be completed the obligations stay open and completion keeps refusing, so a missed
 * recovery can never clear a gate.
 */
export async function readOpenStationObservationsFromLedger({
  repoPath, issueNumber, stationId, workspaceAuthorizationResolver = undefined,
}) {
  const ledger = await _resolveLedgerTarget(repoPath, null, workspaceAuthorizationResolver);
  if (ledger == null) return [];
  try {
    const state = await readTrustedExecutionObligationState(
      ledger.repoRoot, ledger.owner, ledger.name, issueNumber,
    );
    if (!state.ok) return [];
    return state.obligations
      .filter((o) => o.status === "open" && o.kind === "station_observation" && o.station === stationId)
      .map((o) => ({ obligationId: o.obligation_id, stationId, logicalCycle: o.cycle }));
  } catch {
    return [];
  }
}

/**
 * The station ledger's repository, pinned to the MCP launch workspace (issue #1578).
 *
 * Every obligation this seam opens, escalates, or recovers is bound to the checkout this server was
 * launched for; an unauthorized or unreadable checkout yields no ledger target at all.
 */
async function _resolveLedgerTarget(repoPath, cached, workspaceAuthorizationResolver = undefined) {
  if (cached != null) return cached;
  try {
    const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
    return repository.ok
      ? { repoRoot: repository.repoRoot, owner: repository.owner, name: repository.name }
      : null;
  } catch {
    return null;
  }
}

async function _resolveLogicalCycle({ repoRoot, owner, name }, issueNumber, reviewer) {
  try {
    const prior = reviewer === "codex"
      ? await readPriorCodexReviewPrePushCycleCount(repoRoot, owner, name, issueNumber)
      : await readPriorTestQualityReviewCycleCount(repoRoot, owner, name, issueNumber);
    return (Number.isInteger(prior) ? prior : 0) + 1;
  } catch {
    // An unreadable thread falls back to the first cycle rather than inventing an ordinal. The
    // obligation id stays deterministic either way, so a later attempt reconciles onto it.
    return 1;
  }
}

/**
 * Decorate an exhausted-re-attempt envelope so the orchestrator escalates the right thing.
 *
 * Without this the caller sees `fix_engine_issue_and_retry` — a repair that does not exist for a
 * timeout — and escalates a defect decision instead of a hard external dependency.
 */
export function _decorateUnobservedStation(envelope, run) {
  return {
    ...envelope,
    next_action: "escalate_unobserved_station_under_hard_external_dependency",
    unobserved_station: run.stationId,
    escalation_pause_class: "hard_external_dependency",
    obligation_kind: "station_observation",
    ...(run.obligationId ? { obligation_id: run.obligationId } : {}),
    ...(run.logicalCycle ? { logical_cycle: run.logicalCycle } : {}),
    obligation_recorded: run.observationOpened === true,
    station_attempts: run.attempts,
  };
}
