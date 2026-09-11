// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { TEST_QUALITY_FINDING_EXAMPLE, TEST_QUALITY_FINDING_FIELDS_DESCRIPTION, validateTestQualityFinding } from "./ci-watcher.js";
import { REVIEW_NOTES_MAX, REVIEW_VERDICTS, buildPrincipalEngineerRubric } from "./grc-legacy-compat-5.js";
import { REVIEW_NOTE_TEXT_MAX, checkVerdictBlockingConsistency, truncateReviewProse } from "./grc-legacy-compat.js";
export const TEST_QUALITY_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ship", "ship-with-fixes", "don't-ship"] },
    architectural_read: { type: "string", minLength: 1 },
    blocking: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "warning"] },
          location: { type: "string", minLength: 1 },
          problem: { type: "string", minLength: 1 },
          why_it_matters: { type: "string" },
          fix: { type: "string", minLength: 1 },
          classification: { type: "string", enum: ["one-off", "class"] },
          sweep_evidence: { type: "string" },
          category: {
            type: "object",
            properties: {
              shape: { type: "string", minLength: 1 },
              instances: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
            },
            required: ["shape", "instances"],
            additionalProperties: false,
          },
          structural_blocker: { type: "boolean" },
        },
        required: ["severity", "location", "problem", "fix", "classification"],
        additionalProperties: false,
      },
    },
    notes: {
      type: "array",
      maxItems: REVIEW_NOTES_MAX,
      items: {
        type: "object",
        properties: { text: { type: "string", minLength: 1 } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "architectural_read", "blocking"],
  additionalProperties: false,
};
export const TEST_QUALITY_REVIEW_FINDINGS_SCHEMA = TEST_QUALITY_REVIEW_SCHEMA;
export function buildTestQualityReviewPrompt({
  baseBranch,
  changedTestFiles,
  vocabulary = null,
}) {
  if (typeof baseBranch !== "string" || baseBranch.trim() === "") {
    throw new Error("buildTestQualityReviewPrompt: baseBranch must be a non-empty string");
  }
  if (!Array.isArray(changedTestFiles) || changedTestFiles.length === 0) {
    throw new Error(
      "buildTestQualityReviewPrompt: changedTestFiles must be a non-empty array",
    );
  }
  for (const path of changedTestFiles) {
    if (typeof path !== "string" || path.trim() === "") {
      throw new Error(
        "buildTestQualityReviewPrompt: every changedTestFiles entry must be a non-empty string",
      );
    }
  }
  const listing = changedTestFiles.map((p) => `- ${p}`).join("\n");
  return [
    "You are reviewing test files changed against the base branch `" + baseBranch + "`.",
    "Your job is to identify TESTS THAT PROVIDE FALSE ASSURANCE — tests that pass but would still pass if the implementation were broken. Return `verdict: ship` when the tests are solid — that is a valid outcome.",
    "",
    "## Files to review",
    "",
    "The following test files have changed in this branch. For each, also read the source file it tests so you understand what behavior should be verified. Use the available Read / Glob / Grep tools to navigate the repository (Bash is intentionally not provided; restrict yourself to read-only navigation).",
    "",
    listing,
    "",
    "## What to flag (subject-matter focus)",
    "",
    "### Critical (must fix)",
    "1. **Assertion-free tests** — tests that call code but never assert on the result.",
    "2. **Mock-only assertions** — the only assertion is that a mock was called. The test must also assert on the return value or state change produced by the code under test.",
    "3. **Integration masquerading as unit** — tests that hit a real database, make real HTTP calls, touch the filesystem, or spawn subprocesses without being explicitly marked as integration tests.",
    "4. **Per-test resource setup** — creating a database, connection pool, or heavy resource inside each test method instead of using shared fixtures.",
    "5. **Mocking language/framework internals** — mocking subprocess, os.path, datetime.now, or equivalent. Restructure the code under test instead.",
    "6. **Tests that can't detect regressions** — if you could replace the function under test with a no-op and the test would still pass, the test is worthless.",
    "7. **Security-enforcing behavior tested only by existence** — when the diff adds or materially changes production logic that enforces a protection (authentication, authorization, tenant/project isolation, input validation or sanitization, access restriction, secret handling, audit integrity), the test offered as evidence for it must fail if that enforcement is removed, bypassed, or materially weakened. Flag it when it asserts existence or configuration rather than the protected behavior: it checks that a rule, annotation, row, link, or status is merely present, that a snapshot or string contains an identifier, or that a mock was called — without driving the protected behavior through its boundary and asserting the enforcement effect. Ask: if I removed the enforcement, would this test still pass? If yes, it is an existence test and provides false assurance. Judge this from the diff alone. Use the narrowest layer that genuinely exercises the enforcement boundary — an existing controller slice test is fine; do not demand a full-stack integration test.",
    "",
    "### Warnings (should fix)",
    "8. **Inline mock/stub abuse** — excessive mock/stub/spy instantiation inside a single test method.",
    "9. **Missing parameterization** — near-identical test methods differing only in input/expected output.",
    "10. **Overly broad exception catching** — catching generic Exception types instead of the specific one.",
    "11. **No negative test cases** — only happy-path coverage.",
    "",
    "For each test file: read the test, read the source it tests, ask \"if I broke the implementation, would this test catch it?\" If no, flag it.",
    "",
    "Findings of category 1 / 6 / 7 are typically `critical`; the rest are `warning`. The principal-engineer rubric below governs how the envelope is shaped; this section governs the subject-matter focus.",
    "",
    ...buildPrincipalEngineerRubric({
      reviewerLabel: "test-quality",
      vocabulary,
      findingFieldsDescription: TEST_QUALITY_FINDING_FIELDS_DESCRIPTION,
      findingExampleJson: TEST_QUALITY_FINDING_EXAMPLE,
    }),
  ].join("\n");
}
export function parseTestQualityReviewEnvelope(stdout) {
  if (typeof stdout !== "string") {
    throw new Error("test-quality review output was not a string");
  }
  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new Error("test-quality review output was empty");
  }
  let cliEnvelope;
  try {
    cliEnvelope = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`test-quality review output is not valid JSON: ${err.message}`);
  }

  // Unwrap the claude --output-format json envelope. Two shapes coexist:
  //   1. structured_output carries the JSON-schema-validated payload directly.
  //   2. result is a JSON-encoded string of the payload.
  // The new verdict-envelope contract (#931) means the payload's REQUIRED
  // keys are verdict + architectural_read + blocking; tests/callers that
  // emit a bare {verdict, ...} literal also work via the fallback branch.
  let payload = cliEnvelope;
  if (
    cliEnvelope
    && typeof cliEnvelope === "object"
    && cliEnvelope.structured_output != null
    && typeof cliEnvelope.structured_output === "object"
    && typeof cliEnvelope.structured_output.verdict === "string"
  ) {
    payload = cliEnvelope.structured_output;
  } else if (
    cliEnvelope
    && typeof cliEnvelope === "object"
    && typeof cliEnvelope.result === "string"
  ) {
    if (cliEnvelope.result.trim() === "") {
      throw new Error(
        "test-quality review .result field is empty and no structured_output.verdict was provided",
      );
    }
    try {
      payload = JSON.parse(cliEnvelope.result);
    } catch (err) {
      throw new Error(
        `test-quality review .result field is not valid JSON: ${err.message}`,
      );
    }
  }

  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(
      "test-quality review payload is not an object (expected { verdict, architectural_read, blocking, notes? })",
    );
  }
  if (!REVIEW_VERDICTS.includes(payload.verdict)) {
    throw new Error(
      `test-quality review payload.verdict must be one of: ${REVIEW_VERDICTS.join(", ")} (got ${JSON.stringify(payload.verdict)})`,
    );
  }
  if (typeof payload.architectural_read !== "string" || payload.architectural_read.trim() === "") {
    throw new Error(
      "test-quality review payload is missing required field 'architectural_read' (must be a non-empty string written before any findings)",
    );
  }
  if (!Array.isArray(payload.blocking)) {
    throw new Error("test-quality review payload.blocking must be an array (may be empty)");
  }

  const blocking = payload.blocking.map((raw, i) => validateTestQualityFinding(raw, i));

  let notes = [];
  if (payload.notes != null) {
    if (!Array.isArray(payload.notes)) {
      throw new Error("test-quality review payload.notes must be an array when set");
    }
    if (payload.notes.length > REVIEW_NOTES_MAX) {
      throw new Error(
        `test-quality review payload.notes exceeds the workflow cap of ${REVIEW_NOTES_MAX} (got ${payload.notes.length})`,
      );
    }
    notes = payload.notes.map((entry, idx) => {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`test-quality review notes[${idx}] must be an object {text}`);
      }
      if (typeof entry.text !== "string" || entry.text.trim() === "") {
        throw new Error(`test-quality review notes[${idx}].text must be a non-empty string`);
      }
      return { text: truncateReviewProse(entry.text, REVIEW_NOTE_TEXT_MAX) };
    });
  }

  // Verdict / blocking consistency rules — shared helper (#931 codex cycle-1 F1).
  const consistencyErrs = checkVerdictBlockingConsistency({
    verdict: payload.verdict,
    blocking,
    blockingHasStructural: (f) => f.classification === "class" || f.structural_blocker === true,
  });
  if (consistencyErrs.length) throw new Error(`test-quality review ${consistencyErrs[0]}`);

  return {
    verdict: payload.verdict,
    architectural_read: payload.architectural_read.trim(),
    blocking,
    notes,
  };
}
export function parseTestQualityReviewFindings(stdout) {
  const envelope = parseTestQualityReviewEnvelope(stdout);
  return { findings: envelope.blocking, envelope };
}
const FINAL_REPORT_MARKER_PREFIX = "<!-- gc:final-report";
export const FINAL_REPORT_FILE_KINDS = Object.freeze(["added", "modified", "renamed", "deleted"]);
export const FINAL_REPORT_CI_STATUSES = Object.freeze(["green", "red", "skipped"]);
export const FINAL_REPORT_SONAR_STATUSES = Object.freeze(["passed", "failed", "skipped"]);
