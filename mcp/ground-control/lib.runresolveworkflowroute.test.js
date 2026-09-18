// Split from lib.test.js under issue #1467 for the 500-LOC limit.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runResolveWorkflowRoute } from "./lib.js";

describe("runResolveWorkflowRoute", () => {
  it("reads .ground-control.yaml and resolves configured stage routing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-routing-test-"));
    try {
      execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
      writeFileSync(join(dir, ".ground-control.yaml"), [
        "schema_version: 1",
        "project: gc",
        "routing:",
        "  enabled: true",
        "  stages:",
        "    implementation:",
        "      tier: medium",
        "      model: claude-sonnet-4-6",
        "",
      ].join("\n"));
      const result = await runResolveWorkflowRoute({ repoPath: dir, stage: "implementation" });
      assert.equal(result.ok, true);
      assert.equal(result.enabled, true);
      assert.equal(result.model, "claude-sonnet-4-6");
      assert.equal(result.source, "config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
