// Every privileged command and repository gate the MCP server runs while holding a
// lock or lease has a finite deadline and reaps its whole process tree (issue #1720).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  COMMAND_TIMEOUT_BOUNDS,
  GATE_TIMEOUT_BOUNDS,
  execFileBounded,
  parseBoundedTimeoutMs,
  runBoundedGateCommand,
} from "./lib/bounded-exec.js";
import { runGateCommand } from "./lib/gate-command-runner.js";
import { parseCodexTimeoutMs, CODEX_TIMEOUT_MS_DEFAULT } from "./lib/model-subprocess.js";
import { execFileAsync } from "./implement/gate-helpers.js";
import { runImplementPreCommit } from "./lib.js";
import { defaultExecFile } from "./gc-integrate/exec-file-async.js";

const TEST_TIMEOUT = { timeout: 20000 };

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(path) {
  for (let i = 0; i < 250 && !(existsSync(path) && readFileSync(path, "utf8").trim()); i++) await delay(20);
  return Number(readFileSync(path, "utf8").trim());
}

// A shell that forks a long-lived descendant and blocks on it: the shape of a
// stalled gate or transport whose caller would otherwise wait forever.
function stalledScript(pidFile) {
  return `sleep 300 & echo $! > ${pidFile}; wait`;
}

describe("parseBoundedTimeoutMs", () => {
  const bounds = { min: 1000, max: 60000, default: 5000 };
  it("accepts an in-range integer and falls back to the finite default otherwise", () => {
    assert.equal(parseBoundedTimeoutMs("2500", bounds), 2500);
    for (const raw of [undefined, null, "", "  ", "abc", "0", "-5", "999", "60001", "1e9"]) {
      assert.equal(parseBoundedTimeoutMs(raw, bounds), 5000, `raw=${raw}`);
    }
  });

  it("keeps the codex timeout parser on the same bounded contract", () => {
    assert.equal(parseCodexTimeoutMs("0"), CODEX_TIMEOUT_MS_DEFAULT);
    assert.equal(parseCodexTimeoutMs("90000"), 90000);
  });

  it("declares finite defaults and ceilings for commands and gates", () => {
    for (const bounds of [COMMAND_TIMEOUT_BOUNDS, GATE_TIMEOUT_BOUNDS]) {
      assert.ok(Number.isInteger(bounds.default) && bounds.default <= bounds.max && bounds.min <= bounds.default);
    }
  });
});

describe("bounded command and gate execution", () => {
  let dir;
  const saved = { command: process.env.GC_COMMAND_TIMEOUT_MS, gate: process.env.GC_GATE_TIMEOUT_MS };
  afterEach(() => {
    for (const [key, value] of [["GC_COMMAND_TIMEOUT_MS", saved.command], ["GC_GATE_TIMEOUT_MS", saved.gate]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const pidFile = dir && join(dir, "descendant.pid");
    if (pidFile && existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runGateCommand refuses to run without a finite deadline", TEST_TIMEOUT, async () => {
    for (const timeoutMs of [undefined, 0, -1, Infinity, Number.NaN]) {
      await assert.rejects(runGateCommand("true", [], { timeoutMs }), /finite positive timeoutMs/);
    }
  });

  it("a stalled gate is stopped at its deadline and its descendant is reaped", TEST_TIMEOUT, async () => {
    dir = mkdtempSync(join(tmpdir(), "gc-gate-deadline-"));
    const pidFile = join(dir, "descendant.pid");
    const started = Date.now();
    const error = await runGateCommand("bash", ["-c", stalledScript(pidFile)], { timeoutMs: 500 })
      .then(() => null, (e) => e);
    assert.ok(error, "the stalled gate must reject");
    assert.equal(error.code, "ETIMEDOUT");
    assert.equal(error.killed, true);
    assert.match(error.message, /did not exit within 500ms/);
    assert.ok(Date.now() - started < 5000);
    assert.equal(alive(await readPid(pidFile)), false);
  });

  it("the mechanical and integration command wrappers honor the host command deadline", TEST_TIMEOUT, async () => {
    process.env.GC_COMMAND_TIMEOUT_MS = "1000";
    for (const run of [execFileBounded, execFileAsync, defaultExecFile]) {
      dir = mkdtempSync(join(tmpdir(), "gc-command-deadline-"));
      const pidFile = join(dir, "descendant.pid");
      const started = Date.now();
      const error = await run("bash", ["-c", stalledScript(pidFile)]).then(() => null, (e) => e);
      assert.equal(error?.code, "ETIMEDOUT", run.name);
      assert.ok(Date.now() - started < 6000, run.name);
      assert.equal(alive(await readPid(pidFile)), false, run.name);
      rmSync(dir, { recursive: true, force: true });
    }
    dir = null;
  });

  it("publish's pre-commit boundary defaults to the bounded gate runner", TEST_TIMEOUT, async () => {
    process.env.GC_GATE_TIMEOUT_MS = "1000";
    dir = mkdtempSync(join(tmpdir(), "gc-precommit-deadline-"));
    const pidFile = join(dir, "descendant.pid");
    const error = await runImplementPreCommit(dir, undefined, { workflow: { precommit_command: stalledScript(pidFile) } })
      .then(() => null, (e) => e);
    assert.equal(error?.code, "ETIMEDOUT");
    assert.equal(alive(await readPid(pidFile)), false);
    // Only a bounded output tail is kept, so a verbose hook cannot hit a buffer limit.
    const verbose = await runBoundedGateCommand("bash", ["-c", "head -c 3000000 /dev/zero | tr '\\0' x"]);
    assert.ok(verbose.stdout.length <= 64 * 1024);
  });
});
