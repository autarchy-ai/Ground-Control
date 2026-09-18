// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MAX,
  INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MIN,
  INTEGRATION_MANAGER_MERGE_STRATEGIES,
  INTEGRATION_MANAGER_ORDERINGS,
  buildFinalReport,
  buildPrBody,
  buildSuggestedGroundControlYaml,
  isSafeLabelName,
  normalizeIntegrationManagerConfig,
  validateFinalReportInput,
  validatePrBodyInput,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Phase 5: validatePrBodyInput documentation_outcome field (issue #896)
// ---------------------------------------------------------------------------

describe("validatePrBodyInput documentation_outcome", () => {
  const BASE_INPUT = {
    issueNumber: 896,
    changeClass: "source",
    requirementUids: [],
    adrRefs: ["ADR-054"],
    summary: "Add documentation coverage gate.",
    changes: ["Added gc_documentation_coverage tool"],
    traceability: { implements: [], tests: [] },
    changelogFragment: "changelog.d/896.added.md",
  };

  it("accepts a valid documentation_outcome=updated", () => {
    const result = validatePrBodyInput({ ...BASE_INPUT, documentation_outcome: { outcome: "updated" } });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("accepts a valid documentation_outcome=verified_unchanged", () => {
    const result = validatePrBodyInput({ ...BASE_INPUT, documentation_outcome: { outcome: "verified_unchanged" } });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("accepts a valid documentation_outcome=not_updated_authorized with rationale", () => {
    const result = validatePrBodyInput({
      ...BASE_INPUT,
      documentation_outcome: { outcome: "not_updated_authorized", rationale: "Only test infra changed." },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("rejects invalid documentation_outcome value", () => {
    const result = validatePrBodyInput({ ...BASE_INPUT, documentation_outcome: { outcome: "skipped" } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("documentation_outcome")));
  });

  it("accepts missing documentation_outcome (field is optional)", () => {
    const result = validatePrBodyInput(BASE_INPUT);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// Phase 5: buildPrBody ## Documentation section (issue #896)
// ---------------------------------------------------------------------------

describe("buildPrBody documentation_outcome section", () => {
  const BASE_INPUT = {
    issueNumber: 896,
    changeClass: "source",
    requirementUids: [],
    adrRefs: ["ADR-054"],
    summary: "Add documentation coverage gate.",
    changes: ["Added gc_documentation_coverage tool"],
    traceability: { implements: [], tests: [] },
    changelogFragment: "changelog.d/896.added.md",
  };

  it("renders ## Documentation section for outcome=updated", () => {
    const body = buildPrBody({ ...BASE_INPUT, documentation_outcome: { outcome: "updated" } });
    assert.ok(body.includes("## Documentation"), "should include ## Documentation section");
    assert.ok(body.includes("Updated: see diff"), "should include 'Updated: see diff'");
  });

  it("renders ## Documentation section for outcome=verified_unchanged", () => {
    const body = buildPrBody({ ...BASE_INPUT, documentation_outcome: { outcome: "verified_unchanged" } });
    assert.ok(body.includes("## Documentation"));
    assert.ok(body.includes("Verified unchanged"));
  });

  it("renders ## Documentation section for outcome=not_updated_authorized with rationale", () => {
    const body = buildPrBody({
      ...BASE_INPUT,
      documentation_outcome: { outcome: "not_updated_authorized", rationale: "Only test infra changed." },
    });
    assert.ok(body.includes("## Documentation"));
    assert.ok(body.includes("Not updated (authorized)"));
    assert.ok(body.includes("Only test infra changed."));
  });

  it("omits ## Documentation section when documentation_outcome is absent", () => {
    const body = buildPrBody(BASE_INPUT);
    assert.ok(!body.includes("## Documentation"), "should not include ## Documentation when absent");
  });
});

// ---------------------------------------------------------------------------
// Phase 6: validateFinalReportInput documentation_outcome field (issue #896)
// ---------------------------------------------------------------------------

describe("validateFinalReportInput documentation_outcome", () => {
  const BASE_INPUT = {
    issueNumber: 896,
    prNumber: 999,
    requirements: [],
    reviews: [],
    traceability: {},
    ciStatus: "green",
    sonarStatus: "passed",
    plainEnglishOutcome: "Maintainers see what the workflow change enables in practical terms.",
  };

  it("accepts a valid documentation_outcome=updated", () => {
    const result = validateFinalReportInput({ ...BASE_INPUT, documentation_outcome: { outcome: "updated" } });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("rejects invalid documentation_outcome value", () => {
    const result = validateFinalReportInput({ ...BASE_INPUT, documentation_outcome: { outcome: "unknown" } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("documentation_outcome")));
  });

  it("accepts missing documentation_outcome (field is optional)", () => {
    const result = validateFinalReportInput(BASE_INPUT);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// Phase 6: buildFinalReport ## Documentation section (issue #896)
// ---------------------------------------------------------------------------

describe("buildFinalReport documentation_outcome section", () => {
  const BASE_INPUT = {
    issueNumber: 896,
    prNumber: 999,
    requirements: [],
    reviews: [],
    traceability: {},
    ciStatus: "green",
    sonarStatus: "passed",
    plainEnglishOutcome: "Maintainers see what the workflow change enables in practical terms.",
  };

  it("renders ## Documentation section for outcome=updated", () => {
    const body = buildFinalReport({ ...BASE_INPUT, documentation_outcome: { outcome: "updated" } });
    assert.ok(body.includes("## Documentation"), "should include ## Documentation section");
    assert.ok(body.includes("Updated: see diff"));
  });

  it("renders ## Documentation section for outcome=not_updated_authorized", () => {
    const body = buildFinalReport({
      ...BASE_INPUT,
      documentation_outcome: { outcome: "not_updated_authorized", rationale: "Only test fixture changed." },
    });
    assert.ok(body.includes("## Documentation"));
    assert.ok(body.includes("Not updated (authorized)"));
    assert.ok(body.includes("Only test fixture changed."));
  });

  it("omits ## Documentation section when documentation_outcome is absent", () => {
    const body = buildFinalReport(BASE_INPUT);
    assert.ok(!body.includes("## Documentation"), "should not include ## Documentation when absent");
  });
});

// ---------------------------------------------------------------------------
// Phase 7: buildSuggestedGroundControlYaml covers every parser key (issue #896)
// ---------------------------------------------------------------------------

describe("buildSuggestedGroundControlYaml covers all parser-accepted keys", () => {
  it("covers workflow.pr_title in the suggested template", () => {
    const yaml = buildSuggestedGroundControlYaml();
    assert.ok(yaml.includes("pr_title"), "template must mention pr_title");
  });

  it("does not emit the removed workflow.test_quality_review key", () => {
    const yaml = buildSuggestedGroundControlYaml();
    assert.ok(!yaml.includes("test_quality_review"), "template must omit test_quality_review");
  });

  it("covers architecture.vocabulary sub-schema keys in the suggested template", () => {
    const yaml = buildSuggestedGroundControlYaml();
    assert.ok(yaml.includes("vocabulary"), "template must mention vocabulary");
    assert.ok(yaml.includes("patterns"), "template must mention patterns");
    assert.ok(yaml.includes("canonical_helpers"), "template must mention canonical_helpers");
    assert.ok(yaml.includes("boundary_contract"), "template must mention boundary_contract");
    assert.ok(yaml.includes("binding_adrs"), "template must mention binding_adrs");
    assert.ok(yaml.includes("anti_recommendations"), "template must mention anti_recommendations");
  });
});

// ---------------------------------------------------------------------------
// isSafeLabelName (issue #989)
// ---------------------------------------------------------------------------

describe("isSafeLabelName", () => {
  it("accepts a normal label", () => {
    assert.equal(isSafeLabelName("approved-for-integration"), true);
  });

  it("accepts a label with internal spaces", () => {
    assert.equal(isSafeLabelName("approved for integration"), true);
  });

  it("rejects empty string", () => {
    assert.equal(isSafeLabelName(""), false);
  });

  it("rejects labels with leading whitespace", () => {
    assert.equal(isSafeLabelName(" approved"), false);
  });

  it("rejects labels with trailing whitespace", () => {
    assert.equal(isSafeLabelName("approved "), false);
  });

  it("rejects labels with control characters", () => {
    assert.equal(isSafeLabelName("foo\x01bar"), false);
  });

  it("rejects labels with newline", () => {
    assert.equal(isSafeLabelName("foo\nbar"), false);
  });

  it("rejects labels with non-ASCII characters", () => {
    assert.equal(isSafeLabelName("approved-für-integration"), false);
  });

  it("rejects labels longer than 50 chars", () => {
    assert.equal(isSafeLabelName("a".repeat(51)), false);
  });

  it("accepts exactly 50-char label (boundary)", () => {
    assert.equal(isSafeLabelName("a".repeat(50)), true);
  });

  it("rejects null", () => {
    assert.equal(isSafeLabelName(null), false);
  });

  it("rejects numeric input", () => {
    assert.equal(isSafeLabelName(123), false);
  });

  it("rejects undefined", () => {
    assert.equal(isSafeLabelName(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// normalizeIntegrationManagerConfig (issue #989)
// ---------------------------------------------------------------------------

describe("normalizeIntegrationManagerConfig", () => {
  const emptyValue = { approval_label: null, ordering: null, max_queue_size: null, merge_strategy: null };

  it("accepts null → returns ok with all-null value", () => {
    const r = normalizeIntegrationManagerConfig(null);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, emptyValue);
  });

  it("accepts undefined → returns ok with all-null value", () => {
    const r = normalizeIntegrationManagerConfig(undefined);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, emptyValue);
  });

  it("accepts empty object → returns ok with all-null value", () => {
    const r = normalizeIntegrationManagerConfig({});
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, emptyValue);
  });

  it("accepts a complete valid block", () => {
    const r = normalizeIntegrationManagerConfig({
      approval_label: "foo",
      ordering: "pr_number_asc",
      max_queue_size: 10,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { approval_label: "foo", ordering: "pr_number_asc", max_queue_size: 10, merge_strategy: null });
  });

  it("rejects non-object string", () => {
    const r = normalizeIntegrationManagerConfig("string");
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  });

  it("rejects array", () => {
    const r = normalizeIntegrationManagerConfig([]);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  });

  it("rejects numeric", () => {
    const r = normalizeIntegrationManagerConfig(42);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  });

  it("rejects unknown key — error message names the key", () => {
    const r = normalizeIntegrationManagerConfig({ bogus: true });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("bogus")), JSON.stringify(r.errors));
  });

  it("rejects multiple unknown keys — error array contains both", () => {
    const r = normalizeIntegrationManagerConfig({ bogus: true, another: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("bogus")), JSON.stringify(r.errors));
    assert.ok(r.errors.some((e) => e.includes("another")), JSON.stringify(r.errors));
  });

  it("rejects bad approval_label (empty string)", () => {
    const r = normalizeIntegrationManagerConfig({ approval_label: "" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("approval_label")), JSON.stringify(r.errors));
  });

  it("rejects bad approval_label (leading whitespace)", () => {
    const r = normalizeIntegrationManagerConfig({ approval_label: " bad" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("approval_label")), JSON.stringify(r.errors));
  });

  it("rejects bad approval_label (control character)", () => {
    const r = normalizeIntegrationManagerConfig({ approval_label: "foo\x01bar" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("approval_label")), JSON.stringify(r.errors));
  });

  it("rejects bad approval_label (oversized > 50 chars)", () => {
    const r = normalizeIntegrationManagerConfig({ approval_label: "a".repeat(51) });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("approval_label")), JSON.stringify(r.errors));
  });

  it("rejects bad ordering (unknown enum value)", () => {
    const r = normalizeIntegrationManagerConfig({ ordering: "newest_first" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("ordering")), JSON.stringify(r.errors));
    // Error must list allowed values
    assert.ok(r.errors.some((e) => e.includes("pr_number_asc")), JSON.stringify(r.errors));
  });

  it("accepts ordering pr_number_asc", () => {
    const r = normalizeIntegrationManagerConfig({ ordering: "pr_number_asc" });
    assert.equal(r.ok, true);
    assert.equal(r.value.ordering, "pr_number_asc");
  });

  it("accepts ordering pr_number_desc", () => {
    const r = normalizeIntegrationManagerConfig({ ordering: "pr_number_desc" });
    assert.equal(r.ok, true);
    assert.equal(r.value.ordering, "pr_number_desc");
  });

  it("accepts ordering approved_at_asc", () => {
    const r = normalizeIntegrationManagerConfig({ ordering: "approved_at_asc" });
    assert.equal(r.ok, true);
    assert.equal(r.value.ordering, "approved_at_asc");
  });

  it("rejects max_queue_size of zero", () => {
    const r = normalizeIntegrationManagerConfig({ max_queue_size: 0 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("max_queue_size")), JSON.stringify(r.errors));
  });

  it("rejects max_queue_size of negative", () => {
    const r = normalizeIntegrationManagerConfig({ max_queue_size: -1 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("max_queue_size")), JSON.stringify(r.errors));
  });

  it("rejects max_queue_size of 101", () => {
    const r = normalizeIntegrationManagerConfig({ max_queue_size: 101 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("max_queue_size")), JSON.stringify(r.errors));
  });

  it("rejects non-integer max_queue_size (5.5)", () => {
    const r = normalizeIntegrationManagerConfig({ max_queue_size: 5.5 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("max_queue_size")), JSON.stringify(r.errors));
  });

  it("rejects string max_queue_size", () => {
    const r = normalizeIntegrationManagerConfig({ max_queue_size: "5" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("max_queue_size")), JSON.stringify(r.errors));
  });

  it("accepts max_queue_size 1 (lower bound)", () => {
    const r = normalizeIntegrationManagerConfig({ max_queue_size: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.value.max_queue_size, 1);
  });

  it("accepts max_queue_size 100 (upper bound)", () => {
    const r = normalizeIntegrationManagerConfig({ max_queue_size: 100 });
    assert.equal(r.ok, true);
    assert.equal(r.value.max_queue_size, 100);
  });

  it("accumulates errors: two bad fields returns both errors", () => {
    const r = normalizeIntegrationManagerConfig({ ordering: "bad_ordering", max_queue_size: 0 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("ordering")), JSON.stringify(r.errors));
    assert.ok(r.errors.some((e) => e.includes("max_queue_size")), JSON.stringify(r.errors));
    assert.ok(r.errors.length >= 2, `expected >= 2 errors, got: ${JSON.stringify(r.errors)}`);
  });

  it("INTEGRATION_MANAGER_ORDERINGS constant is exported and complete", () => {
    assert.deepEqual(INTEGRATION_MANAGER_ORDERINGS, ["pr_number_asc", "pr_number_desc", "approved_at_asc"]);
  });

  it("INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MIN is 1", () => {
    assert.equal(INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MIN, 1);
  });

  it("INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MAX is 100", () => {
    assert.equal(INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MAX, 100);
  });

  // merge_strategy tests (issue #989 merge carve-out)

  it("accepts merge_strategy=merge", () => {
    const r = normalizeIntegrationManagerConfig({ merge_strategy: "merge" });
    assert.equal(r.ok, true);
    assert.equal(r.value.merge_strategy, "merge");
  });

  it("accepts merge_strategy=squash", () => {
    const r = normalizeIntegrationManagerConfig({ merge_strategy: "squash" });
    assert.equal(r.ok, true);
    assert.equal(r.value.merge_strategy, "squash");
  });

  it("accepts merge_strategy=rebase", () => {
    const r = normalizeIntegrationManagerConfig({ merge_strategy: "rebase" });
    assert.equal(r.ok, true);
    assert.equal(r.value.merge_strategy, "rebase");
  });

  it("rejects bad merge_strategy (unknown enum value)", () => {
    const r = normalizeIntegrationManagerConfig({ merge_strategy: "fast-forward" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("merge_strategy")), JSON.stringify(r.errors));
    assert.ok(r.errors.some((e) => e.includes("merge")), JSON.stringify(r.errors));
  });

  it("absent merge_strategy → merge_strategy is null", () => {
    const r = normalizeIntegrationManagerConfig({});
    assert.equal(r.ok, true);
    assert.equal(r.value.merge_strategy, null);
  });

  it("INTEGRATION_MANAGER_MERGE_STRATEGIES constant is exported and complete", () => {
    assert.deepEqual(INTEGRATION_MANAGER_MERGE_STRATEGIES, ["merge", "squash", "rebase"]);
  });
});
