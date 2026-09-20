// A run whose status reads `queued` between jobs is not stuck in the queue, and
// every watcher envelope names one run consistently (issue #1581).

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ciRunQueuedSeconds, runWatchCiRun } from "./lib.js";

const CREATED = "2026-09-13T00:36:26Z";
const CREATED_MS = Date.parse(CREATED);
const HEAD_SHA = "1581feedfacecafebabe0000000000000000beef";

function job(name, status, conclusion = "") {
  return { name, status, conclusion, steps: [] };
}

function run(id, workflowName, status, conclusion, jobs, extra = {}) {
  return {
    databaseId: id,
    workflowName,
    status,
    conclusion,
    createdAt: CREATED,
    startedAt: CREATED,
    url: `https://example.test/actions/runs/${id}`,
    jobs,
    ...extra,
  };
}

const done = (id, workflowName) =>
  run(id, workflowName, "completed", "success", [job("check", "completed", "success")]);

// Drives runWatchCiRun on a simulated clock that starts at the runs' creation.
// `timeline(seconds)` returns the snapshots GitHub would report at that moment.
async function watch(repoDir, runIds, timeline, options = {}) {
  let nowMs = CREATED_MS;
  return runWatchCiRun({
    repoPath: repoDir,
    branch: "1581-feature",
    authorizeRepoRead: async () => ({ ok: true, repoSlug: "o/r" }),
    resolveHeadSha: async () => HEAD_SHA,
    resolveRuns: async () => runIds.map((databaseId) => ({ databaseId })),
    fetchRunSnapshot: async (_root, _slug, id) =>
      timeline(Math.floor((nowMs - CREATED_MS) / 1000)).find((snap) => snap.databaseId === id),
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    ...options,
  });
}

function assertRunIdentity(envelope) {
  if (envelope.run_id !== null) {
    assert.equal(envelope.url, `https://example.test/actions/runs/${envelope.run_id}`);
  }
  for (const member of envelope.runs) {
    assert.equal(member.url, `https://example.test/actions/runs/${member.run_id}`);
  }
}

describe("runWatchCiRun queued_too_long is a per-run wait for a first runner (issue #1581)", () => {
  let repoDir;
  before(() => {
    repoDir = mkdtempSync(join(tmpdir(), "gc-ci-watch-1581-"));
    execFileSync("git", ["-C", repoDir, "init", "-q"]);
  });
  after(() => rmSync(repoDir, { recursive: true, force: true }));

  it("returns a failed job without waiting for a slow sibling workflow", async () => {
    const result = await watch(repoDir, [21, 26], () => [
      run(21, "lint", "in_progress", "", [job("lint", "completed", "failure")]),
      run(26, "tests", "in_progress", "", [job("tests", "in_progress")]),
    ], { sleep: async () => { throw new Error("must not wait after failure"); } });
    assert.equal(result.conclusion, "failure");
    assert.equal(result.run_id, 21);
    assert.deepEqual(result.pending_run_ids, [21, 26]);
    assert.equal(result.wait_after_actionable_ms, 0);
  });

  it("completes as success when a run shows queued between jobs after the queued cap", async () => {
    // OpenRAE/env-packs PR #351: tests ran 00:36:29-00:43:55, then sonar and
    // verify (needs: tests) waited for runners, so the CI run read `queued`
    // at 449s of watching.
    let sawQueuedGap = false;
    const ci = (seconds) => {
      if (seconds < 449) {
        return run(26, "CI", "in_progress", "", [
          job("docs", "completed", "success"),
          job("tests", "in_progress"),
          job("sonar", "queued"),
          job("verify", "queued"),
        ]);
      }
      if (seconds < 540) {
        sawQueuedGap = true;
        return run(26, "CI", "queued", "", [
          job("docs", "completed", "success"),
          job("tests", "completed", "success"),
          job("sonar", "queued"),
          job("verify", "queued"),
        ]);
      }
      if (seconds < 600) {
        return run(26, "CI", "in_progress", "", [job("tests", "completed", "success"), job("sonar", "in_progress")]);
      }
      return run(26, "CI", "completed", "success", [job("tests", "completed", "success"), job("sonar", "completed", "success")]);
    };
    const r = await watch(repoDir, [21, 26, 43, 55], (seconds) => [
      done(21, "CodeQL"),
      ci(seconds),
      done(43, "PR Title"),
      done(55, "Fuzz"),
    ]);

    assert.ok(sawQueuedGap, "the watch must have polled inside the between-jobs gap");
    assert.equal(r.ok, true);
    assert.equal(r.conclusion, "success");
    assert.ok(r.duration_seconds > 300);
    // The success belongs to the set, not to the three-second PR Title run.
    assert.equal(r.run_id, null);
    assert.equal(r.url, null);
    assert.deepEqual(r.runs.map((m) => [m.run_id, m.workflow, m.conclusion]), [
      [21, "CodeQL", "success"],
      [26, "CI", "success"],
      [43, "PR Title", "success"],
      [55, "Fuzz", "success"],
    ]);
    assertRunIdentity(r);
  });

  it("reports queued_too_long, naming the stuck run, when no job ever starts", async () => {
    const r = await watch(repoDir, [21, 26], () => [
      run(21, "CodeQL", "in_progress", "", [job("analyze", "in_progress")]),
      run(26, "CI", "queued", "", [job("tests", "queued")]),
    ]);

    assert.equal(r.conclusion, "queued_too_long");
    assert.equal(r.run_id, 26);
    assert.equal(r.status, "queued");
    assert.equal(r.url, "https://example.test/actions/runs/26");
    assert.ok(r.duration_seconds > 300 && r.duration_seconds < 330);
    assertRunIdentity(r);
  });

  it("counts a run's queue wait from before the watch began, and restarts it on a re-run", async () => {
    const stale = await watch(repoDir, [26], () => [
      run(26, "CI", "queued", "", [job("tests", "queued")], { createdAt: "2026-09-13T00:20:00Z", startedAt: "2026-09-13T00:20:00Z" }),
    ]);
    assert.equal(stale.conclusion, "queued_too_long");
    assert.equal(stale.duration_seconds, 0, "a run already queued past the cap is reported on the first poll");

    const rerun = await watch(
      repoDir,
      [26],
      (seconds) => [
        seconds < 60
          ? run(26, "CI", "queued", "", [job("tests", "queued")], { createdAt: "2026-09-12T00:00:00Z", startedAt: CREATED })
          : run(26, "CI", "completed", "success", [job("tests", "completed", "success")], { createdAt: "2026-09-12T00:00:00Z" }),
      ],
    );
    assert.equal(rerun.conclusion, "success");
    assert.equal(rerun.run_id, 26);
    assert.equal(rerun.url, "https://example.test/actions/runs/26");
  });

  it("reports timed_out for a started run on the run it is about", async () => {
    const r = await watch(
      repoDir,
      [21, 26],
      () => [done(21, "CodeQL"), run(26, "CI", "queued", "", [job("tests", "completed", "success"), job("sonar", "queued")])],
      { totalTimeoutSeconds: 900 },
    );

    assert.equal(r.conclusion, "timed_out");
    assert.equal(r.run_id, 26);
    assertRunIdentity(r);
  });
});

describe("ciRunQueuedSeconds (issue #1581)", () => {
  const nowMs = CREATED_MS + 400_000;

  it("is null once any job has claimed a runner, and ignores skipped jobs", () => {
    assert.equal(ciRunQueuedSeconds(run(1, "CI", "queued", "", [job("a", "completed", "success"), job("b", "queued")]), nowMs, nowMs), null);
    assert.equal(ciRunQueuedSeconds(run(1, "CI", "queued", "", [job("a", "completed", "skipped"), job("b", "queued")]), nowMs, nowMs), 400);
  });

  it("falls back to the first queued observation when gh reports no usable timestamp", () => {
    const snapshot = run(1, "CI", "queued", "", [], { createdAt: "0001-01-01T00:00:00Z", startedAt: "0001-01-01T00:00:00Z" });
    assert.equal(ciRunQueuedSeconds(snapshot, nowMs, nowMs - 30_000), 30);
  });
});
