// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_IMPLEMENT_ROUTING_STAGES, postCodexReviewFindings } from "./lib.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

async function withShimPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

// =============================================================================
// Orchestrator / per-step file / routing-stage sync validator (issue #934)
// =============================================================================
//
// The /implement orchestrator at skills/implement/SKILL.md enumerates step ids
// and step file paths in its table. If those drift from
// DEFAULT_IMPLEMENT_ROUTING_STAGES (the canonical stage list in lib.js) or
// from the actual step files on disk, dispatch silently breaks at runtime.
// This validator pins the three sources to each other so a future edit that
// renames a stage, deletes a step file, or adds a stage without wiring it
// into the orchestrator fails CI.

// =============================================================================
// Integration tests with execFile mocking for new MCP tools (issue #934 fix-list)
// =============================================================================
//
// The pure-helper coverage is good but the integration path (real gh
// subprocess + real fetch) was previously only exercised by live runs
// against gc-orchestrator-test. These tests use the existing hermetic-shim
// pattern (PATH-overriding `gh` and stub-overriding `fetch`) so a future
// regression in the integration layer shows up without needing a live
// run to find it.

describe("gc_watch_ci_run integration (hermetic gh shim, issue #934 fix-list)", () => {
  // Standalone shim helper scoped to this describe so the test is
  // self-contained. Same shape as the postCodexReviewFindings shim
  // above; duplicated here intentionally to avoid coupling describes.
  function makeWatchShim({ remote, routes }) {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-ciwatch-repo-"));
    execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", "main"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
    writeFileSync(join(repoDir, "README"), "x\n");
    execFileSync("git", ["-C", repoDir, "add", "README"]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", remote]);
    const binDir = mkdtempSync(join(tmpdir(), "gc-ciwatch-bin-"));
    const cfgPath = join(binDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ routes }));
    const ghShim = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfgPath)}, "utf8"));
const argv = process.argv.slice(2);
function match(prefix) { return prefix.every((p, i) => argv[i] === p); }
for (const route of cfg.routes) {
  if (match(route.argv_prefix)) {
    if (route.exit_code != null && route.exit_code !== 0) {
      process.stderr.write(route.stderr || "");
      process.exit(route.exit_code);
    }
    process.stdout.write(route.stdout || "");
    process.exit(0);
  }
}
process.stderr.write("ci-watch gh shim: unhandled argv: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
    writeFileSync(join(binDir, "gh"), ghShim, { mode: 0o755 });
    return {
      repoDir, binDir,
      cleanup() {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      },
    };
  }

  async function withShimPath(binDir, fn) {
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = oldPath;
    }
  }

  it("success path: returns conclusion='success' with empty failed_steps and null log_summary", async () => {
    const { runWatchCiRun } = await import("./lib.js");
    const shim = makeWatchShim({
      remote: "https://github.com/test-owner/test-repo.git",
      routes: [
        {
          argv_prefix: [
            "--repo", "test-owner/test-repo",
            "run", "view", "123",
            "--json", "status,conclusion,databaseId,url,createdAt,startedAt,updatedAt,workflowName,jobs,headSha",
          ],
          stdout: JSON.stringify({
            status: "completed",
            conclusion: "success",
            databaseId: 123,
            url: "https://example.test/runs/123",
            jobs: [
              { name: "build", conclusion: "success", steps: [{ name: "compile", conclusion: "success" }] },
            ],
          }),
        },
      ],
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const r = await runWatchCiRun({
        authorizeRepoRead: async () => ({ ok: true, repoSlug: "test-owner/test-repo" }),
          repoPath: shim.repoDir,
          branch: "main",
          runId: 123,
          pollIntervalSeconds: 1,
        });
        assert.equal(r.ok, true);
        assert.equal(r.conclusion, "success");
        assert.equal(r.run_id, 123);
        assert.deepEqual(r.failed_steps, []);
        assert.equal(r.log_summary, null);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("failure path: returns failed_steps[] + bounded log_summary", async () => {
    const { runWatchCiRun } = await import("./lib.js");
    const shim = makeWatchShim({
      remote: "https://github.com/test-owner/test-repo.git",
      routes: [
        {
          argv_prefix: [
            "--repo", "test-owner/test-repo",
            "run", "view", "456",
            "--json", "status,conclusion,databaseId,url,createdAt,startedAt,updatedAt,workflowName,jobs,headSha",
          ],
          stdout: JSON.stringify({
            status: "completed",
            conclusion: "failure",
            databaseId: 456,
            url: "https://example.test/runs/456",
            jobs: [
              {
                name: "test",
                conclusion: "failure",
                steps: [
                  { name: "checkout", conclusion: "success" },
                  { name: "run-tests", conclusion: "failure" },
                ],
              },
            ],
          }),
        },
        {
          argv_prefix: [
            "--repo", "test-owner/test-repo",
            "run", "view", "456", "--log-failed",
          ],
          stdout: "test\trun-tests\t2026-01-01T00:00:00Z error: assertion failed\n",
        },
      ],
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const r = await runWatchCiRun({
        authorizeRepoRead: async () => ({ ok: true, repoSlug: "test-owner/test-repo" }),
          repoPath: shim.repoDir,
          branch: "main",
          runId: 456,
          pollIntervalSeconds: 1,
        });
        assert.equal(r.ok, true);
        assert.equal(r.conclusion, "failure");
        assert.deepEqual(r.failed_steps, [{ job_name: "test", step_name: "run-tests" }]);
        assert.match(r.log_summary, /assertion failed/);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("auto-resolves run_id from branch via gh run list (success after resolution)", async () => {
    const { runWatchCiRun } = await import("./lib.js");
    const shim = makeWatchShim({
      remote: "https://github.com/test-owner/test-repo.git",
      routes: [
        {
          argv_prefix: ["api", "repos/test-owner/test-repo/commits/feature/x", "--jq", ".sha"],
          stdout: "5ba10c9f2e7d4a3b8c6f1e0d9a2b3c4d5e6f7081\n",
        },
        {
          argv_prefix: [
            "--repo", "test-owner/test-repo",
            "run", "list", "--branch", "feature/x", "--limit", "20",
            "--json", "status,conclusion,databaseId,url,createdAt,headSha,workflowName,event",
          ],
          stdout: JSON.stringify([
            { status: "completed", conclusion: "success", databaseId: 789, url: "https://example.test/runs/789", createdAt: "2026-01-01T00:00:00Z", headSha: "5ba10c9f2e7d4a3b8c6f1e0d9a2b3c4d5e6f7081" },
          ]),
        },
        {
          argv_prefix: [
            "--repo", "test-owner/test-repo",
            "run", "view", "789",
            "--json", "status,conclusion,databaseId,url,createdAt,startedAt,updatedAt,workflowName,jobs,headSha",
          ],
          stdout: JSON.stringify({
            status: "completed",
            conclusion: "success",
            databaseId: 789,
            url: "https://example.test/runs/789",
            jobs: [],
          }),
        },
      ],
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const r = await runWatchCiRun({
        authorizeRepoRead: async () => ({ ok: true, repoSlug: "test-owner/test-repo" }),
          repoPath: shim.repoDir,
          branch: "feature/x",
          pollIntervalSeconds: 1,
        });
        assert.equal(r.ok, true);
        assert.equal(r.run_id, 789);
        assert.equal(r.conclusion, "success");
      });
    } finally {
      shim.cleanup();
    }
  });

  it("does not report success from a fast sibling workflow while the CI run is still failing (issue #1461)", async () => {
    // The exact shape of the false green: one commit triggers ci.yml and
    // pr-title.yml, the 5-second title lint lands first, and watching only the
    // newest run reported its success as the CI gate.
    const { runWatchCiRun } = await import("./lib.js");
    const shim = makeWatchShim({
      remote: "https://github.com/test-owner/test-repo.git",
      routes: [
        {
          argv_prefix: ["api", "repos/test-owner/test-repo/commits/feature/x", "--jq", ".sha"],
          stdout: "deadbeef\n",
        },
        {
          argv_prefix: [
            "--repo", "test-owner/test-repo",
            "run", "list", "--branch", "feature/x", "--limit", "20",
            "--json", "status,conclusion,databaseId,url,createdAt,headSha,workflowName,event",
          ],
          stdout: JSON.stringify([
            { status: "completed", conclusion: "success", databaseId: 111, url: "https://example.test/runs/111", createdAt: "2026-01-01T00:00:05Z", headSha: "deadbeef" },
            { status: "completed", conclusion: "failure", databaseId: 222, url: "https://example.test/runs/222", createdAt: "2026-01-01T00:00:00Z", headSha: "deadbeef" },
            { status: "completed", conclusion: "success", databaseId: 333, url: "https://example.test/runs/333", createdAt: "2025-12-31T00:00:00Z", headSha: "oldersha" },
          ]),
        },
        {
          argv_prefix: [
            "--repo", "test-owner/test-repo",
            "run", "view", "111",
            "--json", "status,conclusion,databaseId,url,createdAt,startedAt,updatedAt,workflowName,jobs,headSha",
          ],
          stdout: JSON.stringify({
            status: "completed", conclusion: "success", databaseId: 111,
            url: "https://example.test/runs/111", jobs: [],
          }),
        },
        {
          argv_prefix: [
            "--repo", "test-owner/test-repo",
            "run", "view", "222",
            "--json", "status,conclusion,databaseId,url,createdAt,startedAt,updatedAt,workflowName,jobs,headSha",
          ],
          stdout: JSON.stringify({
            status: "completed", conclusion: "failure", databaseId: 222,
            url: "https://example.test/runs/222",
            jobs: [
              { name: "policy", conclusion: "failure", steps: [{ name: "Vale prose lint", conclusion: "failure" }] },
            ],
          }),
        },
        {
          argv_prefix: ["--repo", "test-owner/test-repo", "run", "view", "222", "--log-failed"],
          stdout: "policy\tVale prose lint\tsome error\n",
        },
      ],
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const r = await runWatchCiRun({
        authorizeRepoRead: async () => ({ ok: true, repoSlug: "test-owner/test-repo" }),
          repoPath: shim.repoDir,
          branch: "feature/x",
          pollIntervalSeconds: 1,
        });
        assert.equal(r.conclusion, "failure");
        assert.equal(r.run_id, 222, "must point at the run that actually failed");
        assert.equal(r.url, "https://example.test/runs/222", "url must name the same run as run_id");
        assert.ok(
          r.failed_steps.some((s) => s.step_name === "Vale prose lint"),
          "failure detail must come from the failing run",
        );
      });
    } finally {
      shim.cleanup();
    }
  });
});

describe("gc_get_issue_thread integration (hermetic gh shim, issue #934 fix-list)", () => {
  function makeThreadShim({ remote, routes }) {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-thread-repo-"));
    execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", "main"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
    writeFileSync(join(repoDir, "README"), "x\n");
    execFileSync("git", ["-C", repoDir, "add", "README"]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", remote]);
    const binDir = mkdtempSync(join(tmpdir(), "gc-thread-bin-"));
    const cfgPath = join(binDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ routes }));
    const ghShim = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfgPath)}, "utf8"));
const argv = process.argv.slice(2);
function match(prefix) { return prefix.every((p, i) => argv[i] === p); }
for (const route of cfg.routes) {
  if (match(route.argv_prefix)) {
    process.stdout.write(route.stdout || "");
    process.exit(0);
  }
}
process.stderr.write("thread gh shim: unhandled argv: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
    writeFileSync(join(binDir, "gh"), ghShim, { mode: 0o755 });
    return {
      repoDir, binDir,
      cleanup() {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      },
    };
  }

  async function withShimPath(binDir, fn) {
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try { return await fn(); } finally { process.env.PATH = oldPath; }
  }

  it("full fetch: body + comments parsed from gh api responses; hash is deterministic", async () => {
    const { runGetIssueThread, resetIssueThreadCacheForTest, hashIssueThreadPayload } = await import("./lib.js");
    resetIssueThreadCacheForTest();
    const shim = makeThreadShim({
      remote: "https://github.com/o/r.git",
      routes: [
        {
          argv_prefix: ["api", "/repos/o/r/issues/42"],
          stdout: JSON.stringify({
            body: "issue body",
            title: "Test issue",
            labels: [{ name: "bug" }, { name: "p1" }],
            state: "open",
            html_url: "https://example.test/issues/42",
          }),
        },
        {
          argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp", "/repos/o/r/issues/42/comments"],
          stdout: JSON.stringify([[
            { id: 1, user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z", body: "first comment" },
            { id: 2, user: { login: "bob" }, created_at: "2026-01-02T00:00:00Z", body: "second comment" },
          ]]),
        },
      ],
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const r = await runGetIssueThread(
          { repoPath: shim.repoDir, issueNumber: 42 },
          { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) },
        );
        assert.equal(r.ok, true);
        assert.equal(r.unchanged, false);
        assert.equal(r.body, "issue body");
        assert.equal(r.title, "Test issue");
        assert.deepEqual(r.labels, ["bug", "p1"]);
        assert.equal(r.state, "open");
        assert.equal(r.comments.length, 2);
        assert.equal(r.comments[0].author, "alice");
        // Hash matches the pure-function hashIssueThreadPayload over the
        // body + parsed comments.
        const expectedHash = hashIssueThreadPayload(r.body, r.comments);
        assert.equal(r.hash, expectedHash);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("second call with the returned hash returns {unchanged: true} without re-invoking gh", async () => {
    const { runGetIssueThread, resetIssueThreadCacheForTest } = await import("./lib.js");
    resetIssueThreadCacheForTest();
    let firstHash = null;
    const shim = makeThreadShim({
      remote: "https://github.com/o/r.git",
      routes: [
        {
          argv_prefix: ["api", "/repos/o/r/issues/55"],
          stdout: JSON.stringify({
            body: "body", title: "t", labels: [], state: "open",
            html_url: "https://example.test/issues/55",
          }),
        },
        {
          argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp", "/repos/o/r/issues/55/comments"],
          stdout: JSON.stringify([[]]),
        },
      ],
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const r1 = await runGetIssueThread(
          { repoPath: shim.repoDir, issueNumber: 55 },
          { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) },
        );
        assert.equal(r1.ok, true);
        firstHash = r1.hash;
        // Second call with the hash should NOT touch gh.
        const r2 = await runGetIssueThread({
          repoPath: shim.repoDir,
          issueNumber: 55,
          expectedHash: firstHash,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(r2.ok, true);
        assert.equal(r2.unchanged, true);
        assert.equal(r2.hash, firstHash);
        assert.equal(r2.body, null);
      });
    } finally {
      shim.cleanup();
    }
  });
});
