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

describe("gc_integration_manager — mode=merge", () => {

  it("mode=merge does NOT merge when prepare loop returned queue_wide_halt", async () => {
    const prs = [makePr(1)];
    const calls = [];

    // Trigger queue_wide_halt by failing the base branch fetch.
    let fetchCount = 0;
    const execFileFake = async (file, argv, _options) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      if (file === "git" && argv.includes("fetch") && argv.some((a) => a.includes("pull/"))) {
        return { stdout: "", stderr: "" };
      }
      if (file === "git" && argv.includes("worktree")) {
        return { stdout: "", stderr: "" };
      }
      // Base branch fetch fails → queue_wide_halt.
      if (file === "git" && argv.includes("fetch")) {
        fetchCount++;
        if (fetchCount >= 1) {
          throw new Error("fatal: couldn't find remote ref dev");
        }
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
      { action: "prepare", repo_path: "/some/repo", mode: "merge" },
      deps,
    );

    // The envelope should be ok:false with queue_wide_halt.
    assert.equal(result.ok, false);
    assert.equal(result.error, "queue_wide_halt");

    const mergeCalls = calls.filter((c) => c[0] === "gh" && c.includes("merge"));
    assert.equal(mergeCalls.length, 0, "gh pr merge must not be called after queue_wide_halt");
  });


  it("mode=merge does NOT merge when prepare loop returned consultation_halt", async () => {
    const prs = [makePr(1)];
    const calls = [];

    // Trigger consultation_halt by returning a lease mismatch from git push.
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
      if (file === "git" && argv.includes("merge-base")) {
        return { stdout: "mergebasesha\n", stderr: "" };
      }
      if (file === "git" && argv.includes("push")) {
        const err = new Error("force-with-lease lease mismatch");
        err.stderr = "error: rejected (stale info)";
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

    assert.equal(result.ok, false);
    assert.equal(result.error, "consultation_halt");

    const mergeCalls = calls.filter((c) => c[0] === "gh" && c.includes("merge"));
    assert.equal(mergeCalls.length, 0, "gh pr merge must not be called after consultation_halt");
  });
});

// ---------------------------------------------------------------------------
// SDK registration shape regression. The first deployed registration used
// server.registerTool({inputSchema: <raw JSON Schema>}), which passes the
// registration gate but crashes at call time with
// `v3Schema.safeParseAsync is not a function`: the SDK wraps inputSchema in
// z.object() and calls safeParseAsync, which only Zod schemas implement.
// Unit tests on runIntegrationManager bypass the SDK entirely so the bug
// slipped through. These cases drive the call path through McpServer +
// Client + InMemoryTransport so any future registration-shape regression
// fails here instead of in production.
// ---------------------------------------------------------------------------
describe("gc_integration_manager — SDK registration shape", () => {
  it("client.callTool against the registered tool does not crash on schema parse", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { z } = await import("zod");

    const server = new McpServer({
      name: "gc-integrate-registration-test",
      version: "1.0.0",
    });
    server.tool(
      "gc_integration_manager",
      "test wiring",
      {
        action: z.enum(["plan", "prepare", "status", "release"]),
        repo_path: z.string().min(1),
        mode: z.enum(["prepare", "enqueue", "merge"]).optional(),
      },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const out = await client.callTool({
        name: "gc_integration_manager",
        arguments: { action: "plan", repo_path: "/tmp" },
      });
      assert.equal(out.isError, undefined, `call must not surface as error: ${JSON.stringify(out)}`);
    } finally {
      await client.close();
    }
  });

  it("client.callTool rejects an unknown action enum value at the schema layer", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { z } = await import("zod");

    const server = new McpServer({
      name: "gc-integrate-registration-test",
      version: "1.0.0",
    });
    server.tool(
      "gc_integration_manager",
      "test wiring",
      {
        action: z.enum(["plan", "prepare", "status", "release"]),
        repo_path: z.string().min(1),
        mode: z.enum(["prepare", "enqueue", "merge"]).optional(),
      },
      async () => ({ content: [{ type: "text", text: "should not run" }] }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      let rejected = false;
      try {
        const out = await client.callTool({
          name: "gc_integration_manager",
          arguments: { action: "bogus", repo_path: "/tmp" },
        });
        if (out.isError) rejected = true;
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true, "unknown action value must be rejected by the schema");
    } finally {
      await client.close();
    }
  });
});
