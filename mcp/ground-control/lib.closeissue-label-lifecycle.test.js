// The `in-progress` pickup label's other end (issue #1686).
//
// The label is applied when a lane takes an issue and was removed best-effort by the agent
// after Step 17. ADR-102 let the agent terminate at Phase D, so after a merge nothing runs
// but the workflow, and the step kept its place in the contract while losing its executor:
// every delivery closed still flagged in progress. It now happens at the shared close
// boundary, which every caller reaches.
//
// Every assertion here is on the request actually made. Best-effort cleanup swallows its own
// failures, so `ok: true` says nothing about whether the removal was attempted, and a
// negative assertion built on it would pass vacuously — the class issue #1685 is about.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restLinkedPullRequestRoutes } from "./github-rest.test-helpers.js";
import {
  LINKED_PR_URL,
  ISSUE_API_PATH,
  MARKER_TRUST_ROUTES,
  PR_MERGED_AT,
  makeShimRepo,
  withCloseResult,
} from "./close-issue-shim.fixture.test.js";

describe("runCloseIssueAfterMerge — pickup label lifecycle", () => {
// The label is applied at pickup and was removed best-effort by the agent after Step 17.
// ADR-102 lets the agent terminate at Phase D, so after a merge nothing runs but the
// workflow and the step lost its owner — every delivery closed carrying it (issue #1686).
// The assertions are on the request actually made: best-effort cleanup swallows its own
// failures, so `ok: true` proves nothing about whether the removal happened.
const LABEL_DELETE_PATH = `${ISSUE_API_PATH}/labels/in-progress`;
const removalCalls = (shim) => shim.calls().filter((argv) => argv.includes(LABEL_DELETE_PATH));

it("removes the in-progress label after closing the issue", async () => {
  const shim = makeShimRepo({
    ghHandler: {
      routes: [
        { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
        ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
            { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
        ] }),
        { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "open" }) },
        ...MARKER_TRUST_ROUTES,
        { argv_prefix: ["api", "--method", "PATCH"], stdout: JSON.stringify({ number: 1058, state: "closed" }) },
        // GitHub answers 204 with no body on a label removal.
        { argv_prefix: ["api", "--method", "DELETE"], stdout: "" },
      ],
    },
  });
  await withCloseResult(shim, 1058, (r) => {
    assert.equal(r.ok, true);
    const removals = removalCalls(shim);
    assert.equal(removals.length, 1, "the close must remove the label it no longer describes");
    // A single association, never a label replace (which would clobber a concurrent
    // edit) and never a repository label delete (which would hit every other issue).
    assert.equal(removals[0][2], "DELETE");
    assert.ok(removals[0].includes("github.com"), "the API host is pinned");
  });
});

it("removes the label on the already-closed path so a replay converges", async () => {
  const shim = makeShimRepo({
    ghHandler: {
      routes: [
        { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
        ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
            { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
        ] }),
        { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "closed" }) },
        { argv_prefix: ["api", "--method", "DELETE"], stdout: "" },
      ],
    },
  });
  await withCloseResult(shim, 1058, (r) => {
    assert.equal(r.already_closed, true);
    assert.equal(removalCalls(shim).length, 1);
  });
});

it("leaves the close successful when the label removal fails", async () => {
  const shim = makeShimRepo({
    ghHandler: {
      routes: [
        { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
        ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
            { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
        ] }),
        { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "open" }) },
        ...MARKER_TRUST_ROUTES,
        { argv_prefix: ["api", "--method", "PATCH"], stdout: JSON.stringify({ number: 1058, state: "closed" }) },
        // A 404 for an absent label, and every other cleanup failure, reads the same
        // way here: a delivery is not reported as failed because a cosmetic step was.
        { argv_prefix: ["api", "--method", "DELETE"], exit_code: 1, stderr: "gh: Not Found (HTTP 404)\n" },
      ],
    },
  });
  await withCloseResult(shim, 1058, (r) => {
    assert.equal(r.ok, true);
    assert.equal(r.already_closed, false);
    assert.equal(r.pr_number, 42);
    assert.equal(removalCalls(shim).length, 1, "it was attempted");
    assert.ok(!("label_removal_error" in r), "a cleanup failure adds nothing to the envelope");
  });
});

it("attempts no removal when the close is refused, because the work is still open", async () => {
  const shim = makeShimRepo({
    ghHandler: {
      routes: [
        { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
        ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
            { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
        ] }),
        { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "open" }) },
        // No trusted final-report marker: the close is refused.
        { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: JSON.stringify([[]]) },
      ],
    },
  });
  await withCloseResult(shim, 1058, (r) => {
    assert.equal(r.ok, false);
    assert.equal(r.error, "close_requirement_state_unverified");
    assert.deepEqual(removalCalls(shim), [], "an issue left open keeps the label");
  });
});

it("attempts no removal when the close patch itself fails", async () => {
  const shim = makeShimRepo({
    ghHandler: {
      routes: [
        { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
        ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
            { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
        ] }),
        { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "open" }) },
        ...MARKER_TRUST_ROUTES,
        { argv_prefix: ["api", "--method", "PATCH"], exit_code: 1, stderr: "gh: 502 Bad Gateway\n" },
      ],
    },
  });
  await withCloseResult(shim, 1058, (r) => {
    assert.equal(r.ok, false);
    assert.equal(r.error, "close_issue_patch_failed");
    assert.deepEqual(removalCalls(shim), []);
  });
});
});
