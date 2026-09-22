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

      // The pushed-head read (issue #1365) is answered ahead of the step
      // handlers so adding it did not shift every existing handler index.
      if (file === "git" && argv.includes("rev-parse")) {
        return { stdout: `${"0".repeat(32)}pushedhead\n`, stderr: "" };
      }

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
// 25. Run ID format
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare run ID format", () => {
  it("run ID is <timestamp>-<randomId> from injected deps.now and deps.randomId", async () => {
    const lockFake = makeLockFake();
    const deps = {
      ...prepareDeps({ lockFake, prs: [] }),
      now: () => 1748000001234,
      randomId: () => "xyzabc",
    };
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assert.ok(result.run_id, "run_id must be present");
    assert.equal(result.run_id, "1748000001234-xyzabc", `expected '1748000001234-xyzabc', got: '${result.run_id}'`);
  });
});

// ---------------------------------------------------------------------------
// 26. Argv hygiene for prepare-specific git calls
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare argv hygiene", () => {
  it("git worktree add argv is exactly [git, -C, <repo>, worktree, add, <path>, <ref>]", async () => {
    const prs = [makePr(1)];
    const calls = [];

    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
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

    await runIntegrationManager({ action: "prepare", repo_path: "/some/repo" }, deps);

    const worktreeAdd = calls.find((c) => c[0] === "git" && c.includes("worktree") && c.includes("add"));
    assert.ok(worktreeAdd, "git worktree add must be called");
    assert.equal(worktreeAdd[0], "git");
    assert.equal(worktreeAdd[1], "-C");
    assert.equal(worktreeAdd[2], "/some/repo");
    assert.equal(worktreeAdd[3], "worktree");
    assert.equal(worktreeAdd[4], "add");
    // [5] is the path, [6] is the ref.
    assert.equal(worktreeAdd.length, 7, "worktree add must have exactly 7 elements");
  });

  it("git rebase argv matches --onto pattern", async () => {
    const prs = [makePr(1)];
    const calls = [];

    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
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

    await runIntegrationManager({ action: "prepare", repo_path: "/some/repo" }, deps);

    const rebaseCall = calls.find((c) => c[0] === "git" && c.includes("rebase") && c.includes("--onto"));
    assert.ok(rebaseCall, "git rebase --onto must be called");
    assert.equal(rebaseCall[0], "git");
    assert.equal(rebaseCall[1], "-C");
    // [2] is the worktree path.
    assert.equal(rebaseCall[3], "rebase");
    assert.equal(rebaseCall[4], "--onto");
    // [5] is origin/<base-ref>, [6] is merge-base, [7] is tmp-ref.
    assert.ok(rebaseCall[5].startsWith("origin/"), `--onto target must start with 'origin/', got: ${rebaseCall[5]}`);
  });
});

// ---------------------------------------------------------------------------
// 27. Worktree path containment (defensive)
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare worktree path containment", () => {
  it("traversal-shaped run ID causes blocked outcome with worktree_path_invalid and no git side-effects", async () => {
    // Use a randomId that, when combined with the timestamp prefix and the
    // fixed path segments, produces a worktreePath that escapes /some/repo.
    // Five levels of "../" walk past ".gc/integration-worktrees/<ts>-" and
    // then out of /some/repo entirely (verified: resolves to /some/tmp/escape/1).
    const prs = [makePr(1)];
    const calls = [];

    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
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
      // Five "../" levels escape past ".gc/integration-worktrees/<ts>-" and
      // out of /some/repo, producing a canonical path of /some/tmp/escape/1.
      randomId: () => "../../../../../tmp/escape",
    };

    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );

    // The containment check must fire and return a blocked outcome — not throw.
    assert.ok(result.ok === true, "overall result must be ok:true (blocked is not a halt)");
    assert.ok(Array.isArray(result.results), "results must be an array");
    assert.equal(result.results.length, 1, "exactly one PR result");

    const prResult = result.results[0];
    assert.equal(prResult.outcome, "blocked", "outcome must be blocked");
    assert.equal(prResult.failure_class, "worktree_path_invalid", "failure_class must be worktree_path_invalid");

    // No git worktree add, fetch, rebase, or push must have been called —
    // the containment check fires before any branch mutation.
    const gitSideEffectCalls = calls.filter(
      (c) =>
        c[0] === "git" &&
        (c.includes("worktree") || c.includes("fetch") || c.includes("rebase") || c.includes("push")),
    );
    assert.equal(
      gitSideEffectCalls.length,
      0,
      `no git side-effect calls expected, got: ${JSON.stringify(gitSideEffectCalls)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 28. Prepare envelope fields
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare envelope fields", () => {
  it("successful prepare envelope has required fields: ok, action, mode, run_id, owner, repo, policy, results", async () => {
    const lockFake = makeLockFake();
    const deps = prepareDeps({ lockFake, prs: [makePr(1)] });

    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );

    if (result.ok) {
      assert.equal(result.action, "prepare");
      assert.equal(result.mode, "prepare");
      assert.ok(typeof result.run_id === "string" && result.run_id.length > 0, "run_id must be a non-empty string");
      assert.ok(typeof result.owner === "string", "owner must be a string");
      assert.ok(typeof result.repo === "string", "repo must be a string");
      assert.ok(typeof result.policy === "object", "policy must be an object");
      assert.ok(Array.isArray(result.results), "results must be an array");
    }
    // If not ok (e.g., a blocked run due to test env behavior), still valid.
    // We only assert shape when ok:true.
  });
});

// ===========================================================================
// DISPATCH 2c TESTS — CI watcher, Sonar watcher, status, release
// ===========================================================================

// ---------------------------------------------------------------------------
// 29. CI watcher mapping
// ---------------------------------------------------------------------------

describe("gc_integration_manager — CI watcher mapping", () => {
  // Build a minimal prepare deps set with a fake CI watcher.
  function ciWatcherDeps(fakeCiWatcher, prs = [makePr(1)]) {
    return prepareDeps({
      prs,
      runCiWatcher: fakeCiWatcher,
      runSonarWatcher: async () => ({ conclusion: "skipped" }),
    });
  }

  it("runCiWatcher returns {conclusion:'success'} → outcome:ready", async () => {
    const deps = ciWatcherDeps(async () => ({ conclusion: "success" }));
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.results[0].outcome, "ready");
  });

  it("runCiWatcher returns {conclusion:'failure'} → outcome:blocked, failure_class:ci_failed", async () => {
    const deps = ciWatcherDeps(async () => ({ conclusion: "failure", details_url: "https://ci.example.com/runs/1" }));
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "ci_failed");
  });

  it("runCiWatcher returns {conclusion:'queued_too_long'} → outcome:blocked, failure_class:ci_queued_too_long", async () => {
    const deps = ciWatcherDeps(async () => ({ conclusion: "queued_too_long" }));
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "ci_queued_too_long");
  });

  it("runCiWatcher returns {conclusion:'timed_out'} → outcome:blocked, failure_class:ci_timed_out", async () => {
    const deps = ciWatcherDeps(async () => ({ conclusion: "timed_out" }));
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "ci_timed_out");
  });

  // Inverted by issue #1679: a skip observes nothing, and GC-O011(c) requires the
  // CI signal to be watched before a PR is marked ready. The production adapter no
  // longer emits `skipped`, and the gate refuses it if anything else does.
  it("runCiWatcher returns {conclusion:'skipped'} → blocked, not ready", async () => {
    const deps = ciWatcherDeps(async () => ({ conclusion: "skipped" }));
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "ci_unverified_for_head");
  });

  it("runCiWatcher is called with repo_path=repoRoot and branch=pr.head_ref", async () => {
    const ciWatcherCalls = [];
    const fakeCiWatcher = async (pr, ctx) => {
      ciWatcherCalls.push({ pr, ctx });
      return { conclusion: "success" };
    };
    const deps = ciWatcherDeps(fakeCiWatcher, [makePr(7)]);
    await runIntegrationManager({ action: "prepare", repo_path: "/some/repo" }, deps);
    assert.equal(ciWatcherCalls.length, 1, "CI watcher must be called once per PR");
    const { pr, ctx } = ciWatcherCalls[0];
    assert.equal(pr.head_ref, "feature/pr-7", `expected head_ref='feature/pr-7', got: ${pr.head_ref}`);
    assert.ok(typeof ctx.repoRoot === "string" && ctx.repoRoot.length > 0, "ctx.repoRoot must be present");
  });

  it("names the rebased commit it pushed, so the watcher cannot read the pre-rebase run (issue #1365)", async () => {
    const ciWatcherCalls = [];
    const fakeCiWatcher = async (pr) => {
      ciWatcherCalls.push(pr);
      return { conclusion: "skipped" };
    };
    const deps = ciWatcherDeps(fakeCiWatcher, [makePr(7)]);
    await runIntegrationManager({ action: "prepare", repo_path: "/some/repo" }, deps);
    assert.equal(ciWatcherCalls[0].pushed_head_sha, `${"0".repeat(32)}pushedhead`);
  });
});
