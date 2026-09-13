// The pure Requirements-section transformer (issue #1569).
//
// The issue body's `## Requirements` section is the only in-scope authority four
// separate gates read. Nothing could write it for an existing issue, so a
// requirement introduced mid-run was invisible to Phase E. These tests pin the
// transformation the writer performs: it owns scope-bearing bullets, leaves every
// other byte alone, and is verified against the same extractor the gates use.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRequirementScopeOperation,
  extractInScopeRequirementUids,
  locateRequirementsSection,
} from "./lib/issue-requirements-scope.js";

const TITLES = {
  "GC-O007": "Gated Agentic Development Loop",
  "GC-O016": "Host-Wide Verification Resource Dispatcher",
  "GC-A001": "First",
};

function apply(body, operation, requirementUids, titleByUid = TITLES) {
  return applyRequirementScopeOperation(body, { operation, requirementUids, titleByUid });
}

describe("locateRequirementsSection", () => {
  it("targets the first Requirements section and stops at the next same-or-higher heading", () => {
    const body = "# Top\n\n## Requirements\n\n- GC-O007 — x\n\n## Next\n\nafter\n";
    const found = locateRequirementsSection(body);
    assert.equal(body.slice(found.contentStart, found.contentEnd), "\n- GC-O007 — x\n\n");
    assert.equal(found.level, 2);
  });

  it("returns null when no Requirements section exists", () => {
    assert.equal(locateRequirementsSection("## Problem\n\nnope\n"), null);
  });

  it("ignores a later duplicate Requirements heading", () => {
    const body = "## Requirements\n\n- GC-O007 — x\n\n## Other\n\n## Requirements\n\n- GC-A001 — y\n";
    const found = locateRequirementsSection(body);
    assert.equal(found.contentEnd, body.indexOf("## Other"));
  });
});

describe("applyRequirementScopeOperation — section shapes", () => {
  it("appends a canonical section when none exists", () => {
    const body = "## Problem\n\nThe gap.\n";
    const result = apply(body, "add", ["GC-O007"]);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.ok(result.body.startsWith(body), "every pre-existing byte is preserved");
    assert.match(result.body, /\n## Requirements\n\n- GC-O007 — Gated Agentic Development Loop\n$/);
    assert.deepEqual(extractInScopeRequirementUids(result.body), ["GC-O007"]);
  });

  it("adds the list under a section that held prose only, keeping the prose", () => {
    const body = "## Requirements\n\nReconcile to GC-O007 during planning.\n\n## Next\n\ntail\n";
    const result = apply(body, "add", ["GC-O007"]);
    assert.ok(result.body.includes("Reconcile to GC-O007 during planning."));
    assert.ok(result.body.includes("- GC-O007 — Gated Agentic Development Loop"));
    assert.ok(result.body.endsWith("## Next\n\ntail\n"), "the following section is untouched");
    assert.deepEqual(extractInScopeRequirementUids(result.body), ["GC-O007"]);
  });

  it("replaces an existing list in place and preserves the surrounding sections", () => {
    const body = "# T\n\n## Requirements\n\n- GC-A001 — First\n\n## After\n\nkeep\n";
    const result = apply(body, "add", ["GC-O007"]);
    assert.equal(
      result.body,
      "# T\n\n## Requirements\n\n- GC-A001 — First\n- GC-O007 — Gated Agentic Development Loop\n\n## After\n\nkeep\n",
    );
  });

  it("populates a Requirements heading that ends the body with no line terminator", () => {
    const body = "## Problem\n\nx\n\n## Requirements";
    const result = apply(body, "add", ["GC-O007"]);
    assert.equal(result.ok, true);
    assert.ok(
      !result.body.includes("## Requirements- "),
      "generated content must not be concatenated onto an unterminated heading line",
    );
    assert.deepEqual(extractInScopeRequirementUids(result.body), ["GC-O007"]);
  });

  it("leaves a later duplicate Requirements heading alone", () => {
    const body = "## Requirements\n\n- GC-A001 — First\n\n## Mid\n\n## Requirements\n\n- GC-O016 — x\n";
    const result = apply(body, "add", ["GC-O007"]);
    assert.ok(result.body.endsWith("## Mid\n\n## Requirements\n\n- GC-O016 — x\n"));
  });
});

describe("applyRequirementScopeOperation — byte preservation", () => {
  it("does not normalize CRLF line endings", () => {
    const body = "## Requirements\r\n\r\n- GC-A001 — First\r\n\r\n## After\r\n\r\nkeep\r\n";
    const result = apply(body, "add", ["GC-O007"]);
    assert.ok(!result.body.includes("\n\n\n"));
    assert.ok(result.body.endsWith("## After\r\n\r\nkeep\r\n"));
    assert.ok(result.body.includes("- GC-O007 — Gated Agentic Development Loop\r\n"));
    assert.deepEqual(extractInScopeRequirementUids(result.body), ["GC-A001", "GC-O007"]);
  });

  it("does not add a trailing newline to a body that lacks one outside the section", () => {
    const body = "## Requirements\n\n- GC-A001 — First\n\n## After\n\nno trailing newline";
    const result = apply(body, "add", ["GC-O007"]);
    assert.ok(result.body.endsWith("## After\n\nno trailing newline"));
  });
});

describe("applyRequirementScopeOperation — add is monotonic, remove is explicit", () => {
  it("never narrows scope on add", () => {
    const body = "## Requirements\n\n- GC-A001 — First\n- GC-O016 — x\n";
    const result = apply(body, "add", ["GC-O007"]);
    assert.deepEqual(result.requirementUids, ["GC-A001", "GC-O016", "GC-O007"]);
  });

  it("removes only the named UIDs and preserves the remaining order", () => {
    const body = "## Requirements\n\n- GC-A001 — First\n- GC-O016 — x\n- GC-O007 — y\n";
    const result = apply(body, "remove", ["GC-O016"]);
    assert.deepEqual(result.requirementUids, ["GC-A001", "GC-O007"]);
    assert.deepEqual(extractInScopeRequirementUids(result.body), ["GC-A001", "GC-O007"]);
  });

  it("reports a re-add of the current set as an unchanged no-op with an identical body", () => {
    const body = "## Requirements\n\nprose\n\n- GC-A001 (First)\n";
    const result = apply(body, "add", ["GC-A001"]);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.body, body, "older formatting is not rewritten by a semantic no-op");
  });

  it("reports removing an absent UID as an unchanged no-op", () => {
    const body = "## Requirements\n\n- GC-A001 — First\n";
    const result = apply(body, "remove", ["GC-O007"]);
    assert.equal(result.changed, false);
    assert.equal(result.body, body);
  });

  it("refuses duplicate caller entries rather than reinterpreting them", () => {
    const result = apply("## Requirements\n\n", "add", ["GC-O007", "GC-O007"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "issue_requirements_uids_duplicated");
  });

  it("refuses an empty UID list rather than treating it as permission to clear", () => {
    const result = apply("## Requirements\n\n- GC-A001 — First\n", "remove", []);
    assert.equal(result.ok, false);
    assert.equal(result.error, "issue_requirements_uids_invalid");
  });

  it("refuses an unknown operation", () => {
    const result = apply("## Requirements\n\n", "replace", ["GC-O007"]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "issue_requirements_operation_invalid");
  });
});

describe("applyRequirementScopeOperation — parser round-trip", () => {
  it("round-trips through the extractor the gates use", () => {
    for (const body of [
      "",
      "## Problem\n\nx\n",
      "## Requirements\n\nprose only\n",
      "## Requirements\n\n- GC-A001 — First\n",
      "#### Requirements\n\n- GC-A001 — First\n\n#### Tail\n\nz\n",
    ]) {
      const result = apply(body, "add", ["GC-O007", "GC-O016"]);
      assert.equal(result.ok, true, `failed for ${JSON.stringify(body)}`);
      assert.deepEqual(
        extractInScopeRequirementUids(result.body),
        result.requirementUids,
        `round-trip mismatch for ${JSON.stringify(body)}`,
      );
      assert.ok(result.requirementUids.includes("GC-O007"));
      assert.ok(result.requirementUids.includes("GC-O016"));
    }
  });

  it("renders a bare UID bullet when no title is known", () => {
    const result = apply("## Requirements\n\n", "add", ["GC-O007"], {});
    assert.ok(result.body.includes("- GC-O007\n"));
    assert.deepEqual(extractInScopeRequirementUids(result.body), ["GC-O007"]);
  });

  it("collapses a multi-line title so one requirement cannot become two bullets", () => {
    const result = apply("## Requirements\n\n", "add", ["GC-O007"], {
      "GC-O007": "Gated\n- GC-A001 injected",
    });
    assert.deepEqual(extractInScopeRequirementUids(result.body), ["GC-O007"]);
  });
});
