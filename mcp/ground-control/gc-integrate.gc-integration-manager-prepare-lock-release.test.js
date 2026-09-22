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

// Build a worktree-capable execFile fake for prepare tests.
// `stepHandlers` is an array of functions `(file, argv) => result|throws`.
// Falls back to the default (gh API page 1) if no handler matches.
function makePrepareExecFileFake(prs, stepHandlers = []) {
  const calls = [];
  let handlerIdx = 0;

  return {
    calls,
    execFile: async (file, argv, _options) => {
      calls.push([file, ...argv]);

      // First check step handlers in order.
      if (handlerIdx < stepHandlers.length) {
        const handler = stepHandlers[handlerIdx];
        handlerIdx++;
        return handler(file, argv);
      }

      // Default: gh api calls return the prs list on page 1, empty after.
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        const pageData = pageNum === 1 ? prs : [];
        return { stdout: JSON.stringify(pageData), stderr: "" };
      }

      // Default: all git calls succeed.
      return { stdout: "", stderr: "" };
    },
  };
}

// Build the deps object for a prepare test.
// `overrides` let individual tests replace specific deps.
function prepareDeps(overrides = {}) {
  const prs = overrides.prs ?? [makePr(1)];
  const yaml = overrides.yaml ?? validYaml();
  const lockFake = overrides.lockFake ?? makeLockFake();
  const execFileFake = overrides.execFileFake ?? makePrepareExecFileFake(prs, overrides.stepHandlers ?? []);

  return {
    execFile: execFileFake.execFile,
    execFileCalls: execFileFake.calls,
    resolveWorkspaceRoot: overrides.resolveWorkspaceRoot ?? (() => "/some/repo"),
    ensureGitRepo: overrides.ensureGitRepo ?? (async (p) => p),
    getOwnerRepo: overrides.getOwnerRepo ?? (async () => ({ owner: "acme", name: "myrepo" })),
    readYaml: overrides.readYaml ?? (() => yaml),
    acquireIntegrationLock: lockFake.acquireIntegrationLock,
    lockFake,
    writeHaltLedger: overrides.writeHaltLedger ?? (() => {}),
    runCiWatcher: overrides.runCiWatcher ?? (async () => ({ conclusion: "success" })),
    runSonarWatcher: overrides.runSonarWatcher ?? (async () => ({ conclusion: "skipped" })),
    // Deterministic run ID.
    now: overrides.now ?? (() => 1748000000000),
    randomId: overrides.randomId ?? (() => "abc123"),
  };
}

// ---------------------------------------------------------------------------
// 15. Lock release on every path
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare lock release invariant", () => {
  it("empty queue → lock acquired and released", async () => {
    const lockFake = makeLockFake();
    const deps = prepareDeps({ lockFake, prs: [] });
    await runIntegrationManager({ action: "prepare", repo_path: "/some/repo" }, deps);
    assert.equal(lockFake.getAcquireCount(), 1, "lock acquired once");
    assert.equal(lockFake.getReleaseCount(), 1, "lock released once");
  });

  it("single PR succeeds → lock released after loop", async () => {
    const lockFake = makeLockFake();
    const deps = prepareDeps({ lockFake, prs: [makePr(1)] });
    await runIntegrationManager({ action: "prepare", repo_path: "/some/repo" }, deps);
    assert.equal(lockFake.getAcquireCount(), 1);
    assert.equal(lockFake.getReleaseCount(), 1, "lock released after successful run");
  });

  it("mid-loop exception → lock released", async () => {
    const lockFake = makeLockFake();
    const prs = [makePr(1), makePr(2)];
    let callCount = 0;
    // Make execFile throw on the second git fetch call (after the gh api call).
    const explodingExecFile = async (file, argv, opts) => {
      if (file === "git" && argv.includes("fetch") && callCount++ >= 1) {
        throw new Error("mid-loop explosion");
      }
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const deps = {
      execFile: explodingExecFile,
      execFileCalls: [],
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
    // The prepare action should not throw externally — it handles internally.
    await runIntegrationManager({ action: "prepare", repo_path: "/some/repo" }, deps);
    assert.equal(lockFake.getAcquireCount(), 1);
    assert.equal(lockFake.getReleaseCount(), 1, "lock released even when mid-loop exception occurs");
  });

  it("consultation_halt → lock released", async () => {
    const lockFake = makeLockFake();
    const prs = [makePr(1)];
    // Make the push fail with a lease mismatch.
    const execFileFake = {
      calls: [],
      execFile: async (file, argv, _opts) => {
        execFileFake.calls.push([file, ...argv]);
        if (file === "gh" && argv.includes("api")) {
          const pageIdx = argv.findIndex((a) => a.startsWith("page="));
          const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
          return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
        }
        if (file === "git" && argv.includes("push")) {
          const e = new Error("rejected (stale info)");
          e.stderr = "error: failed to push some refs\nhint: Updates were rejected because the remote contains work that you do\nnot have locally. Integrate the remote changes (e.g.\n'git pull ...') before pushing again.\nTo github.com:acme/myrepo.git\n ! [rejected] integ-tmp-1 -> feature/pr-1 (stale info)";
          throw e;
        }
        return { stdout: "", stderr: "" };
      },
    };
    const deps = {
      execFile: execFileFake.execFile,
      execFileCalls: execFileFake.calls,
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
    const result = await runIntegrationManager({ action: "prepare", repo_path: "/some/repo" }, deps);
    assert.equal(result.error, "consultation_halt");
    assert.equal(lockFake.getReleaseCount(), 1, "lock released on consultation_halt");
  });
});

// ---------------------------------------------------------------------------
// 16. Single PR — full happy path
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare single PR happy path", () => {
  it("worktree created, fetch ok, rebase clean, gate exits 0, CI skipped, Sonar skipped (no sonarcloud config) → outcome:ready", async () => {
    const pr1 = makePr(1);
    const prs = [pr1];
    const calls = [];

    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      if (file === "git" && argv.includes("merge-base")) {
        return { stdout: "abc123mergebase\n", stderr: "" };
      }
      // All git ops succeed.
      return { stdout: "", stderr: "" };
    };

    const lockFake = makeLockFake();
    const deps = {
      execFile: execFileFake,
      execFileCalls: calls,
      resolveWorkspaceRoot: () => "/some/repo",
    ensureGitRepo: async (p) => p,
      getOwnerRepo: async () => ({ owner: "acme", name: "myrepo" }),
      readYaml: () => validYaml(), // no sonarcloud config
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

    assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.action, "prepare");
    assert.equal(result.mode, "prepare");
    assert.ok(typeof result.run_id === "string" && result.run_id.length > 0);
    assert.equal(Array.isArray(result.results), true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].pr_number, 1);
    assert.equal(result.results[0].outcome, "ready");

    // Verify the worktree add argv shape.
    const worktreeAdd = calls.find((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"));
    assert.ok(worktreeAdd, "expected a git worktree add call");
    assert.equal(worktreeAdd[0], "git");
    assert.equal(worktreeAdd[1], "-C");
    assert.equal(worktreeAdd[2], "/some/repo");
    assert.equal(worktreeAdd[3], "worktree");
    assert.equal(worktreeAdd[4], "add");
    // Path and ref are positional after "add".
    assert.ok(worktreeAdd[5], "worktree path must be present");
    assert.ok(worktreeAdd[6], "worktree ref must be present");
    assert.match(worktreeAdd[6], /^integ-tmp-\d+$/, "ref must be integ-tmp-<number>");
  });
});

// ---------------------------------------------------------------------------
// 17. Worktree creation failure
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare worktree failure", () => {
  it("git worktree add exits non-zero → outcome:blocked, failure_class:worktree_create_failed, subsequent PRs continue", async () => {
    const pr1 = makePr(1);
    const pr2 = makePr(2);
    const prs = [pr1, pr2];
    const calls = [];

    let pr1FetchDone = false;

    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      // Fail worktree add for PR 1 (after its fetch).
      if (file === "git" && argv.includes("fetch") && argv.some((a) => a.includes("pull/1/head"))) {
        pr1FetchDone = true;
        return { stdout: "", stderr: "" };
      }
      if (file === "git" && argv.includes("worktree") && argv.includes("add") && pr1FetchDone) {
        // Only fail for PR 1's worktree add (first call).
        pr1FetchDone = false;
        const e = new Error("worktree already exists");
        e.stderr = "fatal: 'path' is already checked out";
        throw e;
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

    assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.results.length, 2);
    // PR 1: blocked (worktree_create_failed).
    assert.equal(result.results[0].pr_number, 1);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "worktree_create_failed");
    // PR 2: continues normally (ready).
    assert.equal(result.results[1].pr_number, 2);
    assert.equal(result.results[1].outcome, "ready");
  });
});

// ---------------------------------------------------------------------------
// 18. Base fetch failure → queue_wide_halt
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare base fetch failure", () => {
  it("git fetch origin <base> exits non-zero → outcome:queue_wide_halt, failure_class:base_fetch_failed, subsequent PRs not processed", async () => {
    const prs = [makePr(1), makePr(2)];
    const calls = [];

    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      // PR head fetch succeeds.
      if (file === "git" && argv.includes("fetch") && argv.some((a) => a.includes("pull/"))) {
        return { stdout: "", stderr: "" };
      }
      // Worktree add succeeds.
      if (file === "git" && argv.includes("worktree") && argv.includes("add")) {
        return { stdout: "", stderr: "" };
      }
      // Base branch fetch fails.
      if (file === "git" && argv.includes("fetch") && argv.includes("origin")) {
        const e = new Error("fetch failed");
        e.stderr = "fatal: couldn't find remote ref dev";
        throw e;
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

    assert.equal(result.ok, false);
    assert.equal(result.error, "queue_wide_halt");
    assert.equal(result.results.length, 1, "only the halted PR appears in results");
    assert.equal(result.results[0].pr_number, 1);
    assert.equal(result.results[0].outcome, "queue_wide_halt");
    assert.equal(result.results[0].failure_class, "base_fetch_failed");
    // PR 2 must NOT appear (not "skipped", simply absent).
    const pr2 = result.results.find((r) => r.pr_number === 2);
    assert.equal(pr2, undefined, "PR 2 must not appear in results on queue_wide_halt");
    // Lock still released.
    assert.equal(lockFake.getReleaseCount(), 1);
  });
});
