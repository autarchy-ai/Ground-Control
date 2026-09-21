// Split from gc-integrate.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Helpers — minimal dep factories
// ---------------------------------------------------------------------------

// A ground-control.yaml that passes the parser (schema_version + project are
// the minimum required keys).
function validYaml(integrationManagerBlock = "") {
  return `schema_version: 1
project: test-project
${integrationManagerBlock}`;
}

// Build a fake PR entry as the GitHub API would return.
function makePr(n, labels = ["approved-for-integration"]) {
  return {
    number: n,
    head: { ref: `feature/pr-${n}`, sha: `sha${n}` },
    base: { ref: "dev" },
    created_at: `2026-05-0${n}T00:00:00Z`,
    updated_at: `2026-05-0${n}T01:00:00Z`,
    labels: labels.map((name) => ({ name })),
  };
}

// ---------------------------------------------------------------------------
// Import the module under test.  If gc-integrate.js does not exist yet the
// dynamic import below will throw, which surfaces as a failing test — that is
// the TDD "red" state we want.
// ---------------------------------------------------------------------------

let runIntegrationManager;

try {
  ({ runIntegrationManager } = await import("./gc-integrate.js"));
} catch (e) {
  // Not yet implemented; define a stub that always throws so every test fails
  // with a meaningful message.
  runIntegrationManager = async () => {
    throw new Error("gc-integrate.js not yet implemented");
  };
}

// ---------------------------------------------------------------------------
// Prepare-action test helpers
// ---------------------------------------------------------------------------

// Build a lock that tracks acquire/release counts, and can be forced to ELOCKED.
function makeLockFake({ locked = false } = {}) {
  let acquireCount = 0;
  let releaseCount = 0;

  return {
    getAcquireCount: () => acquireCount,
    getReleaseCount: () => releaseCount,
    acquireIntegrationLock: async (_repoRoot) => {
      if (locked) {
        const e = new Error("integration run is already in progress");
        e.code = "ELOCKED";
        throw e;
      }
      acquireCount++;
      return async () => {
        releaseCount++;
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 34. Fork PR refusal in prepare — no git/gh side-effects
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare fork PR blocked without side-effects", () => {
  it("fork PR → outcome:blocked, failure_class:fork_pr_unsupported, zero git/gh calls for that PR", async () => {
    const forkPr = makePr(5);
    forkPr.head.repo = { full_name: "contributor/myrepo" };
    forkPr.base.repo = { full_name: "acme/myrepo" };

    const calls = [];
    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? [forkPr] : []), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const lockFake = makeLockFake();
    const deps = {
      execFile: execFileFake,
      execFileCalls: calls,
      resolveWorkspaceRoot: () => "/some/repo",
    ensureGitRepo: async (p) => p,
      getOwnerRepo: async () => ({ owner: "acme", name: "myrepo" }),
      readYaml: () => validYaml(),
      acquireIntegrationLock: lockFake.acquireIntegrationLock,
      lockFake,
      writeHaltLedger: () => {},
      runCiWatcher: async () => { throw new Error("should not be called for fork PR"); },
      runSonarWatcher: async () => { throw new Error("should not be called for fork PR"); },
      now: () => 1748000000000,
      randomId: () => "abc123",
    };

    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );

    assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.results.length, 1);
    const outcome = result.results[0];
    assert.equal(outcome.pr_number, 5);
    assert.equal(outcome.outcome, "blocked");
    assert.equal(outcome.failure_class, "fork_pr_unsupported");
    assert.equal(outcome.next_action, "merge_manually_or_open_followup");

    // No git fetch, worktree, rebase, push calls for the fork PR.
    const gitCalls = calls.filter((c) => c[0] === "git");
    const gitSideEffects = gitCalls.filter((c) =>
      c.includes("fetch") || c.includes("worktree") || c.includes("rebase") || c.includes("push"),
    );
    assert.equal(
      gitSideEffects.length,
      0,
      `expected zero git side-effect calls for fork PR, got: ${JSON.stringify(gitSideEffects)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 35. Mixed queue: fork PR blocked, same-repo PR proceeds
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare mixed queue fork and same-repo", () => {
  it("1 fork PR + 1 same-repo PR → fork blocked, same-repo ready, queue not halted", async () => {
    const forkPr = makePr(1);
    forkPr.head.repo = { full_name: "contributor/myrepo" };
    forkPr.base.repo = { full_name: "acme/myrepo" };

    const samePr = makePr(2);
    samePr.head.repo = { full_name: "acme/myrepo" };
    samePr.base.repo = { full_name: "acme/myrepo" };

    const calls = [];
    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? [forkPr, samePr] : []), stderr: "" };
      }
      if (file === "git" && argv.includes("merge-base")) {
        return { stdout: "mergebasesha\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const lockFake = makeLockFake();
    const deps = {
      execFile: execFileFake,
      execFileCalls: calls,
      resolveWorkspaceRoot: () => "/some/repo",
    ensureGitRepo: async (p) => p,
      getOwnerRepo: async () => ({ owner: "acme", name: "myrepo" }),
      readYaml: () => validYaml(),
      acquireIntegrationLock: lockFake.acquireIntegrationLock,
      lockFake,
      writeHaltLedger: () => {},
      runCiWatcher: async () => ({ conclusion: "success" }),
      runSonarWatcher: async () => ({ conclusion: "skipped" }),
      now: () => 1748000000000,
      randomId: () => "abc123",
    };

    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );

    assert.equal(result.ok, true, `expected ok:true (no halt), got: ${JSON.stringify(result)}`);
    assert.equal(result.results.length, 2, "both PRs must appear in results");

    const forkResult = result.results.find((r) => r.pr_number === 1);
    assert.ok(forkResult, "fork PR must be in results");
    assert.equal(forkResult.outcome, "blocked");
    assert.equal(forkResult.failure_class, "fork_pr_unsupported");

    const sameResult = result.results.find((r) => r.pr_number === 2);
    assert.ok(sameResult, "same-repo PR must be in results");
    assert.equal(sameResult.outcome, "ready");
  });
});

// ---------------------------------------------------------------------------
// 29. CI and Sonar watchers must run AFTER force-with-lease push
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare watcher ordering: push before watchers", () => {
  it("runCiWatcher and runSonarWatcher are called only after git push --force-with-lease", async () => {
    const prs = [makePr(1)];
    const callOrder = [];

    const execFileFake = async (file, argv, _opts) => {
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      if (file === "git" && argv.includes("push")) {
        callOrder.push("push");
      }
      if (file === "git" && argv.includes("merge-base")) {
        return { stdout: "mergebasesha\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const lockFake = makeLockFake();
    const deps = {
      execFile: execFileFake,
      resolveWorkspaceRoot: () => "/some/repo",
    ensureGitRepo: async (p) => p,
      getOwnerRepo: async () => ({ owner: "acme", name: "myrepo" }),
      readYaml: () => validYaml(),
      acquireIntegrationLock: lockFake.acquireIntegrationLock,
      lockFake,
      writeHaltLedger: () => {},
      runCiWatcher: async () => {
        callOrder.push("ci_watcher");
        return { conclusion: "success" };
      },
      runSonarWatcher: async () => {
        callOrder.push("sonar_watcher");
        return { conclusion: "skipped" };
      },
      now: () => 1748000000000,
      randomId: () => "abc123",
    };

    await runIntegrationManager({ action: "prepare", repo_path: "/some/repo" }, deps);

    assert.ok(callOrder.includes("push"), "git push must be called");
    assert.ok(callOrder.includes("ci_watcher"), "runCiWatcher must be called");
    assert.ok(callOrder.includes("sonar_watcher"), "runSonarWatcher must be called");

    const pushIdx = callOrder.indexOf("push");
    const ciIdx = callOrder.indexOf("ci_watcher");
    const sonarIdx = callOrder.indexOf("sonar_watcher");

    assert.ok(
      pushIdx < ciIdx,
      `git push (index ${pushIdx}) must occur before runCiWatcher (index ${ciIdx}); order was: ${JSON.stringify(callOrder)}`,
    );
    assert.ok(
      pushIdx < sonarIdx,
      `git push (index ${pushIdx}) must occur before runSonarWatcher (index ${sonarIdx}); order was: ${JSON.stringify(callOrder)}`,
    );
  });
});
