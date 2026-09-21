// GitHub REST helpers that replaced GraphQL-backed gh commands (issue #1584).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveReviewDecision,
  fetchCommitCheckRollup,
  ghRestJson,
  listIssueCrossReferencedPullNumbers,
  listPullRequestsForHead,
  normalizeRestPullRequest,
  parseClosingIssueReferences,
} from "./lib/github-rest.js";

const repo = (fullName) => ({ name: fullName.split("/")[1], full_name: fullName, owner: { login: fullName.split("/")[0] } });

describe("normalizeRestPullRequest", () => {
  it("maps merged, open, and closed pull requests onto the GraphQL-era state vocabulary", () => {
    const base = { number: 7, base: { ref: "dev", repo: repo("o/r") }, head: { ref: "7-x", sha: "abc", repo: repo("o/r") } };
    const merged = normalizeRestPullRequest({ ...base, state: "closed", merged_at: "2026-09-13T00:00:00Z", merge_commit_sha: "m1" });
    assert.equal(merged.state, "MERGED");
    assert.deepEqual(merged.mergeCommit, { oid: "m1" });
    assert.equal(merged.baseRefName, "dev");
    assert.equal(merged.headRefOid, "abc");
    assert.equal(merged.isCrossRepository, false);
    assert.equal(normalizeRestPullRequest({ ...base, state: "open", merged_at: null }).state, "OPEN");
    const closed = normalizeRestPullRequest({ ...base, state: "closed", merged_at: null, merge_commit_sha: "test-merge" });
    assert.equal(closed.state, "CLOSED");
    // An unmerged PR's test-merge commit is not a merge revision.
    assert.equal(closed.mergeCommit, null);
  });

  it("flags a pull request whose head lives in another repository", () => {
    const pr = normalizeRestPullRequest({
      number: 8, state: "open", base: { ref: "dev", repo: repo("o/r") }, head: { ref: "x", sha: "s", repo: repo("fork/r") },
    });
    assert.equal(pr.isCrossRepository, true);
  });

  it("treats a deleted head repository as a deleted fork, as GraphQL does", () => {
    const pr = normalizeRestPullRequest({
      number: 9, state: "open", base: { ref: "dev", repo: repo("o/r") }, head: { ref: "x", sha: "s", repo: null },
    });
    assert.equal(pr.isCrossRepository, true);
    assert.equal(pr.headRepository, null);
  });

  it("maps the review-lane identity fields onto the GraphQL-era names (issue #1586)", () => {
    const pr = normalizeRestPullRequest({
      number: 10, state: "open", mergeable_state: "behind", maintainer_can_modify: true,
      base: { ref: "dev", sha: "b1", repo: repo("o/r") }, head: { ref: "x", sha: "h1", repo: repo("o/r") },
    });
    assert.equal(pr.mergeStateStatus, "BEHIND");
    assert.equal(pr.baseRefOid, "b1");
    assert.equal(pr.maintainerCanModify, true);
    // List endpoints omit mergeable_state; an unrecognized value is not passed through either.
    assert.equal(normalizeRestPullRequest({ number: 11, state: "open" }).mergeStateStatus, null);
    assert.equal(normalizeRestPullRequest({ number: 12, state: "open", mergeable_state: "weird" }).mergeStateStatus, null);
    assert.equal(normalizeRestPullRequest({ number: 13, state: "open" }).maintainerCanModify, false);
  });
});

describe("deriveReviewDecision", () => {
  const review = (login, state) => ({ user: { login }, state });

  it("lets a change request outrank approvals", () => {
    assert.equal(deriveReviewDecision([review("a", "APPROVED"), review("b", "CHANGES_REQUESTED")]), "CHANGES_REQUESTED");
  });

  it("uses each reviewer's latest decision, which a later comment does not reset", () => {
    const reviews = [review("a", "CHANGES_REQUESTED"), review("a", "APPROVED"), review("a", "COMMENTED")];
    assert.equal(deriveReviewDecision(reviews), "APPROVED");
  });

  it("clears a dismissed decision and reports REVIEW_REQUIRED without a standing one", () => {
    assert.equal(deriveReviewDecision([review("a", "CHANGES_REQUESTED"), review("a", "DISMISSED")]), "REVIEW_REQUIRED");
    assert.equal(deriveReviewDecision([review("a", "COMMENTED")]), "REVIEW_REQUIRED");
    assert.equal(deriveReviewDecision(null), "REVIEW_REQUIRED");
  });
});

describe("fetchCommitCheckRollup", () => {
  const responses = {
    "/repos/o/r/commits/abc/check-runs?per_page=100": [{
      check_runs: [{ name: "build", status: "completed", conclusion: "success", completed_at: "t", details_url: "https://github.com/o/r/actions/runs/5/job/1" }],
    }],
    "/repos/o/r/commits/abc/status": { statuses: [{ context: "legacy", state: "pending" }] },
    "/repos/o/r/actions/runs/5": { name: "CI" },
  };
  const recorder = () => {
    const paths = [];
    const execFile = async (bin, args) => {
      const path = args.find((arg) => arg.startsWith("/repos/"));
      paths.push(path);
      return { stdout: JSON.stringify(responses[path]) };
    };
    return { paths, execFile };
  };

  it("returns check runs and status contexts in the GraphQL rollup shape", async () => {
    const { paths, execFile } = recorder();
    const rollup = await fetchCommitCheckRollup("/repo", "o/r", "abc", { execFile });
    assert.deepEqual(rollup, [
      { __typename: "CheckRun", name: "build", appId: null, run_id: undefined, head_sha: undefined, url: "https://github.com/o/r/actions/runs/5/job/1", workflowName: null, status: "COMPLETED", conclusion: "SUCCESS", completedAt: "t" },
      { __typename: "StatusContext", context: "legacy", state: "PENDING" },
    ]);
    assert.ok(!paths.some((path) => path.includes("/actions/runs/")), "workflow names are read only on request");
  });

  it("adds each Actions check run's workflow name on request", async () => {
    const { execFile } = recorder();
    const rollup = await fetchCommitCheckRollup("/repo", "o/r", "abc", { execFile, withWorkflowNames: true });
    assert.equal(rollup[0].workflowName, "CI");
  });
});

describe("listIssueCrossReferencedPullNumbers", () => {
  it("returns same-repository pull requests only, deduplicated, from the REST timeline", async () => {
    const events = [
      { event: "cross-referenced", source: { issue: { number: 42, pull_request: {}, repository: { full_name: "O/R" } } } },
      { event: "cross-referenced", source: { issue: { number: 42, pull_request: {}, repository: { full_name: "o/r" } } } },
      { event: "cross-referenced", source: { issue: { number: 43, pull_request: {}, repository: { full_name: "evil/r" } } } },
      { event: "cross-referenced", source: { issue: { number: 44, repository: { full_name: "o/r" } } } },
      { event: "labeled" },
    ];
    let observed;
    const numbers = await listIssueCrossReferencedPullNumbers("/repo", "o", "r", 5, {
      execFile: async (bin, args) => {
        observed = args;
        return { stdout: JSON.stringify([events]) };
      },
    });
    assert.deepEqual(numbers, [42]);
    assert.deepEqual(observed, ["api", "--method", "GET", "--paginate", "--slurp", "/repos/o/r/issues/5/timeline?per_page=100"]);
  });
});

describe("listPullRequestsForHead", () => {
  it("filters by an owner-qualified head on a pinned repository path", async () => {
    let path;
    await listPullRequestsForHead("/repo", "o", "r", "5-branch", {
      execFile: async (bin, args) => {
        path = args.find((arg) => arg.startsWith("/repos/"));
        return { stdout: "[]" };
      },
    });
    const url = new URL(`https://api.github.com${path}`);
    assert.equal(url.pathname, "/repos/o/r/pulls");
    assert.equal(url.searchParams.get("head"), "o:5-branch");
    assert.equal(url.searchParams.get("state"), "open");
  });
});

describe("parseClosingIssueReferences", () => {
  it("reads GitHub closing keywords for this repository only", () => {
    const body = "Closes #12\nfixes: #13\nResolved o/r#14\nRefs #15\ncloses other/r#16\nfix #12";
    assert.deepEqual(parseClosingIssueReferences(body, "o", "r"), [12, 13, 14]);
    assert.deepEqual(parseClosingIssueReferences(null, "o", "r"), []);
  });
});

describe("ghRestJson field modes and empty bodies (issue #1673)", () => {
  const capture = (stdout) => {
    const seen = [];
    return {
      seen,
      execFile: async (bin, args) => { seen.push(args); return { stdout }; },
    };
  };

  it("sends typed fields with -F and string fields with -f", async () => {
    const { seen, execFile } = capture("{}");
    await ghRestJson("/repo", "/repos/o/r/issues/1/dependencies/blocked_by", {
      method: "POST", typedFields: { issue_id: 2020 }, fields: { note: "text" }, execFile,
    });
    // `gh api -f` stringifies its value; GitHub rejects a stringified issue_id with 422.
    assert.deepEqual(seen[0].slice(-4), ["-f", "note=text", "-F", "issue_id=2020"]);
  });

  it("reads an empty response body as null rather than throwing", async () => {
    const { execFile } = capture("");
    assert.equal(await ghRestJson("/repo", "/repos/o/r/x", { method: "DELETE", execFile }), null);
  });
});
