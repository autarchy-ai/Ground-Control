// The gate command runner must observe the gate's exit status no matter how
// verbose the command is. execFile aborts a completion command whose stdout
// exceeds its 1 MiB maxBuffer before the child exits, so the completion
// boundary could never be satisfied on a large merged tree (issue #1501).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runGateCommand } from "./lib/gate-command-runner.js";

const GATE_DEADLINE = { timeoutMs: 60_000 };

// Comfortably past execFile's 1 MiB maxBuffer default; the pre-fix runner
// aborted with ERR_CHILD_PROCESS_STDIO_MAXBUFFER at this size.
const OVER_MAXBUFFER = "head -c 2000000 </dev/zero | tr '\\0' a";
const TAIL_CAP_BYTES = 64 * 1024;

describe("runGateCommand", () => {
  it("observes a success exit status behind multi-megabyte stdout", async () => {
    const result = await runGateCommand("bash", ["-c", `${OVER_MAXBUFFER}; printf ZZZEND; exit 0`], GATE_DEADLINE);
    // The exit status is what the gate boundary reads; the transcript is kept
    // only as a bounded tail, so the freshest output survives while memory stays
    // capped.
    assert.ok(result.stdout.endsWith("ZZZEND"));
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= TAIL_CAP_BYTES);
  });

  it("surfaces a non-zero exit status with a bounded stderr tail behind large output", async () => {
    await assert.rejects(
      runGateCommand("bash", ["-c", `${OVER_MAXBUFFER} >&2; exit 7`], GATE_DEADLINE),
      (error) => {
        assert.equal(error.code, 7);
        assert.ok(Buffer.byteLength(error.stderr, "utf8") <= TAIL_CAP_BYTES);
        return true;
      },
    );
  });
});
