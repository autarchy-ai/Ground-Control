// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PR_BODY_POLICY_CHECK_LINE,
  PR_BODY_SUMMARY_MAX,
  PR_BODY_TEST_NOTES_MAX,
  buildFinalReport,
  buildPrBody,
  checkPrBodyShape,
  runRenderPrBody,
  validatePrBodyInput,
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

describe("buildFinalReport", () => {
  it("renders a complete report with all sections", () => {
    const body = buildFinalReport({
      issueNumber: 868, prNumber: 871,
      requirements: [
        { uid: "GC-O007", title: "Gated Agentic Development Loop", status: "ACTIVE" },
        { uid: "GC-O009", title: "Temporal", status: "DRAFT", note: "forward-looking" },
      ],
      files: {
        added: ["a.js"],
        modified: ["b.js"],
        deleted: [],
        renamed: [],
      },
      reviews: [
        { reviewer: "codex", summary: "2 cycles, all fix, 0 remaining." },
        { reviewer: "codex", summary: "0 findings." },
      ],
      traceability: {
        added: ["IMPLEMENTS:GC-O007→a.js"],
        updated: [],
        deleted: [],
        notes: "Net new IMPLEMENTS coverage on the new tool files.",
      },
      ciStatus: "green",
      sonarStatus: "passed",
      planCommentUrl: "https://github.com/x/y/issues/868#issuecomment-1",
      plainEnglishOutcome: "Maintainers can tell what the shipped workflow change enables before they read the evidence checklist.",
    });
    assert.match(body, /gc:final-report/);
    assert.match(body, /## Final report — issue #868 complete/);
    assert.match(body, /\*\*PR:\*\* #871/);
    assert.match(body, /GC-O007/);
    assert.match(body, /GC-O009.*DRAFT.*forward-looking/);
    assert.match(body, /Files changed/);
    assert.match(body, /`a\.js`/);
    assert.match(body, /Reviews/);
    assert.match(body, /codex.*2 cycles/);
    assert.match(body, /Traceability reconciliation/);
    assert.match(body, /added: 1/);
    assert.match(body, /CI: ✅ green/);
    assert.match(body, /SonarCloud: ✅ passed/);
    assert.match(body, /PR ready for user review and merge/);
    assert.match(body, /### Outcome/);
    assert.match(body, /what the shipped workflow change enables/);
  });

  it("renders sonarcloud=skipped as 'skipped (no sonarcloud config)'", () => {
    const body = buildFinalReport({
      issueNumber: 1, prNumber: 2, requirements: [], reviews: [],
      ciStatus: "green", sonarStatus: "skipped",
      plainEnglishOutcome: "The report explains the practical result for operators.",
    });
    assert.match(body, /SonarCloud: skipped \(no sonarcloud config\)/);
  });

  it("omits the In-scope requirements section when requirements is empty, and retains populated sections", () => {
    // Covers both the requirement-free omission and the invariant that other sections
    // (e.g. Reviews) are not suppressed when requirements is empty.
    const body = buildFinalReport({
      issueNumber: 1, prNumber: 2,
      requirements: [],
      reviews: [{ reviewer: "codex", summary: "1 cycle, 0 findings." }],
      ciStatus: "green", sonarStatus: "passed",
      plainEnglishOutcome: "The report explains the practical result for operators.",
    });
    assert.ok(!body.includes("### In-scope requirements"), "heading must not appear when requirements is empty");
    assert.ok(!body.includes("bug/refactor/maintenance run"), "placeholder must not appear when requirements is empty");
    // Reviews section should still appear since reviews is non-empty.
    assert.match(body, /### Reviews/);
  });

  it("omits the Reviews section when reviews is empty", () => {
    const body = buildFinalReport({
      issueNumber: 1, prNumber: 2,
      requirements: [{ uid: "GC-O007", title: "Gated Loop", status: "ACTIVE" }],
      reviews: [],
      ciStatus: "green", sonarStatus: "passed",
      plainEnglishOutcome: "The report explains the practical result for operators.",
    });
    assert.ok(!body.includes("### Reviews"), "Reviews heading must not appear when reviews is empty");
    // In-scope requirements section should still appear.
    assert.match(body, /### In-scope requirements/);
    assert.match(body, /GC-O007/);
  });
});

describe("validatePrBodyInput", () => {
  function baseInput(overrides = {}) {
    return {
      issueNumber: 868,
      changeClass: "source",
      requirementUids: ["GC-O007"],
      adrRefs: ["ADR-036"],
      summary: "Add per-step routing.",
      changes: ["Added gc_post_decision_record"],
      traceability: { implements: ["GC-O007"], tests: ["GC-O007"] },
      changelogFragment: "changelog.d/868.changed.md",
      ...overrides,
    };
  }
  it("accepts a valid source-class input", () => {
    assert.equal(validatePrBodyInput(baseInput()).ok, true);
  });
  it("accepts doc-only without a changelog fragment", () => {
    const r = validatePrBodyInput(baseInput({ changeClass: "doc-only", changelogFragment: null }));
    assert.equal(r.ok, true);
  });
  it("rejects source without a changelog fragment", () => {
    const r = validatePrBodyInput(baseInput({ changelogFragment: null }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /requires a changelogFragment/.test(e)));
  });
  it("rejects UIDs that are not a single bounded identifier", () => {
    // The renderer shares the identity corpus (issue #1425), so the refusal is
    // for values that cannot be one UID, not for an allocator-shaped grammar.
    for (const bad of ["not a uid", "", `${"A".repeat(49)}-1`, "GC-O007 GC-O008"]) {
      const r = validatePrBodyInput(baseInput({ requirementUids: [bad] }));
      assert.equal(r.ok, false, `should reject '${bad}'`);
    }
  });
  it("rejects unknown change_class values", () => {
    const r = validatePrBodyInput(baseInput({ changeClass: "behavior-preserving" }));
    assert.equal(r.ok, false);
  });

  it("rejects non-fragment-shaped changelogFragment paths (codex cycle-4 F4)", () => {
    for (const bad of [
      "README.md",
      "changelog.d/foo.md", // missing <type>
      "changelog.d/868.bogus.md", // invalid type
      "changelog.d/sub/868.added.md", // nested
      "changelog.d/868.added", // missing .md
      "fragments/868.added.md", // wrong dir
    ]) {
      const r = validatePrBodyInput(baseInput({ changelogFragment: bad }));
      assert.equal(r.ok, false, `should reject ${bad}`);
      assert.ok(r.errors.some((e) => /changelogFragment/.test(e)), `error should mention changelogFragment for ${bad}`);
    }
  });

  it("accepts canonical fragment paths", () => {
    for (const good of [
      "changelog.d/868.added.md",
      "changelog.d/868.changed.md",
      "changelog.d/868.security.md",
      "changelog.d/+adhoc-slug.fixed.md",
    ]) {
      const r = validatePrBodyInput(baseInput({ changelogFragment: good }));
      assert.equal(r.ok, true, `should accept ${good}; errors=${r.errors?.join(";")}`);
    }
  });

  it("release-please mode: accepts source-class without a changelog fragment (#1336)", () => {
    const r = validatePrBodyInput(baseInput({ changelogMode: "release-please", changelogFragment: null }));
    assert.equal(r.ok, true, `errors=${r.errors?.join(";")}`);
  });
  it("release-please mode: rejects a changelog fragment (Release Please owns CHANGELOG.md)", () => {
    const r = validatePrBodyInput(baseInput({ changelogMode: "release-please", changelogFragment: "changelog.d/868.changed.md" }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /not accepted when changelogMode is 'release-please'/.test(e)));
  });
  it("rejects an unknown changelogMode", () => {
    const r = validatePrBodyInput(baseInput({ changelogMode: "bogus", changelogFragment: null }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /changelogMode/.test(e)));
  });

  assertSummaryByteCap(validatePrBodyInput, PR_BODY_SUMMARY_MAX, baseInput);
});

describe("buildPrBody", () => {
  function baseInput(overrides = {}) {
    return {
      issueNumber: 868,
      changeClass: "source",
      requirementUids: ["GC-O007", "GC-O009"],
      adrRefs: ["ADR-036", "ADR-021 (amended)"],
      summary: "Per-step routing + tool surfaces + telemetry.",
      changes: ["Added decision-record tool", "Added telemetry writer"],
      traceability: {
        implements: ["GC-O007 ← skills/implement/SKILL.md"],
        tests: ["GC-O007 ← mcp/ground-control/lib.test.js"],
      },
      changelogFragment: "changelog.d/868.changed.md",
      ...overrides,
    };
  }
  it("emits every required template header for source-class", () => {
    const body = buildPrBody(baseInput());
    for (const h of [
      "## Summary",
      "## Requirement UIDs",
      "## Related Issues",
      "## ADR Impact",
      "## Changes",
      "## Test Plan",
      "## Ground Control Checks",
      "## Traceability",
      "## Checklist",
    ]) {
      assert.ok(body.includes(h), `missing header: ${h}`);
    }
  });

  it("includes IMPLEMENTS and TESTS markers (policy: pr-traceability-summary)", () => {
    const body = buildPrBody(baseInput());
    assert.ok(body.includes("- IMPLEMENTS:"), "missing IMPLEMENTS marker");
    assert.ok(body.includes("- TESTS:"), "missing TESTS marker");
  });

  it("includes the exact repo-neutral Ground Control Checks lines (policy: pr-ground-control-checks)", () => {
    const body = buildPrBody(baseInput());
    assert.ok(body.includes(PR_BODY_POLICY_CHECK_LINE));
    assert.ok(body.includes("- [x] Pre-push Codex review completed; all findings fixed or dispositioned"));
    // The former checks named tools removed with the #1500 teardown (issue #1199).
    assert.ok(!body.includes("gc_evaluate_quality_gates"), "must not attest a removed tool");
    assert.ok(!body.includes("gc_run_sweep"), "must not attest a removed tool");
  });

  it("names the policy gate semantically, never a concrete repo command (#1429)", () => {
    // The rendered body is durable GitHub content shared by every consuming
    // repo. It states that the *configured* gate passed; it must not assert a
    // Make target the repo may not have, and must not copy command text
    // (which can carry repo-internal paths) into the record.
    const body = buildPrBody(baseInput());
    assert.equal(PR_BODY_POLICY_CHECK_LINE, "- [x] Repository policy checks required in CI before merge");
    assert.ok(!body.includes("`make policy`"), "PR body must not name a concrete policy command");
  });

  it("names the completion gate semantically too, for both change classes (#1429)", () => {
    // Same reason as the policy line: `completion_command` is repo config, so
    // a rendered `make check` is false in any repo that configures something
    // else. The issue's own notes call this out alongside `make policy`.
    for (const changeClass of ["source", "doc-only"]) {
      const body = buildPrBody(baseInput({
        changeClass,
        changelogFragment: changeClass === "doc-only" ? null : "changelog.d/868.changed.md",
      }));
      assert.ok(
        body.includes("- [x] Full completion suite required in CI before merge"),
        `${changeClass}: missing semantic completion line`,
      );
      for (const target of ["`make check`", "`make test`", "`make integration`"]) {
        assert.ok(!body.includes(target), `${changeClass}: must not name ${target}`);
      }
    }
  });

  it("emits a non-closing 'Refs #N' for a requirement-backed run (issue #1541)", () => {
    // baseInput() is requirement-backed (requirementUids: ["GC-O007"]); the issue must
    // NOT auto-close at merge ahead of Phase E merged-requirement-state validation.
    const body = buildPrBody(baseInput());
    assert.match(body, /Refs #868/);
    assert.ok(!/Closes #868/.test(body), "requirement-backed runs must not use the auto-closing keyword");
  });

  it("emits 'Closes #N' for a requirement-free run", () => {
    const body = buildPrBody(baseInput({ requirementUids: [], changeClass: "doc-only", changelogFragment: null, traceability: { implements: [], tests: [] } }));
    assert.match(body, /Closes #868/);
  });

  it("renders ADR Impact='No ADR required' when adrRefs is empty", () => {
    const body = buildPrBody(baseInput({ adrRefs: [] }));
    assert.match(body, /## ADR Impact[^]*No ADR required/);
  });

  it("doc-only marks integration tests N/A and the changelog fragment N/A", () => {
    const body = buildPrBody(baseInput({
      changeClass: "doc-only",
      changelogFragment: null,
    }));
    assert.match(body, /Unit tests \/ integration tests: N\/A — docs-only change/);
    assert.match(body, /Changelog fragment: N\/A — docs-only change/);
    // Even doc-only must keep the policy-gate line.
    assert.ok(body.includes(PR_BODY_POLICY_CHECK_LINE));
  });

  it("source+migration adds a repo-neutral migration reminder (no framework/test-class names)", () => {
    const body = buildPrBody(baseInput({ changeClass: "source+migration" }));
    assert.match(body, /\*\*Migration reminder:\*\*/);
    assert.ok(!body.includes("MigrationSmokeTest.java"), "must not name a Java test class");
    assert.ok(!body.includes("RequirementsE2EIntegrationTest.java"), "must not name a Java test class");
    assert.ok(!body.includes("Flyway"), "must not name a migration tool");
  });

  it("checklist is repo-neutral: no Java/domain rules or hardcoded doc path (#1199)", () => {
    const body = buildPrBody(baseInput());
    for (const forbidden of [
      "Envers",
      "@Audited",
      "No business logic in API layer",
      "Domain layer has no framework imports",
      "docs/CODING_STANDARDS.md",
    ]) {
      assert.ok(!body.includes(forbidden), `checklist must not include Java/domain claim: ${forbidden}`);
    }
    assert.ok(body.includes("- [x] Code follows the project's coding standards"), "keeps a neutral coding-standards line");
  });

  it("rejects test_notes over the byte cap (#1199)", () => {
    const r = validatePrBodyInput(baseInput({ testNotes: "x".repeat(PR_BODY_TEST_NOTES_MAX + 1) }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /testNotes exceeds/.test(e)), r.errors.join("; "));
  });

  it("runRenderPrBody rejects a final body over the GitHub PR-body cap (#1199)", async () => {
    // Each bullet passes element validation; the aggregate exceeds PR_BODY_MAX.
    const bigChanges = Array.from({ length: 400 }, (_, i) => `change ${i} ` + "y".repeat(200));
    const r = await runRenderPrBody(baseInput({ changes: bigChanges }));
    assert.equal(r.ok, false);
    assert.equal(r.error, "pr_body_too_large");
  });

  it("release-please mode: emits the Release Please changelog line, not a fragment line (#1336)", () => {
    const body = buildPrBody(baseInput({ changelogMode: "release-please", changelogFragment: null }));
    assert.match(body, /Changelog: owned by Release Please/);
    assert.ok(!/Changelog fragment added at/.test(body), "must not emit a fragment line in release-please mode");
  });

  it("requirement-free runs render an explicit '(none ...)' line — no synthetic UID injected", () => {
    const body = buildPrBody(baseInput({
      changeClass: "doc-only",
      requirementUids: [],
      changelogFragment: null,
    }));
    // Codex cycle-2 finding F1: do NOT fabricate a placeholder UID under
    // Requirement UIDs. The "(none — bug/refactor/maintenance run...)"
    // explicit marker preserves honest traceability.
    assert.match(body, /## Requirement UIDs\n\n- \(none/);
    assert.ok(!body.includes("- `GC-O007` (workflow-anchored"), "synthetic placeholder must not appear");
    // The PR-body policy gate still requires a UID-shaped token anywhere in
    // the body — satisfied here by the ADR refs (ADR-036 ...).
    assert.match(body, /ADR-036/);
  });

  it("requirement-free run with NO adrRefs passes the policy-shape gate on the explicit marker", async () => {
    // Previously this failed only because the whole-body UID scan found no
    // UID-shaped token anywhere, so a requirement-free doc PR had to cite an
    // unrelated ADR to satisfy a *requirement* gate. That is the concept
    // confusion section-scoping exists to remove (issue #1425); ADR impact is
    // still gated independently by the `pr-adr-impact` / ADR Impact check.
    const body = buildPrBody({
      issueNumber: 999,
      changeClass: "doc-only",
      requirementUids: [],
      adrRefs: [],
      summary: "doc fix",
      changes: ["fix typo"],
      traceability: { implements: [], tests: [] },
    });
    assert.match(body, /No ADR required/);
    const shape = checkPrBodyShape(body);
    assert.equal(shape.ok, true, JSON.stringify(shape.errors));
  });
});
