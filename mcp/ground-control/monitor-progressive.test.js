import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runMonitor } from "./implement/monitor.js";
import { _resetAsyncJobsForTest, pollAsyncJob } from "./lib/async-job-registry.js";
const args = { repoPath: "/repo", issueNumber: 1628, prNumber: 42 };
const snapshot = { ok: true, head_sha: "a".repeat(40), branch: "issue", failures: [], passed: true };
const goodSonar = { ok: true, skipped: true };
const sleep = () => new Promise((resolve) => setImmediate(resolve));
afterEach(_resetAsyncJobsForTest);
describe("progressive hosted remediation", () => {
  it("returns 18 Sonar findings while CI remains pending and preserves its handle", async () => {
    let finishCi;
    const result = await runMonitor(args, {
      remoteSnapshot: async () => snapshot,
      watchCi: () => new Promise((resolve) => { finishCi = resolve; }),
      watchSonar: async () => ({ ok: true, quality_gate: "ERROR", issues_summary: { open_count: 18 }, hotspots_summary: { open_count: 0 } }),
      monitorSleep: sleep,
    });
    assert.equal(result.failed_stage, "sonar");
    assert.equal(result.sonar.issues_summary.open_count, 18);
    assert.equal(pollAsyncJob(result.monitor_jobs.ci).status, "running");
    finishCi({ ok: true, conclusion: "failure" });
    await sleep();
    assert.equal(pollAsyncJob(result.monitor_jobs.ci).result.conclusion, "failure");
    assert.equal(result.head_sha, snapshot.head_sha);
  });
  it("returns CI failure while Sonar is pending", async () => {
    let finishSonar;
    const result = await runMonitor(args, {
      remoteSnapshot: async () => snapshot,
      watchCi: async () => ({ ok: true, conclusion: "failure" }),
      watchSonar: () => new Promise((resolve) => { finishSonar = resolve; }), monitorSleep: sleep,
    });
    assert.equal(result.failed_stage, "ci");
    finishSonar(goodSonar);
    await sleep();
  });
  it("reuses child jobs on unchanged-head resume", async () => {
    let calls = 0;
    const deps = { remoteSnapshot: async () => snapshot, monitorSleep: sleep,
      watchCi: async () => { calls++; return { ok: true, conclusion: "success" }; },
      watchSonar: async () => goodSonar };
    assert.equal((await runMonitor(args, deps)).ok, true);
    assert.equal((await runMonitor(args, deps)).ok, true);
    assert.equal(calls, 1);
  });
  it("starts a fresh Sonar watch after a producer_pending rerun on the same head", async () => {
    let sonarCalls = 0;
    const deps = { remoteSnapshot: async () => snapshot, monitorSleep: sleep,
      watchCi: async () => ({ ok: true, conclusion: "success" }),
      watchSonar: async () => {
        sonarCalls += 1;
        return sonarCalls === 1
          ? { ok: false, error: "sonar_watch_producer_pending", pr_number: 42, head_sha: snapshot.head_sha }
          : goodSonar;
      } };
    const first = await runMonitor(args, deps);
    assert.equal(first.ok, false);
    assert.equal(first.error, "sonar_watch_producer_pending");
    const second = await runMonitor(args, deps);
    assert.equal(second.ok, true);
    assert.equal(sonarCalls, 2);
  });
  it("invalidates old-head completion after a push", async () => {
    let reads = 0;
    const result = await runMonitor(args, {
      remoteSnapshot: async () => ({ ...snapshot, head_sha: ++reads === 1 ? snapshot.head_sha : "b".repeat(40) }),
      watchCi: async () => ({ ok: true, conclusion: "success" }), watchSonar: async () => goodSonar, monitorSleep: sleep,
    });
    assert.equal(result.error, "monitor_head_changed");
  });
});
