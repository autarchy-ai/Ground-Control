// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReviewCoverage, planReviewSlices } from "./lib.js";

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

// Issue #1414: above the byte cap the server slices the authoritative diff and
// reviews every slice, instead of handing the reviewer a manifest and trusting
// it to fetch per-file diffs itself.
describe("planReviewSlices", () => {
  function fileDiff(path, lines, { prefix = "+" } = {}) {
    return [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${lines.length} +1,${lines.length} @@`,
      ...lines.map((l) => `${prefix}${l}`),
      "",
    ].join("\n");
  }

  it("returns a single slice when the diff fits the budget", () => {
    const diffText = fileDiff("Foo.java", ["a", "b"]);
    const plan = planReviewSlices({ diffText, maxBytes: 64 * 1024 });
    assert.equal(plan.slices.length, 1);
    assert.equal(plan.slices[0], diffText);
    assert.equal(plan.strategy, "whole-diff");
    assert.equal(plan.files_total, 1);
    assert.equal(plan.files_covered, 1);
  });

  it("reserves the reviewer prompt overhead before accepting a whole-diff slice", () => {
    const a = fileDiff("A.js", ["a".repeat(200)]);
    const b = fileDiff("B.js", ["b".repeat(200)]);
    const diffText = a + b;
    const maxBytes = Buffer.byteLength(diffText, "utf8") + 1;
    const promptOverheadBytes = Buffer.byteLength(a, "utf8") + 1;
    const plan = planReviewSlices({ diffText, maxBytes, promptOverheadBytes });
    assert.equal(plan.slices.length, 2);
    assert.equal(plan.slices.join(""), diffText);
    assert.ok(plan.slices.every((slice) =>
      Buffer.byteLength(slice, "utf8") + promptOverheadBytes <= maxBytes));
  });

  it("returns a single slice when the byte cap is disabled", () => {
    const diffText = fileDiff("Big.java", Array.from({ length: 500 }, (_, i) => `line ${i}`));
    const plan = planReviewSlices({ diffText, maxBytes: 0 });
    assert.equal(plan.slices.length, 1);
    assert.equal(plan.strategy, "whole-diff");
  });

  it("packs whole files into slices bounded by the byte budget", () => {
    const a = fileDiff("A.java", Array.from({ length: 20 }, (_, i) => `a${i}`));
    const b = fileDiff("B.java", Array.from({ length: 20 }, (_, i) => `b${i}`));
    const c = fileDiff("C.java", Array.from({ length: 20 }, (_, i) => `c${i}`));
    const diffText = a + b + c;
    // Budget fits two of the three file blocks per slice.
    const maxBytes = Buffer.byteLength(a + b, "utf8");
    const plan = planReviewSlices({ diffText, maxBytes });
    assert.equal(plan.strategy, "file-slices");
    assert.equal(plan.slices.length, 2);
    assert.equal(plan.files_total, 3);
    assert.equal(plan.files_covered, 3);
    for (const slice of plan.slices) {
      assert.ok(Buffer.byteLength(slice, "utf8") <= maxBytes);
    }
    // Reassembling the slices reproduces the authoritative diff byte-for-byte:
    // nothing is dropped, duplicated, or reordered.
    assert.equal(plan.slices.join(""), diffText);
  });

  it("splits a single file larger than the budget on hunk boundaries and repeats its header", () => {
    const header = [
      "diff --git a/Huge.java b/Huge.java",
      "index 1111111..2222222 100644",
      "--- a/Huge.java",
      "+++ b/Huge.java",
      "",
    ].join("\n");
    const hunk = (n) => [`@@ -${n},2 +${n},2 @@`, `-old ${n}`, `+new ${n}`, ""].join("\n");
    const diffText = header + hunk(1) + hunk(20) + hunk(40);
    const maxBytes = Buffer.byteLength(header + hunk(1), "utf8");
    const plan = planReviewSlices({ diffText, maxBytes });
    assert.equal(plan.strategy, "hunk-slices");
    assert.ok(plan.slices.length >= 2);
    assert.equal(plan.files_total, 1);
    assert.equal(plan.files_covered, 1);
    for (const slice of plan.slices) {
      // Every hunk slice carries the file header so it is a self-describing,
      // reviewable diff rather than an orphan hunk.
      assert.ok(slice.startsWith("diff --git a/Huge.java b/Huge.java"));
      assert.ok(slice.includes("+++ b/Huge.java"));
    }
    // Every hunk of the original file is present in exactly one slice.
    for (const marker of ["-old 1", "-old 20", "-old 40"]) {
      const hits = plan.slices.filter((s) => s.includes(marker)).length;
      assert.equal(hits, 1, `expected ${marker} in exactly one slice, saw ${hits}`);
    }
  });

  it("splits a hunk larger than the budget at line boundaries rather than emitting it whole", () => {
    // An unbounded slice defeats the byte budget precisely on the oversized
    // changes slicing exists to handle, so a hunk too big for the budget falls
    // through to the next safe boundary: whole lines.
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const plan = planReviewSlices({ diffText: fileDiff("Wide.java", lines), maxBytes: 512 });

    assert.ok(plan.slices.length > 1, "expected the oversized hunk to be split");
    assert.equal(plan.strategy, "hunk-slices");
    assert.equal(plan.oversized_slices, 0);
    for (const slice of plan.slices) {
      assert.ok(Buffer.byteLength(slice, "utf8") <= 512);
      // Each piece stays attributable: file header plus a hunk header whose
      // coordinates describe THIS fragment (not the original hunk's).
      assert.ok(slice.startsWith("diff --git a/Wide.java b/Wide.java"));
      assert.match(slice, /^@@ -\d+,\d+ \+\d+,\d+ @@/m);
    }
    // Every content line survives in exactly one slice: nothing truncated,
    // nothing duplicated.
    for (const marker of ["+line 0", "+line 117", "+line 199"]) {
      const hits = plan.slices.filter((s) => s.includes(`${marker}\n`)).length;
      assert.equal(hits, 1, `expected ${marker} in exactly one slice, saw ${hits}`);
    }
  });

  it("recomputes hunk coordinates so a later fragment anchors to its real right-side line", () => {
    // Each slice is reviewed by an independent process, so a fragment that
    // repeated the ORIGINAL @@ header would make every reported line number
    // wrong. Reconstruct the file from the fragments' own coordinates and
    // check that a known line lands where the header claims it does.
    const body = Array.from({ length: 60 }, (_, i) => `+new line ${i}`);
    const diffText = [
      "diff --git a/Big.java b/Big.java",
      "index 1111111..2222222 100644",
      "--- a/Big.java",
      "+++ b/Big.java",
      "@@ -10,0 +10,60 @@ class Big {",
      ...body,
      "",
    ].join("\n");

    const plan = planReviewSlices({ diffText, maxBytes: 400 });
    assert.ok(plan.slices.length > 1, "expected the hunk to be split");

    // Walk every fragment: its header's new-side start must equal the real
    // line number of its first added line in the reconstructed file.
    let expectedNewStart = 10;
    for (const slice of plan.slices) {
      assert.ok(slice.startsWith("diff --git a/Big.java b/Big.java"));
      const header = slice.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@(.*)$/m);
      assert.ok(header, `fragment has no recomputed hunk header:\n${slice}`);
      assert.equal(Number(header[3]), expectedNewStart);
      const added = slice.split("\n").filter((l) => l.startsWith("+new line "));
      assert.equal(Number(header[4]), added.length, "new-side count must match the fragment");
      // The section heading from the original header is preserved.
      assert.equal(header[5], " class Big {");
      // The first added line of this fragment is the one at expectedNewStart.
      assert.equal(added[0], `+new line ${expectedNewStart - 10}`);
      expectedNewStart += added.length;
    }
    // Every added line is accounted for exactly once across the fragments.
    assert.equal(expectedNewStart, 70);
  });

  it("keeps file attribution on every fragment of a split metadata-only block", () => {
    const noHunks = [
      "diff --git a/blob.bin b/blob.bin",
      ...Array.from({ length: 40 }, (_, i) => `GIT binary patch fragment ${i}`),
      "",
    ].join("\n");
    const plan = planReviewSlices({ diffText: noHunks, maxBytes: 256 });
    assert.ok(plan.slices.length > 1);
    for (const slice of plan.slices) {
      assert.ok(
        slice.startsWith("diff --git a/blob.bin b/blob.bin"),
        "a fragment without its diff --git line has no file attribution",
      );
    }
  });

  it("emits an indivisible over-budget line whole and reports it as oversized", () => {
    // A single line is the smallest unit that can be split without corrupting
    // the diff. Emitting it beats truncating it, but the caller must be able to
    // see that a slice exceeded the budget.
    const plan = planReviewSlices({
      diffText: fileDiff("Minified.js", ["x".repeat(4000), "short"]),
      maxBytes: 512,
    });
    assert.ok(plan.slices.some((s) => Buffer.byteLength(s, "utf8") > 512));
    assert.equal(plan.oversized_slices, 1);
    assert.ok(plan.slices.join("").includes("x".repeat(4000)));
  });

  it("line-slices an over-budget block that has no hunk boundary at all", () => {
    // Binary / rename-only / mode-change blocks carry no `@@`, so the hunk
    // boundary is unavailable and the line boundary is the fallback.
    const noHunks = [
      "diff --git a/blob.bin b/blob.bin",
      ...Array.from({ length: 40 }, (_, i) => `GIT binary patch fragment ${i}`),
      "",
    ].join("\n");
    const plan = planReviewSlices({ diffText: noHunks, maxBytes: 256 });
    assert.ok(plan.slices.length > 1);
    for (const slice of plan.slices) {
      assert.ok(Buffer.byteLength(slice, "utf8") <= 256);
    }
    // Sub-file slicing repeats the attribution line by design, so the exact
    // concatenation invariant that holds for file-level slicing does not apply
    // here. What must hold is that no content line is lost or duplicated.
    for (let i = 0; i < 40; i += 1) {
      const hits = plan.slices.filter((s) => s.includes(`GIT binary patch fragment ${i}\n`)).length;
      assert.equal(hits, 1, `fragment ${i} appeared in ${hits} slices`);
    }
  });

  it("preserves deletion direction in deletion-only slices", () => {
    const del = [
      "diff --git a/Gone.java b/Gone.java",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/Gone.java",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-public class Gone {}",
      "-// end",
      "",
    ].join("\n");
    const add = fileDiff("New.java", ["x"]);
    const plan = planReviewSlices({ diffText: del + add, maxBytes: Buffer.byteLength(del, "utf8") });
    assert.equal(plan.files_total, 2);
    const joined = plan.slices.join("");
    assert.ok(joined.includes("deleted file mode 100644"));
    assert.ok(joined.includes("-public class Gone {}"));
    assert.ok(joined.includes("+++ /dev/null"));
  });

  it("keeps binary and rename-only blocks whole and counts them as files", () => {
    const binary = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");
    const rename = [
      "diff --git a/Old.java b/New.java",
      "similarity index 100%",
      "rename from Old.java",
      "rename to New.java",
      "",
    ].join("\n");
    const plan = planReviewSlices({
      diffText: binary + rename,
      maxBytes: Buffer.byteLength(binary, "utf8"),
    });
    assert.equal(plan.files_total, 2);
    assert.equal(plan.files_covered, 2);
    assert.ok(plan.slices.some((s) => s.includes("Binary files a/logo.png")));
    assert.ok(plan.slices.some((s) => s.includes("rename to New.java")));
  });

  it("counts files with spaces and non-ASCII names", () => {
    const odd = fileDiff("docs/my report ünïcode.md", ["x", "y"]);
    const plain = fileDiff("Plain.java", ["z"]);
    const plan = planReviewSlices({
      diffText: odd + plain,
      maxBytes: Buffer.byteLength(odd, "utf8"),
    });
    assert.equal(plan.files_total, 2);
    assert.equal(plan.files_covered, 2);
  });

  it("does not treat an added line that looks like a diff header as a file boundary", () => {
    const tricky = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,1 +1,2 @@",
      " intro",
      "+diff --git a/Fake.java b/Fake.java",
      "",
    ].join("\n");
    const plan = planReviewSlices({ diffText: tricky, maxBytes: 32 });
    assert.equal(plan.files_total, 1);
  });

  it("returns one empty slice for an empty diff", () => {
    const plan = planReviewSlices({ diffText: "", maxBytes: 1024 });
    assert.deepEqual(plan.slices, [""]);
    assert.equal(plan.files_total, 0);
    assert.equal(plan.files_covered, 0);
  });
});

describe("buildReviewCoverage", () => {
  const plan = {
    slices: ["a", "b"],
    strategy: "file-slices",
    files_total: 4,
    files_covered: 4,
    oversized_slices: 2,
  };

  it("publishes every coverage field from the plan and the reviewers", () => {
    const coverage = buildReviewCoverage({
      slicePlan: plan,
      reviewerResults: [{ slices_completed: 2 }, { slices_completed: 2 }],
      unreviewedUntrackedPaths: [".pgpass"],
    });
    assert.deepEqual(Object.keys(coverage).sort(), REVIEW_COVERAGE_KEYS);
    assert.equal(coverage.strategy, "file-slices");
    assert.equal(coverage.chunks_total, 2);
    assert.equal(coverage.chunks_completed, 2);
    assert.equal(coverage.files_total, 4);
    assert.equal(coverage.files_covered, 4);
    assert.equal(coverage.oversized_slices, 2);
    assert.deepEqual(coverage.unreviewed_untracked_paths, [".pgpass"]);
    assert.equal(coverage.complete, true);
  });

  it("is bounded by the weakest reviewer, so one reviewer's gap fails coverage", () => {
    const coverage = buildReviewCoverage({
      slicePlan: plan,
      reviewerResults: [{ slices_completed: 2 }, { slices_completed: 1 }],
    });
    assert.equal(coverage.chunks_completed, 1);
    assert.equal(coverage.complete, false);
  });

  it("defaults the untracked list rather than dropping the field", () => {
    const coverage = buildReviewCoverage({ slicePlan: plan, reviewerResults: [] });
    assert.deepEqual(coverage.unreviewed_untracked_paths, []);
    assert.equal(coverage.complete, false);
  });

  it("fails coverage when the plan did not cover every file", () => {
    const coverage = buildReviewCoverage({
      slicePlan: { ...plan, files_covered: 3 },
      reviewerResults: [{ slices_completed: 2 }, { slices_completed: 2 }],
    });
    assert.equal(coverage.complete, false);
  });
});
