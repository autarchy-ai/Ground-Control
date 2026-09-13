// GitHub REST helpers that replaced GraphQL-backed gh commands (issue #1584).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
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
