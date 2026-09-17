// runWatchSonarAnalysis stops a watch that cannot succeed (issue #1559).
//
// Observed on Brad-Edwards/shifter PR #2114: every changed path was owned by a
// `sonar: false` unit, CI skipped the scan by design, and the watcher still
// polled toward its 30-minute cap for a component SonarCloud answered did not
// exist. The job could not be cancelled, and because the credential gate ran
// before any evidence about whether a Sonar request was needed, the run
// escalated a SONAR_TOKEN provisioning obligation that was never the cause.
//
// Injected clock, sleep, and check-run reader: nothing here waits through a cap.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCheckRollupEntry } from "./lib/sonar-scope.js";
import { runWatchSonarAnalysis } from "./lib/sonar-watcher.js";

const VALID_CONFIG =
  "schema_version: 1\nproject: test\nsonarcloud:\n  project_key: test_key\n  organization: test_org\n";

function makeRepo(yamlBody = VALID_CONFIG) {
  const dir = mkdtempSync(join(tmpdir(), "gc-sonar-scope-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  writeFileSync(join(dir, ".ground-control.yaml"), yamlBody);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
  return dir;
}

function producer(name, conclusion, { status = "COMPLETED", workflowName = null } = {}) {
  return { __typename: "CheckRun", name, workflowName, status, conclusion, completedAt: "2026-09-06T15:59:10Z" };
}

/**
 * Run the watcher with the network, clock, and sleep replaced.
 *
 * `checks` is the PR's check-run rollup; `null` stands for a rollup the server
 * could not read at all.
 */
async function watch({
  yaml = VALID_CONFIG,
  checks = [],
  expectedHeadSha = null,
  token = "test-token-stub",
  fetchImpl = null,
  initialWaitSeconds = 60,
  totalTimeoutSeconds = 1800,
  pollIntervalSeconds = 30,
  authorizeRepoRead = async () => ({ ok: true, repoSlug: "fake/repo" }),
} = {}) {
  const dir = makeRepo(yaml);
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.SONAR_TOKEN;
  if (token === null) delete process.env.SONAR_TOKEN;
  else process.env.SONAR_TOKEN = token;

  let clock = 0;
  const calls = { fetches: [], sleeps: [], producerReads: 0, elapsedMs: () => clock };
  globalThis.fetch = async (url) => {
    calls.fetches.push(url);
    if (fetchImpl) return fetchImpl(url, calls.fetches.length);
    return { status: 404, ok: false, json: async () => ({}) };
  };
  try {
    const result = await runWatchSonarAnalysis({
      repoPath: dir,
      prNumber: 2114,
      expectedHeadSha,
      initialWaitSeconds,
      totalTimeoutSeconds,
      pollIntervalSeconds,
      authorizeRepoRead,
      fetchProducerEvidence: async () => {
        calls.producerReads++;
        if (checks === null) return null;
        return {
          headSha: "a9df89dae32854f0915230ffd17ba2fcb65aee68",
          entries: checks.map(normalizeCheckRollupEntry).filter((entry) => entry !== null),
        };
      },
      sleepMs: async (ms) => { calls.sleeps.push(ms); clock += ms; },
      now: () => clock,
    });
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.SONAR_TOKEN;
    else process.env.SONAR_TOKEN = originalToken;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("runWatchSonarAnalysis — scope pre-check (issue #1559)", () => {
  it("does not read a stale analysis while the current producer is pending", async () => {
    const { result, calls } = await watch({
      expectedHeadSha: "a9df89dae32854f0915230ffd17ba2fcb65aee68",
      checks: [producer("sonar", null, { status: "IN_PROGRESS" })],
      totalTimeoutSeconds: 60,
    });
    assert.equal(result.error, "sonar_watch_producer_pending");
    assert.deepEqual(calls.fetches, []);
  });
  it("rejects an analysis read after the PR head changes", async () => {
    const { result, calls } = await watch({ expectedHeadSha: "b".repeat(40) });
    assert.equal(result.error, "sonar_watch_head_changed");
    assert.deepEqual(calls.fetches, []);
  });

  it("stops on a terminally skipped producer without alleging a credential fault", async () => {
    const { result } = await watch({ checks: [producer("sonar", "SKIPPED", { workflowName: "SonarCloud" })], token: null });
    assert.equal(result.ok, false);
    assert.equal(result.error, "sonar_watch_analysis_not_produced");
    assert.equal(result.scope, "unproved");
    assert.equal(result.scope_evidence.reason, "producer_skipped");
    // The whole point of the issue: no token obligation for a scan that never ran.
    assert.equal(result.message.includes("SONAR_TOKEN"), false);
  });

  it("spends no propagation wait and no SonarCloud request on a watch that cannot succeed", async () => {
    const { calls } = await watch({ checks: [producer("sonar", "SKIPPED")], token: null });
    assert.deepEqual(calls.sleeps, []);
    assert.deepEqual(calls.fetches, []);
  });

  // A red `SonarCloud Code Analysis` check reports a rejected quality gate, so
  // an analysis exists. Terminating on it would hide the real issue and hotspot
  // lists behind an "unevaluable gate" that Sonar had in fact evaluated.
  it("still reads SonarCloud when the producer failed, because a failure can mean a rejected analysis", async () => {
    const { result, calls } = await watch({
      checks: [producer("sonar", "FAILURE")],
      initialWaitSeconds: 0,
      fetchImpl: (url) => (url.includes("qualitygates")
        ? { status: 200, ok: true, json: async () => ({ projectStatus: { status: "ERROR" } }) }
        : { status: 200, ok: true, json: async () => ({ total: 0, issues: [], paging: { total: 0 }, hotspots: [] }) }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.quality_gate, "ERROR");
    assert.ok(calls.fetches.length > 0);
  });

  it("binds the evidence to the repository, pull request, and head revision inspected", async () => {
    const { result } = await watch({ checks: [producer("sonar", "SKIPPED")] });
    const evidence = result.scope_evidence;
    assert.equal(evidence.repo, "fake/repo");
    assert.equal(evidence.pr_number, 2114);
    assert.equal(evidence.head_sha, "a9df89dae32854f0915230ffd17ba2fcb65aee68");
    assert.equal(evidence.project_key, "test_key");
    assert.deepEqual(evidence.checks.map((c) => c.conclusion), ["skipped"]);
  });

  it("keeps waiting while the producer is still running", async () => {
    const { result, calls } = await watch({
      checks: [producer("sonar", null, { status: "IN_PROGRESS" })],
      initialWaitSeconds: 0,
      fetchImpl: (url) => (url.includes("qualitygates")
        ? { status: 200, ok: true, json: async () => ({ projectStatus: { status: "OK" } }) }
        : { status: 200, ok: true, json: async () => ({ total: 0, issues: [], paging: { total: 0 }, hotspots: [] }) }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.quality_gate, "OK");
    assert.ok(calls.fetches.length > 0);
  });

  it("leaves behavior unchanged when no producer check is observed at all", async () => {
    const { result } = await watch({
      checks: [producer("policy", "SUCCESS")],
      initialWaitSeconds: 0,
      fetchImpl: (url) => (url.includes("qualitygates")
        ? { status: 200, ok: true, json: async () => ({ projectStatus: { status: "OK" } }) }
        : { status: 200, ok: true, json: async () => ({ total: 0, issues: [], paging: { total: 0 }, hotspots: [] }) }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.quality_gate, "OK");
  });

  it("falls through to the existing watch when the check-run rollup cannot be read", async () => {
    const { result } = await watch({ checks: null, token: null });
    assert.equal(result.error, "sonar_watch_token_missing");
  });
});

describe("runWatchSonarAnalysis — the watch budget actually bounds the call", () => {
  it("clips the propagation wait to the remaining budget instead of sleeping it in full", async () => {
    const { result, calls } = await watch({
      checks: [producer("sonar", "SUCCESS")],
      initialWaitSeconds: 120,
      totalTimeoutSeconds: 60,
    });
    assert.equal(result.ok, true);
    assert.equal(result.timed_out, true);
    // The wait is cut to what the cap allows, and it exhausts it, so no
    // quality-gate poll is ever due.
    assert.deepEqual(calls.sleeps, [60_000]);
    assert.deepEqual(calls.fetches, []);
    assert.ok(calls.elapsedMs() <= 60_000, `elapsed ${calls.elapsedMs()}ms exceeded the 60s cap`);
  });

  it("keeps the whole call inside the cap when polling repeatedly returns no analysis", async () => {
    const { result, calls } = await watch({
      checks: [producer("sonar", "SUCCESS")],
      initialWaitSeconds: 60,
      totalTimeoutSeconds: 300,
      pollIntervalSeconds: 30,
      fetchImpl: () => ({ status: 404, ok: false, json: async () => ({}) }),
    });
    assert.equal(result.timed_out, true);
    assert.ok(calls.elapsedMs() <= 300_000, `elapsed ${calls.elapsedMs()}ms exceeded the 300s cap`);
  });

  it("bounds the retry backoff too, so a flapping endpoint cannot outrun the cap", async () => {
    const { result, calls } = await watch({
      checks: [producer("sonar", "SUCCESS")],
      initialWaitSeconds: 0,
      totalTimeoutSeconds: 2,
      pollIntervalSeconds: 1,
      fetchImpl: () => ({ status: 503, ok: false, json: async () => ({}) }),
    });
    assert.equal(result.ok, false);
    assert.ok(calls.elapsedMs() <= 2_000, `elapsed ${calls.elapsedMs()}ms exceeded the 2s cap`);
  });
});

describe("runWatchSonarAnalysis — the privileged pull-request read is authorized", () => {
  // The harm is another repository's pull-request metadata coming back in
  // scope_evidence. Not making the request prevents it outright, and the Sonar
  // watch itself needs no GitHub access, so an unauthorized checkout loses the
  // optimization rather than a gate it can still evaluate.
  it("never reads pull-request metadata for a checkout it is not authorized to act on", async () => {
    const unauthorized = async () => ({
      ok: false,
      error: "sonar_watch_repo_not_authorized",
      message: "The requested repository is outside the MCP launch workspace authorized for this run",
    });
    const { result, calls } = await watch({
      authorizeRepoRead: unauthorized,
      checks: [producer("sonar", "SKIPPED")],
      initialWaitSeconds: 0,
      fetchImpl: (url) => (url.includes("qualitygates")
        ? { status: 200, ok: true, json: async () => ({ projectStatus: { status: "OK" } }) }
        : { status: 200, ok: true, json: async () => ({ total: 0, issues: [], paging: { total: 0 }, hotspots: [] }) }),
    });
    assert.equal(calls.producerReads, 0);
    assert.equal(result.scope_evidence, undefined);
    // ... and the watch it can legitimately perform still runs.
    assert.equal(result.ok, true);
    assert.equal(result.quality_gate, "OK");
  });
});

describe("runWatchSonarAnalysis — a gate that cannot be read is never a cleared gate", () => {
  it("refuses a malformed .ground-control.yaml instead of reporting a skip", async () => {
    const { result } = await watch({ yaml: "schema_version: 1\nproject: test\nsonarcloud:\n  organization: test_org\n" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "sonar_watch_config_invalid");
    assert.equal(result.skipped, undefined);
  });

  // Only ENOENT proves the repo never opted in. A permission or wrong-type read
  // failure means the declaration could not be read, and the caller turns a
  // "no config" answer into a skip that clears the gate.
  it("refuses a .ground-control.yaml it cannot read at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-sonar-unreadable-"));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    // A directory at the config path: readFileSync raises EISDIR, not ENOENT.
    execFileSync("mkdir", ["-p", join(dir, ".ground-control.yaml")]);
    try {
      const result = await runWatchSonarAnalysis({
        repoPath: dir,
        prNumber: 2114,
        initialWaitSeconds: 0,
        authorizeRepoRead: async () => ({ ok: true, repoSlug: "fake/repo" }),
        fetchProducerEvidence: async () => null,
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, "sonar_watch_config_invalid");
      assert.equal(result.skipped, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still skips cleanly for a valid config that declares no sonarcloud block", async () => {
    const { result } = await watch({ yaml: "schema_version: 1\nproject: test\n" });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.quality_gate, "NONE");
  });

  it("reports a rejected credential as an authentication failure, not a missing one", async () => {
    const { result } = await watch({
      checks: [producer("sonar", "SUCCESS")],
      initialWaitSeconds: 0,
      fetchImpl: () => ({ status: 401, ok: false, json: async () => ({}) }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "sonar_watch_authentication_failed");
  });

  it("refuses a malformed quality-gate body instead of polling on it forever", async () => {
    const { result, calls } = await watch({
      checks: [producer("sonar", "SUCCESS")],
      initialWaitSeconds: 0,
      fetchImpl: () => ({ status: 200, ok: true, json: async () => "not-an-object" }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "sonar_watch_quality_gate_malformed");
    assert.equal(calls.fetches.length, 1);
  });

  it("keeps polling on SonarCloud's component-not-found error document", async () => {
    const { result } = await watch({
      checks: [producer("sonar", "SUCCESS")],
      initialWaitSeconds: 0,
      pollIntervalSeconds: 1,
      fetchImpl: (url, n) => {
        if (!url.includes("qualitygates")) {
          return { status: 200, ok: true, json: async () => ({ total: 0, issues: [], paging: { total: 0 }, hotspots: [] }) };
        }
        if (n === 1) {
          return { status: 200, ok: true, json: async () => ({ errors: [{ msg: "Component 'x' of pull request '2114' not found" }] }) };
        }
        return { status: 200, ok: true, json: async () => ({ projectStatus: { status: "OK" } }) };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.quality_gate, "OK");
  });
});
