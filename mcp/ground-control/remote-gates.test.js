import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateRemoteChecks, readRemoteGateSnapshot } from "./lib/remote-gates.js";
const passed = { __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "SUCCESS", appId: 1 };
const required = [{ context: "tests", app_id: 1 }];
describe("authoritative hosted checks", () => {
  it("requires current, completed evidence from the required producer", () => {
    assert.equal(evaluateRemoteChecks([passed], required).passed, true);
    for (const checks of [[], [{ ...passed, status: "IN_PROGRESS" }], [{ ...passed, conclusion: "FAILURE" }], [{ ...passed, appId: 2 }]]) {
      assert.equal(evaluateRemoteChecks(checks, required).passed, false);
    }
    assert.equal(evaluateRemoteChecks([passed], []).passed, false);
  });
  it("refuses results when the PR head changes during observation", async () => {
    let calls = 0;
    const result = await readRemoteGateSnapshot({ repoPath: "/repo", prNumber: 1 }, {
      authorize: async () => ({ ok: true, repoRoot: "/repo", owner: "o", name: "r" }),
      readPr: async () => ({ headRefOid: ++calls === 1 ? "old" : "new", baseRefName: "dev" }),
      readChecks: async () => [passed], readJson: async () => ({ checks: required }),
    });
    assert.equal(result.error, "remote_gate_head_changed");
  });
  it("fails closed if required-check metadata is unavailable", async () => {
    const result = await readRemoteGateSnapshot({ repoPath: "/repo", prNumber: 1 }, {
      authorize: async () => ({ ok: true, repoRoot: "/repo", owner: "o", name: "r" }),
      readPr: async () => ({ headRefOid: "head", baseRefName: "dev" }),
      readChecks: async () => [passed], readJson: async () => { throw new Error("denied"); },
    });
    assert.equal(result.ok, false);
  });
});
