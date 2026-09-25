// Server-owned deadlines for the commands the MCP server runs while it holds a
// lock or lease (issue #1720).
//
// The mechanical publish path holds a per-worktree mutation lease and the
// integration manager holds the repository integration lock while they run
// fixed Git/GitHub argv and the repository's gate shell. A hung transport or gate
// used to hold that lease forever, and a caller's polling deadline never stopped
// the child. These wrappers put every such call on a finite deadline and on the
// process-group lifecycle that reaps the whole tree:
//
//   - execFileBounded: fixed argv with buffered output, through the
//     single-settlement execFileWithInput lifecycle (issues #1518, #1719).
//   - runBoundedGateCommand: a repository gate shell, through the streaming
//     runGateCommand, which keeps only a bounded output tail (issue #1501).
//
// The deadlines are host configuration, read per call like GC_CODEX_TIMEOUT_MS
// (issue #1521). They are not MCP inputs or .ground-control.yaml keys: a
// repository chooses what its gate runs, never whether the server may stop it.

import { execFileWithInput } from "./model-subprocess.js";
import { runGateCommand } from "./gate-command-runner.js";
import { parseBoundedTimeoutMs } from "./timeout-bounds.js";

export { parseBoundedTimeoutMs };

// Fetch, push, and GitHub API calls; generous for a large repository on a slow link.
export const COMMAND_TIMEOUT_BOUNDS = Object.freeze({ min: 1000, max: 3_600_000, default: 600_000 });
// pre-commit and completion gates, which can run a full test suite.
export const GATE_TIMEOUT_BOUNDS = Object.freeze({ min: 1000, max: 10_800_000, default: 1_800_000 });

export function getCommandTimeoutMs() {
  return parseBoundedTimeoutMs(process.env.GC_COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_BOUNDS);
}

export function getGateTimeoutMs() {
  return parseBoundedTimeoutMs(process.env.GC_GATE_TIMEOUT_MS, GATE_TIMEOUT_BOUNDS);
}

// execFile-compatible: resolves {stdout, stderr}; rejects with code/signal/stdout/stderr.
export async function execFileBounded(file, args, options = {}) {
  return execFileWithInput(file, args, { ...options, timeoutMs: getCommandTimeoutMs() });
}

export async function runBoundedGateCommand(file, args, options = {}) {
  return runGateCommand(file, args, { ...options, timeoutMs: getGateTimeoutMs() });
}
