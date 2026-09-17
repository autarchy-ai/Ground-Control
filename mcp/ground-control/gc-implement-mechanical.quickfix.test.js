import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runImplementMechanical } from "./gc-implement-mechanical.js";

describe("runImplementMechanical quickfix lane", () => {
  it("refuses the implement-only readiness phase", async () => {
    let assertionCalls = 0;
    const result = await runImplementMechanical({
      action: "readiness",
      lane: "quickfix",
      repoPath: "/repo",
      issueNumber: 1637,
    }, {
      assertCompletion: async () => {
        assertionCalls += 1;
        return { ok: true };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "quickfix_readiness_not_applicable");
    assert.equal(result.next_action, "wait_for_user_merge_then_run_finalize");
    assert.equal(assertionCalls, 0);
  });

  it("uses the shared finalizer without implement-only outcome or review fields", async () => {
    let completionCall;
    const result = await runImplementMechanical({
      action: "finalize",
      lane: "quickfix",
      repoPath: "/repo",
      issueNumber: 1637,
      prNumber: 99,
      completion: {
        requirements: [],
        files: { modified: ["src/change.js"] },
        reviews: [],
        ci_status: "green",
        sonar_status: "passed",
        summary: "The narrow fix shipped.",
      },
    }, {
      assertCompletion: async (input) => {
        completionCall = input;
        return { ok: true, final_report: { comment_url: "https://github.test/final" } };
      },
      closeIssue: async () => ({ ok: true, closed: true }),
    });

    assert.equal(result.ok, true);
    assert.equal(completionCall.lane, "quickfix");
    assert.equal(completionCall.phase, "post_merge");
    assert.equal(completionCall.plainEnglishOutcome, undefined);
    assert.deepEqual(completionCall.reviews, []);
  });
});
