// The /integrate lane's production Sonar adapter (issue #1559).
//
// Every other test in this lane injects `runSonarWatcher` as a hand-written
// fake that already returns the hook contract's shape, so `defaultRunSonarWatcher`
// — the function that actually maps a `runWatchSonarAnalysis` envelope onto that
// contract, and the function this issue changes — was never invoked. Reverting
// its `!result.ok` branch to the pre-fix `{conclusion: "skipped"}` would have
// left every one of those tests green while the lane regressed to blaming the
// repository's Sonar configuration for a scan its own CI declined to run.
//
// These drive the adapter itself, with the watcher injected.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultRunSonarWatcher } from "./gc-integrate/exec-file-async.js";

const PR = { pr_number: 2114 };
const CTX = { repoRoot: "/repo" };
const SCOPE_EVIDENCE = {
  source: "github_check_runs",
  repo: "Brad-Edwards/shifter",
  pr_number: 2114,
  head_sha: "a9df89dae32854f0915230ffd17ba2fcb65aee68",
  reason: "producer_skipped",
  checks: [{ name: "sonar", status: "completed", conclusion: "skipped" }],
};

const adapt = (envelope) => defaultRunSonarWatcher(PR, CTX, undefined, async () => envelope);

describe("defaultRunSonarWatcher — watcher envelope to hook contract", () => {
  it("passes an unevaluable gate's reason and scope evidence through the skip", async () => {
    const result = await adapt({
      ok: false,
      error: "sonar_watch_analysis_not_produced",
      scope: "unproved",
      scope_evidence: SCOPE_EVIDENCE,
    });
    assert.equal(result.conclusion, "skipped");
    assert.equal(result.reason, "sonar_watch_analysis_not_produced");
    assert.deepEqual(result.scope_evidence, SCOPE_EVIDENCE);
  });

  it("names the reason even when the watcher produced no scope evidence", async () => {
    const result = await adapt({ ok: false, error: "sonar_watch_token_missing" });
    assert.equal(result.conclusion, "skipped");
    assert.equal(result.reason, "sonar_watch_token_missing");
    assert.equal("scope_evidence" in result, false);
  });

  it("keeps a configured-but-absent Sonar block a plain skip with no cause attached", async () => {
    const result = await adapt({ ok: true, skipped: true, quality_gate: "NONE" });
    assert.deepEqual(result, { conclusion: "skipped" });
  });

  it("maps an evaluated gate onto success and failure", async () => {
    assert.deepEqual(await adapt({ ok: true, skipped: false, quality_gate: "OK" }), { conclusion: "success" });
    assert.deepEqual(await adapt({ ok: true, skipped: false, quality_gate: "ERROR" }), { conclusion: "failure" });
    assert.deepEqual(await adapt({ ok: true, skipped: false, quality_gate: "WARN" }), { conclusion: "failure" });
  });

  it("forwards the pull request and repository the lane asked about", async () => {
    let observed = null;
    await defaultRunSonarWatcher(PR, CTX, undefined, async (args) => {
      observed = args;
      return { ok: true, skipped: true };
    });
    assert.deepEqual(observed, { repoPath: "/repo", prNumber: 2114, expectedHeadSha: null });
  });

  it("forwards the commit the lane pushed so the scan is read for that head (issue #1365)", async () => {
    let observed = null;
    const pushed = "0f3c1d2e4a5b6c7d8e9f0a1b2c3d4e5f60718293";
    await defaultRunSonarWatcher({ ...PR, pushed_head_sha: pushed }, CTX, undefined, async (args) => {
      observed = args;
      return { ok: true, skipped: true };
    });
    assert.equal(observed.expectedHeadSha, pushed);
  });
});
