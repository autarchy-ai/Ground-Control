// Bounded, tail-anchored diagnostics for a failed or killed subprocess
// (issue #1568).
//
// A codex/claude worker killed at the wall-clock cap has usually produced tens
// of thousands of characters of trace. The characters that say what it was
// doing when it died are at the END of that stream; the characters at the
// START are the engine's startup banner and its echo of the prompt. Every
// bound here is therefore tail-anchored or head-and-tail preserving: a
// head-only cap is structurally guaranteed to keep only the least informative
// output a long run produced, which is the failure issue #1568 reports.

export const COMMAND_OUTPUT_TAIL_MAX = 1000;
export const FAILURE_MESSAGE_MAX = 3000;
// The head states what failed; the tail carries the diagnostics. Weighted
// toward the tail because the head is a single known sentence.
const FAILURE_MESSAGE_HEAD_SHARE = 0.4;

export const DIAGNOSTICS_MAX_KEYS = 12;
export const DIAGNOSTICS_MAX_LIST = 25;
export const DIAGNOSTICS_MAX_STRING = 200;

// Returns null for absent/blank output, otherwise the last `limit` characters
// plus the accounting a reader needs to know what was dropped.
export function boundedOutputTail(text, limit = COMMAND_OUTPUT_TAIL_MAX) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.length <= limit) {
    return { text: trimmed, elided: 0, total: trimmed.length };
  }
  return {
    text: trimmed.slice(trimmed.length - limit),
    elided: trimmed.length - limit,
    total: trimmed.length,
  };
}

export function formatOutputTail(label, tail) {
  if (tail == null) return null;
  if (tail.elided === 0) return `${label}: ${tail.text}`;
  return `${label} tail (last ${tail.text.length} of ${tail.total} chars): ${tail.text}`;
}

// The child's own terminal state, independent of anything it printed.
// `killed`/`ETIMEDOUT` is what separates "the wall cap fired" from "the
// command ran to completion and exited non-zero" — a distinction the message
// text alone does not always carry.
export function describeChildProcessState(error) {
  const parts = [];
  if (error?.code !== undefined && error?.code !== null) parts.push(`code=${error.code}`);
  if (error?.signal) parts.push(`signal=${error.signal}`);
  if (error?.killed) parts.push("killed=true");
  return parts.length > 0 ? `state: ${parts.join(" ")}` : null;
}

// Bound a failure message without destroying either end. A head-only slice
// keeps the "what failed" sentence and drops every diagnostic appended after
// it; this keeps both.
export function boundFailureMessage(raw, limit = FAILURE_MESSAGE_MAX) {
  if (typeof raw !== "string" || raw.length <= limit) return raw;
  // Two passes: the marker's own length depends on the elided count, which
  // depends on the marker's length. Pass one sizes the marker from its upper
  // bound (nothing kept) so the result can never exceed `limit`; pass two
  // states the true count.
  const budget = Math.max(limit - `…[${raw.length} chars elided]…`.length, 0);
  const head = Math.floor(budget * FAILURE_MESSAGE_HEAD_SHARE);
  const tail = budget - head;
  const marker = `…[${raw.length - budget} chars elided]…`;
  return `${raw.slice(0, head)}${marker}${raw.slice(raw.length - tail)}`;
}

function boundDiagnosticValue(value) {
  if (typeof value === "string") return value.slice(0, DIAGNOSTICS_MAX_STRING);
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value
      .slice(0, DIAGNOSTICS_MAX_LIST)
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.slice(0, DIAGNOSTICS_MAX_STRING));
  }
  return undefined;
}

// Closed whitelist, the same philosophy as the running-job progress snapshot
// (issue #1497): only bounded scalars and bounded string lists survive, so a
// failed-job envelope can never carry unbounded child output or an arbitrary
// object graph.
export function boundFailureDiagnostics(diagnostics) {
  if (diagnostics == null || typeof diagnostics !== "object" || Array.isArray(diagnostics)) {
    return null;
  }
  const bounded = {};
  for (const key of Object.keys(diagnostics).slice(0, DIAGNOSTICS_MAX_KEYS)) {
    const value = boundDiagnosticValue(diagnostics[key]);
    if (value !== undefined) bounded[key] = value;
  }
  return Object.keys(bounded).length > 0 ? bounded : null;
}

// Render the working-tree mutation an engine run left behind. A run that dies
// at the wall cap has usually already written to the checkout, and a failure
// that says only "failed" lets the next attempt build silently on that partial
// output (issue #1568).
export function formatWorkingTreeMutation(mutation) {
  if (mutation?.working_tree_scan_error) {
    return `working tree not scanned after failure: ${mutation.working_tree_scan_error}`;
  }
  const count = mutation?.changed_file_count ?? 0;
  if (count === 0) return "working tree unchanged by the failed run";
  const shown = mutation.changed_files ?? [];
  const more = count > shown.length ? ` (+${count - shown.length} more)` : "";
  return `the failed run left ${count} changed path(s) in the working tree: ${shown.join(", ")}${more}`;
}
