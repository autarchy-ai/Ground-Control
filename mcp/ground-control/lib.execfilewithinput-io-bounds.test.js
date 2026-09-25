// execFileWithInput's stdin and output-limit boundaries (issue #1719): a child
// that exits before reading its prompt must yield a structured failure rather
// than an unhandled EPIPE that crashes the MCP server, and maxBuffer is an
// exact per-stream byte limit whose first excess byte always overflows.
// Every case except the deterministic state-machine one runs a real child over
// real pipes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileWithInput } from "./lib/runtime-primitives.js";

const LARGE_PROMPT = "p".repeat(8 * 1024 * 1024); // far past any pipe buffer

// A fake child for the event-order cases (the spawnImpl seam). Its null pid
// makes process-group cleanup a no-op.
function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  return child;
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function endFakeChild(child) {
  child.stdout.end();
  child.stderr.end();
  await flush();
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  await flush();
}

// Writes the first chunk, pauses so it arrives as its own read, then writes
// the second, so the cap is hit exactly before the later byte arrives.
function twoChunkScript(first, second, fd) {
  return ["-c", `printf '%s' "$1" >&${fd}; sleep 0.2; printf '%s' "$2" >&${fd}`, "_", first, second];
}

describe("execFileWithInput — stdin closure (issue #1719)", () => {
  it("reports a failing child's own exit when it exits before reading a large prompt", { timeout: 10000 }, async () => {
    await assert.rejects(
      execFileWithInput("bash", ["-c", "exit 7"], { input: LARGE_PROMPT, timeoutMs: 5000 }),
      (err) => err.code === 7,
    );
  });

  it("fails instead of succeeding when a clean exit leaves the prompt undelivered", { timeout: 10000 }, async () => {
    await assert.rejects(
      execFileWithInput("bash", ["-c", "echo partial"], { input: LARGE_PROMPT, timeoutMs: 5000 }),
      (err) => {
        assert.equal(err.code, "EPIPE");
        assert.match(err.message, /did not accept its full input/);
        assert.equal(err.stdout, "partial\n");
        return true;
      },
    );
  });

  for (const timeoutMs of [30000, undefined]) {
    it(`terminates a child that closes stdin but keeps running (timeoutMs=${timeoutMs})`, { timeout: 10000 }, async () => {
      // Without termination this child holds its output pipes open for 30s,
      // so the call would wait out the timeout, or hang with none set.
      const started = Date.now();
      await assert.rejects(
        execFileWithInput("bash", ["-c", "exec 0<&-; sleep 30"], { input: LARGE_PROMPT, timeoutMs, killGraceMs: 500 }),
        (err) => err.code === "EPIPE" && /did not accept its full input/.test(err.message),
      );
      assert.ok(Date.now() - started < 5000, "the call waited for the child instead of terminating it");
    });
  }

  it("keeps an earlier overflow as the terminal cause when stdin fails later", async () => {
    const child = makeFakeChild();
    const call = execFileWithInput("fake-emitter", [], { input: "prompt", maxBuffer: 4, spawnImpl: () => child });
    const rejection = assert.rejects(call, (err) => err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    await flush();
    child.stdout.write("12345");
    await flush();
    child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await endFakeChild(child);
    await rejection;
  });

  it("gives a child with no input an immediate EOF on stdin", { timeout: 10000 }, async () => {
    const { stdout } = await execFileWithInput("bash", ["-c", "cat; echo eof"], { timeoutMs: 5000 });
    assert.equal(stdout, "eof\n");
  });
});

describe("execFileWithInput — exact maxBuffer saturation (issue #1719)", () => {
  for (const [which, fd] of [["stdout", 1], ["stderr", 2]]) {
    it(`overflows on ${which} when a later chunk follows an exactly-full buffer`, { timeout: 10000 }, async () => {
      await assert.rejects(
        execFileWithInput("bash", twoChunkScript("1234", "5678", fd), { maxBuffer: 4, timeoutMs: 5000 }),
        (err) => {
          assert.equal(err.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
          assert.match(err.message, new RegExp(`maxBuffer on ${which}$`));
          assert.equal(err[which], "1234");
          return true;
        },
      );
    });
  }

  it("still succeeds when output fills the limit exactly", { timeout: 10000 }, async () => {
    const { stdout, stderr } = await execFileWithInput("bash", ["-c", "printf 1234; printf abcd >&2"], {
      maxBuffer: 4,
      timeoutMs: 5000,
    });
    assert.equal(stdout, "1234");
    assert.equal(stderr, "abcd");
  });

  it("treats a zero-byte limit as exact: silence passes, one byte overflows", { timeout: 10000 }, async () => {
    const { stdout } = await execFileWithInput("bash", ["-c", "true"], { maxBuffer: 0, timeoutMs: 5000 });
    assert.equal(stdout, "");
    await assert.rejects(
      execFileWithInput("bash", ["-c", "printf x"], { maxBuffer: 0, timeoutMs: 5000 }),
      (err) => err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && err.stdout === "",
    );
  });

  it("counts UTF-8 bytes, not characters, and never surfaces a split character", { timeout: 10000 }, async () => {
    // "€" is three bytes. Six bytes fit a six-byte limit exactly.
    const fits = await execFileWithInput("bash", ["-c", "printf '€€'"], { maxBuffer: 6, timeoutMs: 5000 });
    assert.equal(fits.stdout, "€€");
    // A four-byte limit keeps one whole "€" plus one byte of the next, which
    // must be withheld rather than decoded to U+FFFD.
    await assert.rejects(
      execFileWithInput("bash", ["-c", "printf '€€'"], { maxBuffer: 4, timeoutMs: 5000 }),
      (err) => err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && err.stdout === "€",
    );
  });

  it("decodes a character whose bytes arrive in separate chunks", { timeout: 10000 }, async () => {
    // The first two of the three "€" bytes, a pause, then the last byte.
    const { stdout } = await execFileWithInput("bash", ["-c", "printf '\\342\\202'; sleep 0.2; printf '\\254'"], {
      timeoutMs: 5000,
    });
    assert.equal(stdout, "€");
  });

  it("overflows deterministically on the first byte after an exact fill", async () => {
    // State-machine guard for the same boundary, independent of pipe chunking.
    const child = makeFakeChild();
    const call = execFileWithInput("fake-emitter", [], { maxBuffer: 4, spawnImpl: () => child });
    const rejection = assert.rejects(call, (err) => err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && err.stdout === "1234");
    await flush();
    child.stdout.write("1234");
    await flush();
    child.stdout.write("5");
    await endFakeChild(child);
    await rejection;
  });
});
