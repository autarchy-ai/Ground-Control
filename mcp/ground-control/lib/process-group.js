// Process-group containment for long-running model subprocesses (issue #1518).
//
// POSIX-only: Ground Control and its CI run on Linux. There is no tested
// Windows tree-termination equivalent, so a caller that needs bounded
// containment must fail closed on other platforms rather than silently
// degrade to signalling only the direct child.

export function isPosixProcessGroupCapable() {
  return process.platform !== "win32";
}

export function isProcessGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

export function signalProcessGroup(pgid, sig) {
  try {
    process.kill(-pgid, sig);
    return { ok: true };
  } catch (error) {
    if (error.code === "ESRCH") return { ok: true };
    return { ok: false, error };
  }
}

const TERMINATE_POLL_INTERVAL_MS = 20;
// Bounded: SIGKILL cannot be blocked, only delayed by the kernel reaping the group.
const POST_SIGKILL_CONFIRM_MS = 2000;

// Escalate `killSignal` (default SIGTERM) then SIGKILL against process group
// `pgid`, resolving only once the group is empty. A descendant that survives even
// SIGKILL for the bounded post-kill confirmation window rejects the promise with
// `code: "ERR_PROCESS_GROUP_SURVIVED"`: callers hold locks and leases, so an
// unconfirmed cleanup must surface as a failure, never as a settled call (issue
// #1720). `isAlive` and `signalGroup` are test seams for that branch. Polling
// beats a single fixed delay: most signalled processes die well inside the grace
// window, and death is never instantaneous with the signal call returning, so a
// one-shot check-then-settle races both ways. A no-op re-signal on an empty group
// is safe, so this is the single escalation both the buffered model-subprocess
// runner and the streaming gate runner share (issue #1495).
export function terminateProcessGroup(pgid, {
  killSignal = "SIGTERM",
  killGraceMs = 5000,
  label = "process",
  isAlive = isProcessGroupAlive,
  signalGroup = signalProcessGroup,
} = {}) {
  if (!pgid || !isAlive(pgid)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    signalGroup(pgid, killSignal);
    const termDeadline = Date.now() + killGraceMs;
    let killSent = false;
    let killDeadline = null;
    const poll = () => {
      if (!isAlive(pgid)) {
        resolve();
        return;
      }
      const now = Date.now();
      if (!killSent && now >= termDeadline) {
        signalGroup(pgid, "SIGKILL");
        killSent = true;
        killDeadline = now + POST_SIGKILL_CONFIRM_MS;
      } else if (killSent && now >= killDeadline) {
        const error = new Error(`${label}'s process group survived SIGKILL (pgid ${pgid})`);
        error.code = "ERR_PROCESS_GROUP_SURVIVED";
        reject(error);
        return;
      }
      setTimeout(poll, TERMINATE_POLL_INTERVAL_MS);
    };
    setTimeout(poll, TERMINATE_POLL_INTERVAL_MS);
  });
}
