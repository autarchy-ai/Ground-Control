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
// 19. Rebase conflict
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare rebase conflict", () => {
  it("git rebase exits non-zero → git rebase --abort invoked, outcome:blocked, failure_class:rebase_conflict, worktree cleanup invoked", async () => {
    const prs = [makePr(1)];
    const calls = [];

    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      if (file === "git" && argv.includes("rebase") && !argv.includes("--abort")) {
        const e = new Error("rebase conflict");
        e.stderr = "CONFLICT (content): Merge conflict in src/Foo.java\nCONFLICT (content): Merge conflict in src/Bar.java";
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

    assert.equal(result.ok, true, `expected ok:true (blocked is not an error), got: ${JSON.stringify(result)}`);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "rebase_conflict");

    // git rebase --abort must have been called.
    const abortCall = calls.find((c) =>
      c[0] === "git" && c.includes("rebase") && c.includes("--abort"),
    );
    assert.ok(abortCall, "git rebase --abort must be invoked on conflict");

    // Worktree cleanup (remove) must have been attempted.
    const removeCall = calls.find((c) =>
      c[0] === "git" && c.includes("worktree") && c.includes("remove"),
    );
    assert.ok(removeCall, "git worktree remove must be invoked for cleanup");
  });
});

// ---------------------------------------------------------------------------
// 21. CI failure via injected hook
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare CI failure", () => {
  it("runCiWatcher returns conclusion:failure → outcome:blocked, failure_class:ci_failed", async () => {
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
      runCiWatcher: async () => ({ conclusion: "failure", details_url: "https://ci.example.com/runs/42" }),
      runSonarWatcher: async () => ({ conclusion: "skipped" }),
      now: () => 1748000000000,
      randomId: () => "abc123",
    };

    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );

    assert.equal(result.ok, true, `expected ok:true (blocked), got: ${JSON.stringify(result)}`);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "ci_failed");
  });
});

// ---------------------------------------------------------------------------
// 22. Sonar configured but skipped
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare sonar configured but skipped", () => {
  it("sonarcloud in config + runSonarWatcher returns skipped → outcome:blocked, failure_class:sonar_skipped_but_configured", async () => {
    const prs = [makePr(1)];
    const calls = [];
    // yaml with sonarcloud config.
    const yaml = validYaml("sonarcloud:\n  organization: myorg\n  project_key: myrepo\n");

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
      readYaml: () => yaml,
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

    assert.equal(result.ok, true, `expected ok:true (blocked), got: ${JSON.stringify(result)}`);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "sonar_skipped_but_configured");
  });
});

// ---------------------------------------------------------------------------
// 23. Force-with-lease mismatch → consultation_halt + halt ledger
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare force-with-lease mismatch", () => {
  it("push --force-with-lease rejected with stale info → outcome:consultation_halt, halt_reason:pr_head_moved, halt ledger written", async () => {
    const prs = [makePr(1)];
    const calls = [];
    const ledgerWriteCalls = [];

    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      if (file === "git" && argv.includes("push")) {
        const e = new Error("rejected (stale info)");
        e.stderr = "error: failed to push some refs\n ! [rejected] integ-tmp-1 -> feature/pr-1 (stale info)";
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
      writeHaltLedger: (runDir, ledger) => {
        ledgerWriteCalls.push({ runDir, ledger });
      },
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
    assert.equal(result.error, "consultation_halt");
    assert.equal(result.halt_reason, "pr_head_moved");
    assert.equal(result.next_action, "consult_maintainer");
    assert.ok(Array.isArray(result.candidate_resolutions) && result.candidate_resolutions.length > 0);
    assert.equal(result.results[0].pr_number, 1);
    assert.equal(result.results[0].outcome, "consultation_halt");

    // Halt ledger must have been written.
    assert.equal(ledgerWriteCalls.length, 1, "halt ledger must be written once");
    const { runDir, ledger } = ledgerWriteCalls[0];
    assert.ok(runDir.includes(".gc/integration-runs"), "runDir must be under .gc/integration-runs");
    assert.ok(typeof ledger.run_id === "string");
    assert.equal(ledger.halt_reason, "pr_head_moved");
    assert.equal(ledger.pr_number_at_halt, 1);
    assert.ok(Array.isArray(ledger.queue_state));
    assert.ok(typeof ledger.timestamp === "string");

    // Lock released on halt.
    assert.equal(lockFake.getReleaseCount(), 1);
  });

  it("push --force-with-lease argv contains exact expected OID", async () => {
    const pr1 = makePr(1); // head.sha is "sha1"
    const prs = [pr1];
    const calls = [];

    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      if (file === "git" && argv.includes("push")) {
        // Succeed — check the lease OID from the test assertions below.
        return { stdout: "", stderr: "" };
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

    const pushCall = calls.find((c) => c[0] === "git" && c.includes("push"));
    assert.ok(pushCall, "expected a git push call");
    // The lease must contain the discovery-time OID (sha1 from makePr(1)).
    const leaseArg = pushCall.find((a) => a.startsWith("--force-with-lease="));
    assert.ok(leaseArg, "--force-with-lease argument must be present");
    assert.ok(leaseArg.includes("sha1"), `lease arg must contain the PR head OID 'sha1', got: ${leaseArg}`);
  });
});

// ---------------------------------------------------------------------------
// 24. Multiple PRs — mixed outcomes
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare multiple PRs mixed outcomes", () => {
  it("PR-1 ready, PR-2 blocked (rebase conflict), PR-3 ready → all three in results[], queue not halted", async () => {
    const prs = [makePr(1), makePr(2), makePr(3)];
    const calls = [];
    let rebaseCallCount = 0;

    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      if (file === "git" && argv.includes("rebase") && !argv.includes("--abort")) {
        rebaseCallCount++;
        if (rebaseCallCount === 2) {
          // PR 2's rebase fails.
          const e = new Error("rebase conflict");
          e.stderr = "CONFLICT (content): Merge conflict in src/Main.java";
          throw e;
        }
        return { stdout: "", stderr: "" };
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

    assert.equal(result.ok, true, `expected ok:true (blocked is not queue-stopping), got: ${JSON.stringify(result)}`);
    assert.equal(result.results.length, 3, "all three PRs must appear in results");

    const [r1, r2, r3] = result.results;
    assert.equal(r1.pr_number, 1);
    assert.equal(r1.outcome, "ready");
    assert.equal(r2.pr_number, 2);
    assert.equal(r2.outcome, "blocked");
    assert.equal(r2.failure_class, "rebase_conflict");
    assert.equal(r3.pr_number, 3);
    assert.equal(r3.outcome, "ready");
  });
});
