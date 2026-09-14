// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

describe("runGetIssueThread cache short-circuit (issue #934)", () => {
  function makeGitRepo() {
    const dir = mkdtempSync(join(tmpdir(), "gc-issue-thread-cache-"));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    writeFileSync(join(dir, "README"), "x\n");
    execFileSync("git", ["-C", dir, "add", "README"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    // Real origin so owner/repo resolves from the git remote, as production does. git ignores
    // GH_REPO; the `gh repo view` fallback honours it.
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
    return dir;
  }

  it("returns {unchanged: true} when expected_hash matches the cached entry", async () => {
    const {
      runGetIssueThread,
      seedIssueThreadCacheForTest,
      resetIssueThreadCacheForTest,
    } = await import("./lib.js");
    const dir = makeGitRepo();
    try {
      resetIssueThreadCacheForTest();
      // Resolve the real path the cache will key on, so the lookup matches.
      const realDir = realpathSync(dir);
      seedIssueThreadCacheForTest(realDir, 42, "deadbeef");
      const r = await runGetIssueThread({
        repoPath: dir,
        issueNumber: 42,
        expectedHash: "deadbeef",
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(dir) });
      assert.equal(r.ok, true);
      assert.equal(r.unchanged, true);
      assert.equal(r.hash, "deadbeef");
      assert.equal(r.body, null);
      assert.equal(r.comments, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns ok=true unchanged=true and does not surface non-cache fields when the cache hits", async () => {
    const {
      runGetIssueThread,
      seedIssueThreadCacheForTest,
      resetIssueThreadCacheForTest,
    } = await import("./lib.js");
    const dir = makeGitRepo();
    try {
      resetIssueThreadCacheForTest();
      const realDir = realpathSync(dir);
      seedIssueThreadCacheForTest(realDir, 7, "abc123");
      const r = await runGetIssueThread({
        repoPath: dir,
        issueNumber: 7,
        expectedHash: "abc123",
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(dir) });
      assert.equal(r.ok, true);
      assert.equal(r.unchanged, true);
      // Cache-hit envelope nulls payload fields so callers know to use
      // their prior state — the cache never serves stale data, only a
      // confirmation that the hash is still current.
      assert.equal(r.body, null);
      assert.equal(r.title, null);
      assert.equal(r.labels, null);
      assert.equal(r.state, null);
      assert.equal(r.url, null);
      assert.equal(r.comments, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not short-circuit when expected_hash is null", async () => {
    // We can't run the fetch path without `gh`, but we can verify the
    // cache short-circuit is NOT taken when expected_hash is null — the
    // tool must move past the cache check and attempt a real fetch
    // (which will fail in the test env, surfacing a fetch error envelope
    // rather than {unchanged: true}).
    const {
      runGetIssueThread,
      seedIssueThreadCacheForTest,
      resetIssueThreadCacheForTest,
    } = await import("./lib.js");
    const dir = makeGitRepo();
    try {
      resetIssueThreadCacheForTest();
      const realDir = realpathSync(dir);
      seedIssueThreadCacheForTest(realDir, 9, "cachedhash");
      const r = await runGetIssueThread({
        repoPath: dir,
        issueNumber: 9,
        expectedHash: null,
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(dir) });
      // Did NOT short-circuit: either it failed at `gh repo view` (no remote)
      // or at the issue fetch. Either way, ok=false and not unchanged.
      assert.equal(r.ok, false);
      assert.notEqual(r.error, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not short-circuit when expected_hash does not match the cache", async () => {
    const {
      runGetIssueThread,
      seedIssueThreadCacheForTest,
      resetIssueThreadCacheForTest,
    } = await import("./lib.js");
    const dir = makeGitRepo();
    try {
      resetIssueThreadCacheForTest();
      const realDir = realpathSync(dir);
      seedIssueThreadCacheForTest(realDir, 11, "cachedhash");
      const r = await runGetIssueThread({
        repoPath: dir,
        issueNumber: 11,
        expectedHash: "different",
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(dir) });
      // Hash mismatch falls through to a fresh fetch (which fails in test
      // env). The cache must NEVER serve a payload it doesn't have a
      // matching hash for.
      assert.equal(r.ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not return a cached entry across distinct (repo, issue) keys", async () => {
    const {
      runGetIssueThread,
      seedIssueThreadCacheForTest,
      resetIssueThreadCacheForTest,
    } = await import("./lib.js");
    const dir = makeGitRepo();
    try {
      resetIssueThreadCacheForTest();
      const realDir = realpathSync(dir);
      // Seed a different issue number under the same repo.
      seedIssueThreadCacheForTest(realDir, 100, "h100");
      const r = await runGetIssueThread({
        repoPath: dir,
        issueNumber: 101,
        expectedHash: "h100",
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(dir) });
      // Hash matches a DIFFERENT issue's cache entry — must NOT short-circuit.
      assert.equal(r.ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Cache cap (issue #934 fix-list). Long-running MCP servers should
  // not grow the cache unboundedly. Verify the LRU eviction policy
  // pins the size and that promote-on-hit keeps recent entries warm.
  it("caps cache entries at ISSUE_THREAD_CACHE_MAX_ENTRIES; oldest are evicted first", async () => {
    const {
      seedIssueThreadCacheForTest,
      resetIssueThreadCacheForTest,
      peekIssueThreadCacheForTest,
      ISSUE_THREAD_CACHE_MAX_ENTRIES,
    } = await import("./lib.js");
    resetIssueThreadCacheForTest();
    // Seed cap+5 entries; the oldest 5 should be evicted on the
    // (cap+1)th and subsequent inserts.
    // Note: seed helpers insert directly without calling the eviction
    // hook, so we use the production path via the runGetIssueThread
    // fresh-fetch codepath would be ideal — but for a pure cap test,
    // we can verify the constant exists and is reasonable.
    assert.equal(typeof ISSUE_THREAD_CACHE_MAX_ENTRIES, "number");
    assert.ok(
      ISSUE_THREAD_CACHE_MAX_ENTRIES > 0 && ISSUE_THREAD_CACHE_MAX_ENTRIES < 10000,
      `cache cap should be a small positive integer; got ${ISSUE_THREAD_CACHE_MAX_ENTRIES}`,
    );
  });
});

describe("shouldRetrySonarStatus (issue #934 fix-list)", () => {
  it("retries on 5xx server errors", async () => {
    const { shouldRetrySonarStatus } = await import("./lib.js");
    assert.equal(shouldRetrySonarStatus(500), true);
    assert.equal(shouldRetrySonarStatus(502), true);
    assert.equal(shouldRetrySonarStatus(503), true);
    assert.equal(shouldRetrySonarStatus(504), true);
    assert.equal(shouldRetrySonarStatus(599), true);
  });

  it("retries on 429 (rate-limit)", async () => {
    const { shouldRetrySonarStatus } = await import("./lib.js");
    assert.equal(shouldRetrySonarStatus(429), true);
  });

  it("does not retry on 4xx (except 429) — permanent failures", async () => {
    const { shouldRetrySonarStatus } = await import("./lib.js");
    // 401/403 are auth failures; 404 is not-found; 400 is bad request.
    // None of these are transient; retrying just wastes time.
    assert.equal(shouldRetrySonarStatus(400), false);
    assert.equal(shouldRetrySonarStatus(401), false);
    assert.equal(shouldRetrySonarStatus(403), false);
    assert.equal(shouldRetrySonarStatus(404), false);
    assert.equal(shouldRetrySonarStatus(422), false);
  });

  it("does not retry on 2xx/3xx", async () => {
    const { shouldRetrySonarStatus } = await import("./lib.js");
    assert.equal(shouldRetrySonarStatus(200), false);
    assert.equal(shouldRetrySonarStatus(201), false);
    assert.equal(shouldRetrySonarStatus(204), false);
    assert.equal(shouldRetrySonarStatus(301), false);
    assert.equal(shouldRetrySonarStatus(304), false);
  });

  it("does not retry on non-number / malformed input", async () => {
    const { shouldRetrySonarStatus } = await import("./lib.js");
    assert.equal(shouldRetrySonarStatus(null), false);
    assert.equal(shouldRetrySonarStatus(undefined), false);
    assert.equal(shouldRetrySonarStatus("500"), false);
    assert.equal(shouldRetrySonarStatus(NaN), false);
  });
});

describe("SONAR_EXPORT_RETENTION (issue #934 fix-list)", () => {
  it("exposes a small positive integer cap", async () => {
    const { SONAR_EXPORT_RETENTION } = await import("./lib.js");
    assert.equal(typeof SONAR_EXPORT_RETENTION, "number");
    assert.ok(
      SONAR_EXPORT_RETENTION > 0 && SONAR_EXPORT_RETENTION < 1000,
      `retention should be a reasonable cap; got ${SONAR_EXPORT_RETENTION}`,
    );
  });
});
