// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCodexReview, runCodexReviewCycle } from "./lib.js";

// =============================================================================
// Shared review-cycle seam + cycle wrappers (issue #934)
// =============================================================================
//
// gc_codex_review_cycle uses a shared review-cycle helper. The helper:
//   1. Calls the underlying review fn.
//   2. Builds a decision-record entry per finding (decision='fix' as the only
//      decision the cycle tool can post without user authorization).
//   3. Posts the decision record via runPostDecisionRecord.
//   4. Returns a compact envelope (no verbatim findings; raw stays
//      server-side via the underlying review's findings record).
//
// Tests here cover the pure mapper + input validation. The end-to-end
// path through the underlying review + decision-record post is covered
// by the Phase 5 verification run.

describe("buildAutoFixDecisionFindings (issue #934)", () => {
  it("returns an empty array for an empty findings list (clean cycle)", async () => {
    const { buildAutoFixDecisionFindings } = await import("./lib.js");
    assert.deepEqual(buildAutoFixDecisionFindings([]), []);
  });

  it("maps a one-off finding to a decision entry with sweep_evidence", async () => {
    const { buildAutoFixDecisionFindings } = await import("./lib.js");
    const out = buildAutoFixDecisionFindings([
      {
        path: "src/Foo.java",
        line: 42,
        title: "Missing input validation",
        body: "The handler does not validate `name`.",
        classification: "one-off",
        sweep_evidence: "grepped controllers for missing @Valid",
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].classification, "one-off");
    assert.equal(out[0].decision, "fix");
    assert.equal(out[0].sweep_evidence, "grepped controllers for missing @Valid");
    assert.equal(out[0].location, "src/Foo.java:42");
    assert.equal(out[0].title, "Missing input validation");
    assert.ok(typeof out[0].rationale === "string" && out[0].rationale.length > 0);
    assert.ok(out[0].id);
  });

  it("maps a class finding to a decision entry with instances", async () => {
    const { buildAutoFixDecisionFindings } = await import("./lib.js");
    const out = buildAutoFixDecisionFindings([
      {
        path: "src/Bar.java",
        line: 88,
        title: "Bypass of existing helper",
        body: "Uses raw JdbcTemplate.",
        classification: "class",
        category: {
          shape: "controller method bypassing scoped repository",
          instances: ["src/Bar.java:88", "src/Baz.java:140"],
        },
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].classification, "class");
    assert.equal(out[0].decision, "fix");
    assert.deepEqual(out[0].instances, ["src/Bar.java:88", "src/Baz.java:140"]);
    assert.equal(out[0].location, "src/Bar.java:88");
  });

  it("synthesizes sweep_evidence for one-off findings missing it (cycle tool must post a valid record)", async () => {
    const { buildAutoFixDecisionFindings } = await import("./lib.js");
    const out = buildAutoFixDecisionFindings([
      {
        path: "src/Foo.java",
        line: 1,
        title: "x",
        body: "y",
        classification: "one-off",
        // no sweep_evidence — cycle tool synthesizes
      },
    ]);
    assert.equal(out.length, 1);
    assert.ok(
      typeof out[0].sweep_evidence === "string" && out[0].sweep_evidence.length > 0,
      "sweep_evidence must be non-empty for one-off decision entries",
    );
    // The synthesized text names the structural sweep mechanism (the cycle
    // loop itself) rather than a placeholder. This prevents "auto-fix-cycle"
    // showing up in the durable issue-thread record where it would read as
    // an opaque magic string to a human reviewer.
    assert.match(
      out[0].sweep_evidence,
      /cycle loop|next.*review|sweep/i,
      "synthesized sweep_evidence should name the structural mechanism",
    );
  });

  it("falls back to id=F{idx+1} when the source finding has no id", async () => {
    const { buildAutoFixDecisionFindings } = await import("./lib.js");
    const out = buildAutoFixDecisionFindings([
      { path: "a", line: 1, title: "x", classification: "one-off" },
      { path: "b", line: 2, title: "y", classification: "one-off" },
    ]);
    assert.equal(out[0].id, "F1");
    assert.equal(out[1].id, "F2");
  });

  it("treats anything other than 'class' as 'one-off'", async () => {
    const { buildAutoFixDecisionFindings } = await import("./lib.js");
    const out = buildAutoFixDecisionFindings([
      { path: "a", line: 1, title: "x" }, // no classification — default
      { path: "b", line: 2, title: "y", classification: "minor" }, // unknown classifier
      { path: "c", line: 3, title: "z", classification: "class" },
    ]);
    assert.equal(out[0].classification, "one-off");
    assert.equal(out[1].classification, "one-off");
    assert.equal(out[2].classification, "class");
  });

  it("truncates very long bodies so the decision record stays under the GH comment cap", async () => {
    const { buildAutoFixDecisionFindings } = await import("./lib.js");
    const big = "x".repeat(5000);
    const out = buildAutoFixDecisionFindings([
      {
        path: "a",
        line: 1,
        title: "t",
        body: big,
        classification: "one-off",
        sweep_evidence: "s",
      },
    ]);
    assert.ok(out[0].rationale.length < 500, `rationale length=${out[0].rationale.length}`);
  });
});

describe("summarizeReviewFindings (issue #934)", () => {
  it("returns zero counts for empty input (clean cycle)", async () => {
    const { summarizeReviewFindings } = await import("./lib.js");
    const r = summarizeReviewFindings([]);
    assert.equal(r.one_off_count, 0);
    assert.equal(r.class_count, 0);
    assert.deepEqual(r.top_categories, []);
  });

  it("counts one-off vs class", async () => {
    const { summarizeReviewFindings } = await import("./lib.js");
    const r = summarizeReviewFindings([
      { classification: "one-off", path: "a", line: 1, title: "x" },
      { classification: "one-off", path: "b", line: 2, title: "y" },
      { classification: "class", path: "c", line: 3, title: "z", category: { shape: "shape-1", instances: ["c:3", "d:4"] } },
    ]);
    assert.equal(r.one_off_count, 2);
    assert.equal(r.class_count, 1);
  });

  it("groups class findings by category.shape and caps top_categories", async () => {
    const { summarizeReviewFindings } = await import("./lib.js");
    const r = summarizeReviewFindings([
      // "missing helper" total instances: 1
      { classification: "class", category: { shape: "missing helper", instances: ["a"] } },
      // "raw query" total instances: 5 (clear winner)
      { classification: "class", category: { shape: "raw query", instances: ["d", "e", "f", "g", "h"] } },
    ], 1);
    assert.equal(r.top_categories.length, 1);
    // Largest category by summed instance count wins.
    assert.equal(r.top_categories[0].shape, "raw query");
    assert.equal(r.top_categories[0].instance_count, 5);
  });

  it("sums instance_count across multiple findings of the same shape", async () => {
    const { summarizeReviewFindings } = await import("./lib.js");
    const r = summarizeReviewFindings([
      { classification: "class", category: { shape: "missing helper", instances: ["a", "b"] } },
      { classification: "class", category: { shape: "missing helper", instances: ["c"] } },
    ]);
    assert.equal(r.top_categories.length, 1);
    assert.equal(r.top_categories[0].shape, "missing helper");
    assert.equal(r.top_categories[0].instance_count, 3);
    assert.equal(r.top_categories[0].finding_count, 2);
  });
});

describe("normalizeReviewCycleNextAction (issue #934 fix-list)", () => {
  it("maps proceed_clean (underlying tool vocabulary) to the canonical clean action", async () => {
    const { normalizeReviewCycleNextAction } = await import("./lib.js");
    assert.equal(
      normalizeReviewCycleNextAction("proceed_clean", "clean"),
      "post_clean_decision_record_and_advance_to_phase_c",
    );
  });

  it("preserves the canonical clean action when the underlying tool already emits it", async () => {
    const { normalizeReviewCycleNextAction } = await import("./lib.js");
    assert.equal(
      normalizeReviewCycleNextAction(
        "post_clean_decision_record_and_advance_to_phase_c",
        "clean",
      ),
      "post_clean_decision_record_and_advance_to_phase_c",
    );
  });

  it("normalizes capped status to ask_over_cap_or_proceed", async () => {
    const { normalizeReviewCycleNextAction } = await import("./lib.js");
    assert.equal(
      normalizeReviewCycleNextAction("anything", "capped"),
      "ask_over_cap_or_proceed",
    );
  });

  it("passes findings actions through unchanged (vocabulary already matches)", async () => {
    const { normalizeReviewCycleNextAction } = await import("./lib.js");
    assert.equal(
      normalizeReviewCycleNextAction("fix_findings_and_reinvoke", "findings"),
      "fix_findings_and_reinvoke",
    );
    assert.equal(
      normalizeReviewCycleNextAction(
        "fix_findings_then_ask_over_cap_or_proceed",
        "findings",
      ),
      "fix_findings_then_ask_over_cap_or_proceed",
    );
  });

  it("passes post_failed-status actions through (the wrapper builds its own error envelope)", async () => {
    const { normalizeReviewCycleNextAction } = await import("./lib.js");
    // post_failed status: the cycle wrapper returns an error envelope before
    // this normalizer is reached in practice, but pass-through here keeps
    // the function pure and prevents surprise.
    assert.equal(
      normalizeReviewCycleNextAction("some_post_failure_action", "post_failed"),
      "some_post_failure_action",
    );
  });
});

describe("runCodexReviewCycle input validation (issue #934)", () => {
  // The cycle wrapper validates BEFORE the underlying review runs.
  // We can't hit the full flow without `gh`/`claude`, but we can verify
  // that invalid input never reaches the underlying review tool.

  it("refuses when repo_path is missing", async () => {
    const { runCodexReviewCycle } = await import("./lib.js");
    const r = await runCodexReviewCycle({
      repoPath: "",
      issueNumber: 1,
      uncommitted: true,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "codex_review_cycle_input_invalid");
  });

  it("refuses when issue_number is not a positive integer", async () => {
    const { runCodexReviewCycle } = await import("./lib.js");
    for (const bad of [0, -1, 1.5, "1", null, undefined]) {
      const r = await runCodexReviewCycle({
        repoPath: "/tmp",
        issueNumber: bad,
        uncommitted: true,
      });
      assert.equal(r.ok, false, `bad=${bad}`);
      assert.equal(r.error, "codex_review_cycle_input_invalid");
    }
  });

  it("refuses when uncommitted is not true (cycle tool is pre-push only)", async () => {
    const { runCodexReviewCycle } = await import("./lib.js");
    const r = await runCodexReviewCycle({
      repoPath: "/tmp",
      issueNumber: 1,
      uncommitted: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "codex_review_cycle_input_invalid");
    assert.match(r.message, /uncommitted/i);
  });
});

// ---------------------------------------------------------------------------
// reviewCycleFindings — reviewer result field reconciliation (issue #966)
// ---------------------------------------------------------------------------

describe("reviewCycleFindings — cycle-seam field reconciliation (issue #966)", () => {
  it("reads reviewer findings from .findings", async () => {
    const { reviewCycleFindings } = await import("./lib.js");
    const r = reviewCycleFindings({ ok: true, findings: [{ title: "a" }, { title: "b" }] });
    assert.equal(r.length, 2);
  });

  it("reads codex findings from .comments when .findings is absent", async () => {
    const { reviewCycleFindings } = await import("./lib.js");
    // runCodexReview returns its findings array under `comments`, not
    // `findings`. Before #966 the cycle seam read only `.findings`, so every
    // codex review was flattened to "0 findings" and the review was a no-op.
    const r = reviewCycleFindings({ ok: true, comments: [{ title: "x" }, { title: "y" }, { title: "z" }] });
    assert.equal(r.length, 3);
  });

  it("prefers .findings when both are present", async () => {
    const { reviewCycleFindings } = await import("./lib.js");
    const r = reviewCycleFindings({ findings: [{ title: "a" }], comments: [{ title: "b" }, { title: "c" }] });
    assert.equal(r.length, 1);
    assert.equal(r[0].title, "a");
  });

  it("returns [] when neither field is present or input is nullish", async () => {
    const { reviewCycleFindings } = await import("./lib.js");
    assert.deepEqual(reviewCycleFindings({ ok: true }), []);
    assert.deepEqual(reviewCycleFindings(null), []);
    assert.deepEqual(reviewCycleFindings(undefined), []);
  });
});

describe("renderReviewerEnvelope — findings-record renderer (issue #966)", () => {
  it("renders verdict, architectural read, and blocking findings from the envelope", async () => {
    const { renderReviewerEnvelope } = await import("./lib.js");
    const out = renderReviewerEnvelope({
      body: "",
      envelope: {
        verdict: "ship-with-fixes",
        architectural_read: "The change is sound but leaks an envelope.",
        blocking: [
          { classification: "one-off", title: "Null deref", path: "a.js", line: 12, body: "fix it" },
          { classification: "class", title: "Unvalidated input", path: "b.js" },
        ],
      },
    });
    assert.match(out, /ship-with-fixes/);
    assert.match(out, /leaks an envelope/);
    assert.match(out, /Blocking findings \(2\)/);
    assert.match(out, /\[one-off\]\*\* Null deref — `a\.js:12`/);
    assert.match(out, /\[class\]\*\* Unvalidated input/);
  });

  it("shows the architectural read and 'no blocking findings' on a clean review", async () => {
    const { renderReviewerEnvelope } = await import("./lib.js");
    const out = renderReviewerEnvelope({
      body: "",
      envelope: { verdict: "ship", architectural_read: "Clean — well-scoped.", blocking: [] },
    });
    assert.match(out, /Clean — well-scoped\./);
    assert.match(out, /No blocking findings/);
    assert.doesNotMatch(out, /_\(empty\)_/);
  });

  it("falls back to the raw body when the envelope is absent (parse failure)", async () => {
    const { renderReviewerEnvelope } = await import("./lib.js");
    assert.equal(renderReviewerEnvelope({ body: "raw prose" }), "raw prose");
    assert.equal(renderReviewerEnvelope({}), "");
    assert.equal(renderReviewerEnvelope(null), "");
  });
});
