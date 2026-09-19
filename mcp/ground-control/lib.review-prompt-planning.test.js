import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCodexReviewCorePrompt, buildCodexSecurityReviewPrompt } from "./lib/codex-review-prompt.js";
import { planBoundedReviewPrompts } from "./lib/review-prompt-planning.js";

function fileDiff(path, payload) {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -0,0 +1 @@",
    `+${payload}`,
    "",
  ].join("\n");
}

describe("bounded reviewer prompt planning", () => {
  it("slices a near-cap diff before prompt framing exceeds the configured budget", () => {
    const maxBytes = 256 * 1024;
    const diffText = fileDiff("a.js", "a".repeat(125000))
      + fileDiff("b.js", "b".repeat(125000));
    const promptArgs = {
      baseBranch: "dev", uncommitted: true,
      diffManifest: "1\t0\ta.js\n1\t0\tb.js",
      baseRefDescriptor: "dev", vocabulary: null, trackedSymlinks: [],
    };
    assert.ok(Buffer.byteLength(diffText, "utf8") < maxBytes);
    const { diffMode, slicePlan } = planBoundedReviewPrompts({ diffText, promptArgs, maxBytes });
    assert.equal(diffMode, "manifest");
    assert.equal(slicePlan.slices.length, 2);
    assert.equal(slicePlan.slices.join(""), diffText);
    for (const [index, slice] of slicePlan.slices.entries()) {
      const args = { ...promptArgs, diffMode, diffText: slice,
        slice: { index: index + 1, total: slicePlan.slices.length } };
      assert.ok(Buffer.byteLength(buildCodexReviewCorePrompt(args), "utf8") <= maxBytes);
      assert.ok(Buffer.byteLength(buildCodexSecurityReviewPrompt(args), "utf8") <= maxBytes);
    }
  });
});
