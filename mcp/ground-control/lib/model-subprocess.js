// Extracted from runtime-primitives.js (issue #1518) to stay under the
// repo's 500-LOC file gate. runtime-primitives.js re-exports execFileWithInput
// and the timeout constants, so every existing caller's import path is
// unchanged.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isProcessGroupAlive, isPosixProcessGroupCapable, terminateProcessGroup } from "./process-group.js";

export const CODEX_TIMEOUT_MS_MIN = 1000; // 1 second floor
export const CODEX_TIMEOUT_MS_MAX = 3600000; // 1 hour ceiling
export const CODEX_TIMEOUT_MS_DEFAULT = 1200000; // 20 minutes
// GC_CODEX_TIMEOUT_MS is host configuration, not repository policy (issue
// #1518). A zero, negative, malformed, or excessive value must fall back to
// the finite default rather than disabling or effectively removing the wall
// cap that bounds every codex/claude subprocess this server spawns.
export function parseCodexTimeoutMs(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return CODEX_TIMEOUT_MS_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < CODEX_TIMEOUT_MS_MIN || parsed > CODEX_TIMEOUT_MS_MAX) {
    return CODEX_TIMEOUT_MS_DEFAULT;
  }
  return parsed;
}
// Resolved on every call, not once at module-import time (issue #1521): the
// import graph that reaches this module executes before index.js's
// loadDotenvFromCwd() (or any other startup env-config loader) runs, so a
// module-level constant would permanently miss a GC_CODEX_TIMEOUT_MS value
// that only lives in a .env/host-config file rather than the ambient shell.
export function getDefaultCodexTimeoutMs() {
  return parseCodexTimeoutMs(process.env.GC_CODEX_TIMEOUT_MS);
}
const KILL_GRACE_MS_DEFAULT = 5000;
const MAX_BUFFER_DEFAULT = 1024 * 1024; // 1 MiB, matches Node's own execFile default

function newOutputBuffer() {
  return { chunks: [], length: 0, overflowed: false };
}

// An overflowed stream was cut at a byte boundary that may split a UTF-8
// character; StringDecoder.write() withholds that incomplete tail instead of
// surfacing a replacement character the child never wrote. A complete stream
// decodes as-is.
function decodeOutput({ chunks, overflowed }) {
  const bytes = Buffer.concat(chunks);
  return overflowed ? new StringDecoder("utf8").write(bytes) : bytes.toString("utf8");
}

// child_process.execFile() silently drops `detached` before it reaches the
// real spawn() call (it forwards only an explicit options allowlist), so it
// can never produce a real process-group leader — confirmed by reading
// Node's own execFile source. execFileWithInput therefore builds directly on
// spawn(), reimplementing the small slice of execFile's behavior (buffered
// stdout/stderr, maxBuffer enforcement, exit-code/signal error shape) that
// every caller here relies on (issue #1518).
class BufferedProcessExecution {
  constructor(file, args, config, resolve, reject) {
    this.file = file;
    this.args = args;
    this.config = config;
    this.resolve = resolve;
    this.reject = reject;
    this.timedOut = false;
    this.aborted = false;
    this.maxBufferExceeded = null;
    this.killTimer = null;
    this.settled = false;
    this.pendingCleanup = null;
    this.output = { stdout: newOutputBuffer(), stderr: newOutputBuffer() };
    this.stdoutDone = false;
    this.stderrDone = false;
    this.stdinDone = false;
    this.stdinError = null;
    this.inputFailed = false;
    this.closeResult = null;
  }

  start() {
    const { file, args, config } = this;
    // Detached so child.pid is also its POSIX process-group id: signalling
    // -pid reaches every subprocess the child spawns (e.g. a shell tool
    // call), not just the direct child. A signal to the direct pid alone let
    // a codex-spawned `ugrep` outlive its leader and run orphaned for 10+
    // days once reparented to init (issue #1518).
    this.child = this.config.spawnImpl(file, args, { ...config.options, detached: true });
    this.attachOutputHandlers();
    this.attachLifecycleHandlers();
    this.armTerminationTriggers();
    this.deliverInput();
  }

  deliverInput() {
    const { stdin } = this.child;
    if (!stdin) {
      this.stdinDone = true;
      return;
    }
    // A child that exits before reading its whole prompt makes the pending
    // write fail with EPIPE. Without a listener that error is unhandled and
    // crashes the whole MCP server (issue #1719), so the stdin outcome is part
    // of this lifecycle.
    const markStdinDone = () => {
      this.stdinDone = true;
      this.maybeFinalize();
    };
    const onInputError = (error) => {
      this.failInput(error);
      markStdinDone();
    };
    stdin.on("error", onInputError);
    stdin.on("finish", markStdinDone);
    stdin.on("close", markStdinDone);
    try {
      // Always end stdin, even without input, so a child that reads it sees
      // EOF instead of blocking until the timeout.
      if (this.config.input == null) stdin.end();
      else stdin.end(this.config.input);
    } catch (error) {
      onInputError(error);
    }
  }

  hasTerminalCause() {
    return this.timedOut || this.aborted || this.maxBufferExceeded !== null || this.inputFailed;
  }

  clearKillTimer() {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  failInput(error) {
    this.stdinError ??= error;
    if (this.hasTerminalCause()) return;
    // An undelivered prompt makes any output worthless, and a child that
    // closed stdin but kept its output pipes open would otherwise hold the
    // call until the timeout (or forever without one): terminate the group.
    this.inputFailed = true;
    this.clearKillTimer();
    this.ensureGroupEmpty();
  }

  ensureGroupEmpty() {
    // TERM the group, then SIGKILL anything still alive after the grace period,
    // confirming the group is actually empty before resolving. Settlement awaits
    // this (see the `close` handler) so a SIGTERM-ignoring descendant can't
    // outlive a call that already resolved or rejected. Single-flight via
    // `pendingCleanup`: concurrent triggers (timeout, abort, maxBuffer,
    // leader-exit) collapse onto one in-flight escalation. The escalation itself
    // is the shared terminateProcessGroup primitive (issue #1495).
    if (this.pendingCleanup !== null) return this.pendingCleanup;
    if (!this.child.pid || !isProcessGroupAlive(this.child.pid)) return Promise.resolve();
    this.pendingCleanup = terminateProcessGroup(this.child.pid, {
      killSignal: this.config.killSignal,
      killGraceMs: this.config.killGraceMs,
      label: this.file,
    });
    return this.pendingCleanup;
  }

  trackChunk(which, chunk) {
    // Counts raw pipe bytes, before any UTF-8 decoding, so the limit is a true
    // byte limit. Filling it exactly is allowed; the first byte past it (in
    // the same chunk or any later one) is overflow (issue #1719).
    const buffer = this.output[which];
    if (buffer.overflowed) return;
    const allowed = this.config.maxBuffer - buffer.length;
    if (chunk.length <= allowed) {
      buffer.chunks.push(chunk);
      buffer.length += chunk.length;
      return;
    }
    if (allowed > 0) buffer.chunks.push(chunk.subarray(0, allowed));
    buffer.length += allowed;
    buffer.overflowed = true;
    if (!this.hasTerminalCause()) {
      this.maxBufferExceeded = which;
      // maxBuffer is the first terminal cause. Cleanup can legitimately
      // outlive timeoutMs, but that later timer must not rewrite the result.
      this.clearKillTimer();
      this.ensureGroupEmpty();
    }
  }

  attachOutputHandlers() {
    this.child.stdout.on("data", (chunk) => this.trackChunk("stdout", chunk));
    this.child.stderr.on("data", (chunk) => this.trackChunk("stderr", chunk));
  }

  markStreamDone(which) {
    if (which === "stdout") this.stdoutDone = true;
    else this.stderrDone = true;
    this.maybeFinalize();
  }

  attachLifecycleHandlers() {
    this.child.on("error", (error) => this.finish(this.reject, error));
    // `close` is documented to fire only after the child's stdio streams
    // have closed, but that ordering guarantee is not airtight in practice —
    // Node has long-standing reports of a fast-exiting child's buffered
    // stdout being reported as fully consumed before every 'data' event for
    // it has actually been delivered (nodejs/node#9633, #7184, #4236).
    // Waiting on each stream's own `end` (or `error`, so a stream fault
    // can't hang this call forever) makes "every byte the child wrote before
    // exiting was read" an explicit, per-stream guarantee instead of an
    // inference from the child's own close event.
    this.child.stdout.on("end", () => this.markStreamDone("stdout"));
    this.child.stdout.on("error", () => this.markStreamDone("stdout"));
    this.child.stderr.on("end", () => this.markStreamDone("stderr"));
    this.child.stderr.on("error", () => this.markStreamDone("stderr"));
    this.child.on("close", (code, closeSignal) => {
      this.closeResult = { code, closeSignal };
      this.maybeFinalize();
    });
    // The leader may exit while a background descendant it spawned (and did
    // not wait on) is still running. `close` — which the handler above waits
    // for — doesn't fire until every process sharing the child's stdio pipes
    // exits, so a live straggler would otherwise hang this call forever.
    // `exit` fires as soon as the leader itself terminates, independent of
    // its descendants, which is what actually lets this reap them.
    this.child.on("exit", () => this.ensureGroupEmpty());
  }

  maybeFinalize() {
    if (!this.closeResult || !this.stdoutDone || !this.stderrDone || !this.stdinDone) return;
    // Await in-flight cleanup before settling so descendants cannot outlive the call.
    Promise.resolve(this.pendingCleanup).then(() => this.settleFromClose());
  }

  settleFromClose() {
    const { code, closeSignal } = this.closeResult;
    const { timeoutMs, killSignal, killGraceMs } = this.config;
    const stdout = decodeOutput(this.output.stdout);
    const stderr = decodeOutput(this.output.stderr);
    if (this.timedOut || this.aborted) {
      const error = new Error(
        this.timedOut
          ? `${this.file} did not exit within ${timeoutMs}ms (sent ${killSignal}, then SIGKILL after ${killGraceMs}ms grace)`
          : `${this.file} aborted via AbortSignal`,
      );
      error.code = this.timedOut ? "ETIMEDOUT" : "ABORT_ERR";
      if (this.aborted && !this.timedOut) error.name = "AbortError";
      error.killed = true;
      error.stdout = stdout;
      error.stderr = stderr;
      this.finish(this.reject, error);
      return;
    }
    if (this.maxBufferExceeded) {
      const error = new Error(`${this.file} exceeded maxBuffer on ${this.maxBufferExceeded}`);
      error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      error.stdout = stdout;
      error.stderr = stderr;
      this.finish(this.reject, error);
      return;
    }
    // A child that failed on its own (nonzero exit, no signal) keeps that as
    // the primary cause even when the EPIPE it caused was observed first; a
    // clean exit or the group termination failInput() sent is reported as the
    // undelivered prompt.
    const exitedWithOwnFailure = code !== 0 && closeSignal === null;
    if (this.inputFailed && !exitedWithOwnFailure) {
      const error = new Error(`${this.file} did not accept its full input: ${this.stdinError.message}`);
      error.code = this.stdinError.code ?? "ERR_CHILD_PROCESS_STDIN";
      error.cause = this.stdinError;
      error.stdout = stdout;
      error.stderr = stderr;
      this.finish(this.reject, error);
      return;
    }
    if (code !== 0 || closeSignal !== null) {
      const error = new Error(`Command failed: ${this.file} ${this.args.join(" ")}\n${stderr}`);
      error.code = code;
      error.signal = closeSignal;
      error.stdout = stdout;
      error.stderr = stderr;
      this.finish(this.reject, error);
      return;
    }
    this.finish(this.resolve, { stdout, stderr });
  }

  finish(fn, value) {
    if (this.settled) return;
    this.settled = true;
    this.clearKillTimer();
    fn(value);
  }

  armTerminationTriggers() {
    const { timeoutMs, signal } = this.config;
    if (timeoutMs && timeoutMs > 0) {
      this.killTimer = setTimeout(() => {
        if (this.hasTerminalCause()) return;
        this.timedOut = true;
        this.ensureGroupEmpty();
      }, timeoutMs);
    }
    if (signal) {
      const onAbort = () => {
        if (this.hasTerminalCause()) return;
        this.aborted = true;
        this.clearKillTimer();
        this.ensureGroupEmpty();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  }
}

export async function execFileWithInput(
  file,
  args,
  {
    input,
    timeoutMs,
    killSignal = "SIGTERM",
    killGraceMs = KILL_GRACE_MS_DEFAULT,
    signal,
    maxBuffer = MAX_BUFFER_DEFAULT,
    // Test seam only: lets a unit test drive the buffering/settle state machine
    // with a fake child (a controllable stream) so the maxBuffer-bounding and
    // maxBuffer-vs-abort-precedence contracts are asserted deterministically
    // instead of racing a real child's scheduling under load (issue #1532).
    // Production callers never pass this; it defaults to the real spawn().
    spawnImpl = spawn,
    ...options
  } = {},
) {
  // Ground Control and its CI run on Linux; fail closed when the supported
  // POSIX process-group termination contract is unavailable (issue #1518).
  if (!isPosixProcessGroupCapable()) {
    throw new Error(
      `execFileWithInput requires POSIX process-group support to bound ${file}'s subprocess tree; `
      + "this platform has no tested tree-termination equivalent (issue #1518)",
    );
  }
  return await new Promise((resolve, reject) => {
    new BufferedProcessExecution(file, args, {
      input,
      timeoutMs,
      killSignal,
      killGraceMs,
      signal,
      maxBuffer,
      spawnImpl,
      options,
    }, resolve, reject).start();
  });
}
