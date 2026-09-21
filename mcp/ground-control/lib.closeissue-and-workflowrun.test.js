// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restLinkedPullRequestRoutes } from "./github-rest.test-helpers.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";
// The route-replaying gh shim and the close-path fixtures moved to their own file when the
// label-lifecycle suite became a second consumer (issue #1686).
import {
  FINAL_REPORT_MARKER,
  ISSUE_API_PATH,
  LINKED_PR_URL,
  MARKER_TRUST_ROUTES,
  PR_MERGED_AT,
  makeShimRepo,
  slurpComments,
  withCloseResult,
  withShimPath,
} from "./close-issue-shim.fixture.test.js";

// ---------------------------------------------------------------------------
// gc_close_issue_after_merge (issue #1058)
// ---------------------------------------------------------------------------

describe("runCloseIssueAfterMerge", () => {
  it("throws on invalid issue_number (input validation)", async () => {
    const shim = makeShimRepo({ ghHandler: { routes: [] } });
    try {
      const { runCloseIssueAfterMerge } = await import("./lib.js");
      await assert.rejects(
        runCloseIssueAfterMerge({ repoPath: shim.repoDir, issueNumber: 0 }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
        /positive integer issue_number/,
      );
    } finally {
      shim.cleanup();
    }
  });

  it("refuses with close_no_linked_pr when no PR is linked to the issue", async () => {
    const shim = makeShimRepo({
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          // The REST issue timeline carries no PR cross-references.
          ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [] }),
        ],
      },
    });
    await withCloseResult(shim, 1058, (r) => {
        assert.equal(r.ok, false);
        assert.equal(r.error, "close_no_linked_pr");
    });
  });

  it("refuses with close_pr_not_merged when linked PR has merged_at=null and state=open", async () => {
    const shim = makeShimRepo({
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
              { number: 42, state: "OPEN", mergedAt: null, url: LINKED_PR_URL },
          ] }),
        ],
      },
    });
    await withCloseResult(shim, 1058, (r) => {
        assert.equal(r.ok, false);
        assert.equal(r.error, "close_pr_not_merged");
        assert.equal(r.pr_state, "OPEN");
        assert.equal(r.pr_merged_at, null);
    });
  });

  it("closes open issue when linked PR is merged", async () => {
    const shim = makeShimRepo({
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
              { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
          ] }),
          // Issue lookup — current state=open.
          { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "open" }) },
          // Trusted final-report marker gate (issue #1541).
          ...MARKER_TRUST_ROUTES,
          // PATCH close.
          { argv_prefix: ["api", "--method", "PATCH"], stdout: JSON.stringify({ number: 1058, state: "closed" }) },
        ],
      },
    });
    // ADR-089 §5: the close path performs ONLY linked-PR resolution,
    // merge-state verification, and idempotent close — no issue listing, no
    // ranking, and no recommendation field (not even null; a null field would
    // still advertise the retired feature).
    await withCloseResult(shim, 1058, (r) => {
        assert.equal(r.ok, true);
        assert.equal(r.already_closed, false);
        assert.equal(r.pr_number, 42);
        assert.equal(r.pr_merged_at, PR_MERGED_AT);
        assert.ok(!("next_issue_recommendation" in r), "next_issue_recommendation must not be present");
        assert.ok(!("next_issue_recommendation_reason" in r), "next_issue_recommendation_reason must not be present");
        assert.ok(!("next_issue_recommendation_source" in r), "next_issue_recommendation_source must not be present");
        assert.ok(!("next_issue_recommendation_error" in r), "next_issue_recommendation_error must not be present");
    });
  });

  it("idempotent no-op when issue is already closed", async () => {
    const shim = makeShimRepo({
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
              { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
          ] }),
          // Issue is already closed.
          { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "closed" }) },
        ],
      },
    });
    await withCloseResult(shim, 1058, (r) => {
        assert.equal(r.ok, true);
        assert.equal(r.already_closed, true);
        assert.equal(r.pr_number, 42);
    });
  });

  // Codex review cycle 1 (issue #1058): a caller-supplied pr_number must be
  // verified as linked to the issue before it gates the close. Without this
  // check, a caller could pass any merged PR + an unrelated issue number and
  // cause the wrong issue to close. The runner now resolves the issue's
  // timeline first and refuses if the supplied PR is not present.
  it("refuses with close_pr_not_linked_to_issue when supplied pr_number is not in the issue's timeline-linked PR set", async () => {
    const shim = makeShimRepo({
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          // Issue 1058's timeline links PR 42 (merged).
          ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
              { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
          ] }),
        ],
      },
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const { runCloseIssueAfterMerge } = await import("./lib.js");
        // Caller passes PR #99, which is NOT one of issue 1058's linked PRs.
        const r = await runCloseIssueAfterMerge({ repoPath: shim.repoDir, issueNumber: 1058, prNumber: 99 }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(r.ok, false);
        assert.equal(r.error, "close_pr_not_linked_to_issue");
        assert.deepEqual(r.linked_pr_numbers, [42]);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("uses the supplied pr_number when it IS in the issue's timeline-linked PR set", async () => {
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
        ],
      },
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const { runCloseIssueAfterMerge } = await import("./lib.js");
        const r = await runCloseIssueAfterMerge({ repoPath: shim.repoDir, issueNumber: 1058, prNumber: 42 }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(r.ok, true);
        assert.equal(r.already_closed, false);
        assert.equal(r.pr_number, 42);
      });
    } finally {
      shim.cleanup();
    }
  });

  // Issue #1541: closing an OPEN issue requires the trusted final-report marker so the
  // canonical close can never run ahead of merged requirement-state validation.
  it("refuses with close_requirement_state_unverified when no final-report marker is present", async () => {
    const shim = makeShimRepo({
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
              { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
          ] }),
          { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "open" }) },
          // No marker on the thread.
          { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: slurpComments([]) },
        ],
      },
    });
    await withCloseResult(shim, 1058, (r) => {
      assert.equal(r.ok, false);
      assert.equal(r.error, "close_requirement_state_unverified");
      assert.equal(r.next_action, "post_the_validated_final_report_first_or_post_a_trusted_override_authorization");
    });
  });

  // Locks the trust filter in hasTrustedFinalReportMarker: a final-report marker forged
  // by an author WITHOUT repo write must not authorize the close. Without this, dropping
  // the `trust.isTrusted` check would pass every other marker test (they use trusted
  // OWNER authors) — the class-7 asymmetry the test-quality reviewer flagged.
  it("does not honor a final-report marker forged by an author without repo write", async () => {
    const forged = { body: FINAL_REPORT_MARKER, user: { login: "stranger" }, author_association: "NONE" };
    const shim = makeShimRepo({
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
              { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
          ] }),
          { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "open" }) },
          { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: slurpComments([forged]) },
          // Non-collaborator: both the marker-trust and override-trust permission lookups 404.
          { argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/stranger/permission"], exit_code: 1, stderr: "HTTP 404" },
        ],
      },
    });
    await withCloseResult(shim, 1058, (r) => {
      assert.equal(r.ok, false);
      assert.equal(r.error, "close_requirement_state_unverified");
    });
  });

  it("closes without a final-report marker when a trusted issue-thread override authorizes this PR", async () => {
    const overrideComment = { body: "gc-authorize-merge-state-override pr=42 covered out of band", user: { login: "fake" }, author_association: "OWNER" };
    const shim = makeShimRepo({
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
              { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
          ] }),
          { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "open" }) },
          // Trusted override comment, no final-report marker.
          { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: slurpComments([overrideComment]) },
          { argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/fake/permission"], stdout: "write\n" },
          { argv_prefix: ["api", "--method", "PATCH"], stdout: JSON.stringify({ number: 1058, state: "closed" }) },
        ],
      },
    });
    await withCloseResult(shim, 1058, (r) => {
      assert.equal(r.ok, true);
      assert.equal(r.already_closed, false);
    });
  });

  it("does not honor an override comment that names a different PR (PR-binding)", async () => {
    const overrideComment = { body: "gc-authorize-merge-state-override pr=99 wrong pr", user: { login: "fake" }, author_association: "OWNER" };
    const shim = makeShimRepo({
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
              { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
          ] }),
          { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "open" }) },
          { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: slurpComments([overrideComment]) },
          { argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/fake/permission"], stdout: "write\n" },
        ],
      },
    });
    await withCloseResult(shim, 1058, (r) => {
      assert.equal(r.ok, false);
      assert.equal(r.error, "close_requirement_state_unverified");
    });
  });

  it("does not honor an override comment from an author without repo write", async () => {
    const overrideComment = { body: "gc-authorize-merge-state-override pr=42 outsider", user: { login: "stranger" }, author_association: "NONE" };
    const shim = makeShimRepo({
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          ...restLinkedPullRequestRoutes({ issueNumber: 1058, prs: [
              { number: 42, state: "MERGED", mergedAt: PR_MERGED_AT, url: LINKED_PR_URL },
          ] }),
          { argv_prefix: ["api", ISSUE_API_PATH], stdout: JSON.stringify({ number: 1058, state: "open" }) },
          { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: slurpComments([overrideComment]) },
          // Non-collaborator: permission lookup 404s.
          { argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/stranger/permission"], exit_code: 1, stderr: "HTTP 404" },
        ],
      },
    });
    await withCloseResult(shim, 1058, (r) => {
      assert.equal(r.ok, false);
      assert.equal(r.error, "close_requirement_state_unverified");
    });
  });
});
