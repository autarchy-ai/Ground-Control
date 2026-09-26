// A process group that survives SIGKILL is a cleanup failure, never a clean
// settlement: the bounded runners hold locks and leases, so they must not report
// success or an ordinary timeout while a descendant may still run (issue #1720).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { terminateProcessGroup } from "./lib/process-group.js";
import { runGateCommand } from "./lib/gate-command-runner.js";
import { execFileWithInput } from "./lib/model-subprocess.js";

function survived() {
  const error = new Error("fixture group survived SIGKILL");
  error.code = "ERR_PROCESS_GROUP_SURVIVED";
  return error;
}

async function withStalledLeader(run) {
  const dir = mkdtempSync(join(tmpdir(), "gc-group-survivor-"));
  const pidFile = join(dir, "leader.pid");
  try {
    return await run(["-c", `echo $$ > ${pidFile}; exec sleep 300`]);
  } finally {
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(20);
    if (existsSync(pidFile)) {
      try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("process-group survivor", () => {
  it("terminateProcessGroup rejects when the group outlives SIGKILL", { timeout: 10000 }, async () => {
    const sent = [];
    await assert.rejects(
      terminateProcessGroup(4242, {
        killGraceMs: 10,
        label: "fixture",
        isAlive: () => true,
        signalGroup: (_pgid, sig) => sent.push(sig),
      }),
      { code: "ERR_PROCESS_GROUP_SURVIVED", message: /fixture's process group survived SIGKILL/ },
    );
    assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
  });

  it("runGateCommand settles on the cleanup failure instead of a timeout", { timeout: 10000 }, async () => {
    await withStalledLeader((args) => assert.rejects(
      runGateCommand("bash", args, { timeoutMs: 200, terminateGroup: async () => { throw survived(); } }),
      { code: "ERR_PROCESS_GROUP_SURVIVED" },
    ));
  });

  it("execFileWithInput settles on the cleanup failure instead of a timeout", { timeout: 10000 }, async () => {
    await withStalledLeader((args) => assert.rejects(
      execFileWithInput("bash", args, { timeoutMs: 200, terminateGroup: async () => { throw survived(); } }),
      { code: "ERR_PROCESS_GROUP_SURVIVED" },
    ));
  });
});
