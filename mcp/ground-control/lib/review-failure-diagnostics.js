// Local-only closed diagnostics. Never retain raw model output, subprocess
// stderr, paths, or parser messages in a publishable failure record.
export const REVIEW_FAILURE_CAUSES = Object.freeze([
  "engine_failed", "missing_tail", "invalid_json", "invalid_envelope", "unknown",
]);

export function classifyReviewFailureCauses(parseErrors) {
  if (!Array.isArray(parseErrors) || parseErrors.length === 0) return ["unknown"];
  return [...new Set(parseErrors.map((entry) => {
    const error = entry?.error;
    if (typeof error !== "string") return "unknown";
    if (error.startsWith("codex execution failed:")) return "engine_failed";
    if (error.startsWith("Codex review did not emit a")) return "missing_tail";
    if (error.startsWith("Codex review REVIEW block was not valid JSON:")) return "invalid_json";
    return "invalid_envelope";
  }))].sort();
}
