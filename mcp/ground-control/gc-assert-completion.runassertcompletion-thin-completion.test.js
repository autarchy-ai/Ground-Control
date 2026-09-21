// Thin post-merge completion contract (issue #1500). Traceability reconciliation is
// retired with the backend: runAssertCompletion no longer runs a server-side
// reconcile assertion, so the post-merge happy path carries an empty assertions[]
// and depends only on the gh/git gates — merge state, open-obligation scrub, and the
// runPostFinalReport gates (CI green, Sonar pass-or-legit-skipped, mandatory Codex
// review). These tests are entirely hermetic: a gh route shim stands in for GitHub
// and there is no backend to mock.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAssertCompletion } from "./lib.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";
import { makeCompletionShimRepo, makeFailShimRepo, withShimPath } from "./gc-assert-completion.test-helpers.js";

// ---------------------------------------------------------------------------
// Happy path — no in-scope requirements, ci green / sonar skipped, codex review
// present, PR merged → ok:true. The gate records trusted published-review
// evidence without restoring the removed GRC reconciliation assertion.
// ---------------------------------------------------------------------------

describe("runAssertCompletion — thin post-merge happy path", () => {
  it("returns ok:true with published-review evidence and a final report", async () => {
    const shim = makeCompletionShimRepo({ comments: [], commentIdSeq: [9500, 9501, 9502] });
    try {
      const r = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 1103,
          prNumber: 42,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
          ciStatus: "green",
          sonarStatus: "skipped",
          plainEnglishOutcome: "Consolidates Phase D completion into a single tool call.",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(r.ok, true, `expected ok:true; got: ${JSON.stringify(r)}`);
      assert.ok(Array.isArray(r.assertions));
      assert.deepEqual(r.assertions, [{
        // Issue #1679 (core-F2): the delivery being completed is the delivery
        // that was synchronized, not merely one on the same branch.
        name: "delivery_head_synchronized",
        ok: true,
        head_sha: "a".repeat(40),
        settled_tree_oid: "1".repeat(40),
        synchronization_record_id: "4".repeat(32),
      }, {
        name: "codex_review_published",
        ok: true,
        comment_id: 8999,
        // Issue #1679: the assertion names what the publication actually covered.
        revision_digest: "c".repeat(64),
        candidate_tree_oid: "1".repeat(40),
        findings_count: 0,
        branch: "1103-branch",
      }, {
        // Issue #1679: the record and the publication are asserted as one chain,
        // not as two independent checks.
        name: "delivery_binding_current",
        ok: true,
        review_publication_id: "a".repeat(64),
        review_revision_digest: "c".repeat(64),
      }]);
      assert.ok(r.final_report != null);
      assert.ok(typeof r.final_report.comment_url === "string");
    } finally {
      shim.cleanup();
    }
  });

  // The lane is read from the run's recorded pickup (issue #1679); this case models
  // a branch picked up as /quickfix and synchronized under that lane. Derivation
  // itself is exercised in lib.run-lane-evidence-1679.test.js.
  it("posts the slim quickfix report after merge without review or implement-only outcome", async () => {
    const shim = makeCompletionShimRepo({ comments: [], commentIdSeq: [9510, 9511], syncLane: "quickfix" });
    try {
      const r = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 1103,
          prNumber: 42,
          lane: "quickfix",
          requirements: [],
          reviews: [],
          ciStatus: "green",
          sonarStatus: "skipped",
          summary: "The bounded quickfix shipped.",
        }, {
          workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir),
          laneReader: async () => ({ ok: true, lane: "quickfix" }),
        }),
      );
      assert.equal(r.ok, true, `expected ok:true; got: ${JSON.stringify(r)}`);
      // No review assertion - that is the waiver - but the delivery is still bound
      // to the head that was synchronized, under a quickfix record (issue #1679).
      assert.deepEqual(r.assertions.map((assertion) => assertion.name), [
        "delivery_head_synchronized",
        "delivery_binding_current",
      ]);
      assert.equal(r.assertions[1].review_publication_id, "-");
      assert.ok(typeof r.final_report.comment_url === "string");
    } finally {
      shim.cleanup();
    }
  });

  // core-F1 / security-F2 (cycle 4): finalize forwarded the caller's lane, and
  // completion skipped the entire delivery chain when it read 'quickfix'. So a
  // caller could finalize an ordinary /implement run as a quickfix and post a
  // trusted final report with no synchronized head and no published review.
  for (const [label, derived, expected] of [
    ["a run that was never picked up as /quickfix",
      { ok: true, lane: "implement" }, "completion_lane_mismatch"],
  ]) {
    it(`refuses to finalize ${label} as a quickfix`, async () => {
      const shim = makeCompletionShimRepo({ comments: [], commentIdSeq: [9520, 9521] });
      try {
        const r = await withShimPath(shim.binDir, () =>
          runAssertCompletion({
            repoPath: shim.repoDir,
            issueNumber: 1103,
            prNumber: 42,
            lane: "quickfix",
            requirements: [],
            reviews: [],
            ciStatus: "green",
            sonarStatus: "skipped",
            summary: "The bounded quickfix shipped.",
          }, {
            workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir),
            laneReader: async () => derived,
          }),
        );
        assert.equal(r.ok, false);
        assert.equal(r.error, expected);
        assert.equal(r.final_report, null, "no final report may be posted on a caller-chosen waiver");
      } finally {
        shim.cleanup();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Malformed final-report input → early ok:false BEFORE any side effects.
// ---------------------------------------------------------------------------

describe("runAssertCompletion — malformed input early rejection", () => {
  it("returns ok:false with completion_final_report_input_invalid before any gh call", async () => {
    const shim = makeFailShimRepo();
    try {
      const r = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 1103,
          prNumber: -1, // invalid → validateFinalReportInput returns ok:false
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
          ciStatus: "green",
          sonarStatus: "skipped",
          plainEnglishOutcome: "Consolidates Phase D completion into a single tool call.",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "completion_final_report_input_invalid");
      assert.ok(Array.isArray(r.assertions));
      assert.equal(r.assertions.length, 0);
      assert.equal(r.final_report, null);
    } finally {
      shim.cleanup();
    }
  });
});
