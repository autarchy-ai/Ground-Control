// Process-tree reaping for the streaming gate runner (issue #1495).
//
// The publish hang was a gate whose leader exited while a background descendant
// kept the stdout pipe open, so the runner's `close` never fired. The gate runner
// now runs each gate as its own process-group leader and reaps the group when the
// leader exits, so a lingering descendant can no longer keep the runner running
// after every visible child has exited. A per-test timeout turns a regressed reap
// (which would hang on the sleep) into a failing case rather than a stuck suite.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runGateCommand } from "./lib/gate-command-runner.js";

const GATE_DEADLINE = { timeoutMs: 60_000 };

const CASE_TIMEOUT_MS = 15000;

describe("runGateCommand process-tree reaping (#1495)", () => {
  it("does not hang when the leader exits leaving a descendant holding the pipe", { timeout: CASE_TIMEOUT_MS }, async () => {
    // The exact publish-hang shape: the leader spawns a background process that
    // keeps stdout open, then exits 0 without waiting. Reaping the group on the
    // leader's exit lets `close` fire promptly instead of blocking on the sleep.
    const result = await runGateCommand("bash", ["-c", "echo ready; sleep 300 & exit 0"], GATE_DEADLINE);
    assert.ok(result.stdout.includes("ready"));
  });

  it("reaps a descendant even when the leader fails", { timeout: CASE_TIMEOUT_MS }, async () => {
    await assert.rejects(
      runGateCommand("bash", ["-c", "printf boom 1>&2; sleep 300 & exit 4"], GATE_DEADLINE),
      (error) => error.code === 4,
    );
  });

  it("returns the exit status normally for a well-behaved gate", async () => {
    const ok = await runGateCommand("bash", ["-c", "printf done; exit 0"], GATE_DEADLINE);
    assert.equal(ok.stdout, "done");
    await assert.rejects(
      runGateCommand("bash", ["-c", "printf boom 1>&2; exit 3"], GATE_DEADLINE),
      (error) => error.code === 3,
    );
  });
});
