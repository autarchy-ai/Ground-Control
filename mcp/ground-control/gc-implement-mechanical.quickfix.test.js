import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runImplementMechanical } from "./gc-implement-mechanical.js";

describe("runImplementMechanical quickfix lane", () => {
  // Issue #1671: readiness is lane-discriminated rather than implement-only. The quickfix
  // lane records the delivery handoff so a merged quickfix PR finalizes without an agent,
  // but it still gains no pre-merge report and none of /implement's requirement or review
  // gates — the slim outcome is written by the finalizer, exactly as before.
  it("records the delivery handoff without an implement-only pre-merge report", async () => {
    let assertionCalls = 0;
    let recorded;
    const result = await runImplementMechanical({
      action: "readiness",
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
      },
    }, {
      assertCompletion: async () => {
        assertionCalls += 1;
        return { ok: true };
      },
      readRemoteGates: async () => ({ ok: true, passed: true, state: "OPEN", head_sha: "c".repeat(40) }),
      recordDeliveryReadiness: async (input) => {
        recorded = input;
        return { ok: true, record_comment_id: 7 };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.lane, "quickfix");
    assert.equal(result.next_action, "wait_for_user_to_merge_the_pr");
    assert.equal(result.readiness_report, undefined);
    assert.equal(assertionCalls, 0);
    assert.equal(recorded.lane, "quickfix");
    assert.equal(recorded.headSha, "c".repeat(40));
  });

  it("refuses to record a handoff when the current head's hosted checks are not green", async () => {
    let recordCalls = 0;
    const result = await runImplementMechanical({
      action: "readiness",
      lane: "quickfix",
      repoPath: "/repo",
      issueNumber: 1637,
      prNumber: 99,
      completion: { requirements: [], files: {}, reviews: [], ci_status: "green", sonar_status: "passed" },
    }, {
      readRemoteGates: async () => ({ ok: true, passed: false, state: "OPEN", head_sha: "c".repeat(40) }),
      recordDeliveryReadiness: async () => {
        recordCalls += 1;
        return { ok: true };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(recordCalls, 0);
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

describe("runImplementMechanical implement-lane readiness", () => {
  it("binds the handoff to the head its own readiness gate verified, with no second read", async () => {
    let recorded;
    let gateReads = 0;
    const result = await runImplementMechanical({
      action: "readiness",
      repoPath: "/repo",
      issueNumber: 1671,
      prNumber: 1680,
      completion: { requirements: [], files: {}, reviews: [], ci_status: "green", sonar_status: "passed" },
    }, {
      assertCompletion: async () => ({ ok: true, readiness_report: { comment_id: 5 }, head_sha: "d".repeat(40) }),
      readRemoteGates: async () => { gateReads += 1; return { ok: true, passed: true, state: "OPEN", head_sha: "e".repeat(40) }; },
      recordDeliveryReadiness: async (input) => { recorded = input; return { ok: true, record_comment_id: 9 }; },
    });

    assert.equal(result.ok, true);
    assert.equal(recorded.lane, "implement");
    assert.equal(recorded.headSha, "d".repeat(40));
    assert.equal(gateReads, 0, "the implement lane reuses the head readiness already verified");
  });

  it("records no handoff when the readiness gate itself refuses", async () => {
    let recordCalls = 0;
    const result = await runImplementMechanical({
      action: "readiness",
      repoPath: "/repo",
      issueNumber: 1671,
      prNumber: 1680,
      completion: { requirements: [], files: {}, reviews: [], ci_status: "green", sonar_status: "passed" },
    }, {
      assertCompletion: async () => ({ ok: false, error: "completion_hosted_checks_not_green", message: "red" }),
      recordDeliveryReadiness: async () => { recordCalls += 1; return { ok: true }; },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "completion_hosted_checks_not_green");
    assert.equal(recordCalls, 0);
  });
});
