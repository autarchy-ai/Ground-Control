// Non-verdict station retry policy (issue #1476).
//
// The policy is pure on purpose: retry eligibility is the security-relevant decision here, and a
// pure predicate can be exhaustively tested against every failure class without standing up an
// engine, a GitHub shim, or a repository. The executors keep owning how an attempt runs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  _decorateUnobservedStation,
  NON_VERDICT_RETRY_LIMIT_DEFAULT,
  NON_VERDICT_RETRY_LIMIT_MAX,
  NON_VERDICT_RETRY_LIMIT_MIN,
  REVIEW_STATION_IDS,
  classifyStationAttempt,
  decideNonVerdictRetry,
  resolveNonVerdictRetryLimit,
  runStationWithNonVerdictRetry,
} from "./lib.js";

const EVALUABLE_CLEAN = { ok: true, next_action: "proceed_clean", finding_count: 0 };

describe("classifyStationAttempt", () => {
  it("treats each declared transient non-verdict as unobserved and retryable", () => {
    const transient = [
      ["test_quality_review_engine_failed", "engine_invocation_failed"],
      ["test_quality_review_parse_failed", "unparseable_validated_output"],
      ["review_coverage_incomplete", "incomplete_reviewer_coverage"],
    ];
    for (const [error, failureClass] of transient) {
      const c = classifyStationAttempt({ ok: false, error });
      assert.equal(c.evaluable, false, error);
      assert.equal(c.retryable, true, error);
      assert.equal(c.failure_class, failureClass, error);
    }
  });

  it("treats a rendered verdict as evaluable and never retryable", () => {
    // The cap exists to bound review depth. Retrying a station that rendered a verdict would
    // spend cycles the cap is not meant to absorb, so pass/fail is terminal for this policy.
    for (const envelope of [EVALUABLE_CLEAN, { ok: true, finding_count: 3 }]) {
      const c = classifyStationAttempt(envelope);
      assert.equal(c.evaluable, true);
      assert.equal(c.retryable, false);
      assert.equal(c.failure_class, null);
    }
  });

  it("does not retry cancellation", () => {
    // An aborted job surfaces as an engine failure, which is otherwise retryable. Re-running a
    // station the caller just cancelled would resurrect abandoned work.
    const c = classifyStationAttempt(
      { ok: false, error: "test_quality_review_engine_failed" },
      { cancelled: true },
    );
    assert.equal(c.retryable, false);
    assert.equal(c.failure_class, "cancelled");
  });

  it("does not retry a failure that is not a declared transient non-verdict", () => {
    // Every one of these either wrote something durable, refused before the engine ran, or
    // describes a condition a retry cannot change.
    const notRetryable = [
      "prepush_cycle_record_failed",
      "review_comment_post_failed",
      "codex_review_prepush_cap_reached",
      "codex_review_cycle_input_invalid",
      "test_quality_review_cycle_input_invalid",
      "auto_grant_unauthorized",
      "test_quality_review_reserved_marker",
      "execution_obligation_repo_not_authorized",
      "review_partial_failure",
    ];
    for (const error of notRetryable) {
      const c = classifyStationAttempt({ ok: false, error });
      assert.equal(c.retryable, false, error);
      assert.equal(c.evaluable, false, error);
    }
  });

  it("classifies a missing or malformed envelope as unobserved but not retryable", () => {
    // Fail closed: an envelope the policy cannot read is not evidence that a retry is free.
    for (const envelope of [null, undefined, "nope", {}]) {
      const c = classifyStationAttempt(envelope);
      assert.equal(c.evaluable, false);
      assert.equal(c.retryable, false);
    }
  });
});

describe("decideNonVerdictRetry", () => {
  const transient = { evaluable: false, retryable: true, failure_class: "engine_invocation_failed" };

  it("retries while attempts remain under the limit", () => {
    const d = decideNonVerdictRetry({ attemptOrdinal: 1, maxReattempts: 1, classification: transient });
    assert.equal(d.retry, true);
    assert.equal(d.next_attempt_ordinal, 2);
  });

  it("stops once the configured re-attempts are spent", () => {
    const d = decideNonVerdictRetry({ attemptOrdinal: 2, maxReattempts: 1, classification: transient });
    assert.equal(d.retry, false);
    assert.equal(d.reason, "reattempts_exhausted");
  });

  it("never retries when the limit is zero", () => {
    const d = decideNonVerdictRetry({ attemptOrdinal: 1, maxReattempts: 0, classification: transient });
    assert.equal(d.retry, false);
    assert.equal(d.reason, "reattempts_exhausted");
  });

  it("allows the maximum of two additional attempts", () => {
    assert.equal(
      decideNonVerdictRetry({ attemptOrdinal: 2, maxReattempts: 2, classification: transient }).retry,
      true,
    );
    assert.equal(
      decideNonVerdictRetry({ attemptOrdinal: 3, maxReattempts: 2, classification: transient }).retry,
      false,
    );
  });

  it("never retries a classification that is not retryable, however many attempts remain", () => {
    const d = decideNonVerdictRetry({
      attemptOrdinal: 1,
      maxReattempts: 2,
      classification: { evaluable: false, retryable: false, failure_class: "cancelled" },
    });
    assert.equal(d.retry, false);
    assert.equal(d.reason, "not_retryable");
  });
});

describe("resolveNonVerdictRetryLimit", () => {
  it("uses the canonical default when the block is absent or the key is unset", () => {
    assert.equal(resolveNonVerdictRetryLimit(null), NON_VERDICT_RETRY_LIMIT_DEFAULT);
    assert.equal(resolveNonVerdictRetryLimit({}), NON_VERDICT_RETRY_LIMIT_DEFAULT);
    assert.equal(
      resolveNonVerdictRetryLimit({ non_verdict_retry_limit: null }),
      NON_VERDICT_RETRY_LIMIT_DEFAULT,
    );
  });

  it("honours a configured limit inside the bounds", () => {
    assert.equal(resolveNonVerdictRetryLimit({ non_verdict_retry_limit: 0 }), 0);
    assert.equal(resolveNonVerdictRetryLimit({ non_verdict_retry_limit: 2 }), 2);
  });

  it("clamps a value the config validator would already have rejected", () => {
    // Defence in depth: normalizeReviewerConfig rejects out-of-bounds values, so reaching here
    // means the resolver was handed something unvalidated. Clamp rather than trust it.
    assert.equal(resolveNonVerdictRetryLimit({ non_verdict_retry_limit: 99 }), NON_VERDICT_RETRY_LIMIT_MAX);
    assert.equal(resolveNonVerdictRetryLimit({ non_verdict_retry_limit: -3 }), NON_VERDICT_RETRY_LIMIT_MIN);
  });
});

describe("runStationWithNonVerdictRetry", () => {
  it("returns the first attempt untouched when it renders a verdict", async () => {
    let calls = 0;
    const result = await runStationWithNonVerdictRetry({
      stationId: "codex_review",
      maxReattempts: 2,
      invoke: async () => {
        calls += 1;
        return EVALUABLE_CLEAN;
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].station_result, "pass");
    assert.equal(result.observed, true);
  });

  it("re-attempts a transient non-verdict and returns the later verdict", async () => {
    const envelopes = [
      { ok: false, error: "test_quality_review_engine_failed" },
      { ok: true, next_action: "proceed_clean", finding_count: 0 },
    ];
    let calls = 0;
    const result = await runStationWithNonVerdictRetry({
      stationId: "test_quality_review",
      maxReattempts: 1,
      invoke: async () => envelopes[calls++],
    });
    assert.equal(calls, 2);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.observed, true);
    // The unobserved attempt is still a recorded attempt — it just is not a verdict.
    assert.deepEqual(
      result.attempts.map((a) => a.station_result),
      ["not_evaluable", "pass"],
    );
    assert.equal(result.attempts[0].failure_class, "engine_invocation_failed");
  });

  it("re-observation may render fail; that is still an observation", async () => {
    const envelopes = [
      { ok: false, error: "review_coverage_incomplete" },
      { ok: true, finding_count: 2 },
    ];
    let calls = 0;
    const result = await runStationWithNonVerdictRetry({
      stationId: "codex_review",
      maxReattempts: 1,
      invoke: async () => envelopes[calls++],
    });
    assert.equal(result.observed, true);
    assert.equal(result.attempts[1].station_result, "fail");
  });

  it("stops at the configured limit and reports the station as unobserved", async () => {
    let calls = 0;
    const result = await runStationWithNonVerdictRetry({
      stationId: "test_quality_review",
      maxReattempts: 2,
      invoke: async () => {
        calls += 1;
        return { ok: false, error: "test_quality_review_engine_failed" };
      },
    });
    assert.equal(calls, 3, "one initial attempt plus two re-attempts");
    assert.equal(result.observed, false);
    assert.equal(result.attempts.length, 3);
    assert.ok(result.attempts.every((a) => a.station_result === "not_evaluable"));
  });

  it("does not re-attempt a non-retryable failure", async () => {
    let calls = 0;
    const result = await runStationWithNonVerdictRetry({
      stationId: "codex_review",
      maxReattempts: 2,
      invoke: async () => {
        calls += 1;
        return { ok: false, error: "prepush_cycle_record_failed" };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.observed, false);
  });

  it("stops re-attempting as soon as the caller cancels", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await runStationWithNonVerdictRetry({
      stationId: "test_quality_review",
      maxReattempts: 2,
      signal: controller.signal,
      invoke: async () => {
        calls += 1;
        controller.abort();
        return { ok: false, error: "test_quality_review_engine_failed" };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.observed, false);
    assert.equal(result.attempts[0].failure_class, "cancelled");
  });

  it("records every attempt with a distinct ordinal for the observation ledger", async () => {
    // The ADR-090 aggregate collapses duplicate ordinals within a run, so a re-attempt that
    // reused an ordinal would vanish from the attempt sequence instead of showing the rework.
    let calls = 0;
    const result = await runStationWithNonVerdictRetry({
      stationId: "codex_review",
      maxReattempts: 2,
      invoke: async () => {
        calls += 1;
        return calls < 3
          ? { ok: false, error: "review_coverage_incomplete" }
          : EVALUABLE_CLEAN;
      },
    });
    assert.deepEqual(result.attempts.map((a) => a.attempt_ordinal), [1, 2, 3]);
  });
});

describe("station registry", () => {
  it("registers exactly the two reviewer stations the workflow owns today", () => {
    assert.deepEqual([...REVIEW_STATION_IDS].sort(), ["codex_review", "test_quality_review"]);
  });
});

describe("_decorateUnobservedStation", () => {
  const run = {
    stationId: "test_quality_review",
    obligationId: "STATION-OBS-TEST-QUALITY-REVIEW-C1",
    logicalCycle: 1,
    observationOpened: true,
    attempts: [
      { attempt_ordinal: 1, station_result: "not_evaluable", failure_class: "engine_invocation_failed" },
      { attempt_ordinal: 2, station_result: "not_evaluable", failure_class: "engine_invocation_failed" },
    ],
  };

  it("replaces an unactionable next_action with the escalation an operator can act on", () => {
    // `fix_engine_issue_and_retry` names a repair that does not exist for a timeout, so the
    // orchestrator escalated a defect decision instead of a hard external dependency.
    const decorated = _decorateUnobservedStation(
      { ok: false, error: "test_quality_review_engine_failed", next_action: "fix_engine_issue_and_retry" },
      run,
    );
    assert.equal(decorated.next_action, "escalate_unobserved_station_under_hard_external_dependency");
    assert.equal(decorated.escalation_pause_class, "hard_external_dependency");
    assert.equal(decorated.unobserved_station, "test_quality_review");
    assert.equal(decorated.obligation_kind, "station_observation");
    assert.equal(decorated.obligation_id, "STATION-OBS-TEST-QUALITY-REVIEW-C1");
    assert.equal(decorated.obligation_recorded, true);
    assert.equal(decorated.station_attempts.length, 2);
  });

  it("never asks for a wontfix decision", () => {
    const decorated = _decorateUnobservedStation({ ok: false, error: "test_quality_review_engine_failed" }, run);
    assert.ok(!JSON.stringify(decorated).includes("wontfix"));
  });

  it("still escalates when the durable obligation could not be recorded", () => {
    // A GitHub outage while opening the obligation must not downgrade the escalation back to a
    // repair that does not exist.
    const decorated = _decorateUnobservedStation(
      { ok: false, error: "review_coverage_incomplete" },
      { ...run, obligationId: null, logicalCycle: null, observationOpened: false },
    );
    assert.equal(decorated.next_action, "escalate_unobserved_station_under_hard_external_dependency");
    assert.equal(decorated.obligation_recorded, false);
    assert.ok(!("obligation_id" in decorated));
  });
});

describe("attempt boundary: what actually counts as a station attempt", () => {
  // Codex cycle-1 blocking finding (class): every non-ok envelope was assigned `not_evaluable`,
  // so cap refusals, invalid input, authorization failures, and post-verdict GitHub failures all
  // emitted an ADR-090 attempt, opened a station-observation obligation, and satisfied the
  // exhaustion predicate — escalating a "hard external dependency" for a station that either
  // never ran or had already rendered its verdict.
  it("records no attempt for a refusal that happened before the reviewer ran", async () => {
    for (const error of [
      "codex_review_prepush_cap_reached",
      "codex_review_cycle_input_invalid",
      "test_quality_review_cycle_input_invalid",
      "auto_grant_unauthorized",
      "execution_obligation_repo_not_authorized",
    ]) {
      const result = await runStationWithNonVerdictRetry({
        stationId: "codex_review",
        maxReattempts: 2,
        invoke: async () => ({ ok: false, error }),
      });
      assert.equal(result.attempts.length, 0, `${error} must not be a station attempt`);
      assert.equal(result.observed, false);
    }
  });

  it("records no unobserved attempt when a rendered verdict merely failed to post", async () => {
    // The reviewer ran and produced findings; the GitHub write failed. That is transport
    // recovery, not a missing observation — re-running the engine would burn a review.
    for (const error of [
      "prepush_cycle_record_failed",
      "review_comment_post_failed",
      "test_quality_review_reserved_marker",
      "review_partial_failure",
    ]) {
      const result = await runStationWithNonVerdictRetry({
        stationId: "test_quality_review",
        maxReattempts: 2,
        invoke: async () => ({ ok: false, error }),
      });
      assert.equal(result.attempts.length, 0, `${error} must not be a station attempt`);
    }
  });

  it("records a cancelled attempt on its own axis, not as an unobserved gate", async () => {
    // The station did execute, so it is a real attempt — but ADR-090 has `cancelled` for exactly
    // this, and it must not open an observation obligation.
    const controller = new AbortController();
    const result = await runStationWithNonVerdictRetry({
      stationId: "test_quality_review",
      maxReattempts: 2,
      signal: controller.signal,
      invoke: async () => {
        controller.abort();
        return { ok: false, error: "test_quality_review_engine_failed" };
      },
    });
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].station_result, "cancelled");
  });

  it("still records the declared transient non-verdicts as unobserved attempts", async () => {
    for (const error of [
      "test_quality_review_engine_failed",
      "test_quality_review_parse_failed",
      "review_coverage_incomplete",
    ]) {
      const result = await runStationWithNonVerdictRetry({
        stationId: "codex_review",
        maxReattempts: 0,
        invoke: async () => ({ ok: false, error }),
      });
      assert.equal(result.attempts.length, 1, error);
      assert.equal(result.attempts[0].station_result, "not_evaluable", error);
    }
  });
});
