// A stalled completion gate cannot strand the integration lock (issue #1720): the
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
import { makePr, validYaml } from "./gc-integrate.test-helpers.js";

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
