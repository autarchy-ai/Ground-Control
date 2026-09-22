import { _resetAsyncJobsForTest } from "./lib/async-job-registry.js";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runImplementMechanical } from "./gc-implement-mechanical.js";
import { baseDeps, completionInput } from "./gc-implement-mechanical.mechanical-fixtures.js";

beforeEach(_resetAsyncJobsForTest);
// Split from gc-implement-mechanical.runimplementmechanical-publish.test.js under
// issue #1692 for the 500-line limit (docs/CODING_STANDARDS.md). Test bodies are
// unchanged.

describe("runImplementMechanical monitor and completion", () => {
  it("waits for CI and Sonar and returns compact successful status", async () => {
    const result = await runImplementMechanical({
      action: "monitor",
      repoPath: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      prNumber: 99,
    }, baseDeps());

    assert.equal(result.ok, true);
    assert.equal(result.ci_status, "green");
    assert.equal(result.sonar_status, "passed");
  });

  it("starts Sonar concurrently with CI and returns an actionable failure", async () => {
    let sonarCalls = 0;
    const result = await runImplementMechanical({
      action: "monitor",
      repoPath: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      prNumber: 99,
    }, baseDeps({
      remoteSnapshot: async () => ({ ok: true, head_sha: "a".repeat(40), branch: "1426-script-phases", failures: [], passed: true }),
    monitorSleep: async () => new Promise((resolve) => setImmediate(resolve)),
    watchCi: async () => ({ ok: true, conclusion: "failure", log_summary: "lint failed" }),
      watchSonar: async () => {
        sonarCalls += 1;
        return { ok: true, skipped: true };
      },
    }));

    assert.equal(result.agent_required, true);
    assert.equal(result.failed_stage, "ci");
    assert.equal(sonarCalls, 1);
  });

  it("runs post-merge close without waiting on additional hosted actions", async () => {
    const calls = [];
    const deps = baseDeps({
      watchCi: async () => { throw new Error("finalize must not wait for post-merge CI"); },
      watchSonar: async () => { throw new Error("finalize must not wait for post-merge Sonar"); },
      assertCompletion: async ({ phase }) => {
        calls.push(phase);
        return { ok: true, readiness_report: "ready", head_sha: "a".repeat(40) };
      },
      closeIssue: async () => {
        calls.push("close");
        return { ok: true, closed: true };
      },
    });
    const readiness = await runImplementMechanical({
      action: "readiness",
      repoPath: "/repo",
      issueNumber: 1426,
      prNumber: 99,
      completion: completionInput(),
    }, deps);
    const finalized = await runImplementMechanical({
      action: "finalize",
      repoPath: "/repo",
      issueNumber: 1426,
      prNumber: 99,
      completion: completionInput(),
    }, deps);

    assert.equal(readiness.ok, true);
    assert.equal(finalized.ok, true);
    assert.deepEqual(calls, ["pre_merge", "post_merge", "close"]);
  });
});
