// Bounded terminal-wait coverage for the shared async job registry (issue
// #1669), split out of lib.asyncjobregistry.test.js because the combined suite
// crossed the 500-line limit (ADR-092, docs/CODING_STANDARDS.md). The waiting
// operation is its own seam: it is the only registry behavior that resolves
// from a job's terminal transition rather than from a caller's call.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("bounded terminal wait for async jobs (issue #1669)", () => {
  const flush = () => new Promise((r) => setImmediate(r));

  it("returns an already-terminal job's envelope without waiting", async () => {
    const { awaitAsyncJob, pollAsyncJob, startAsyncJob, _resetAsyncJobsForTest } =
      await import("./lib.js");
    _resetAsyncJobsForTest();
    const start = startAsyncJob("codex_review", () => Promise.resolve({ ok: true, verdict: "ship" }));
    await flush();

    const awaited = await awaitAsyncJob(start.job_id, 1000);

    assert.deepEqual(awaited, pollAsyncJob(start.job_id));
    assert.equal(awaited.status, "done");
    assert.deepEqual(awaited.result, { ok: true, verdict: "ship" });
  });

  it("resolves as soon as a running job reaches each terminal state", async () => {
    const { awaitAsyncJob, cancelAsyncJob, startAsyncJob, _resetAsyncJobsForTest } =
      await import("./lib.js");
    _resetAsyncJobsForTest();
    let settleDone;
    let settleFailed;
    const done = startAsyncJob("architecture_preflight", () => new Promise((r) => { settleDone = r; }));
    const failed = startAsyncJob("codex_review", () => new Promise((_r, reject) => { settleFailed = reject; }));
    const cancelled = startAsyncJob("codex_review", (signal) => new Promise((_r, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    await flush();

    // A generous bound: each wait must be released by the terminal transition,
    // not by its own expiry, or the test would hang well past node --test's limit.
    const waits = Promise.all([
      awaitAsyncJob(done.job_id, 30000),
      awaitAsyncJob(failed.job_id, 30000),
      awaitAsyncJob(cancelled.job_id, 30000),
    ]);
    settleDone({ ok: false, action: "monitor", error: "ci_failure" });
    settleFailed(new Error("codex exec blew up"));
    cancelAsyncJob(cancelled.job_id);
    const [doneEnvelope, failedEnvelope, cancelledEnvelope] = await waits;

    assert.equal(doneEnvelope.status, "done");
    assert.equal(failedEnvelope.status, "failed");
    assert.equal(failedEnvelope.error, "job_failed");
    assert.equal(cancelledEnvelope.status, "cancelled");
    assert.equal(cancelledEnvelope.error, "job_cancelled");
  });

  it("preserves a completed job whose own result is a gate failure", async () => {
    const { awaitAsyncJob, startAsyncJob, _resetAsyncJobsForTest } = await import("./lib.js");
    _resetAsyncJobsForTest();
    // The distinction this asserts is the whole point of the transport: a red
    // gate is a completed job, never a transport-level failure.
    const envelope = { ok: false, action: "publish", agent_required: true, error: "implement_mechanical_merge_conflicts" };
    let settle;
    const start = startAsyncJob("implement_mechanical_publish", () => new Promise((r) => { settle = r; }));
    await flush();

    const waiting = awaitAsyncJob(start.job_id, 30000);
    settle(envelope);
    const awaited = await waiting;

    assert.equal(awaited.ok, true, "the transport succeeded even though the action did not");
    assert.equal(awaited.status, "done");
    assert.deepEqual(awaited.result, envelope);
  });

  it("returns the ordinary running envelope when the bounded wait expires", async () => {
    const { awaitAsyncJob, pollAsyncJob, startAsyncJob, _resetAsyncJobsForTest } =
      await import("./lib.js");
    _resetAsyncJobsForTest();
    let settle;
    const start = startAsyncJob("monitor_ci", () => new Promise((r) => { settle = r; }));
    await flush();

    const expired = await awaitAsyncJob(start.job_id, 5);

    assert.equal(expired.ok, true);
    assert.equal(expired.status, "running");
    assert.equal(expired.job_id, start.job_id);
    // Expiry is not cancellation: the job keeps running and stays pollable.
    assert.equal(pollAsyncJob(start.job_id).status, "running");
    settle({ ok: true });
    await flush();
    assert.equal(pollAsyncJob(start.job_id).status, "done");
  });

  it("resolves a job that completes while the wait is being registered", async () => {
    const { awaitAsyncJob, startAsyncJob, _resetAsyncJobsForTest } = await import("./lib.js");
    _resetAsyncJobsForTest();
    let settle;
    const start = startAsyncJob("codex_review_cycle", () => new Promise((r) => { settle = r; }));
    await flush();

    // Settle in the same tick the wait is created, before any await yields.
    const waiting = awaitAsyncJob(start.job_id, 30000);
    settle({ ok: true, next_action: "advance" });
    const awaited = await waiting;

    assert.equal(awaited.status, "done");
    assert.deepEqual(awaited.result, { ok: true, next_action: "advance" });
  });

  it("releases every concurrent waiter on one job", async () => {
    const { awaitAsyncJob, startAsyncJob, _resetAsyncJobsForTest } = await import("./lib.js");
    _resetAsyncJobsForTest();
    let settle;
    const start = startAsyncJob("monitor_sonar", () => new Promise((r) => { settle = r; }));
    await flush();

    const waits = Promise.all([
      awaitAsyncJob(start.job_id, 30000),
      awaitAsyncJob(start.job_id, 30000),
      awaitAsyncJob(start.job_id, 30000),
    ]);
    settle({ ok: true, quality_gate: "OK" });
    const envelopes = await waits;

    assert.equal(envelopes.length, 3);
    for (const envelope of envelopes) {
      assert.equal(envelope.status, "done");
      assert.deepEqual(envelope.result, { ok: true, quality_gate: "OK" });
    }
  });

  it("reports an unknown, malformed, or expired handle without echoing caller input", async () => {
    const {
      ASYNC_JOB_TTL_MS,
      awaitAsyncJob,
      startAsyncJob,
      _resetAsyncJobsForTest,
      _setAsyncJobClockForTest,
    } = await import("./lib.js");
    _resetAsyncJobsForTest();
    let now = 1000;
    _setAsyncJobClockForTest(() => now);

    const unknown = await awaitAsyncJob("job-does-not-exist-1", 30000);
    assert.equal(unknown.error, "job_not_found");
    assert.doesNotMatch(unknown.message, /job-does-not-exist-1/);

    const malformed = await awaitAsyncJob("../../etc/passwd", 30000);
    assert.equal(malformed.error, "job_not_found");
    assert.doesNotMatch(malformed.message, /passwd/);

    const start = startAsyncJob("codex_review", () => Promise.resolve({ ok: true }));
    await flush();
    now += ASYNC_JOB_TTL_MS + 1;
    assert.equal((await awaitAsyncJob(start.job_id, 30000)).error, "job_not_found");
    _resetAsyncJobsForTest();
  });

  it("refuses an out-of-range wait rather than clamping it", async () => {
    const {
      ASYNC_JOB_WAIT_SECONDS_MAX,
      awaitAsyncJob,
      pollAsyncJob,
      startAsyncJob,
      _resetAsyncJobsForTest,
    } = await import("./lib.js");
    _resetAsyncJobsForTest();
    let settle;
    const start = startAsyncJob("codex_review", () => new Promise((r) => { settle = r; }));
    await flush();

    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "600", null, ASYNC_JOB_WAIT_SECONDS_MAX * 1000 + 1]) {
      const refused = await awaitAsyncJob(start.job_id, bad);
      assert.equal(refused.ok, false, `wait ${String(bad)} must be refused`);
      assert.equal(refused.error, "job_wait_invalid");
      assert.equal(refused.job_id, undefined);
    }
    // A refusal is not a cancellation.
    assert.equal(pollAsyncJob(start.job_id).status, "running");
    settle({ ok: true });
    await flush();
  });

  it("bounds the wait window below the supported MCP client tool timeout", async () => {
    const { ASYNC_JOB_WAIT_SECONDS_DEFAULT, ASYNC_JOB_WAIT_SECONDS_MAX } = await import("./lib.js");
    // The default has to cover a default-capped codex child (20 min,
    // CODEX_TIMEOUT_MS_DEFAULT) in one wait, and the max has to stay well under
    // the 3,600,000 ms MCP_TOOL_TIMEOUT this repo configures.
    assert.ok(ASYNC_JOB_WAIT_SECONDS_DEFAULT >= 1200);
    assert.ok(ASYNC_JOB_WAIT_SECONDS_DEFAULT <= ASYNC_JOB_WAIT_SECONDS_MAX);
    assert.ok(ASYNC_JOB_WAIT_SECONDS_MAX * 1000 <= 1800000);
  });

  it("leaves retention, cancellation, and idempotency semantics unchanged after a wait", async () => {
    const { awaitAsyncJob, cancelAsyncJob, startAsyncJob, _resetAsyncJobsForTest } =
      await import("./lib.js");
    _resetAsyncJobsForTest();
    const options = {
      idempotencyKey: "attempt-1669-monitor-1",
      idempotencyNamespace: "repo:/repo:issue:1669:action:monitor",
      fingerprint: "c".repeat(64),
    };
    let settle;
    let runCount = 0;
    const run = () => {
      runCount += 1;
      return new Promise((r) => { settle = r; });
    };
    const start = startAsyncJob("implement_mechanical_monitor", run, { ...options, cancellable: false });
    await flush();

    const expired = await awaitAsyncJob(start.job_id, 5);
    assert.equal(expired.status, "running");
    // Waiting neither grants cancellation nor re-runs the job under its key.
    assert.equal(cancelAsyncJob(start.job_id).error, "job_not_cancellable");
    assert.equal(startAsyncJob("implement_mechanical_monitor", run, { ...options, cancellable: false }).job_id, start.job_id);
    assert.equal(runCount, 1);

    settle({ ok: true, action: "monitor" });
    await flush();
    assert.deepEqual((await awaitAsyncJob(start.job_id, 5)).result, { ok: true, action: "monitor" });
  });
});
