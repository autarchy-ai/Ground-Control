import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("MCP-only runtime boundary", () => {
  it("contains no backend lifecycle or telemetry adapters", () => {
    for (const relative of [
      "mcp/ground-control/telemetry.js",
      "mcp/ground-control/workflow-run-lifecycle.js",
      "mcp/ground-control/lib/api-workflow-run.js",
      "mcp/ground-control/lib/review-station-emission.js",
      "mcp/ground-control/lib/step-telemetry.js",
      ".claude/agents/completion-verifier.md",
      ".claude/rules/implementation-quality.md",
    ]) {
      assert.equal(existsSync(path.join(ROOT, relative)), false, relative);
    }
  });

  it("does not exempt a retired deployment environment template", () => {
    const source = readFileSync(path.join(ROOT, ".claude/hooks/protect_files.sh"), "utf8");
    assert.equal(source.includes("deploy/docker/.env.example"), false);
  });

  it("does not inventory retired backend connection variables", () => {
    const source = readFileSync(path.join(ROOT, "mcp/ground-control/lib/server-env.js"), "utf8");
    for (const name of [
      "GC_BASE_URL",
      "GROUND_CONTROL_API_TOKEN",
      "GROUND_CONTROL_PACK_REGISTRY_ADMIN_TOKEN",
    ]) {
      assert.equal(source.includes(`\"${name}\"`), false, name);
    }
  });

  it("does not expose measurement-only gate artifacts", () => {
    const makefile = readFileSync(path.join(ROOT, "Makefile"), "utf8");
    const policyCli = readFileSync(path.join(ROOT, "tools/policy/workflow_routing.py"), "utf8");
    for (const token of ["GC_POLICY_JSON", "GC_VALE_JSON"]) {
      assert.equal(makefile.includes(token), false, token);
    }
    assert.equal(policyCli.includes('"--json"'), false, "policy measurement artifact flag");
    assert.equal(policyCli.includes("write_violations_json"), false, "policy measurement writer");
  });
});
