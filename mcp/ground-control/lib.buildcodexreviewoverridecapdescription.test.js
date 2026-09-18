// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_REVIEW_HARD_CAP,
  CODEX_REVIEW_PREPUSH_HARD_CAP,
  FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX,
  FINAL_REPORT_REVIEW_SUMMARY_MAX,
  FINAL_REPORT_SUMMARY_MAX,
  buildCodexReviewOverrideCapDescription,
  buildCodexReviewOverrideReasonDescription,
  buildDecisionRecord,
  buildDecisionRecordMarker,
  buildFinalReportMarker,
  validateDecisionRecordInput,
  validateFinalReportInput,
} from "./lib.js";

/**
 * Assert the summary byte-cap boundary for a validator that accepts a `summary` field.
 * @param {Function} validator - function that takes an input object and returns {ok, errors}
 * @param {number} cap - the byte cap constant being tested
 * @param {Function} baseInputFn - zero-arg factory producing a valid base input for the validator
 */
function assertSummaryByteCap(validator, cap, baseInputFn) {
  it(`rejects summary > ${cap} bytes`, () => {
    const oversized = "x".repeat(cap + 1);
    const r = validator(baseInputFn({ summary: oversized }));
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => /summary/.test(e) && new RegExp(String(cap)).test(e)),
      `expected error mentioning 'summary' and cap value ${cap}, got: ${r.errors.join("; ")}`,
    );
  });

  it(`accepts summary at exactly ${cap} bytes`, () => {
    const atCap = "x".repeat(cap);
    const r = validator(baseInputFn({ summary: atCap }));
    assert.equal(r.ok, true, `errors=${r.errors?.join("; ")}`);
  });
}

describe("buildCodexReviewOverrideCapDescription", () => {
  it("surfaces the live cap value as a structured cap phrase (not a bare digit)", () => {
    const desc = buildCodexReviewOverrideCapDescription({
      postPushCap: CODEX_REVIEW_HARD_CAP,
      prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP,
    });
    if (CODEX_REVIEW_HARD_CAP === CODEX_REVIEW_PREPUSH_HARD_CAP) {
      assert.match(
        desc,
        new RegExp(`hard-cap-${CODEX_REVIEW_HARD_CAP}\\b`, "i"),
        `equal-cap form must surface "hard-cap-N"; got: ${desc}`,
      );
    } else {
      assert.match(
        desc,
        new RegExp(
          `post-push ${CODEX_REVIEW_HARD_CAP}\\b.*pre-push ${CODEX_REVIEW_PREPUSH_HARD_CAP}\\b|` +
            `pre-push ${CODEX_REVIEW_PREPUSH_HARD_CAP}\\b.*post-push ${CODEX_REVIEW_HARD_CAP}\\b`,
          "is",
        ),
        `divergent-cap form must surface both caps; got: ${desc}`,
      );
    }
  });

  it("does not contain stale hard-cap-2 wording", () => {
    const desc = buildCodexReviewOverrideCapDescription({
      postPushCap: CODEX_REVIEW_HARD_CAP,
      prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP,
    });
    assert.ok(!/hard-cap-2\b/i.test(desc), `must not contain hard-cap-2; got: ${desc}`);
  });

  it("nudges the agent toward fix-and-escalate, not silent retries", () => {
    const desc = buildCodexReviewOverrideCapDescription({
      postPushCap: CODEX_REVIEW_HARD_CAP,
      prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP,
    });
    assert.ok(
      desc.includes("override_reason"),
      `must require override_reason; got: ${desc}`,
    );
    assert.ok(
      /user\b/i.test(desc),
      `must remind that only the user can authorize overrides; got: ${desc}`,
    );
  });

  it("collapses to hard-cap-N when caps are equal", () => {
    const desc = buildCodexReviewOverrideCapDescription({ postPushCap: 9, prepushCap: 9 });
    assert.match(desc, /hard-cap-9\b/i);
    assert.ok(!/hard-cap-3\b/i.test(desc), `must not leak default 3; got: ${desc}`);
  });

  it("surfaces both caps when post-push and pre-push diverge", () => {
    const desc = buildCodexReviewOverrideCapDescription({ postPushCap: 4, prepushCap: 6 });
    assert.match(desc, /post-push 4.*pre-push 6|pre-push 6.*post-push 4/is);
    assert.ok(!/hard-cap-4\b/i.test(desc), `divergent caps must not collapse; got: ${desc}`);
    assert.ok(!/hard-cap-6\b/i.test(desc), `divergent caps must not collapse; got: ${desc}`);
  });
});

describe("buildCodexReviewOverrideReasonDescription", () => {
  it("requires override_reason when override_cap=true", () => {
    const desc = buildCodexReviewOverrideReasonDescription({
      postPushCap: CODEX_REVIEW_HARD_CAP,
      prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP,
    });
    assert.match(desc, /Required when override_cap=true/);
    assert.match(desc, /Stored in the marker for audit/);
  });

  it("uses a concrete next-cycle example when caps are equal", () => {
    // Post-push and pre-push caps diverged when issue #906 lowered the
    // pre-push default to 1 while leaving the post-push default at 3. Pass
    // equal explicit caps so this test continues to exercise the
    // equal-caps branch of the description renderer.
    const equalCap = 3;
    const desc = buildCodexReviewOverrideReasonDescription({
      postPushCap: equalCap,
      prepushCap: equalCap,
    });
    assert.match(
      desc,
      new RegExp(`run cycle ${equalCap + 1}`),
      `equal-cap example should name the first cycle past the cap; got: ${desc}`,
    );
  });

  it("uses cap-relative wording when caps diverge so it does not lock in a single number", () => {
    const desc = buildCodexReviewOverrideReasonDescription({ postPushCap: 4, prepushCap: 6 });
    assert.ok(
      /next over-cap cycle/i.test(desc),
      `divergent-cap example must avoid a hardcoded next-cycle integer; got: ${desc}`,
    );
    assert.ok(!/cycle 5\b/.test(desc), `must not pin to post-push next cycle; got: ${desc}`);
    assert.ok(!/cycle 7\b/.test(desc), `must not pin to pre-push next cycle; got: ${desc}`);
  });

  it("does not hardcode the cap value (proves it follows the constants)", () => {
    const desc = buildCodexReviewOverrideReasonDescription({ postPushCap: 9, prepushCap: 9 });
    assert.match(desc, /run cycle 10\b/);
    assert.ok(!/run cycle 4\b/.test(desc), `must not leak default cap+1; got: ${desc}`);
  });
});

// ===========================================================================
// /implement cost reduction (issue #868 / ADR-036) — pure-helper tests for
// the four new tool surfaces. Runners are covered by integration tests at
// the MCP layer; these tests pin the renderer / validator contracts.
// ===========================================================================

describe("buildDecisionRecordMarker", () => {
  it("renders the standard marker shape", () => {
    const m = buildDecisionRecordMarker({ reviewer: "codex", cycle: 2, issueNumber: 868 });
    assert.equal(m, '<!-- gc:decision-record reviewer="codex" cycle="2" issue="868" -->');
  });
});

describe("validateDecisionRecordInput", () => {
  function baseInput(overrides = {}) {
    return {
      issueNumber: 868,
      cycle: 1,
      reviewer: "codex",
      findings: [],
      ...overrides,
    };
  }

  it("accepts a zero-finding clean run", () => {
    const r = validateDecisionRecordInput(baseInput());
    assert.equal(r.ok, true);
  });

  it("rejects non-positive issue numbers", () => {
    assert.equal(validateDecisionRecordInput(baseInput({ issueNumber: 0 })).ok, false);
    assert.equal(validateDecisionRecordInput(baseInput({ issueNumber: -1 })).ok, false);
    assert.equal(validateDecisionRecordInput(baseInput({ issueNumber: 1.5 })).ok, false);
  });

  it("rejects unknown reviewer values", () => {
    const r = validateDecisionRecordInput(baseInput({ reviewer: "marketing" }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /reviewer/.test(e)));
  });

  it("rejects decision='defer' with a pointed ADR-029 message", () => {
    const r = validateDecisionRecordInput(baseInput({
      findings: [{
        id: "F1", title: "x", classification: "one-off", sweep_evidence: "tested-sweep",
        decision: "defer", rationale: "y",
      }],
    }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /defer/.test(e) && /ADR-029/.test(e)),
      `expected ADR-029 deferral message; got: ${r.errors.join(" | ")}`);
  });

  it("requires class findings to carry instances[] with >= 2 entries", () => {
    const r1 = validateDecisionRecordInput(baseInput({
      findings: [{
        id: "F1", title: "x", classification: "class",
        decision: "fix", rationale: "y",
      }],
    }));
    assert.equal(r1.ok, false);
    assert.ok(r1.errors.some((e) => /instances/.test(e)));

    const r2 = validateDecisionRecordInput(baseInput({
      findings: [{
        id: "F1", title: "x", classification: "class",
        decision: "fix", rationale: "y", instances: ["a.java:1"],
      }],
    }));
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.some((e) => /length >= 2/.test(e)));
  });

  it("accepts a valid one-off finding with location and comment_url", () => {
    const r = validateDecisionRecordInput(baseInput({
      findings: [{
        id: "F1", title: "Missing validation", classification: "one-off", sweep_evidence: "tested-sweep",
        decision: "fix", rationale: "Added validator at line 42.",
        location: "src/foo.java:42",
        comment_url: "https://github.com/x/y/pull/1#discussion_r1",
      }],
    }));
    assert.equal(r.ok, true);
  });

  it("rejects non-object input shapes", () => {
    assert.equal(validateDecisionRecordInput(null).ok, false);
    assert.equal(validateDecisionRecordInput("nope").ok, false);
    assert.equal(validateDecisionRecordInput([]).ok, false);
  });

  it("requires user_authorization on wontfix decisions (codex cycle-2 F4)", () => {
    const r1 = validateDecisionRecordInput({
      issueNumber: 868, cycle: 1, reviewer: "codex",
      findings: [{
        id: "F1", title: "x", classification: "one-off", sweep_evidence: "tested-sweep",
        decision: "wontfix", rationale: "user said no",
      }],
    });
    assert.equal(r1.ok, false);
    assert.ok(r1.errors.some((e) => /user_authorization/.test(e)));

    const r2 = validateDecisionRecordInput({
      issueNumber: 868, cycle: 1, reviewer: "codex",
      findings: [{
        id: "F1", title: "x", classification: "one-off", sweep_evidence: "tested-sweep",
        decision: "wontfix", rationale: "user said no",
        user_authorization: "https://github.com/x/y/issues/868#issuecomment-1",
      }],
    });
    assert.equal(r2.ok, true);
  });

  it("accepts a wontfix decision when user_authorization is present", () => {
    const r = validateDecisionRecordInput({
      issueNumber: 868, cycle: 1, reviewer: "codex",
      findings: [{
        id: "F1", title: "x", classification: "one-off", sweep_evidence: "tested-sweep",
        decision: "wontfix", rationale: "false positive",
        user_authorization: "see issue-comment id 4418000000",
      }],
    });
    assert.equal(r.ok, true);
  });
});

describe("buildDecisionRecord", () => {
  it("renders a clean-run record for zero findings", () => {
    const body = buildDecisionRecord({ issueNumber: 868, cycle: 3, reviewer: "codex", findings: [] });
    assert.match(body, /gc:decision-record/);
    assert.match(body, /## Review decision record — codex cycle 3 \(issue #868\)/);
    assert.match(body, /Blocking findings:\*\* 0 \(clean run\)/);
  });

  it("renders verdict + architectural_read header when supplied (verdict envelope, #931)", () => {
    const body = buildDecisionRecord({
      issueNumber: 931, cycle: 1, reviewer: "codex", findings: [],
      verdict: "ship",
      architectural_read: "This change is shaped correctly; reuses the canonical Repository pattern.",
    });
    assert.match(body, /\*\*Verdict:\*\* `ship`/);
    assert.match(body, /\*\*Architectural read:\*\*/);
    assert.match(body, /shaped correctly/);
  });

  it("rejects verdict='ship' decision-record input with non-empty findings (#931 codex F1)", () => {
    const result = validateDecisionRecordInput({
      issueNumber: 931, cycle: 1, reviewer: "codex",
      verdict: "ship",
      architectural_read: "shaped correctly",
      findings: [{
        id: "F1", title: "x", classification: "one-off",
        decision: "fix", rationale: "validator added",
      }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("verdict='ship'")));
  });

  it("rejects verdict='don't-ship' decision-record without a class finding (#931 codex F1)", () => {
    const result = validateDecisionRecordInput({
      issueNumber: 931, cycle: 1, reviewer: "codex",
      verdict: "don't-ship",
      architectural_read: "bad shape",
      findings: [{
        id: "F1", title: "x", classification: "one-off",
        decision: "fix", rationale: "trivial fix",
      }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("structural blocker")));
  });

  it("accepts verdict='ship-with-fixes' with at least one finding (#931 codex F1)", () => {
    const result = validateDecisionRecordInput({
      issueNumber: 931, cycle: 1, reviewer: "codex",
      verdict: "ship-with-fixes",
      architectural_read: "Mostly fine; one bypass to address.",
      findings: [{
        id: "F1", title: "x", classification: "one-off",
        decision: "fix", rationale: "validator added",
      }],
    });
    assert.equal(result.ok, true);
  });

  it("renders notes section when notes[] is supplied (clean run path)", () => {
    const body = buildDecisionRecord({
      issueNumber: 931, cycle: 1, reviewer: "codex", findings: [],
      verdict: "ship",
      architectural_read: "Clean.",
      notes: [{ text: "Consider documenting the seam for future variations." }],
    });
    assert.match(body, /\*\*Notes \(non-blocking, no decisions\):\*\*/);
    assert.match(body, /Consider documenting the seam/);
  });

  it("renders each one-off finding with id/title/decision/rationale", () => {
    const body = buildDecisionRecord({
      issueNumber: 868, cycle: 1, reviewer: "codex",
      findings: [
        { id: "F1", title: "Missing validation", classification: "one-off", sweep_evidence: "tested-sweep",
          decision: "fix", rationale: "Validator added at line 42.",
          location: "src/foo.java:42" },
      ],
    });
    assert.match(body, /Finding 1 — `one-off`/);
    assert.match(body, /\*\*ID:\*\* `F1`/);
    assert.match(body, /Missing validation/);
    assert.match(body, /`src\/foo\.java:42`/);
    assert.match(body, /\*\*Decision:\*\* fix/);
    assert.match(body, /Validator added at line 42\./);
  });

  it("renders class findings with the instance list", () => {
    const body = buildDecisionRecord({
      issueNumber: 868, cycle: 2, reviewer: "codex",
      findings: [
        { id: "F2", title: "Repository bypass", classification: "class",
          decision: "fix", rationale: "Single repair at helper layer.",
          instances: ["src/a.java:11", "src/b.java:22", "src/c.java:33"] },
      ],
    });
    assert.match(body, /class.*3 instances/);
    assert.match(body, /`src\/a\.java:11`/);
    assert.match(body, /`src\/b\.java:22`/);
    assert.match(body, /`src\/c\.java:33`/);
  });

  it("propagates wontfix and not-applicable decisions distinctly", () => {
    const body = buildDecisionRecord({
      issueNumber: 868, cycle: 1, reviewer: "codex",
      findings: [
        { id: "F1", title: "x", classification: "one-off", sweep_evidence: "tested-sweep",
          decision: "wontfix", rationale: "User-authorized — see #999.",
          user_authorization: "https://github.com/x/y/issues/999#issuecomment-1" },
        { id: "F2", title: "y", classification: "one-off", sweep_evidence: "tested-sweep",
          decision: "not-applicable", rationale: "False positive on this codebase." },
      ],
    });
    assert.match(body, /\*\*Decision:\*\* wontfix/);
    assert.match(body, /\*\*Decision:\*\* not-applicable/);
  });

  it("throws on invalid input (defense in depth alongside validateDecisionRecordInput)", () => {
    assert.throws(() => buildDecisionRecord({
      issueNumber: -1, cycle: 1, reviewer: "codex", findings: [],
    }), /input invalid/);
  });

  it("renders the wontfix user_authorization line when present (codex cycle-2 F4)", () => {
    const body = buildDecisionRecord({
      issueNumber: 868, cycle: 1, reviewer: "codex",
      findings: [{
        id: "F1", title: "x", classification: "one-off", sweep_evidence: "tested-sweep",
        decision: "wontfix", rationale: "false positive",
        user_authorization: "see comment #4418000000",
      }],
    });
    assert.match(body, /\*\*User authorization:\*\* see comment #4418000000/);
  });
});

describe("buildFinalReportMarker", () => {
  it("renders the standard marker shape", () => {
    const m = buildFinalReportMarker({ issueNumber: 868, prNumber: 871 });
    assert.equal(m, '<!-- gc:final-report issue="868" pr="871" -->');
  });
});

describe("validateFinalReportInput", () => {
  function baseInput(overrides = {}) {
    return {
      issueNumber: 868, prNumber: 871,
      requirements: [], files: {}, reviews: [], traceability: {},
      ciStatus: "green", sonarStatus: "passed",
      plainEnglishOutcome: "Operators get a clearer closeout that explains the practical effect of the change.",
      ...overrides,
    };
  }
  it("accepts a minimal valid input", () => {
    assert.equal(validateFinalReportInput(baseInput()).ok, true);
  });
  it("requires positive integer ids", () => {
    assert.equal(validateFinalReportInput(baseInput({ issueNumber: 0 })).ok, false);
    assert.equal(validateFinalReportInput(baseInput({ prNumber: 0 })).ok, false);
  });
  it("rejects unknown file-kind keys", () => {
    const r = validateFinalReportInput(baseInput({ files: { invented: ["a"] } }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /unknown key 'invented'/.test(e)));
  });
  it("rejects unknown ci/sonar values", () => {
    assert.equal(validateFinalReportInput(baseInput({ ciStatus: "yellow" })).ok, false);
    assert.equal(validateFinalReportInput(baseInput({ sonarStatus: "warn" })).ok, false);
  });
  it("requires reviewer + summary on each review", () => {
    const r = validateFinalReportInput(baseInput({ reviews: [{ reviewer: "codex" }] }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /summary/.test(e)));
  });

  assertSummaryByteCap(validateFinalReportInput, FINAL_REPORT_SUMMARY_MAX, baseInput);

  it("requires plainEnglishOutcome for implement final reports", () => {
    const input = baseInput();
    delete input.plainEnglishOutcome;
    const r = validateFinalReportInput(input);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /plainEnglishOutcome/.test(e)));
  });

  it("does not require plainEnglishOutcome for quickfix close comments", () => {
    const input = baseInput({ lane: "quickfix" });
    delete input.plainEnglishOutcome;
    const r = validateFinalReportInput(input);
    assert.equal(r.ok, true, `errors=${r.errors?.join("; ")}`);
  });

  it("rejects plainEnglishOutcome over the byte cap", () => {
    const r = validateFinalReportInput(baseInput({
      plainEnglishOutcome: "x".repeat(FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX + 1),
    }));
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => /plainEnglishOutcome/.test(e) && new RegExp(String(FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX)).test(e)),
      `expected error mentioning plainEnglishOutcome cap ${FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX}, got: ${r.errors.join("; ")}`,
    );
  });

  it("rejects reviews[i].summary > FINAL_REPORT_REVIEW_SUMMARY_MAX bytes", () => {
    const short = "1 cycle, 0 findings.";
    const oversized = "x".repeat(FINAL_REPORT_REVIEW_SUMMARY_MAX + 1);
    const r = validateFinalReportInput(baseInput({
      reviews: [
        { reviewer: "codex", summary: short },
        { reviewer: "codex", summary: oversized },
      ],
    }));
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => /reviews\[1\]/.test(e) && new RegExp(String(FINAL_REPORT_REVIEW_SUMMARY_MAX)).test(e)),
      `expected error mentioning 'reviews[1]' and cap ${FINAL_REPORT_REVIEW_SUMMARY_MAX}, got: ${r.errors.join("; ")}`,
    );
  });
});
