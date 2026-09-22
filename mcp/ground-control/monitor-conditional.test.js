// Cheap waiting and fast stall detection for the remote-gate monitor (issue #1671).
//
// Two failures motivated this. Watching a quiet head cost roughly five unconditional REST
// calls every fifteen seconds against a token shared by every agent on the host, so a long
// watch could exhaust the hour's quota and fail unrelated work. And a pull request that
// conflicts with its base produces no checks at all, because GitHub never builds the merge
// ref, so the watch polled out its full forty-five-minute cap and then reported a timeout
// that named nothing the agent could act on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextMonitorInterval } from "./implement/monitor.js";
import { readRemoteGateSnapshot } from "./lib/remote-gates.js";
import { runImplementMechanical } from "./gc-implement-mechanical.js";

const HEAD = "a".repeat(40);

function snapshotDeps({ conditional, overrides = {} } = {}) {
  const calls = { full: 0, conditional: 0 };
  return {
    calls,
    deps: {
      authorize: async () => ({ ok: true, repoRoot: "/repo", owner: "o", name: "r" }),
      readPr: async () => {
        calls.full += 1;
        return { headRefOid: HEAD, baseRefName: "dev", headRefName: "1671-x", state: "OPEN", mergeStateStatus: "CLEAN" };
      },
      readChecks: async () => [{ __typename: "CheckRun", name: "policy", status: "COMPLETED", conclusion: "SUCCESS", appId: 1 }],
      readJson: async () => ({ contexts: ["policy"] }),
      conditionalGet: async (_repoRoot, path) => {
        calls.conditional += 1;
        return conditional ? conditional(path) : { changed: true, body: null, paginated: false };
      },
      snapshotCache: new Map(),
      ...overrides,
    },
  };
}

describe("remote gate snapshot reuses an unchanged answer", () => {
  it("spends full reads once, then answers from conditional revalidation", async () => {
    const unchanged = () => ({ changed: false, body: null, paginated: false });
    const { calls, deps } = snapshotDeps({ conditional: unchanged });

    const first = await readRemoteGateSnapshot({ repoPath: "/repo", prNumber: 1 }, deps);
    assert.equal(first.ok, true);
    assert.equal(first.unchanged, false);
    const fullAfterFirst = calls.full;
    assert.ok(fullAfterFirst > 0, "the first read has nothing to revalidate against");

    for (let i = 0; i < 5; i += 1) {
      const tick = await readRemoteGateSnapshot({ repoPath: "/repo", prNumber: 1 }, deps);
      assert.equal(tick.ok, true);
      assert.equal(tick.unchanged, true);
      assert.equal(tick.head_sha, HEAD, "an unchanged tick still answers with the real snapshot");
    }
    assert.equal(calls.full, fullAfterFirst, "five quiet ticks cost no unconditional reads");
  });

  it("re-reads in full as soon as any watched endpoint changed", async () => {
    let changedOnce = false;
    const { calls, deps } = snapshotDeps({
      conditional: (path) => {
        if (!changedOnce && path.includes("/check-runs")) {
          changedOnce = true;
          return { changed: true, body: null, paginated: false };
        }
        return { changed: false, body: null, paginated: false };
      },
    });
    await readRemoteGateSnapshot({ repoPath: "/repo", prNumber: 1 }, deps);
    const fullAfterFirst = calls.full;
    const second = await readRemoteGateSnapshot({ repoPath: "/repo", prNumber: 1 }, deps);
    assert.equal(second.unchanged, false);
    assert.ok(calls.full > fullAfterFirst, "a changed endpoint forces the authoritative read");
  });

  it("never calls one unchanged first page the whole answer", async () => {
    const { calls, deps } = snapshotDeps({
      conditional: () => ({ changed: false, body: null, paginated: true }),
    });
    await readRemoteGateSnapshot({ repoPath: "/repo", prNumber: 1 }, deps);
    const fullAfterFirst = calls.full;
    const second = await readRemoteGateSnapshot({ repoPath: "/repo", prNumber: 1 }, deps);
    assert.equal(second.unchanged, false);
    assert.ok(calls.full > fullAfterFirst, "a paginated response falls through to the full read");
  });

  it("treats a probe that cannot answer as no evidence of stability", async () => {
    const { calls, deps } = snapshotDeps({
      conditional: () => { throw new Error("network"); },
    });
    await readRemoteGateSnapshot({ repoPath: "/repo", prNumber: 1 }, deps);
    const fullAfterFirst = calls.full;
    await readRemoteGateSnapshot({ repoPath: "/repo", prNumber: 1 }, deps);
    assert.ok(calls.full > fullAfterFirst);
  });
});

describe("monitor cadence", () => {
  it("backs off while nothing changes, and stops at a bound", () => {
    let interval = 15000;
    const seen = [];
    for (let i = 0; i < 12; i += 1) {
      interval = nextMonitorInterval(interval, true);
      seen.push(interval);
    }
    assert.ok(seen[0] > 15000, "a quiet tick slows the next one");
    assert.equal(Math.max(...seen), 120000, "backoff is bounded");
  });

  it("returns to the base cadence the moment something changes", () => {
    assert.equal(nextMonitorInterval(120000, false), 15000);
  });
});

describe("monitor refuses a pull request whose checks cannot run", () => {
  const conflicted = { ok: true, head_sha: HEAD, branch: "1671-x", base_ref: "dev", state: "OPEN",
    merge_state: "DIRTY", checks: [], required: [], failures: [], pending: [], missing: [], passed: false };

  it("fails before starting a watcher, naming the conflict and the repair", async () => {
    let started = 0;
    const result = await runImplementMechanical({
      action: "monitor", repoPath: "/repo", issueNumber: 1671, prNumber: 1680,
    }, {
      remoteSnapshot: async () => conflicted,
      startMonitorJob: () => { started += 1; return { ok: true, job_id: "j" }; },
      watchCi: async () => ({ ok: true }),
      watchSonar: async () => ({ ok: true }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "monitor_pr_conflicted");
    assert.equal(result.next_action, "resolve_the_base_conflict_then_rerun_publish_and_monitor");
    assert.match(result.message, /conflicts with its base/);
    assert.equal(started, 0, "there is nothing to watch on a pull request that cannot build a merge ref");
  });

  it("also catches a conflict that appears after the base moves mid-watch", async () => {
    let reads = 0;
    const clean = { ...conflicted, merge_state: "CLEAN" };
    const result = await runImplementMechanical({
      action: "monitor", repoPath: "/repo", issueNumber: 1671, prNumber: 1680,
    }, {
      remoteSnapshot: async () => { reads += 1; return reads === 1 ? clean : conflicted; },
      startMonitorJob: () => ({ ok: true, job_id: "j" }),
      pollMonitorJob: () => ({ ok: true, status: "running" }),
      monitorSleep: async () => {},
      watchCi: async () => ({ ok: true }),
      watchSonar: async () => ({ ok: true }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "monitor_pr_conflicted");
    assert.equal(result.merge_state, "DIRTY");
  });
});
