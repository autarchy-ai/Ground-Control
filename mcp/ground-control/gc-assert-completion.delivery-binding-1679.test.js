// Issue #1679: the completion phases bind a delivery to the review and the
// synchronized head that authorized it. Split from
// gc-assert-completion.runassertcompletion-thin-completion.test.js for the
// 500-line limit; the shim harness is shared through
// gc-assert-completion.test-helpers.js.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAssertCompletion } from "./lib.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";
import { makeCompletionShimRepo, withShimPath } from "./gc-assert-completion.test-helpers.js";

// core-F1 (cycle 1): the completion phases recorded the publication's branch and
// tree into a successful assertion without comparing either to the delivery, so a
// trusted publication produced on some other branch satisfied both phases. Naming
// evidence is not checking it.
describe("completion refuses a review that ran on another branch (#1679)", () => {
  it("refuses post_merge when the reviewed branch is not the branch the PR delivers", async () => {
    const shim = makeCompletionShimRepo({
      comments: [],
      commentIdSeq: [9600, 9601, 9602],
      reviewedBranch: "1103-some-other-branch",
    });
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

      assert.equal(r.ok, false);
      assert.equal(r.error, "completion_review_branch_mismatch");
      assert.equal(r.final_report, null, "no completion record may be posted on unbound evidence");
    } finally {
      shim.cleanup();
    }
  });
});

// core-F2 (cycle 2): branch equality does not establish that this delivery is the
// delivery that was synchronized. Another commit can land on the same branch after
// the pull request was created, and both completion phases would otherwise accept
// the earlier publication for it.
describe("completion refuses a head that was never synchronized (#1679)", () => {
  it("refuses when the PR head has moved past the synchronized delivery", async () => {
    const shim = makeCompletionShimRepo({
      comments: [],
      commentIdSeq: [9700, 9701, 9702],
      synchronizedHead: "b".repeat(40),
    });
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

      assert.equal(r.ok, false);
      assert.equal(r.error, "completion_delivery_head_unsynchronized");
      assert.match(r.message, /not bound to anything/);
      assert.equal(r.final_report, null);
    } finally {
      shim.cleanup();
    }
  });
});

// security-F2 (cycle 4): the completion phases passed the synchronization
// record's own lane into the binding check, so the lane-continuity check compared
// the record with itself and could never refuse. It now receives the lane derived
// from trusted records. A quickfix record carried into an implement completion
// would otherwise take the quickfix branch of the binding and skip every
// implement check.
describe("completion judges the record against the derived lane, not its own (#1679)", () => {
  it("refuses a quickfix synchronization record presented for an implement delivery", async () => {
    const shim = makeCompletionShimRepo({
      comments: [],
      commentIdSeq: [9800, 9801, 9802],
      syncLane: "quickfix",
    });
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
        }, {
          workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir),
          laneReader: async () => ({ ok: true, lane: "implement" }),
        }),
      );

      assert.equal(r.ok, false);
      assert.equal(r.error, "implement_delivery_binding_lane_mismatch");
      assert.equal(r.final_report, null);
    } finally {
      shim.cleanup();
    }
  });
});

// core-F1 (cycle 5): the quickfix waiver relaxes the review publication and
// nothing else, but both completion phases skipped the whole delivery chain for
// quickfix - head synchronization included. A commit pushed to a quickfix branch
// after synchronization could then be finalized without ever being synchronized.
describe("a quickfix delivery is still bound to its synchronized head (#1679)", () => {
  it("refuses to finalize a quickfix head that was never synchronized", async () => {
    const shim = makeCompletionShimRepo({
      comments: [],
      commentIdSeq: [9900, 9901],
      syncLane: "quickfix",
      synchronizedHead: "b".repeat(40),
    });
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
      assert.equal(r.ok, false);
      assert.equal(r.error, "completion_delivery_head_unsynchronized");
      assert.equal(r.final_report, null);
    } finally {
      shim.cleanup();
    }
  });
});
