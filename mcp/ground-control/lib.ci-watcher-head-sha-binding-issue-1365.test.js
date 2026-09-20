// The CI gate answers for the commit that was pushed, not for whichever run
// GitHub happened to list first (issue #1365).
//
// `gh run list` is ordered by creation, and a push's own runs register seconds
// to minutes after the push returns. Selecting the newest listed run therefore
// selected the *previous* commit's run during exactly the window the gate is
// consulted in, and its success passed as this commit's.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runWatchCiRun } from "./lib.js";

const PUSHED = "1365aaaabbbbccccddddeeeeffff000011112222";
const PRIOR = "0000111122223333444455556666777788889999";

function listed(databaseId, headSha, workflowName, conclusion = "success") {
  return {
    databaseId,
    headSha,
    workflowName,
    status: "completed",
    conclusion,
    url: `https://example.test/actions/runs/${databaseId}`,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function snapshotOf(run) {
  return { ...run, startedAt: run.createdAt, jobs: [{ name: "check", status: "completed", conclusion: run.conclusion, steps: [] }] };
}

// Drives runWatchCiRun over a listing that changes with simulated time, through
// the production selection path (`resolveRuns` is left at its default only in
// the sense that the filtering under test is the real one).
async function watch(repoDir, listingAt, options = {}) {
  let nowMs = 0;
  const { selectCiRunsForHeadSha } = await import("./lib.js");
  return runWatchCiRun({
    repoPath: repoDir,
    branch: "1365-feature",
    pollIntervalSeconds: 15,
    authorizeRepoRead: async () => ({ ok: true, repoSlug: "o/r" }),
    resolveHeadSha: async () => PUSHED,
    resolveRuns: async (_root, _slug, _branch, headSha) =>
      selectCiRunsForHeadSha(listingAt(Math.floor(nowMs / 1000)), headSha),
    fetchRunSnapshot: async (_root, _slug, id) =>
      snapshotOf(listingAt(Math.floor(nowMs / 1000)).find((run) => run.databaseId === id)),
    fetchFailedLog: async () => "",
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    ...options,
  });
}

describe("runWatchCiRun binds the gate to the pushed head SHA (issue #1365)", () => {
  let repoDir;
  before(() => {
    repoDir = mkdtempSync(join(tmpdir(), "gc-ci-watch-1365-"));
    execFileSync("git", ["-C", repoDir, "init", "-q"]);
  });
  after(() => rmSync(repoDir, { recursive: true, force: true }));

  it("waits for a delayed registration instead of reporting the prior commit's green", async () => {
    // For the first 60s the only run on the branch is the previous commit's,
    // and it is green. The pushed commit's run registers after that.
    const listingAt = (seconds) =>
      seconds < 60
        ? [listed(100, PRIOR, "CI")]
        : [listed(200, PUSHED, "CI"), listed(100, PRIOR, "CI")];

    const r = await watch(repoDir, listingAt);

    assert.equal(r.ok, true);
    assert.equal(r.conclusion, "success");
    assert.equal(r.run_id, 200, "the gate must report the pushed commit's run, not run 100");
    assert.equal(r.head_sha, PUSHED);
    assert.equal(r.workflow, "CI");
  });

  it("reports the pushed commit's failure even while a prior green run is listed", async () => {
    const r = await watch(repoDir, () => [
      listed(300, PUSHED, "CI", "failure"),
      listed(100, PRIOR, "CI"),
    ]);

    assert.equal(r.conclusion, "failure");
    assert.equal(r.run_id, 300);
    assert.equal(r.head_sha, PUSHED);
    assert.deepEqual(r.runs.map((run) => run.run_id), [300]);
  });

  it("does not let a newer unrelated workflow on an older commit answer for the push", async () => {
    // The shape reported on RAESystem/rae PR #918: a five-second title lint
    // finished first and was the newest run on the branch.
    const listingAt = (seconds) =>
      seconds < 30
        ? [listed(400, PRIOR, "PR Title Lint"), listed(100, PRIOR, "CI")]
        : [listed(500, PUSHED, "CI"), listed(400, PRIOR, "PR Title Lint"), listed(100, PRIOR, "CI")];

    const r = await watch(repoDir, listingAt);

    assert.equal(r.run_id, 500);
    assert.equal(r.head_sha, PUSHED);
  });

  it("refuses rather than passing when no run registers for the head within the bound", async () => {
    const r = await watch(repoDir, () => [listed(100, PRIOR, "CI")], {
      runRegistrationTimeoutSeconds: 60,
    });

    assert.equal(r.ok, false);
    assert.equal(r.error, "ci_watch_no_run_for_head_sha");
    assert.equal(r.head_sha, PUSHED);
    assert.match(r.message, /within 60s/);
  });

  it("refuses when the branch tip lookup answers with something that is not a commit", async () => {
    const r = await watch(repoDir, () => [], { resolveHeadSha: async () => "[]" });

    assert.equal(r.ok, false);
    assert.equal(r.error, "ci_watch_head_sha_unresolved");
  });

  it("refuses when the branch tip cannot be resolved", async () => {
    const r = await watch(repoDir, () => [], {
      resolveHeadSha: async () => {
        throw new Error("HTTP 404: Not Found");
      },
    });

    assert.equal(r.ok, false);
    assert.equal(r.error, "ci_watch_head_sha_unresolved");
    assert.match(r.message, /404/);
  });

  it("refuses a pinned run_id that ran on a different commit than the caller expects", async () => {
    const r = await watch(repoDir, () => [listed(100, PRIOR, "CI")], {
      runId: 100,
      expectedHeadSha: PUSHED,
    });

    assert.equal(r.ok, false);
    assert.equal(r.error, "ci_watch_run_head_mismatch");
    assert.equal(r.run_id, 100);
    assert.equal(r.head_sha, PUSHED);
    assert.equal(r.run_head_sha, PRIOR);
  });

  it("spends the registration wait from the total cap rather than beside it", async () => {
    // A run that never registers must not leave a full poll budget behind it.
    const r = await watch(repoDir, () => [listed(100, PRIOR, "CI")], {
      runRegistrationTimeoutSeconds: 600,
      totalTimeoutSeconds: 120,
    });

    assert.equal(r.error, "ci_watch_no_run_for_head_sha");
    assert.match(r.message, /within 120s/, "the effective bound is the smaller of the two caps");
  });
});

describe("selectCiRunsForHeadSha (issues #1461, #1365)", () => {
  it("keeps every run for the bound head SHA, not just the newest run", async () => {
    const { selectCiRunsForHeadSha } = await import("./lib.js");

    const selected = selectCiRunsForHeadSha([
      { databaseId: 2, headSha: "aaa", status: "completed", conclusion: "success" },
      { databaseId: 1, headSha: "aaa", status: "in_progress", conclusion: null },
      { databaseId: 0, headSha: "bbb", status: "completed", conclusion: "failure" },
    ], "aaa");

    assert.deepEqual(
      selected.map((r) => r.databaseId),
      [2, 1],
    );
  });

  it("returns an empty list for no runs", async () => {
    const { selectCiRunsForHeadSha } = await import("./lib.js");
    assert.deepEqual(selectCiRunsForHeadSha([], "aaa"), []);
    assert.deepEqual(selectCiRunsForHeadSha(null, "aaa"), []);
  });

  it("selects nothing rather than the newest run when no run carries the bound SHA", async () => {
    // The defect shape of issue #1365: the pushed commit's runs have not
    // registered, so every listed run belongs to an earlier commit. An empty
    // selection makes the caller wait; the old newest-run fallback made it
    // report the earlier commit's green.
    const { selectCiRunsForHeadSha } = await import("./lib.js");

    assert.deepEqual(selectCiRunsForHeadSha([
      { databaseId: 9, headSha: "older", status: "completed", conclusion: "success" },
      { databaseId: 8, status: "completed", conclusion: "failure" },
    ], "pushed"), []);
  });

  it("refuses to select without a head SHA to bind to", async () => {
    const { selectCiRunsForHeadSha } = await import("./lib.js");
    assert.throws(() => selectCiRunsForHeadSha([{ databaseId: 9, headSha: "aaa" }]), /head SHA is required/);
    assert.throws(() => selectCiRunsForHeadSha([{ databaseId: 9, headSha: "aaa" }], ""), /head SHA is required/);
  });
});
