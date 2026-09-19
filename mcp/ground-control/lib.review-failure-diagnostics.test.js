import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyReviewFailureCauses } from "./lib/review-failure-diagnostics.js";

describe("closed deferred review failure diagnostics", () => {
  it("classifies failures without retaining raw output or paths", () => {
    assert.deepEqual(classifyReviewFailureCauses([
      { reviewer: "core", error: "codex execution failed: sensitive stderr" },
      { reviewer: "security", error: "Codex review did not emit a tail: private path" },
      { reviewer: "security", error: "Codex review REVIEW block was not valid JSON: secret" },
      { reviewer: "security", error: "finding path includes private value" },
    ]), ["engine_failed", "invalid_envelope", "invalid_json", "missing_tail"]);
  });

  it("uses an unknown code when no structured cause survived", () => {
    assert.deepEqual(classifyReviewFailureCauses([]), ["unknown"]);
    assert.deepEqual(classifyReviewFailureCauses([null]), ["unknown"]);
  });
});
