// Station-observation orchestration for the review cycle seam (issue #1476).
//
// Split from review-cycle-seam.js, which the retry/ledger wiring pushed past the repo's 500-LOC
// limit (docs/CODING_STANDARDS.md, Sonar S104). The seam still owns the cycle contract; this file
// owns what happens around one station's bounded attempts.

import { buildStationObservationObligationId } from "./execution-obligation-v2.js";
import { getOwnerRepo } from "./grc-legacy-compat-3.js";
import { ensureGitRepo, readTrustedExecutionObligationState } from "./grc-legacy-compat-4.js";
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

const DEFAULT_LEDGER_DEPS = Object.freeze({
  readContext: getRepoGroundControlContext,
  resolveLedgerTarget: _resolveLedgerTarget,
  resolveLogicalCycle: _resolveLogicalCycle,
  readObligationState: readTrustedExecutionObligationState,
  postOpened: postStationObservationOpened,
  postEscalation: postStationObservationEscalation,
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
  deps = DEFAULT_LEDGER_DEPS,
}) {
  const stationId = REVIEW_STATION_BY_REVIEWER[reviewer];
  let context = null;
  try {
    context = await deps.readContext(repoPath);
  } catch {
    // Configuration unavailable falls back to the canonical default rather than failing the
    // review: retry depth is an operational knob, not a gate.
  }
  const maxReattempts = resolveNonVerdictRetryLimit(
    context?.workflow?.[REVIEWER_CONFIG_BLOCK[reviewer]],
  );

  // Derived from the durable cycle markers, which a non-verdict attempt never writes — so it is
  // stable across every re-attempt of the same logical cycle, and across separate invocations of
  // the cycle tool, and repeated failures update one obligation instead of opening one per try.
  //
  // Read before the first attempt, not lazily on the first failure (issue #1582). An obligation
  // opened by an EARLIER invocation is invisible to this one's in-memory state, so a verdict
  // rendered here posted no `reobserved` and the obligation stranded. The durable ledger is the
  // only record that spans invocations, so the wrapper must consult it before it can render.
  const recovered = await _recoverOpenObservation({ repoPath, issueNumber, reviewer, stationId, deps });
  let { ledger, logicalCycle, obligationId } = recovered;
  let observationOpened = recovered.open;

  const run = await runStationWithNonVerdictRetry({
    stationId,
    maxReattempts,
    signal,
    invoke: (attemptOrdinal) =>
      invokeReview({
        // Carried whenever this station's obligation for this logical cycle is open — whether an
        // earlier invocation opened it or an earlier attempt in this one did. Never carried when
        // nothing is open: a resolution for an obligation that never existed is not evidence.
        stationObservation: observationOpened
          ? { obligationId, stationId, logicalCycle }
          : null,
        attemptOrdinal,
      }),
    onAttempt: async (attempt) => {
      if (attempt.station_result !== "not_evaluable") return;
      if (observationOpened) return;
      ledger = await deps.resolveLedgerTarget(repoPath, ledger);
      if (ledger == null) return;
      logicalCycle = await deps.resolveLogicalCycle(ledger, issueNumber, reviewer);
      obligationId = buildStationObservationObligationId({ stationId, logicalCycle });
      const opened = await deps.postOpened({
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
    ledger = await deps.resolveLedgerTarget(repoPath, ledger);
    if (ledger != null) {
      await deps.postEscalation({
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

/**
 * This station's obligation for the upcoming logical cycle, if the durable ledger holds it open.
 *
 * Fails open to "nothing open": an unreadable thread must not stop a working station from rendering
 * its verdict. The cost of that direction is bounded — a verdict posted without a resolution is
 * exactly the state gc_reconcile_station_observation recovers from the durable records.
 */
async function _recoverOpenObservation({ repoPath, issueNumber, reviewer, stationId, deps }) {
  const none = { ledger: null, logicalCycle: null, obligationId: null, open: false };
  const ledger = await deps.resolveLedgerTarget(repoPath, null);
  if (ledger == null) return none;
  const logicalCycle = await deps.resolveLogicalCycle(ledger, issueNumber, reviewer);
  const obligationId = buildStationObservationObligationId({ stationId, logicalCycle });
  let state;
  try {
    state = await deps.readObligationState(ledger.repoRoot, ledger.owner, ledger.name, issueNumber);
  } catch {
    return { ...none, ledger, logicalCycle };
  }
  const open = state?.ok === true && (state.open_obligations ?? []).some(
    (o) => o.obligation_id === obligationId
      && o.kind === "station_observation"
      && o.schema_version === 2
      && o.station === stationId
      && o.cycle === logicalCycle,
  );
  return { ledger, logicalCycle, obligationId: open ? obligationId : null, open };
}

async function _resolveLedgerTarget(repoPath, cached) {
  if (cached != null) return cached;
  try {
    const repoRoot = await ensureGitRepo(repoPath);
    const { owner, name } = await getOwnerRepo(repoRoot);
    return { repoRoot, owner, name };
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
