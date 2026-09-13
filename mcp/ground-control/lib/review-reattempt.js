// Non-verdict station retry policy (issue #1476).
//
// A review station that produced no verdict — a timed-out engine, a dead child process, an
// unparseable payload, a diff whose slices did not all come back — used to have exactly one exit:
// a repository writer posting an exact `/ground-control authorize-wontfix` command. Nothing about
// a timeout is a decision anyone needs to make, and `wontfix` records a defect the project agreed
// to live with, which is not what happened.
//
// Retrying is already free. Each failure class below returns before any findings record or cycle
// marker is written, so the review cap is not consumed and no durable state exists to reconcile.
// This module is the piece that consumes that free retry, and the classification is deliberately
// an allow-list of stable error codes rather than a heuristic over messages: a wrong "retryable"
// here would re-run a station that already spent a cycle.
//
// The policy is pure so it can be tested exhaustively against every failure class. Executors keep
// owning how one attempt runs and how its verdict is parsed; see
// architecture/notes/unobserved-station-recovery-preflight.md.

/** Canonical reviewer ids shared by the retry and issue-thread observation ledgers. */
export const REVIEW_STATION_IDS = Object.freeze(["codex_review", "test_quality_review"]);

/**
 * Stable error codes that mean "the station ran but rendered no verdict, and wrote nothing".
 *
 * Verified against the producers rather than assumed:
 * - `test_quality_review_engine_failed` / `test_quality_review_parse_failed` return before
 *   `postFindingsRecordAndCycleMarker`, so the cap is untouched (lib/test-quality-runner-2.js).
 * - `review_coverage_incomplete` is the codex analogue: a slice engine failure breaks out of the
 *   reviewer loop and fails the coverage gate before any write (lib/grc-legacy-compat-6.js,
 *   lib/api-controls.js).
 *
 * Everything absent from this map is not retried, including cap refusals (a retry cannot change
 * them), input/authorization failures (likewise), reserved-marker and sensitive-content rejections
 * (the content must change first), and every posting failure (the engine already ran — re-running
 * it would burn a review to retry a GitHub write).
 */
export const NON_VERDICT_FAILURE_CLASSES = Object.freeze({
  test_quality_review_engine_failed: "engine_invocation_failed",
  test_quality_review_parse_failed: "unparseable_validated_output",
  review_coverage_incomplete: "incomplete_reviewer_coverage",
});

export const NON_VERDICT_RETRY_LIMIT_MIN = 0;
export const NON_VERDICT_RETRY_LIMIT_MAX = 2;
export const NON_VERDICT_RETRY_LIMIT_DEFAULT = 1;

/** The station-result value for an attempt that rendered no verdict. */
const NOT_EVALUABLE = "not_evaluable";

/**
 * Classify one station attempt from its structured envelope.
 *
 * Fails closed in both directions: an envelope this cannot read is neither a verdict nor a free
 * retry, and a cancelled attempt is never retried even though cancellation surfaces through the
 * same engine-failure code as a timeout.
 *
 * @returns {{evaluable: boolean, retryable: boolean, failure_class: string|null}}
 */
export function classifyStationAttempt(envelope, { cancelled = false } = {}) {
  if (cancelled) {
    return { evaluable: false, retryable: false, failure_class: "cancelled" };
  }
  if (envelope == null || typeof envelope !== "object") {
    return { evaluable: false, retryable: false, failure_class: "unreadable_envelope" };
  }
  if (envelope.ok === true) {
    return { evaluable: true, retryable: false, failure_class: null };
  }
  const failureClass = typeof envelope.error === "string"
    ? NON_VERDICT_FAILURE_CLASSES[envelope.error] ?? null
    : null;
  if (failureClass == null) {
    return {
      evaluable: false,
      retryable: false,
      failure_class: typeof envelope.error === "string" ? envelope.error : "unreadable_envelope",
    };
  }
  return { evaluable: false, retryable: true, failure_class: failureClass };
}

/**
 * The station-result axis value for a classified attempt, or null when this was not an attempt.
 *
 * Three distinctions matter here, and collapsing any of them corrupts recovery state:
 *
 * - `fail` is reserved for a gate that inspected the change and rejected it. An outage must never
 *   reach it, or the repair path incorrectly asks for a code fix.
 * - `not_evaluable` is reserved for a station that actually executed and rendered no verdict.
 *   A refusal that happened *before* the reviewer ran (cap reached, invalid input, authorization)
 *   is not an attempt at all, and a failure to post a verdict that was already rendered is
 *   transport recovery, not a missing observation. Both return null so the issue-thread ledger
 *   opens obligations only for a reviewer that actually ran without rendering a verdict.
 * - `cancelled` is its own axis value. The station did execute, so it is a real attempt, but the
 *   caller abandoned it — it is not evidence that the gate cannot be observed.
 */
export function stationResultForAttempt(classification, envelope) {
  if (classification.evaluable) {
    const findingCount = Number.isInteger(envelope?.finding_count) ? envelope.finding_count : 0;
    return findingCount > 0 ? "fail" : "pass";
  }
  if (classification.failure_class === "cancelled") return "cancelled";
  return classification.retryable ? NOT_EVALUABLE : null;
}

/**
 * Pure retry decision for one completed attempt.
 *
 * `maxReattempts` counts additional attempts after the first, so ordinal N is allowed to run when
 * N is at most `maxReattempts + 1`.
 *
 * @returns {{retry: boolean, next_attempt_ordinal: number|null, reason: string|null}}
 */
export function decideNonVerdictRetry({ attemptOrdinal, maxReattempts, classification }) {
  if (!classification?.retryable) {
    return { retry: false, next_attempt_ordinal: null, reason: "not_retryable" };
  }
  const limit = clampRetryLimit(maxReattempts);
  if (attemptOrdinal > limit) {
    return { retry: false, next_attempt_ordinal: null, reason: "reattempts_exhausted" };
  }
  return { retry: true, next_attempt_ordinal: attemptOrdinal + 1, reason: null };
}

function clampRetryLimit(value) {
  if (!Number.isInteger(value)) return NON_VERDICT_RETRY_LIMIT_DEFAULT;
  if (value < NON_VERDICT_RETRY_LIMIT_MIN) return NON_VERDICT_RETRY_LIMIT_MIN;
  if (value > NON_VERDICT_RETRY_LIMIT_MAX) return NON_VERDICT_RETRY_LIMIT_MAX;
  return value;
}

/**
 * Resolve a reviewer block's configured re-attempt limit.
 *
 * `normalizeReviewerConfig` already rejects out-of-range and non-integer values, so reaching the
 * clamp means the resolver was handed something that never went through the validator.
 */
export function resolveNonVerdictRetryLimit(reviewerBlock) {
  const configured = reviewerBlock?.non_verdict_retry_limit;
  if (configured == null) return NON_VERDICT_RETRY_LIMIT_DEFAULT;
  return clampRetryLimit(configured);
}

/**
 * Run one station through its bounded re-attempts.
 *
 * The retry boundary wraps one complete station attempt, never a slice, poll, or durable write:
 * partial work from an incomplete attempt is discarded with that attempt rather than merged into a
 * later verdict. Each attempt is reported separately so the caller can bind an unobserved retry
 * to the correct issue-thread obligation and attempt ordinal.
 *
 * @returns {Promise<{envelope: any, observed: boolean, attempts: Array<object>}>}
 */
export async function runStationWithNonVerdictRetry({
  stationId,
  maxReattempts = NON_VERDICT_RETRY_LIMIT_DEFAULT,
  invoke,
  signal = undefined,
  onAttempt = undefined,
}) {
  const attempts = [];
  let attemptOrdinal = 1;
  let envelope;

  for (;;) {
    const startedAt = Date.now();
    envelope = await invoke(attemptOrdinal);
    const classification = classifyStationAttempt(envelope, {
      cancelled: signal?.aborted === true,
    });
    const stationResult = stationResultForAttempt(classification, envelope);
    // A null result means the station never executed, or executed and already rendered its
    // verdict. Either way there is no attempt to record and nothing for the ledger to observe.
    if (stationResult != null) {
      const attempt = {
        station_id: stationId,
        attempt_ordinal: attemptOrdinal,
        station_result: stationResult,
        failure_class: classification.failure_class,
        duration_ms: Date.now() - startedAt,
      };
      attempts.push(attempt);
      // Bounded, stable codes only. Raw engine output, prompts, diffs, and stderr never reach a log.
      if (stationResult === NOT_EVALUABLE) {
        console.error(
          `[gc] station ${stationId} attempt ${attemptOrdinal}/${clampRetryLimit(maxReattempts) + 1} ` +
          `rendered no verdict (${attempt.failure_class})`,
        );
      }
      if (typeof onAttempt === "function") await onAttempt(attempt, classification);
    }

    const decision = decideNonVerdictRetry({ attemptOrdinal, maxReattempts, classification });
    if (!decision.retry) {
      return { envelope, observed: classification.evaluable, attempts };
    }
    attemptOrdinal = decision.next_attempt_ordinal;
  }
}
