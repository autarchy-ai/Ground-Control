// `workflow.<reviewer>.non_verdict_retry_limit` parsing (issue #1476).
//
// Its own file because lib.parsegroundcontrolyaml.test.js is at the 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NON_VERDICT_RETRY_LIMIT_DEFAULT, parseGroundControlYaml, resolveNonVerdictRetryLimit } from "./lib.js";

function parseYamlLines(lines) {
  return parseGroundControlYaml(lines.join("\n"));
}

function reviewerBlock(reviewer, keys) {
  return parseYamlLines([
    "schema_version: 1",
    "project: x",
    "workflow:",
    `  ${reviewer}:`,
    ...keys,
    "",
  ]);
}

describe("workflow.<reviewer>.non_verdict_retry_limit", () => {
  for (const reviewer of ["codex_review"]) {
    it(`accepts an in-bounds ${reviewer}.non_verdict_retry_limit`, () => {
      const result = reviewerBlock(reviewer, ["    non_verdict_retry_limit: 2"]);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(result.value.workflow[reviewer].non_verdict_retry_limit, 2);
    });

    it(`accepts zero for ${reviewer} — opting out of automatic re-attempts`, () => {
      // Zero is meaningful here, unlike pre_push_cap: it means "never re-attempt", which is the
      // pre-#1476 behavior. A repo must be able to ask for exactly that.
      const result = reviewerBlock(reviewer, ["    non_verdict_retry_limit: 0"]);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(result.value.workflow[reviewer].non_verdict_retry_limit, 0);
    });

    it(`defaults ${reviewer}.non_verdict_retry_limit to null when unset`, () => {
      const result = reviewerBlock(reviewer, ["    pre_push_cap: 1"]);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      // null means "use the canonical module default", matching how pre_push_cap defers.
      assert.equal(result.value.workflow[reviewer].non_verdict_retry_limit, null);
      assert.equal(
        resolveNonVerdictRetryLimit(result.value.workflow[reviewer]),
        NON_VERDICT_RETRY_LIMIT_DEFAULT,
      );
    });

    it(`rejects a non-integer ${reviewer}.non_verdict_retry_limit`, () => {
      for (const bad of ["'two'", "1.5", "true"]) {
        const result = reviewerBlock(reviewer, [`    non_verdict_retry_limit: ${bad}`]);
        assert.equal(result.ok, false, `expected ${bad} to fail`);
        assert.ok(
          result.errors.some(
            (e) => e.includes("non_verdict_retry_limit") && e.includes("integer"),
          ),
          JSON.stringify(result.errors),
        );
      }
    });

    it(`rejects ${reviewer}.non_verdict_retry_limit outside [0, 2]`, () => {
      // The upper bound is small on purpose: a station that cannot be observed in three total
      // attempts is a hard external dependency, not something to keep hammering.
      for (const bad of ["-1", "3", "10"]) {
        const result = reviewerBlock(reviewer, [`    non_verdict_retry_limit: ${bad}`]);
        assert.equal(result.ok, false, `expected ${bad} to fail`);
        assert.ok(
          result.errors.some(
            (e) => e.includes("non_verdict_retry_limit") && e.includes("between 0 and 2"),
          ),
          JSON.stringify(result.errors),
        );
      }
    });
  }

  it("still rejects unknown keys in the reviewer block", () => {
    // The new key must not weaken the fail-closed allow-list.
    const result = reviewerBlock("codex_review", [
      "    non_verdict_retry_limit: 1",
      "    bogus: true",
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("unknown key")));
  });

});
