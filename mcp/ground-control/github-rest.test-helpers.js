// REST fixtures for tests whose `gh` shim routes by argv prefix (issue #1584).
//
// Linked pull requests are resolved from the issue's REST timeline plus each pull request's REST
// record. These helpers build both routes from one compact PR description, so a test states which
// PRs link to an issue rather than hand-writing GitHub's REST payloads.

const SHA = "a".repeat(40);

/** A REST pull-request payload for `{ number, state, mergedAt, url, baseRefName, mergeCommitOid, ... }`. */
export function restPullRequest({
  owner = "fake", name = "repo", number, state = "OPEN", mergedAt = null, url = null,
  baseRefName = "dev", headRefName = `${number}-branch`, headRefOid = SHA, mergeCommitOid = null,
  title = `PR ${number}`, body = "", author = "fake",
}) {
  const repo = { name, full_name: `${owner}/${name}`, owner: { login: owner } };
  return {
    number,
    state: mergedAt || state === "CLOSED" ? "closed" : "open",
    merged_at: mergedAt,
    html_url: url ?? `https://github.com/${owner}/${name}/pull/${number}`,
    title,
    body,
    user: { login: author },
    base: { ref: baseRefName, repo },
    head: { ref: headRefName, sha: headRefOid, repo },
    merge_commit_sha: mergeCommitOid,
  };
}

/** Routes for an issue whose timeline cross-references `prs`, and for each PR's REST record. */
export function restLinkedPullRequestRoutes({ owner = "fake", name = "repo", issueNumber, prs }) {
  const events = prs.map((pr) => ({
    event: "cross-referenced",
    source: { issue: { number: pr.number, pull_request: { url: "" }, repository: { full_name: `${owner}/${name}` } } },
  }));
  return [
    {
      argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp", `/repos/${owner}/${name}/issues/${issueNumber}/timeline?per_page=100`],
      stdout: JSON.stringify([events]),
    },
    ...prs.map((pr) => ({
      argv_prefix: ["api", "--method", "GET", `/repos/${owner}/${name}/pulls/${pr.number}`],
      stdout: JSON.stringify(restPullRequest({ owner, name, ...pr })),
    })),
  ];
}
