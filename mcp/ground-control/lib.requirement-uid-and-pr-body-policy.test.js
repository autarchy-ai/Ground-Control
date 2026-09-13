// Requirement-UID recognition and PR-body policy-shape suites.
//
// Relocated from lib.appendsteptelemetry.test.js when that file was retired with the ADR-036 JSONL
// sink (issue #1354): these describe blocks cover still-active exported code — isRequirementUidToken,
// findRequirementUidTokens, EXACT_REQUIREMENT_UID_RE, checkPrBodyShape, and the live gc_render_pr_body
// tool (runRenderPrBody) — none of which the durable-telemetry change touched. Only the
// appendStepTelemetry/JSONL-writer suite was dropped. Test bodies are unchanged.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXACT_REQUIREMENT_UID_RE,
  PR_BODY_POLICY_CHECK_LINE,
  PR_REQUIREMENT_RE,
  buildPrBody,
  checkPrBodyShape,
  findRequirementUidTokens,
  isRequirementUidToken,
  runRenderPrBody,
} from "./lib.js";

describe("free-text UID recognition (isRequirementUidToken)", () => {
  // Asserted through the live helper rather than the raw PR_REQUIREMENT_RE
  // constant: the helper is what production calls, and the constant alone no
  // longer governs any gate (issue #1425).
  it("recognizes the established explicit UID forms", () => {
    for (const uid of ["GC-O007", "GC-O009", "GC-X001", "OBS-042", "GC-O-007"]) {
      assert.ok(isRequirementUidToken(uid), `should recognize ${uid}`);
    }
  });
  it("recognizes allocator-minted short UIDs (issue #1425)", () => {
    // RequirementUidAllocator.allocate() returns `${prefix}-${n}` with no
    // zero-padding, so the first nine UIDs of any prefix carry a single-digit
    // suffix and must still be found in free-form issue prose.
    for (const uid of ["APP-2", "APP-9", "A-1", "PLAT-10"]) {
      assert.ok(isRequirementUidToken(uid), `should recognize ${uid}`);
    }
  });
  it("does not recognize prose words or letters-only suffixes", () => {
    for (const bad of ["GC-OOPS", "lowercase-001", "GC_O007", "GC-", "prose", "notes"]) {
      assert.ok(!isRequirementUidToken(bad), `should not recognize ${bad}`);
    }
  });
  it("findRequirementUidTokens survives adjacent punctuation", async () => {
    // `.` and `_` are legal identity-corpus characters, so scanning for the UID
    // shape is required; splitting on non-corpus characters would leave
    // `GC-O007.` glued together and drop the sentence-final form (issue #1425).
    const { findRequirementUidTokens } = await import("./lib.js");
    assert.deepEqual(findRequirementUidTokens("Fixes GC-O007."), ["GC-O007"]);
    assert.deepEqual(findRequirementUidTokens("(APP-2), [GC-S001];"), ["APP-2", "GC-S001"]);
    assert.deepEqual(findRequirementUidTokens("GC-O007 and GC-O007 again"), ["GC-O007"]);
    assert.deepEqual(findRequirementUidTokens("no uids in this prose"), []);
    assert.deepEqual(findRequirementUidTokens(""), []);
  });
  it("requires the whole token to be the UID, not merely to contain one", () => {
    // PR_REQUIREMENT_RE itself is an unanchored search shape; the helper
    // anchors it so a structured value can never be a fragment of prose.
    assert.ok(PR_REQUIREMENT_RE.test("not really GC-O007"), "search shape matches inside prose");
    assert.ok(!isRequirementUidToken("not really GC-O007"));
    assert.ok(!isRequirementUidToken("GC-O007 cleanup"));
  });
});

describe("EXACT_REQUIREMENT_UID_RE (bounded structured-UID contract — issue #1425)", () => {
  // A stored requirement UID is project-local identity, not a value derivable
  // from RequirementUidAllocator's prefix grammar. The backend stores any
  // string up to 50 characters (`Requirement.uid` is @Column(length = 50))
  // and resolves it case-insensitively, so this validator enforces a bounded,
  // transport-safe scalar and leaves existence to the project-scoped lookup.
  let exact;
  before(async () => {
    ({ EXACT_REQUIREMENT_UID_RE: exact } = await import("./lib.js"));
  });
  it("accepts allocator-minted short UIDs", () => {
    // The regression that motivated issue #1425: `APP-2` is what
    // RequirementUidAllocator.allocate() returns for the second requirement
    // of prefix APP, and every tool rejected it.
    for (const uid of ["APP-2", "APP-9", "A-1", "PLAT-10"]) {
      assert.ok(exact.test(uid), `should accept ${uid}`);
    }
  });
  it("accepts the established explicit UID forms", () => {
    for (const uid of ["GC-O007", "GC-O009", "GC-O-007", "OBS-042"]) {
      assert.ok(exact.test(uid), `should accept ${uid}`);
    }
  });
  it("accepts legacy identifiers the backend can store", () => {
    // Identity is the backend's call, not a client-side grammar's. A UID that
    // does not exist must reach Ground Control and come back through the
    // RequestError / ErrorResponse path, not be refused as malformed input.
    for (const uid of ["lowercase-001", "GC_O007", "GC-OOPS"]) {
      assert.ok(exact.test(uid), `should accept ${uid}`);
    }
  });
  it("rejects values that are not a single bounded identifier", () => {
    for (const bad of [
      "not really GC-O007",
      "GC-O007 cleanup",
      " GC-O007 ",
      "prefix GC-O007 suffix",
      "",
      "GC-O007\nGC-O008",
      "GC-O007\tGC-O008",
    ]) {
      assert.ok(!exact.test(bad), `should reject '${bad}'`);
    }
  });
  it("rejects values over the backend's 50-character bound", () => {
    assert.ok(exact.test("A".repeat(50)), "50 characters is the bound");
    assert.ok(!exact.test("A".repeat(51)), "51 characters exceeds the bound");
  });
  it("free-text recognition is a strict subset of the identity corpus", async () => {
    // The invariant that stops the contract re-splitting (issue #1425): prose
    // scanning may under-recognize an unusual UID, but it must never accept one
    // the structured path would reject — including past the 50-character bound.
    const { isRequirementUidToken } = await import("./lib.js");
    for (const uid of ["APP-2", "GC-O007", "GC-O-007", "OBS-042", `${"A".repeat(48)}-1`]) {
      assert.ok(isRequirementUidToken(uid), `should recognize ${uid}`);
      assert.ok(exact.test(uid), `corpus must also accept ${uid}`);
    }
    for (const bad of [`${"A".repeat(49)}-1`, "prose", "notes", "GC-OOPS"]) {
      assert.ok(!isRequirementUidToken(bad), `should not recognize ${bad}`);
    }
  });
  it("rejects reserved-marker and Markdown-injection shapes", () => {
    // Broadening UID acceptance must not turn a UID field into a Markdown or
    // phase-marker injection channel.
    for (const bad of ["<!-- gc:final-report -->", "<!--gc:plan-->", "`GC-O007`", "[GC-O007](http://x)"]) {
      assert.ok(!exact.test(bad), `should reject '${bad}'`);
    }
  });
});

describe("checkPrBodyShape (policy-shape predicate)", () => {
  function goodBody(overrides = {}) {
    return buildPrBody({
      issueNumber: 868,
      changeClass: "source",
      requirementUids: ["GC-O007"],
      adrRefs: ["ADR-036"],
      summary: "ok",
      changes: ["thing"],
      traceability: { implements: ["GC-O007 ← a"], tests: ["GC-O007 ← b"] },
      changelogFragment: null,
      changelogMode: "release-please",
      ...overrides,
    });
  }
  it("accepts a well-formed renderer output", () => {
    assert.deepEqual(checkPrBodyShape(goodBody()), { ok: true });
  });
  it("rejects a body whose policy-gate check line was dropped (#1429)", () => {
    const body = goodBody().replace(PR_BODY_POLICY_CHECK_LINE, "- [x] whatever");
    const r = checkPrBodyShape(body);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes(PR_BODY_POLICY_CHECK_LINE)));
  });
  it("rejects a body missing a required header", () => {
    const body = goodBody().replace("## Traceability", "## Trace");
    const r = checkPrBodyShape(body);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /missing required header.*Traceability/.test(e)));
  });
  it("rejects a body whose Requirement UIDs section names nothing", () => {
    // The section bullet becomes prose rather than a single identifier. A
    // one-word placeholder would NOT be rejected: the gate has no Ground
    // Control lookup, so it cannot tell an unresolvable identifier from a real
    // one and deliberately does not try (issue #1425). What it does enforce is
    // that the section actually names something, in the shape of a UID.
    const body = goodBody().replace("- `GC-O007`", "- (no real UID here)");
    const r = checkPrBodyShape(body);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /requirement UID/.test(e)));
  });
  it("does NOT enforce deferral policy — that lives downstream (codex cycle-4 F1)", () => {
    // The structural shape gate intentionally does not catch deferral text;
    // the previous partial regex set was a subset of the canonical Python
    // classifier (tools/policy/deferral_cases.json) and gave false confidence.
    // Authoritative gates: block-defer-language.py PreToolUse hook on
    // `gh pr create/edit/comment`, AND bin/policy at completion-gate time.
    const body = goodBody({
      summary: "The auth caching is deferred to a follow-up PR.",
    });
    const r = checkPrBodyShape(body);
    assert.equal(r.ok, true, "structural shape gate ignores deferral language");
  });
  it("requires both '- IMPLEMENTS:' and '- TESTS:' markers", () => {
    const body = goodBody().replace("- IMPLEMENTS:", "- impl:");
    const r = checkPrBodyShape(body);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /IMPLEMENTS/.test(e)));
  });

  it("refuses when the Requirement UIDs SECTION has no UID and no '(none)' marker (codex cycle-3 F5)", () => {
    // Construct a body where ADR-036 appears (whole-body regex would match)
    // but the Requirement UIDs section itself is empty of UIDs and the
    // explicit '(none — ...)' marker. The section-scoped check must catch
    // this — concept confusion between ADR impact and requirement traceability.
    const body = goodBody().replace("- `GC-O007`", "- (no real UID here)");
    const r = checkPrBodyShape(body);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /## Requirement UIDs section/.test(e)),
      `expected section-scoped UID error; got: ${r.errors.join(" | ")}`);
  });

  it("accepts a requirement-free body where the section explicitly says '(none — ...)' and ADR refs satisfy the whole-body UID gate", () => {
    // Build a body via buildPrBody with empty requirementUids and ADR refs.
    // The Requirement UIDs section will contain '- (none — ...)'. The body
    // will carry 'ADR-036' which satisfies the WHOLE-BODY whole-token regex
    // (required for Python policy parity). The SECTION check accepts the
    // explicit '(none)' marker, so this body passes both predicates.
    const body = buildPrBody({
      issueNumber: 999,
      changeClass: "doc-only",
      requirementUids: [],
      adrRefs: ["ADR-036"],
      summary: "doc",
      changes: ["fix typo"],
      traceability: { implements: [], tests: [] },
    });
    const r = checkPrBodyShape(body);
    assert.equal(r.ok, true, r.errors?.join("; "));
  });
});

describe("runRenderPrBody (policy enforcement at the tool boundary)", () => {
  function baseInput(overrides = {}) {
    return {
      repoPath: path.resolve(process.cwd(), "../.."),
      issueNumber: 868,
      changeClass: "source",
      requirementUids: ["GC-O007"],
      adrRefs: ["ADR-036"],
      summary: "ok",
      changes: ["thing"],
      traceability: { implements: ["GC-O007 ← a"], tests: ["GC-O007 ← b"] },
      changelogFragment: null,
      changelogMode: "release-please",
      ...overrides,
    };
  }
  it("returns ok=true with a policy-clean body for a valid source-class input", async () => {
    const r = await runRenderPrBody(baseInput());
    assert.equal(r.ok, true);
    assert.ok(r.body.includes("## Summary"));
    assert.ok(r.byte_length > 0);
  });
  it("rejects release-please mode when the target repo has no Release Please config", async () => {
    const repoPath = mkdtempSync(path.join(tmpdir(), "gc-pr-body-"));
    try {
      const r = await runRenderPrBody(baseInput({ repoPath }));
      assert.equal(r.ok, false);
      assert.equal(r.error, "pr_body_changelog_mode_mismatch");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
  it("rejects fragment mode when the target repo uses Release Please", async () => {
    const repoPath = mkdtempSync(path.join(tmpdir(), "gc-pr-body-"));
    try {
      writeFileSync(path.join(repoPath, "release-please-config.json"), "{}\n");
      const r = await runRenderPrBody(baseInput({
        repoPath,
        changelogMode: "fragments",
        changelogFragment: "changelog.d/868.changed.md",
      }));
      assert.equal(r.ok, false);
      assert.equal(r.error, "pr_body_changelog_mode_mismatch");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
  it("renders bodies whose caller-supplied fields contain deferral language — downstream catches it (codex cycle-4 F1)", async () => {
    // The JS-side Tier-1 detector was removed in the cycle-4 fix because it
    // was a partial subset of the Python classifier. The body is rendered
    // as supplied; the PreToolUse `block-defer-language.py` hook catches
    // the resulting `gh pr create` call, and `bin/policy` catches it at the
    // PR-body policy gate. This test pins the new contract: the renderer
    // does NOT short-circuit on deferral text; downstream is authoritative.
    const r = await runRenderPrBody(baseInput({
      summary: "The auth caching is deferred to a follow-up PR.",
    }));
    assert.equal(r.ok, true);
    assert.ok(r.body.includes("deferred to a follow-up PR"), "body is passed through verbatim");
  });
  it("delegates deferral-policy enforcement to downstream gates (codex cycle-4 F1)", async () => {
    // After the F1 fix, the runner renders the body verbatim and does not
    // enforce deferral policy. `gh pr create` triggers
    // block-defer-language.py (PreToolUse hook), and `bin/policy` enforces
    // run_no_deferral_disposition_check at CI / completion-gate time. The
    // MCP tool's job is rendering, not policy enforcement.
    const r = await runRenderPrBody(baseInput({
      summary: "Caching is deferred to a follow-up PR.",
    }));
    assert.equal(r.ok, true);
    assert.ok(r.body.includes("deferred to a follow-up PR"));
  });
  it("refuses with pr_body_input_invalid when a UID is not a single bounded identifier", async () => {
    // `GC-OOPS` is now accepted: it is a storable identifier and the
    // section-scoped policy gate recognizes it, so refusing it here would mean
    // a requirement that reconciles and reports could never be rendered into
    // the mandatory PR body (issue #1425). What stays refused is input that
    // cannot be one UID at all.
    const ok = await runRenderPrBody(baseInput({ requirementUids: ["GC-OOPS"] }));
    assert.equal(ok.ok, true, JSON.stringify(ok.errors ?? ok.error));
    const r = await runRenderPrBody(baseInput({ requirementUids: ["not a uid"] }));
    assert.equal(r.ok, false);
    assert.equal(r.error, "pr_body_input_invalid");
  });
  it("renders the ## Documentation section when documentation_outcome is supplied (issue #989)", async () => {
    // The MCP wrapper (index.js gc_render_pr_body) accepts documentation_outcome
    // and passes it through to runRenderPrBody; runRenderPrBody calls buildPrBody
    // which emits the ## Documentation section. This pins the contract that
    // the field actually reaches the renderer rather than getting dropped at
    // the wrapper boundary (issue #989 follow-up).
    const r = await runRenderPrBody(baseInput({
      documentation_outcome: { outcome: "updated" },
    }));
    assert.equal(r.ok, true);
    assert.ok(r.body.includes("## Documentation"), "rendered body should include the ## Documentation section");
    assert.ok(r.body.includes("Updated: see diff."), "rendered body should include the outcome prose");
  });
  it("renders an optional ## Dev-Start Gate section when supplied", async () => {
    const r = await runRenderPrBody(baseInput({
      devStartGate: [
        "## Dev-Start Gate",
        "",
        "- Source-bearing: yes",
        "- Requirement wave or gate: wave 0 readiness",
        "",
      ].join("\n"),
    }));
    assert.equal(r.ok, true);
    assert.ok(r.body.includes("## Dev-Start Gate"), "rendered body should include the dev-start gate section");
    assert.ok(r.body.includes("- Source-bearing: yes"));
  });
  it("renders the ## Documentation section with rationale for outcome=not_updated_authorized", async () => {
    const r = await runRenderPrBody(baseInput({
      documentation_outcome: {
        outcome: "not_updated_authorized",
        rationale: "diff is test-infra only; runtime docs unchanged",
      },
    }));
    assert.equal(r.ok, true);
    assert.ok(r.body.includes("## Documentation"));
    assert.ok(r.body.includes("Not updated (authorized)"));
    assert.ok(r.body.includes("diff is test-infra only"));
  });
  it("omits the ## Documentation section when documentation_outcome is absent", async () => {
    const r = await runRenderPrBody(baseInput());
    assert.equal(r.ok, true);
    assert.ok(!r.body.includes("## Documentation"), "body should not contain a Documentation section when the field is absent");
  });
});
