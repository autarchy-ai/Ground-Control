import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resetVerificationPhaseCacheForTest,
  runVerifiedGateBoundary,
} from "./lib/verification-gates.js";

const FINGERPRINT = "fingerprint";
const context = {
  status: "ok",
  workflow: {
    completion_command: "make check",
    policy_command: "make policy",
    verification: { toolchain_fingerprint_command: FINGERPRINT },
  },
};
const stableTree = async () => "a".repeat(40);
const stableStatus = async () => "";

function invoke(commandRunner, reuseKey) {
  return runVerifiedGateBoundary({
    repoRoot: "/r",
    context,
    gateEnv: {},
    commandRunner,
    readTreeOid: stableTree,
    readStatus: stableStatus,
    reuseKey,
  });
}

describe("verification phase reuse (issue #1626)", () => {
  it("reuses completion when policy is retried on identical inputs", async () => {
    resetVerificationPhaseCacheForTest();
    const calls = [];
    let policyAttempts = 0;
    const runner = async (file, args) => {
      const command = args.at(-1);
      if (command === FINGERPRINT) return { stdout: `${"e".repeat(64)}\n`, stderr: "" };
      calls.push(command);
      if (command === "make policy" && policyAttempts++ === 0) throw new Error("policy failed");
      return { stdout: "", stderr: "" };
    };

    await assert.rejects(invoke(runner, "candidate-a"), /policy failed/);
    const retried = await invoke(runner, "candidate-a");

    assert.deepEqual(calls, ["make check", "make policy", "make policy"]);
    assert.deepEqual(retried.timings.map(({ phase, outcome }) => [phase, outcome]), [
      ["completion", "reused"],
      ["policy", "passed"],
    ]);
  });

  it("invalidates phase reuse when the content address changes", async () => {
    resetVerificationPhaseCacheForTest();
    const calls = [];
    const runner = async (file, args) => {
      const command = args.at(-1);
      if (command === FINGERPRINT) return { stdout: `${"e".repeat(64)}\n`, stderr: "" };
      calls.push(command);
      return { stdout: "", stderr: "" };
    };

    await invoke(runner, "candidate-a");
    await invoke(runner, "candidate-b");

    assert.deepEqual(calls, ["make check", "make policy", "make check", "make policy"]);
  });
});
