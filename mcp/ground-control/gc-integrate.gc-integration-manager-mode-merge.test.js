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
// Helper: assert the required error-envelope shape.
// ---------------------------------------------------------------------------

function assertErrorEnvelope(env, expectedError) {
  assert.equal(env.ok, false, `envelope.ok should be false, got ${env.ok}`);
  assert.equal(typeof env.error, "string", "envelope.error must be a string");
  assert.equal(typeof env.message, "string", "envelope.message must be a string");
  assert.equal(typeof env.next_action, "string", "envelope.next_action must be a string");
  if (expectedError !== undefined) {
    assert.equal(env.error, expectedError, `expected error=${expectedError}, got ${env.error}`);
  }
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
// 30. mode=merge — merge execution after prepare
// ---------------------------------------------------------------------------

// Build a prepare execFile fake that also records/handles gh pr merge calls.
// `mergeResult` controls what happens when gh pr merge is called:
//   { ok: true }  → succeeds (default)
//   { ok: false, stderr: "..." } → throws with that stderr
function makeMergeExecFileFake(prs, { mergeResult = { ok: true } } = {}) {
  const calls = [];

  return {
    calls,
    execFile: async (file, argv, _options) => {
      calls.push([file, ...argv]);

      // gh api discovery calls.
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }

      // gh pr merge calls.
      if (file === "gh" && argv.includes("merge")) {
        if (mergeResult.ok) {
          return { stdout: "", stderr: "" };
        }
        const err = new Error("gh pr merge failed");
        err.stderr = mergeResult.stderr ?? "remote: permission denied";
        throw err;
      }

      // git merge-base.
      if (file === "git" && argv.includes("merge-base")) {
        return { stdout: "mergebasesha\n", stderr: "" };
      }

      // All other git calls succeed.
      return { stdout: "", stderr: "" };
    },
  };
}

// Build deps for a mode=merge prepare test.
function mergeDeps(overrides = {}) {
  const prs = overrides.prs ?? [makePr(1)];
  const yaml = overrides.yaml ?? validYaml();
  const lockFake = overrides.lockFake ?? makeLockFake();
  const mergeResult = overrides.mergeResult ?? { ok: true };
  const execFileFake = overrides.execFileFake ?? makeMergeExecFileFake(prs, { mergeResult });

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
    now: overrides.now ?? (() => 1748000000000),
    randomId: overrides.randomId ?? (() => "abc123"),
  };
}

describe("gc_integration_manager — mode=merge", () => {
  it("one ready PR → executes gh pr merge with --merge --delete-branch --repo, outcome=merged", async () => {
    const prs = [makePr(1)];
    const deps = mergeDeps({ prs });

    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo", mode: "merge" },
      deps,
    );

    assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].outcome, "merged");
    assert.ok(result.results[0].merged_at, "merged_at must be set");

    // Verify the exact argv of the gh pr merge call.
    const mergeCalls = deps.execFileCalls.filter(
      (c) => c[0] === "gh" && c.includes("merge"),
    );
    assert.equal(mergeCalls.length, 1, "exactly one gh pr merge call");
    const mergeArgv = mergeCalls[0];
    assert.deepEqual(mergeArgv, ["gh", "pr", "merge", "1", "--merge", "--delete-branch", "--repo", "acme/myrepo"]);
  });


  it("one ready + one blocked PR → only the ready PR is merged; blocked PR stays blocked", async () => {
    // PR 1 will be blocked (rebase conflict), PR 2 will be ready then merged.
    const prs = [makePr(1), makePr(2)];

    const calls = [];
    let pr1FetchDone = false;
    let pr1WorktreeDone = false;
    let pr1BaseFetchDone = false;
    let pr1MergeBaseDone = false;
    let pr1RebaseDone = false;

    const execFileFake = async (file, argv, _options) => {
      calls.push([file, ...argv]);

      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      if (file === "gh" && argv.includes("merge")) {
        return { stdout: "", stderr: "" };
      }

      // For PR 1: let fetch, worktree, base fetch, merge-base succeed, then rebase fail.
      if (file === "git") {
        if (argv.includes("fetch") && argv.some((a) => a.includes("pull/1/head"))) {
          pr1FetchDone = true;
          return { stdout: "", stderr: "" };
        }
        if (argv.includes("worktree") && argv.includes("add") && !pr1WorktreeDone) {
          pr1WorktreeDone = true;
          return { stdout: "", stderr: "" };
        }
        if (argv.includes("fetch") && !pr1BaseFetchDone && pr1WorktreeDone) {
          pr1BaseFetchDone = true;
          return { stdout: "", stderr: "" };
        }
        if (argv.includes("merge-base") && !pr1MergeBaseDone) {
          pr1MergeBaseDone = true;
          return { stdout: "mergebasesha\n", stderr: "" };
        }
        if (argv.includes("rebase") && !argv.includes("--abort") && !pr1RebaseDone && pr1MergeBaseDone) {
          pr1RebaseDone = true;
          // Rebase fails for PR 1.
          const err = new Error("rebase conflict");
          err.stderr = "CONFLICT (content): Merge conflict in foo.java";
          throw err;
        }
        if (argv.includes("rebase") && argv.includes("--abort")) {
          return { stdout: "", stderr: "" };
        }
        if (argv.includes("merge-base")) {
          return { stdout: "mergebasesha\n", stderr: "" };
        }
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
      { action: "prepare", repo_path: "/some/repo", mode: "merge" },
      deps,
    );

    assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.results.length, 2);

    const pr1Result = result.results.find((r) => r.pr_number === 1);
    assert.equal(pr1Result.outcome, "blocked");
    assert.equal(pr1Result.failure_class, "rebase_conflict");

    const pr2Result = result.results.find((r) => r.pr_number === 2);
    assert.equal(pr2Result.outcome, "merged");

    // Only PR 2 was merged.
    const mergeCalls = calls.filter((c) => c[0] === "gh" && c.includes("merge"));
    assert.equal(mergeCalls.length, 1);
    assert.ok(mergeCalls[0].includes("2"), "only PR 2 is merged");
  });


  it("gh pr merge exits non-zero → outcome=blocked, failure_class=merge_failed", async () => {
    const prs = [makePr(1)];
    const deps = mergeDeps({
      prs,
      mergeResult: { ok: false, stderr: "remote: permission denied" },
    });

    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo", mode: "merge" },
      deps,
    );

    assert.equal(result.ok, true, `expected ok:true envelope, got: ${JSON.stringify(result)}`);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "merge_failed");
  });


  it("no ready PRs (all blocked) → no merge calls; envelope returns normally", async () => {
    const prs = [makePr(1)];

    // Force the single PR to fail at rebase.
    const calls = [];
    let rebaseDone = false;
    let mergeBaseDone = false;

    const execFileFake = async (file, argv, _options) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      if (file === "git" && argv.includes("merge-base") && !mergeBaseDone) {
        mergeBaseDone = true;
        return { stdout: "mergebasesha\n", stderr: "" };
      }
      if (file === "git" && argv.includes("rebase") && !argv.includes("--abort") && !rebaseDone) {
        rebaseDone = true;
        const err = new Error("rebase conflict");
        err.stderr = "CONFLICT (content): Merge conflict in bar.java";
        throw err;
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
      { action: "prepare", repo_path: "/some/repo", mode: "merge" },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, "blocked");

    const mergeCalls = calls.filter((c) => c[0] === "gh" && c.includes("merge"));
    assert.equal(mergeCalls.length, 0, "no gh pr merge calls when all PRs are blocked");
  });


  it("merge_strategy=squash → argv contains --squash", async () => {
    const prs = [makePr(1)];
    const yaml = validYaml(`workflow:\n  integration_manager:\n    merge_strategy: squash\n`);
    const deps = mergeDeps({ prs, yaml });

    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo", mode: "merge" },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, "merged");

    const mergeCalls = deps.execFileCalls.filter(
      (c) => c[0] === "gh" && c.includes("merge"),
    );
    assert.equal(mergeCalls.length, 1);
    assert.ok(mergeCalls[0].includes("--squash"), `expected --squash in argv, got: ${JSON.stringify(mergeCalls[0])}`);
  });


  it("merge_strategy=rebase → argv contains --rebase", async () => {
    const prs = [makePr(1)];
    const yaml = validYaml(`workflow:\n  integration_manager:\n    merge_strategy: rebase\n`);
    const deps = mergeDeps({ prs, yaml });

    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo", mode: "merge" },
      deps,
    );

    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, "merged");

    const mergeCalls = deps.execFileCalls.filter(
      (c) => c[0] === "gh" && c.includes("merge"),
    );
    assert.equal(mergeCalls.length, 1);
    assert.ok(mergeCalls[0].includes("--rebase"), `expected --rebase in argv, got: ${JSON.stringify(mergeCalls[0])}`);
  });


  it("mode=enqueue still returns error:mode_disabled", async () => {
    const deps = prepareDeps();
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo", mode: "enqueue" },
      deps,
    );
    assertErrorEnvelope(result, "mode_disabled");
    assert.equal(result.mode, "enqueue");
  });
});
