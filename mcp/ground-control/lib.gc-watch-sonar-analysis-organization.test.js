// An organization-scoped SonarCloud token is refused (HTTP 400) on an issue search that
// does not name the organization, so every watch request carries the declared one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeRepo(yamlBody) {
  const dir = mkdtempSync(join(tmpdir(), "gc-sonar-org-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, ".ground-control.yaml"), yamlBody);
  execFileSync("git", ["-C", dir, "add", ".ground-control.yaml"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
  return dir;
}

function sonarResponse(url) {
  if (url.includes("/api/qualitygates/project_status")) return { projectStatus: { status: "OK" } };
  if (url.includes("/api/issues/search")) return { total: 0, issues: [] };
  return { paging: { total: 0 }, hotspots: [] };
}

async function watch(yamlBody) {
  const { runWatchSonarAnalysis } = await import("./lib.js");
  const dir = makeRepo(yamlBody);
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.SONAR_TOKEN;
  process.env.SONAR_TOKEN = "test-token-stub";
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    return { status: 200, ok: true, json: async () => sonarResponse(url) };
  };
  try {
    const result = await runWatchSonarAnalysis({
      authorizeRepoRead: async () => ({ ok: true, repoSlug: "fake/repo" }),
      fetchProducerEvidence: async () => null,
      repoPath: dir, prNumber: 7, initialWaitSeconds: 0, pollIntervalSeconds: 0, totalTimeoutSeconds: 10,
    });
    return { result, urls };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.SONAR_TOKEN;
    else process.env.SONAR_TOKEN = originalToken;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gc_watch_sonar_analysis organization scope", () => {
  it("names the declared organization on the gate, issue, and hotspot requests", async () => {
    const { result, urls } = await watch(
      "schema_version: 1\nproject: test\nsonarcloud:\n  project_key: test_key\n  organization: test_org\n",
    );
    assert.equal(result.ok, true);
    const paths = urls.map((url) => url.pathname);
    for (const path of ["/api/qualitygates/project_status", "/api/issues/search", "/api/hotspots/search"]) {
      assert.ok(paths.includes(path), `expected a request to ${path}`);
    }
    for (const url of urls) {
      assert.equal(url.searchParams.get("organization"), "test_org", url.pathname);
    }
  });
});
