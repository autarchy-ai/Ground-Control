// ADR-091 says the CI gate watches *every* run for the head commit. Two defects
// broke that promise (issue #1679):
//
//   - the watch froze its run set the moment the first run registered, so a
//     workflow that registered seconds later was never observed and its result
//     never gated anything; and
//   - `expected_head_sha` accepted a 7-39 character abbreviation although run
//     selection compares GitHub's full `headSha` exactly, so an abbreviation
//     could only ever produce a confusing "no run registered" refusal.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GITHUB_HEAD_SHA_RE, runWatchCiRun, selectCiRunsForHeadSha } from "./lib.js";

const HEAD = "1679aaaabbbbccccddddeeeeffff000011112222";

function listed(databaseId, workflowName, conclusion = "success", status = "completed") {
  return {
    databaseId,
    headSha: HEAD,
    workflowName,
    status,
    conclusion,
    url: `https://example.test/actions/runs/${databaseId}`,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function snapshotOf(run) {
  return {
    ...run,
    startedAt: run.createdAt,
    jobs: [{ name: "check", status: run.status, conclusion: run.conclusion, steps: [] }],
  };
}

// Drives the watch over a listing that grows with simulated time, through the
// production selection path.
async function watch(repoDir, listingAt, options = {}) {
  let nowMs = 0;
  return runWatchCiRun({
    repoPath: repoDir,
    branch: "1679-review-gate-ci-fixes",
    expectedHeadSha: HEAD,
    pollIntervalSeconds: 15,
    runRegistrationTimeoutSeconds: 60,
    authorizeRepoRead: async () => ({ ok: true, repoSlug: "o/r" }),
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

describe("the CI watch keeps discovering runs for the bound head (issue #1679)", () => {
  let repoDir;
  before(() => {
    repoDir = mkdtempSync(join(tmpdir(), "gc-ci-watch-1679-"));
    execFileSync("git", ["-C", repoDir, "init", "-q"]);
  });
  after(() => rmSync(repoDir, { recursive: true, force: true }));

  it("observes a workflow that registers after the first one already succeeded", async () => {
    // `fast` is green immediately; `sonar` registers 30s later and fails. A watch
    // that froze its set after `fast` would report the whole head green.
    const listingAt = (seconds) =>
      seconds < 30
        ? [listed(100, "fast")]
        : [listed(200, "sonar", "failure"), listed(100, "fast")];

    const r = await watch(repoDir, listingAt);

    assert.equal(r.conclusion, "failure", "the late-registering run must gate the head");
    assert.equal(r.run_id, 200);
    assert.deepEqual(r.runs.map((run) => run.run_id).sort(), [100, 200]);
  });

  it("reports success only once discovery has closed over every run for the head", async () => {
    const listingAt = (seconds) =>
      seconds < 30 ? [listed(100, "fast")] : [listed(200, "sonar"), listed(100, "fast")];

    const r = await watch(repoDir, listingAt);

    assert.equal(r.ok, true);
    assert.equal(r.conclusion, "success");
    assert.deepEqual(r.runs.map((run) => run.run_id).sort(), [100, 200]);
    assert.equal(r.run_id, null, "a success belongs to the whole set, not one member");
  });

  // core-F2 (cycle 1): a run that registers between the last poll and the deadline
  // is still inside the window the watch promised to cover. Closing on the clock
  // alone dropped it; the window closes on a listing taken at or after the
  // deadline instead.
  it("observes a run that registers during the final polling interval", async () => {
    // Window 30s, poll 15s, the failing run registers at 20s: after the polls at
    // 0s and 15s, and before the deadline at 30s.
    const listingAt = (seconds) =>
      seconds < 20 ? [listed(100, "fast")] : [listed(200, "sonar", "failure"), listed(100, "fast")];

    const r = await watch(repoDir, listingAt, { runRegistrationTimeoutSeconds: 30 });

    assert.equal(r.conclusion, "failure", "a run registered inside the window must gate the head");
    assert.equal(r.run_id, 200);
  });

  it("stops discovering once the registration window closes", async () => {
    // A run that appears long after the registration deadline is outside the
    // window the watch promised to cover; the gate must still terminate.
    const listingAt = (seconds) =>
      seconds < 300 ? [listed(100, "fast")] : [listed(900, "late"), listed(100, "fast")];

    const r = await watch(repoDir, listingAt);

    assert.equal(r.conclusion, "success");
    assert.deepEqual(r.runs.map((run) => run.run_id), [100]);
  });

  it("refuses an abbreviated expected head SHA instead of hunting for a run that cannot match", async () => {
    const r = await watch(repoDir, () => [listed(100, "fast")], {
      expectedHeadSha: HEAD.slice(0, 12),
    });

    assert.equal(r.ok, false);
    assert.equal(r.error, "ci_watch_head_sha_invalid");
    assert.match(r.message, /full 40-character/);
  });

  it("exports one provider-specific full-SHA predicate for the tool schema and the library", () => {
    assert.equal(GITHUB_HEAD_SHA_RE.test(HEAD), true);
    assert.equal(GITHUB_HEAD_SHA_RE.test(HEAD.slice(0, 39)), false);
    assert.equal(GITHUB_HEAD_SHA_RE.test(`${HEAD}0`), false);
    assert.equal(GITHUB_HEAD_SHA_RE.test(HEAD.toUpperCase()), false);
    // Deliberately narrower than the repository's generic Git object id, which
    // also admits 64-character SHA-256 ids.
    assert.equal(GITHUB_HEAD_SHA_RE.test("a".repeat(64)), false);
  });
});
