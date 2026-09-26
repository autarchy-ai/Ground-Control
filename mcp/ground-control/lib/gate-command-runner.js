// A size-safe runner for the repository gate commands (completion, policy, and
// pre-commit) that the implement/quickfix workflow runs on a checkout (issue
// #1501).
//
// Those gates are invoked through the same execFile-shaped seam the git calls
// use, which means Node's `child_process.execFile` and its 1 MiB `maxBuffer`
// default. A gate command's console output is not a bounded value like a git
// SHA: a full test suite's stdout on a large merged tree routinely exceeds a
// megabyte. execFile treats that overflow as fatal — it kills the child and
// rejects with ERR_CHILD_PROCESS_STDIO_MAXBUFFER *before* the child exits — so
// the gate's own pass/fail exit status is never observed and the completion
// boundary can never be satisfied. The failure is output-size driven, so a
// retry re-hits it deterministically.
//
// The gate boundary only needs the exit status; the full transcript is
// discarded on success. This runner therefore streams stdout/stderr and keeps
// only a bounded tail for a failure diagnostic, so it never holds the whole
// transcript in memory and never overflows regardless of how verbose the gate
// command is. Its resolve/reject shape mirrors execFile (`{stdout, stderr}` on
// success; an Error carrying `code`, `signal`, `stdout`, and `stderr` on a
// non-zero exit or a terminating signal) so it is a drop-in substitute at the
// existing call sites and the shared failure formatters keep working.
//
// A gate runs while its caller holds a lock or lease, so it also has a required
// finite deadline (issue #1720). At the deadline the whole process group is
// terminated through the same reaping path a leader exit uses, and the call
// rejects with `code: "ETIMEDOUT"` once the group is confirmed empty.

import { spawn } from "node:child_process";
import { isPosixProcessGroupCapable, isProcessGroupAlive, terminateProcessGroup } from "./process-group.js";

// 64 KiB per stream is far more than a failure diagnostic needs while staying a
// hard ceiling on retained memory. A test suite's actionable failure output
// lives at the tail, which is exactly what is kept.
const GATE_TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS_DEFAULT = 5000;

// Retains only the last `limitBytes` of everything pushed. Concatenating then
// slicing on each chunk keeps the live buffer at or below the cap; a truncated
// leading multibyte character can only ever land in a diagnostic tail, never in
// the exit status the boundary actually reads.
function boundedTail(limitBytes) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      const combined = Buffer.concat([buffer, chunk]);
      buffer = combined.length > limitBytes ? combined.subarray(combined.length - limitBytes) : combined;
    },
    toString() {
      return buffer.toString("utf8");
    },
  };
}

// The execFile-shaped rejection for a finished gate, or null when it passed. A
// deadline kill is its own cause, whatever status the reaped leader reported.
function gateFailure(file, args, { code, closeSignal, timeout }, { stdout, stderr }) {
  let error = null;
  if (timeout) {
    error = new Error(`${file} did not exit within ${timeout.timeoutMs}ms `
      + `(sent ${timeout.killSignal}, then SIGKILL after ${timeout.killGraceMs}ms grace)`);
    error.code = "ETIMEDOUT";
    error.killed = true;
  } else if (code !== 0 || closeSignal != null) {
    error = new Error(`Command failed: ${file} ${args.join(" ")}\n${stderr}`);
    error.code = code ?? undefined;
    error.signal = closeSignal ?? undefined;
  }
  if (error) Object.assign(error, { stdout, stderr });
  return error;
}

function requireTimeoutMs(timeoutMs) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("runGateCommand requires a finite positive timeoutMs");
  }
  return timeoutMs;
}

export async function runGateCommand(file, args, options = {}) {
  // onActivity is a progress hook, not a spawn option: pull it out so spawn only
  // ever sees real child_process options. It fires on every drained chunk so a
  // caller can prove the child is still producing output — the signal that tells
  // a slow-but-healthy sweep from a dead job (issue #1497).
  const {
    onActivity,
    killSignal = "SIGTERM",
    killGraceMs = KILL_GRACE_MS_DEFAULT,
    timeoutMs: rawTimeoutMs,
    // Test seam only, like execFileWithInput's spawnImpl: production uses the real primitive.
    terminateGroup = terminateProcessGroup,
    ...spawnOptions
  } = options;
  const timeoutMs = requireTimeoutMs(rawTimeoutMs);
  // Run the gate as its own process-group leader and reap the group when the
  // leader exits. A gate that spawns a background descendant and returns would
  // otherwise leave that descendant holding the stdout pipe, so `close` never
  // fires and the runner hangs forever after every visible child has exited —
  // the original publish-hang failure mode (issue #1495). Reaping an already-empty
  // group is a no-op, so a well-behaved gate is unaffected. There is no tested
  // tree-termination equivalent off POSIX, so a bounded gate fails closed there.
  if (!isPosixProcessGroupCapable()) {
    throw new Error(`runGateCommand requires POSIX process-group support to bound ${file}'s process tree`);
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    let pendingCleanup = null;
    let timedOut = false;
    let leaderExited = false;
    const child = spawn(file, args, { ...spawnOptions, detached: true });
    const stdoutTail = boundedTail(GATE_TAIL_BYTES);
    const stderrTail = boundedTail(GATE_TAIL_BYTES);

    const reapGroup = () => {
      if (!child.pid || !isProcessGroupAlive(child.pid)) return Promise.resolve();
      if (pendingCleanup) return pendingCleanup;
      // A group that outlived SIGKILL settles the call as that failure at once: the
      // surviving descendant may hold the pipes, so `close` might never fire.
      pendingCleanup = terminateGroup(child.pid, { killSignal, killGraceMs, label: file })
        .catch((error) => finish(reject, error));
      return pendingCleanup;
    };
    // A leader that already exited is reported on its own status; any straggler
    // it left is being reaped by the exit handler below.
    const deadline = setTimeout(() => {
      if (leaderExited) return;
      timedOut = true;
      reapGroup();
    }, timeoutMs);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };

    // Draining both pipes as data arrives is also what prevents the child from
    // blocking on a full OS pipe buffer once its output passes ~64 KiB — the
    // failure mode a "discard the output" runner that stopped reading would
    // reintroduce.
    child.stdout.on("data", (chunk) => {
      stdoutTail.push(chunk);
      if (typeof onActivity === "function") onActivity("stdout", chunk.length);
    });
    child.stderr.on("data", (chunk) => {
      stderrTail.push(chunk);
      if (typeof onActivity === "function") onActivity("stderr", chunk.length);
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code, closeSignal) => {
      // Await any in-flight group cleanup so a straggler descendant is confirmed
      // gone before the caller sees a terminal result.
      Promise.resolve(pendingCleanup).then(() => {
        const output = { stdout: stdoutTail.toString(), stderr: stderrTail.toString() };
        const timeout = timedOut ? { timeoutMs, killSignal, killGraceMs } : null;
        const error = gateFailure(file, args, { code, closeSignal, timeout }, output);
        if (error) finish(reject, error);
        else finish(resolve, output);
      });
    });
    // Reap the group when the leader exits so a lingering descendant cannot keep
    // `close` from firing. On a clean exit the group is already empty, so this is
    // a no-op.
    child.on("exit", () => {
      leaderExited = true;
      reapGroup();
    });
  });
}
