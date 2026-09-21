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

// Build an execFile fake that returns one page with the given PRs and empty
// pages after that.  The fake records every argv array it receives.
function makeExecFileFake(pages) {
  const calls = [];
  return {
    calls,
    execFile: async (file, argv) => {
      calls.push([file, ...argv]);
      // Detect the page number from the --field page=N argument.
      const pageIdx = argv.findIndex((a) => a.startsWith("page="));
      const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
      const pageData = pages[pageNum - 1] ?? [];
      return { stdout: JSON.stringify(pageData), stderr: "" };
    },
  };
}

// Build deps that make the plan action succeed with the given PRs.
function happyDeps({ prs = [], yaml = validYaml(), owner = "acme", repo = "myrepo" } = {}) {
  const execFileFake = makeExecFileFake([prs]);
  return {
    execFile: execFileFake.execFile,
    execFileCalls: execFileFake.calls,
    resolveWorkspaceRoot: () => "/some/repo",
    ensureGitRepo: async (p) => p,
    getOwnerRepo: async () => ({ owner, name: repo }),
    readYaml: () => yaml,
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

// ---------------------------------------------------------------------------
// 9. Argv hygiene
// ---------------------------------------------------------------------------

describe("gc_integration_manager — argv hygiene", () => {
  it("gh argv is an exact array with no shell metacharacters", async () => {
    const deps = happyDeps({ prs: [] });
    await runIntegrationManager(
      { action: "plan", repo_path: "/some/repo" },
      deps,
    );
    // Find the gh api call (there should be at least one for page 1).
    const ghCall = deps.execFileCalls.find((argv) => argv[0] === "gh");
    assert.ok(ghCall, "expected at least one gh call");
    // Expected exact argv shape:
    //   ["gh", "api", "-X", "GET", "/repos/acme/myrepo/pulls",
    //    "--field", "state=open", "--field", "per_page=100",
    //    "--field", "page=1"]
    assert.equal(ghCall[0], "gh");
    assert.equal(ghCall[1], "api");
    assert.equal(ghCall[2], "-X");
    assert.equal(ghCall[3], "GET");
    assert.match(ghCall[4], /^\/repos\/[^/]+\/[^/]+\/pulls$/);
    // --field arguments only.
    for (const arg of ghCall.slice(5)) {
      assert.match(
        arg,
        /^(--field|state=open|per_page=100|page=\d+)$/,
        `unexpected argv token: ${arg}`,
      );
    }
    // No shell metacharacters anywhere in the argv.
    const fullArgv = ghCall.join(" ");
    assert.doesNotMatch(fullArgv, /[|&;`$<>]/, "argv must not contain shell metacharacters");
  });
});

// ---------------------------------------------------------------------------
// 10. Sensitive-content scrub
// ---------------------------------------------------------------------------

describe("gc_integration_manager — sensitive-content scrub", () => {
  it("gh response with secret token in PR body → envelope strings are redacted", async () => {
    // Inject a PR whose body contains what looks like a GitHub PAT.
    // The token is in the response JSON but not a PR field we normally
    // surface — we test that the plan entry's own surfaced fields don't
    // contain it (i.e. the scrub runs before returning the envelope).
    const secretToken = "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE";
    const pr = makePr(1);
    // Poison the head_ref with the secret (edge-case: the label name or any
    // surfaced string contains the token).
    pr.head.ref = `feature/${secretToken}`;
    const execFileFake = makeExecFileFake([[pr]]);
    const deps = {
      execFile: execFileFake.execFile,
      execFileCalls: execFileFake.calls,
      resolveWorkspaceRoot: () => "/some/repo",
    ensureGitRepo: async (p) => p,
      getOwnerRepo: async () => ({ owner: "acme", name: "myrepo" }),
      readYaml: () => validYaml(),
    };
    const result = await runIntegrationManager(
      { action: "plan", repo_path: "/some/repo" },
      deps,
    );
    // The plan entry must NOT contain the raw token.
    if (result.ok && result.plan.length > 0) {
      const entry = result.plan[0];
      const serialized = JSON.stringify(entry);
      assert.doesNotMatch(serialized, /ghp_AAAA/, "plan entry must not contain raw secret token");
    }
    // If not ok, the error message must not contain the raw token either.
    if (!result.ok) {
      assert.doesNotMatch(result.message ?? "", /ghp_AAAA/);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Error envelope shape — every error path
// ---------------------------------------------------------------------------

describe("gc_integration_manager — error envelope shape", () => {
  const ERROR_REQUIRED_KEYS = new Set(["ok", "error", "message", "next_action"]);

  async function assertEnvelopeShape(args, deps) {
    const env = await runIntegrationManager(args, deps);
    assert.equal(env.ok, false);
    const keys = new Set(Object.keys(env));
    // All required keys must be present.
    for (const k of ERROR_REQUIRED_KEYS) {
      assert.ok(keys.has(k), `missing required key '${k}' in error envelope`);
    }
    return env;
  }

  it("unknown_action has only ok+error+message+next_action (+ optional allowed extras)", async () => {
    await assertEnvelopeShape({ repo_path: "/r" }, happyDeps());
  });

  it("invalid_repo_path has required shape", async () => {
    await assertEnvelopeShape({ action: "plan" }, happyDeps());
  });

  it("mode_disabled has required shape plus mode field", async () => {
    const env = await assertEnvelopeShape(
      { action: "plan", repo_path: "/r", mode: "merge" },
      happyDeps(),
    );
    // mode_disabled additionally carries a `mode` field.
    assert.ok("mode" in env, "mode_disabled envelope must include 'mode' field");
  });

  it("queue_too_large has required shape", async () => {
    const prs = Array.from({ length: 21 }, (_, i) => makePr(i + 1));
    await assertEnvelopeShape(
      { action: "plan", repo_path: "/r" },
      happyDeps({ prs }),
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Tool registration in index.js
// ---------------------------------------------------------------------------

describe("gc_integration_manager — tool registration", () => {
  it("index.js exposes gc_integration_manager with correct schema", async () => {
    // Read the tool list by inspecting the server registration via a
    // minimal import of index.js.  Because index.js boots the MCP server
    // on import we need a different approach: check that the registration
    // exports are present without actually booting the server.
    //
    // Strategy: import only gc-integrate.js and verify the shape constants
    // that index.js will use.  The integration test for the schema is a
    // static shape check: we verify that `runIntegrationManager` is exported
    // and that the GC_INTEGRATION_MANAGER_DESCRIPTION and
    // GC_INTEGRATION_MANAGER_INPUT_SCHEMA constants have the expected values.
    const mod = await import("./gc-integrate.js");
    // Must export runIntegrationManager.
    assert.equal(typeof mod.runIntegrationManager, "function");
    // Must export schema shape constants used by index.js registration.
    assert.ok(mod.GC_INTEGRATION_MANAGER_DESCRIPTION, "must export GC_INTEGRATION_MANAGER_DESCRIPTION");
    assert.ok(mod.GC_INTEGRATION_MANAGER_INPUT_SCHEMA, "must export GC_INTEGRATION_MANAGER_INPUT_SCHEMA");
    const schema = mod.GC_INTEGRATION_MANAGER_INPUT_SCHEMA;
    // additionalProperties must be false.
    assert.equal(schema.additionalProperties, false);
    // required must include action and repo_path.
    assert.ok(Array.isArray(schema.required));
    assert.ok(schema.required.includes("action"), "required must include 'action'");
    assert.ok(schema.required.includes("repo_path"), "required must include 'repo_path'");
    // action enum must be closed.
    const actionEnum = schema.properties?.action?.enum;
    assert.ok(Array.isArray(actionEnum), "action must have enum");
    assert.ok(actionEnum.includes("plan"), "action enum must include 'plan'");
    assert.ok(actionEnum.includes("prepare"), "action enum must include 'prepare'");
    assert.ok(actionEnum.includes("status"), "action enum must include 'status'");
    assert.ok(actionEnum.includes("release"), "action enum must include 'release'");
    // mode enum must be closed.
    const modeEnum = schema.properties?.mode?.enum;
    assert.ok(Array.isArray(modeEnum), "mode must have enum");
    assert.ok(modeEnum.includes("prepare"), "mode enum must include 'prepare'");
    assert.ok(modeEnum.includes("enqueue"), "mode enum must include 'enqueue'");
    assert.ok(modeEnum.includes("merge"), "mode enum must include 'merge'");
  });
});

// ===========================================================================
// PREPARE ACTION TESTS — Dispatch 2b
// ===========================================================================

// ---------------------------------------------------------------------------
// 13. Mode refusal on prepare action
// ---------------------------------------------------------------------------

describe("gc_integration_manager — mode refusal on prepare action", () => {
  it("prepare + mode=enqueue → error:mode_disabled, no lock acquired, no worktree", async () => {
    const lockFake = makeLockFake();
    const deps = prepareDeps({ lockFake, prs: [makePr(1)] });
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo", mode: "enqueue" },
      deps,
    );
    assertErrorEnvelope(result, "mode_disabled");
    assert.equal(result.mode, "enqueue");
    // Lock must NOT have been acquired.
    assert.equal(lockFake.getAcquireCount(), 0, "lock must not be acquired for mode_disabled");
    // No git worktree calls.
    const worktreeCalls = deps.execFileCalls.filter((c) => c.includes("worktree"));
    assert.equal(worktreeCalls.length, 0, "no worktree calls should occur for mode_disabled");
  });

  it("prepare + mode=merge → ok (ADR-029 carve-out 2026-05-26 enables merge; lock IS acquired)", async () => {
    const lockFake = makeLockFake();
    // Use a full prepare-capable fake so the prepare + merge path can run.
    const deps = mergeDeps({ lockFake, prs: [makePr(1)] });
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo", mode: "merge" },
      deps,
    );
    // mode=merge is now enabled; the result should be ok:true with outcome=merged.
    assert.equal(result.ok, true, `expected ok:true for mode=merge, got: ${JSON.stringify(result)}`);
    assert.equal(result.results[0].outcome, "merged");
    // Lock was acquired (prepare ran).
    assert.equal(lockFake.getAcquireCount(), 1, "lock must be acquired for mode=merge");
  });
});

// ---------------------------------------------------------------------------
// 14. Lock contention
// ---------------------------------------------------------------------------

describe("gc_integration_manager — prepare lock contention", () => {
  it("acquireIntegrationLock throws ELOCKED → error:lock_contended", async () => {
    const lockFake = makeLockFake({ locked: true });
    const deps = prepareDeps({ lockFake, prs: [makePr(1)] });
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assertErrorEnvelope(result, "lock_contended");
    // Lock release never called — lock was never acquired.
    assert.equal(lockFake.getReleaseCount(), 0, "release must not be called when lock was never acquired");
    // No worktree creation.
    const worktreeCalls = deps.execFileCalls.filter((c) => c.includes("worktree"));
    assert.equal(worktreeCalls.length, 0, "no worktree calls when lock contended");
  });
});
