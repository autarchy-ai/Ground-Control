// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parsePhaseMarkers, runCodexReview, runCodexReviewCycle } from "./lib.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

// The full set of keys `review_coverage` publishes. Asserting the exact shape
// at every public surface is the structural gate for a whole class of bug: a
// field computed deep in the pipeline but never wired through to the caller
// (issue #1414 test-quality cycle 1). A new field added without propagation
// fails here rather than silently reading as absent.
const REVIEW_COVERAGE_KEYS = [
  "chunks_completed",
  "chunks_total",
  "complete",
  "files_covered",
  "files_total",
  "oversized_slices",
  "strategy",
  "unreviewed_untracked_paths",
];

async function withShimPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

// ---------------------------------------------------------------------------
// Sliced review of an over-cap diff (issue #1414)
// ---------------------------------------------------------------------------
//
// These exercise the real byte cap end to end: the fixture repo's uncommitted
// diff genuinely exceeds getDefaultCodexReviewMaxDiffBytes(), so the runner
// takes the manifest path without any seam being poked. The codex shim records
// every prompt it is given, which is what lets these assert the property the
// issue is about — that the server supplied the diff rather than trusting the
// reviewer to fetch it.

describe("runCodexReview slices an over-cap diff (#1414, hermetic codex+gh shims)", () => {
  // Three files, each comfortably under the 256 KiB cap on its own but
  // pairwise over it, so the plan is deterministically one file per slice.
  const FILE_BYTES = 200_000;

  function makeOverCapRepo({ codexTails, ghPostFails = false, codexExitCode = 0 }) {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-slice-repo-"));
    execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", "1414-slices"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
    writeFileSync(join(repoDir, "README"), "x\n");
    execFileSync("git", ["-C", repoDir, "add", "README"]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
    // An integration base to diff against (#1694), and a real origin so owner/repo resolves (git ignores GH_REPO).
    execFileSync("git", ["-C", repoDir, "update-ref", "refs/heads/dev", "HEAD"]);
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);

    for (const name of ["alpha.txt", "beta.txt", "gamma.txt"]) {
      const marker = name.replace(".txt", "");
      const line = `${marker}-payload-`;
      const body = `${line.repeat(Math.ceil(FILE_BYTES / line.length))}\n`.slice(0, FILE_BYTES);
      writeFileSync(join(repoDir, name), `${marker}-sentinel\n${body}\n`);
    }
    execFileSync("git", ["-C", repoDir, "add", "-A"]);
    // Deliberately left untracked: the review must report it as NOT covered
    // rather than transmitting it or silently ignoring it.
    writeFileSync(join(repoDir, "local-scratch.txt"), "unstaged local note\n");

    const binDir = mkdtempSync(join(tmpdir(), "gc-slice-bin-"));
    const promptDir = mkdtempSync(join(tmpdir(), "gc-slice-prompts-"));
    const ghStatePath = join(binDir, "gh-state.json");
    writeFileSync(ghStatePath, JSON.stringify({ posts: [] }));

    const ghShim = `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = ${JSON.stringify(ghStatePath)};
const argv = process.argv.slice(2);
const match = (p) => p.every((x, i) => argv[i] === x);
if (match(["repo", "view", "--json", "nameWithOwner"])) {
  process.stdout.write(JSON.stringify({ nameWithOwner: "fake/repo" }));
  process.exit(0);
}
if (match(["api", "--method", "GET", "--paginate", "--slurp"])) {
  process.stdout.write(JSON.stringify([[]]));
  process.exit(0);
}
if (match(["api", "--method", "POST"])) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.posts.push(argv.slice(0, 6).join(" "));
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (${ghPostFails ? "true" : "false"}) {
    process.stderr.write("HTTP 500\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ id: 999, html_url: "https://example.test/c/999" }));
  process.exit(0);
}
process.stderr.write("gh shim: unhandled argv: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
    writeFileSync(join(binDir, "gh"), ghShim, { mode: 0o755 });

    // The codex shim records the prompt it received and returns the next
    // canned tail. Recording the prompts is the point: it is how these tests
    // prove the reviewer was handed real diff content.
    const codexCfgPath = join(binDir, "codex-config.json");
    writeFileSync(codexCfgPath, JSON.stringify({ tails: codexTails, promptDir, exitCode: codexExitCode }));
    const codexShim = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(codexCfgPath)}, "utf8"));
const args = process.argv.slice(2);
let outputPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output-last-message") outputPath = args[i + 1];
}
let stdinBuf = "";
process.stdin.on("data", (c) => { stdinBuf += c.toString(); });
process.stdin.on("end", () => {
  const n = fs.readdirSync(cfg.promptDir).length;
  fs.writeFileSync(path.join(cfg.promptDir, "prompt-" + String(n).padStart(3, "0") + ".txt"), stdinBuf);
  const tail = cfg.tails[Math.min(n, cfg.tails.length - 1)];
  if (cfg.exitCode !== 0) {
    process.stderr.write("codex shim: simulated engine failure\\n");
    process.exit(cfg.exitCode);
  }
  if (outputPath) fs.writeFileSync(outputPath, tail);
  process.stdout.write(tail);
  process.exit(0);
});
`;
    writeFileSync(join(binDir, "codex"), codexShim, { mode: 0o755 });

    return {
      repoDir,
      binDir,
      promptDir,
      prompts: () =>
        readdirSync(promptDir)
          .sort()
          .map((f) => readFileSync(join(promptDir, f), "utf8")),
      posts: () => JSON.parse(readFileSync(ghStatePath, "utf8")).posts,
      cleanup() {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
        rmSync(promptDir, { recursive: true, force: true });
      },
    };
  }

  async function withShimPath(binDir, fn) {
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = oldPath;
    }
  }

  const cleanTail = (read) =>
    "===REVIEW===\n" +
    JSON.stringify({ verdict: "ship", architectural_read: read, blocking: [] }) +
    "\n===END===\n";

  const findingTail = (read, path, line, title) =>
    "===REVIEW===\n" +
    JSON.stringify({
      verdict: "ship-with-fixes",
      architectural_read: read,
      blocking: [
        {
          path,
          line,
          title,
          body: "detail",
          classification: "one-off",
          sweep_evidence: "swept the slice",
        },
      ],
    }) +
    "\n===END===\n";

  it("supplies every slice to both reviewers instead of asking them to fetch diffs", async () => {
    const shim = makeOverCapRepo({ codexTails: [cleanTail("Reviewed this slice.")] });
    try {
      await withShimPath(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
          issueNumber: 1414,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });

        assert.equal(result.ok, true);
        assert.equal(result.diff_mode, "manifest");
        assert.equal(result.review_coverage.complete, true);
        assert.equal(result.review_coverage.chunks_total, 3);
        assert.equal(result.review_coverage.chunks_completed, 3);
        assert.equal(result.review_coverage.files_total, 3);
        assert.equal(result.review_coverage.files_covered, 3);
        assert.equal(result.review_coverage.strategy, "file-slices");
        assert.equal(result.review_coverage.oversized_slices, 0);
        // The whole published shape is pinned at the caller-facing surface, so
        // a field that stops being wired through fails here (issue #1414
        // test-quality cycle 1).
        assert.deepEqual(Object.keys(result.review_coverage).sort(), REVIEW_COVERAGE_KEYS);
        // The untracked working-tree file is reported to the caller as
        // unreviewed, and its body never reaches a reviewer prompt.
        assert.deepEqual(result.review_coverage.unreviewed_untracked_paths, ["local-scratch.txt"]);
        assert.equal(result.next_action, "proceed_clean");
        assert.deepEqual(result.parse_errors, []);

        // One codex run per slice per reviewer — 3 slices x (core + security).
        const prompts = shim.prompts();
        assert.equal(prompts.length, 6);

        for (const prompt of prompts) {
          // Every prompt carries real diff content, and none delegates
          // retrieval back to the reviewer — that delegation is the defect.
          assert.ok(prompt.includes("<<<DIFF\n"), "slice prompt has no inline diff");
          assert.ok(prompt.includes("diff --git a/"), "slice prompt has no diff header");
          assert.ok(prompt.includes("do not re-derive it from git yourself"));
          assert.ok(!prompt.includes("your shell tool"));
          assert.ok(!prompt.includes("git show HEAD -- <path>"));
        }
        // Union of the slices covers every changed file exactly once per
        // reviewer: no file is dropped and none is reviewed twice.
        for (const sentinel of ["alpha-sentinel", "beta-sentinel", "gamma-sentinel"]) {
          const hits = prompts.filter((p) => p.includes(`+${sentinel}`)).length;
          assert.equal(hits, 2, `${sentinel} reached ${hits} prompts, expected 2`);
        }
      });
    } finally {
      shim.cleanup();
    }
  });

  it("unions findings across slices and records coverage in the durable findings comment", async () => {
    const shim = makeOverCapRepo({
      codexTails: [
        findingTail("Slice one read.", "alpha.txt", 1, "Alpha problem"),
        cleanTail("Slice two read."),
        findingTail("Slice three read.", "gamma.txt", 1, "Gamma problem"),
        cleanTail("Security slice one read."),
        cleanTail("Security slice two read."),
        cleanTail("Security slice three read."),
      ],
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
          issueNumber: 1414,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });

        assert.equal(result.ok, true);
        // A clean slice never masks a finding-bearing one.
        assert.equal(result.finding_count, 2);
        const titles = result.comments.map((c) => c.title).sort();
        assert.deepEqual(titles, ["[core] Alpha problem", "[core] Gamma problem"]);
        assert.notEqual(result.next_action, "proceed_clean");
        // Each slice's read is attributed, so the decision record shows all
        // three rather than only whichever slice happened to run last.
        assert.match(result.architectural_read, /Slice 1\/3/);
        assert.match(result.architectural_read, /Slice 3\/3/);
        assert.match(result.architectural_read, /Slice one read\./);
        assert.match(result.architectural_read, /Security slice two read\./);
        assert.ok(result.findings_comment_url);
        assert.equal(result.review_coverage.complete, true);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("fails closed without writing any durable record when a slice produces no valid envelope", async () => {
    const shim = makeOverCapRepo({
      codexTails: [
        cleanTail("Slice one read."),
        "no structured tail here at all\n",
        cleanTail("Slice three read."),
      ],
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
          issueNumber: 1414,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });

        assert.equal(result.ok, false);
        assert.equal(result.error, "review_coverage_incomplete");
        assert.equal(result.next_action, "retry_review_after_resolving_coverage_failure");
        assert.equal(result.diff_mode, "manifest");
        assert.equal(result.review_coverage.complete, false);
        assert.ok(result.review_coverage.chunks_completed < result.review_coverage.chunks_total);
        assert.ok(result.parse_errors.length > 0);
        assert.ok(result.parse_errors.some((e) => typeof e.slice === "string"));
        // The cycle is NOT consumed and nothing durable was published, so a
        // retry is free — the failure cannot be laundered into a clean pass.
        assert.equal(result.cycle, null);
        assert.deepEqual(shim.posts(), []);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("propagates diff mode and coverage through the compact cycle envelope", async () => {
    // The compact envelope is the orchestrator's contract — surfacing the
    // signal only on the direct result would leave /implement blind, which is
    // the observability half of #1414.
    //
    // Finding-bearing on purpose. This fixture keeps an unreviewed untracked file
    // in the repository, and issue #1679 refuses to publish a *clean* cycle in
    // that state: a zero-finding publication authorizes its candidate tree for
    // delivery, and that tree would carry a file the reviewed diff never
    // contained. A finding-bearing cycle authorizes no tree, so it publishes and
    // still reports the same coverage, which is what this test is about.
    const shim = makeOverCapRepo({
      codexTails: [findingTail("Reviewed this slice.", "alpha.txt", 1, "Alpha problem")],
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const result = await runCodexReviewCycle({
          repoPath: shim.repoDir,
          issueNumber: 1414,
          uncommitted: true,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, true);
        assert.equal(result.status, "findings");
        assert.equal(result.diff_mode, "manifest");
        assert.equal(result.review_coverage.chunks_total, 3);
        assert.equal(result.review_coverage.chunks_completed, 3);
        assert.equal(result.review_coverage.complete, true);
        // Same shape gate on the compact envelope: the orchestrator contract
        // must not quietly lose a coverage field either.
        assert.deepEqual(Object.keys(result.review_coverage).sort(), REVIEW_COVERAGE_KEYS);
        assert.deepEqual(result.review_coverage.unreviewed_untracked_paths, ["local-scratch.txt"]);
        assert.equal(result.review_coverage.oversized_slices, 0);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("retains an exhausted sliced review without a cycle or GitHub write", async () => {
    const shim = makeOverCapRepo({
      codexTails: [cleanTail("Slice one read."), "no structured tail\n"],
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const result = await runCodexReviewCycle({
          repoPath: shim.repoDir,
          issueNumber: 1414,
          uncommitted: true,
          publicationMode: "deferred",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, false);
        assert.equal(result.error, "review_station_unobserved");
        assert.equal(result.publication_status, "unpublished_failure");
        assert.deepEqual(result.failure_causes, ["missing_tail"]);
        assert.equal(result.diff_mode, "manifest");
        // No decision record either — the cycle wrapper must not paper over a
        // review that never covered the diff.
        assert.deepEqual(shim.posts(), []);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("turns a slice engine failure into the structured coverage envelope, not an exception", async () => {
    // A dead codex child is a review boundary failure. It must reach the caller
    // as the same no-write, no-cycle-consumed envelope an unparseable tail
    // produces, rather than escaping as an untyped throw the cycle wrapper
    // never sees.
    const shim = makeOverCapRepo({ codexTails: [cleanTail("Slice one read.")], codexExitCode: 1 });
    try {
      await withShimPath(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
          issueNumber: 1414,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, false);
        assert.equal(result.error, "review_coverage_incomplete");
        assert.equal(result.next_action, "retry_review_after_resolving_coverage_failure");
        assert.equal(result.review_coverage.complete, false);
        assert.ok(result.parse_errors.some((e) => /codex execution failed/.test(e.error)));
        assert.equal(result.cycle, null);
        assert.deepEqual(shim.posts(), []);
        // The failing reviewer stops launching further slices instead of
        // burning the remaining codex runs on a review already known to be
        // incomplete: 1 failed core slice + 3 security slices.
        assert.ok(shim.prompts().length < 6, `expected an early stop, saw ${shim.prompts().length}`);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("surfaces an oversized slice at the caller-facing result, not only in the planner", async () => {
    // One indivisible line bigger than the whole budget: the slice cannot be
    // bounded, and "no silent caps" means the caller has to be able to see it.
    const shim = makeOverCapRepo({ codexTails: [cleanTail("Reviewed.")] });
    try {
      writeFileSync(join(shim.repoDir, "minified.js"), `${"z".repeat(300_000)}\n`);
      execFileSync("git", ["-C", shim.repoDir, "add", "minified.js"]);

      await withShimPath(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
          issueNumber: 1414,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, true);
        assert.equal(result.diff_mode, "manifest");
        assert.ok(
          result.review_coverage.oversized_slices >= 1,
          `expected an oversized slice, saw ${result.review_coverage.oversized_slices}`,
        );
        assert.equal(result.review_coverage.complete, true);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("keeps the review a single logical cycle regardless of slice count", async () => {
    const shim = makeOverCapRepo({ codexTails: [cleanTail("Reviewed this slice.")] });
    try {
      await withShimPath(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
          issueNumber: 1414,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.cycle, 1);
        assert.equal(result.review_coverage.chunks_total, 3);
        // One findings record + one cycle marker — never one per slice.
        assert.equal(shim.posts().length, 2);
      });
    } finally {
      shim.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Workflow phase markers (#794 MVP-2)
// ---------------------------------------------------------------------------

describe("parsePhaseMarkers", () => {
  it("returns an empty Set when no comments contain markers", () => {
    const phases = parsePhaseMarkers(["random", "comments", "here"], 791);
    assert.ok(phases instanceof Set);
    assert.equal(phases.size, 0);
  });

  it("collects each phase recorded for the matching issue", () => {
    const bodies = [
      '<!-- gc:phase phase="preflight" issue="791" -->\n_preflight done._',
      "unrelated comment",
      '<!-- gc:phase phase="plan" issue="791" -->',
    ];
    const phases = parsePhaseMarkers(bodies, 791);
    assert.deepEqual([...phases].sort(), ["plan", "preflight"]);
  });

  it("ignores markers for other issues", () => {
    const bodies = [
      '<!-- gc:phase phase="preflight" issue="791" -->',
      '<!-- gc:phase phase="plan" issue="100" -->',
    ];
    const phases = parsePhaseMarkers(bodies, 791);
    assert.deepEqual([...phases], ["preflight"]);
  });

  it("treats duplicates as a single set entry", () => {
    const bodies = [
      '<!-- gc:phase phase="preflight" issue="50" -->',
      'redundant: <!-- gc:phase phase="preflight" issue="50" -->',
    ];
    assert.equal(parsePhaseMarkers(bodies, 50).size, 1);
  });

  it("tolerates non-string entries and non-array input", () => {
    assert.equal(parsePhaseMarkers(["a", 42, null, undefined], 1).size, 0);
    assert.equal(parsePhaseMarkers(null, 1).size, 0);
    assert.equal(parsePhaseMarkers("not an array", 1).size, 0);
  });
});
