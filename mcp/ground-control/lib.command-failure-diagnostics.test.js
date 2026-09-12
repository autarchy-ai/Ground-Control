// Issue #1568: a killed architecture-preflight worker returned a message that
// held only the engine's startup banner and the start of the prompt. These
// tests pin the three surfaces that caused it — the failure formatter, the
// async-job message bound, and the working-tree mutation report.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_OUTPUT_TAIL_MAX,
  DIAGNOSTICS_MAX_LIST,
  DIAGNOSTICS_MAX_STRING,
  boundFailureDiagnostics,
  boundFailureMessage,
  formatCommandFailure,
  formatWorkingTreeMutation,
} from "./lib.js";

// The shape execFileWithInput rejects with when the wall cap fires: a banner
// and prompt echo at the head, the last thing the worker did at the tail.
function killedCodexError() {
  const banner = "OpenAI Codex v1.2.3\n--------\nworkdir: /repo\nUser instructions:\n";
  const filler = "x".repeat(40_000);
  const error = new Error(
    "codex did not exit within 1200000ms (sent SIGTERM, then SIGKILL after 5000ms grace)",
  );
  error.code = "ETIMEDOUT";
  error.killed = true;
  error.stdout = `${banner}${filler}\nexec bash -lc 'mkdocs build' in /repo`;
  error.stderr = "";
  return error;
}

describe("formatCommandFailure diagnostics (issue #1568)", () => {
  it("keeps the tail of a killed worker's stdout and its child-process state", () => {
    const formatted = formatCommandFailure("codex", killedCodexError());

    assert.match(formatted, /did not exit within 1200000ms/);
    assert.match(formatted, /state: code=ETIMEDOUT killed=true/);
    // The last thing the worker did survives; the startup banner does not.
    assert.match(formatted, /exec bash -lc 'mkdocs build' in \/repo/);
    assert.doesNotMatch(formatted, /OpenAI Codex v1\.2\.3/);
    assert.match(formatted, new RegExp(`stdout tail \\(last ${COMMAND_OUTPUT_TAIL_MAX} of \\d+ chars\\)`));
  });

  it("reports stdout even when stderr is non-empty", () => {
    const error = new Error("codex exited with 1");
    error.code = 1;
    error.stderr = "warning: ignoring unknown config key";
    error.stdout = "the trace that explains the failure";

    const formatted = formatCommandFailure("codex", error);

    assert.match(formatted, /stderr: warning: ignoring unknown config key/);
    assert.match(formatted, /stdout: the trace that explains the failure/);
  });

  it("still reports a missing binary without child-process noise", () => {
    const error = new Error("spawn codex ENOENT");
    error.code = "ENOENT";

    const formatted = formatCommandFailure("codex", error);

    assert.equal(formatted, "codex is not installed or not available on PATH");
  });
});

describe("boundFailureMessage (issue #1568)", () => {
  it("preserves both the failure statement and the trailing diagnostics", () => {
    const raw = `FAILURE HEADLINE${"m".repeat(10_000)}TRAILING DIAGNOSTICS`;

    const bounded = boundFailureMessage(raw, 600);

    assert.ok(bounded.length <= 600);
    assert.match(bounded, /^FAILURE HEADLINE/);
    assert.match(bounded, /TRAILING DIAGNOSTICS$/);
    assert.match(bounded, /…\[\d+ chars elided\]…/);
  });

  it("returns a message that already fits unchanged", () => {
    assert.equal(boundFailureMessage("short failure", 600), "short failure");
  });
});

describe("boundFailureDiagnostics (issue #1568)", () => {
  it("bounds scalars and string lists and drops non-whitelisted values", () => {
    const bounded = boundFailureDiagnostics({
      stage: "architecture_preflight",
      timed_out: true,
      changed_file_count: 5,
      changed_files: Array.from({ length: 100 }, (_, i) => `docs/f${i}.md`),
      long: "y".repeat(1000),
      nested: { secretish: "object graphs do not ride along" },
    });

    assert.equal(bounded.stage, "architecture_preflight");
    assert.equal(bounded.timed_out, true);
    assert.equal(bounded.changed_file_count, 5);
    assert.equal(bounded.changed_files.length, DIAGNOSTICS_MAX_LIST);
    assert.equal(bounded.long.length, DIAGNOSTICS_MAX_STRING);
    assert.ok(!("nested" in bounded));
  });

  it("returns null when there is nothing bounded to report", () => {
    assert.equal(boundFailureDiagnostics(null), null);
    assert.equal(boundFailureDiagnostics("not an object"), null);
    assert.equal(boundFailureDiagnostics({ nested: {} }), null);
  });
});

describe("formatWorkingTreeMutation (issue #1568)", () => {
  it("names the paths a failed run left in the checkout", () => {
    const rendered = formatWorkingTreeMutation({
      changed_files: ["docs/architecture/index.md", "mkdocs.yml"],
      changed_file_count: 3,
    });

    assert.match(rendered, /left 3 changed path\(s\)/);
    assert.match(rendered, /docs\/architecture\/index\.md, mkdocs\.yml/);
    assert.match(rendered, /\(\+1 more\)/);
  });

  it("distinguishes a clean tree from an unscannable one", () => {
    assert.equal(
      formatWorkingTreeMutation({ changed_files: [], changed_file_count: 0 }),
      "working tree unchanged by the failed run",
    );
    assert.match(
      formatWorkingTreeMutation({ working_tree_scan_error: "not a git repository" }),
      /^working tree not scanned after failure: not a git repository$/,
    );
  });
});
