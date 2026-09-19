import { buildCodexReviewCorePrompt, buildCodexSecurityReviewPrompt } from "./codex-review-prompt.js";
import { getDefaultCodexReviewMaxDiffBytes } from "./grc-legacy-compat.js";
import { planReviewSlices, selectDiffMode } from "./grc-legacy-compat-2.js";

// Slice metadata gains digits as the slice count grows. Keep a small reserve
// beyond the exact empty-diff wrapper so every emitted prompt has headroom.
const SLICE_METADATA_RESERVE_BYTES = 2048;

export function planBoundedReviewPrompts({ diffText, promptArgs,
  maxBytes = getDefaultCodexReviewMaxDiffBytes() }) {
  const wrapper = { ...promptArgs, diffText: "", diffMode: "manifest",
    slice: { index: 1, total: 2 } };
  const promptOverheadBytes = Math.max(
    Buffer.byteLength(buildCodexReviewCorePrompt(wrapper), "utf8"),
    Buffer.byteLength(buildCodexSecurityReviewPrompt(wrapper), "utf8"),
  ) + SLICE_METADATA_RESERVE_BYTES;
  const options = { diffText, maxBytes, promptOverheadBytes };
  return {
    diffMode: selectDiffMode(options),
    slicePlan: planReviewSlices(options),
  };
}
