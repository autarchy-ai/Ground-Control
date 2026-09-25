// The integration completion gate: its failure mapping and argv shape, and its
// deadline. A stalled completion gate cannot strand the integration lock (issue #1720): the
// gate is stopped at its deadline, its process tree is reaped, the PR is blocked
// with a timeout diagnostic, and a competing run can take the lock afterwards.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runIntegrationManager } from "./gc-integrate.js";
import { runGateCommand } from "./lib/gate-command-runner.js";
import { acquireIntegrationLock } from "./lib.js";
import { makeLockFake, makePr, validYaml } from "./gc-integrate.test-helpers.js";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("gc_integration_manager — stalled completion gate", () => {
  it("stops the gate at its deadline and releases the integration lock", { timeout: 20000 }, async () => {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "gc-integrate-deadline-")));
    const pidFile = join(repoRoot, "descendant.pid");
    const prs = [makePr(1)];
    const yaml = validYaml(`workflow:\n  completion_command: "sleep 300 & echo $! > ${pidFile}; wait"\n`);
    const execFile = async (file, argv) => {
      if (file === "gh" && argv.includes("api")) {
        const page = Number(argv.find((a) => a.startsWith("page=")).split("=")[1]);
        return { stdout: JSON.stringify(page === 1 ? prs : []), stderr: "" };
      }
      if (file === "git" && argv.includes("worktree") && argv.includes("add")) {
        mkdirSync(argv[argv.indexOf("add") + 1], { recursive: true });
      }
      if (file === "git" && argv.includes("merge-base")) return { stdout: "mergebasesha\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    try {
      const run = runIntegrationManager({ action: "prepare", repo_path: repoRoot }, {
        execFile,
        runGate: (file, args, options) => runGateCommand(file, args, { ...options, timeoutMs: 1000 }),
        resolveWorkspaceRoot: () => repoRoot,
        ensureGitRepo: async (p) => p,
        getOwnerRepo: async () => ({ owner: "acme", name: "myrepo" }),
        readYaml: () => yaml,
        writeHaltLedger: () => {},
        runCiWatcher: async () => ({ conclusion: "success" }),
        runSonarWatcher: async () => ({ conclusion: "skipped" }),
      });

      for (let i = 0; i < 250 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()); i++) await delay(20);
      const descendant = Number(readFileSync(pidFile, "utf8"));
      // While the gate stalls, the run holds the repository's integration lock.
      await assert.rejects(acquireIntegrationLock(repoRoot), { code: "ELOCKED" });

      const result = await run;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.results[0].outcome, "blocked");
      assert.equal(result.results[0].failure_class, "completion_gate_failed");
      assert.match(result.results[0].summary, /Completion gate timed out/);
      assert.equal(alive(descendant), false);

      const release = await acquireIntegrationLock(repoRoot);
      await release();
    } finally {
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ }
      }
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("gc_integration_manager — prepare completion gate failure", () => {
  it("bash -c completion_command exits non-zero → outcome:blocked, failure_class:completion_gate_failed", async () => {
    const prs = [makePr(1)];
    const calls = [];
    const yaml = validYaml(`workflow:\n  completion_command: "make test"\n`);

    const execFileFake = async (file, argv, _opts) => {
      calls.push([file, ...argv]);
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        return { stdout: JSON.stringify(pageNum === 1 ? prs : []), stderr: "" };
      }
      if (file === "bash") {
        const e = new Error("make test failed");
        e.code = 1;
        e.stderr = "Error: test failures";
        throw e;
      }
      if (file === "git" && argv.includes("merge-base")) {
        return { stdout: "mergebasesha\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const lockFake = makeLockFake();
    const deps = {
      execFile: execFileFake,
      runGate: execFileFake,
      execFileCalls: calls,
      resolveWorkspaceRoot: () => "/some/repo",
      ensureGitRepo: async (p) => p,
      getOwnerRepo: async () => ({ owner: "acme", name: "myrepo" }),
      readYaml: () => yaml,
      acquireIntegrationLock: lockFake.acquireIntegrationLock,
      lockFake,
      writeHaltLedger: () => {},
      runCiWatcher: async () => ({ conclusion: "success" }),
      runSonarWatcher: async () => ({ conclusion: "skipped" }),
      now: () => 1748000000000,
      randomId: () => "abc123",
    };

    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );

    assert.equal(result.ok, true, `expected ok:true (blocked is not an error), got: ${JSON.stringify(result)}`);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "completion_gate_failed");

    // Argv for bash must be exactly ["bash", "-c", <completion-command>].
    const bashCall = calls.find((c) => c[0] === "bash");
    assert.ok(bashCall, "expected a bash call");
    assert.equal(bashCall[0], "bash");
    assert.equal(bashCall[1], "-c");
    assert.equal(bashCall[2], "make test", "third argv element must be the exact completion_command string");
    assert.equal(bashCall.length, 3, "bash argv must be exactly [bash, -c, <cmd>] with no further interpolation");
  });
});
