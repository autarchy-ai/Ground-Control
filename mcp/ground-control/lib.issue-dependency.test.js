// gc_issue_dependency — GitHub issue "blocked by" relationships (issue #1673).
//
// Hermetic: a real throwaway git repo (the authorization path runs `git` for real) plus an
// injected `gh` seam. The seam records argv, because the argv IS the contract here: GitHub's
// write endpoints key on the blocking issue's numeric REST id, and `-f` stringifies it into a
// 422. A test that mocked at a higher layer would not catch either mistake.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runIssueDependency } from "./lib/issue-dependency.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

const BLOCKED = 10;
const BLOCKED_ID = 1010;
const BLOCKING = 20;
const BLOCKING_ID = 2020;

function makeRepo(slug = "o/r") {
  const dir = mkdtempSync(join(tmpdir(), "gc-issue-dependency-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", `https://github.com/${slug}.git`]);
  return dir;
}

function issue(number, id, { slug = "o/r", title = `Issue ${number}`, state = "open", pull = false } = {}) {
  return {
    number,
    id,
    title,
    state,
    html_url: `https://github.com/${slug}/issues/${number}`,
    repository_url: `https://api.github.com/repos/${slug}`,
    ...(pull ? { pull_request: { url: `https://api.github.com/repos/${slug}/pulls/${number}` } } : {}),
  };
}

function ghError(message) {
  const error = new Error("Command failed: gh api");
  error.stderr = message;
  return error;
}

/** An `execFile` seam that routes on the REST path and records every argv. */
function ghSeam(routes) {
  const calls = [];
  const seam = async (file, args) => {
    const path = args.find((arg) => typeof arg === "string" && arg.startsWith("/repos/"));
    const method = args[args.indexOf("--method") + 1];
    calls.push({ file, args, method, path });
    const route = routes[`${method} ${String(path).split("?")[0]}`];
    if (route === undefined) throw ghError(`gh: Not Found (HTTP 404)\nno route for ${method} ${path}`);
    const value = typeof route === "function" ? route(calls.length) : route;
    if (value instanceof Error) throw value;
    return { stdout: typeof value === "string" ? value : JSON.stringify(value) };
  };
  seam.calls = calls;
  seam.writes = () => calls.filter((call) => call.method === "POST" || call.method === "DELETE");
  return seam;
}

const BLOCKED_BY = `GET /repos/o/r/issues/${BLOCKED}/dependencies/blocked_by`;
const BLOCKING_LIST = `GET /repos/o/r/issues/${BLOCKED}/dependencies/blocking`;
const ADD = `POST /repos/o/r/issues/${BLOCKED}/dependencies/blocked_by`;
const REMOVE = `DELETE /repos/o/r/issues/${BLOCKED}/dependencies/blocked_by/${BLOCKING_ID}`;

/** Both issue lookups plus empty dependency lists; individual tests override what they exercise. */
function baseRoutes(overrides = {}) {
  return {
    [`GET /repos/o/r/issues/${BLOCKED}`]: issue(BLOCKED, BLOCKED_ID),
    [`GET /repos/o/r/issues/${BLOCKING}`]: issue(BLOCKING, BLOCKING_ID),
    [BLOCKED_BY]: [[]],
    [BLOCKING_LIST]: [[]],
    ...overrides,
  };
}

async function withRepo(run, slug = "o/r") {
  const repoDir = makeRepo(slug);
  try {
    return await run(repoDir, workspaceAuthorizationFor(repoDir));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

function call(repoDir, resolver, execFile, overrides = {}) {
  return runIssueDependency(
    { repoPath: repoDir, action: "read", blockedIssueNumber: BLOCKED, ...overrides },
    { workspaceAuthorizationResolver: resolver, execFile },
  );
}

describe("gc_issue_dependency — reading", () => {
  it("returns both directions normalized, without transport-only fields", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes({
        [BLOCKED_BY]: [[issue(BLOCKING, BLOCKING_ID)]],
        [BLOCKING_LIST]: [[issue(30, 3030)]],
      }));
      const result = await call(repoDir, resolver, seam);
      assert.equal(result.ok, true);
      assert.deepEqual(result.blocked_by, [{
        repository: "o/r", number: BLOCKING, title: `Issue ${BLOCKING}`, state: "open",
        url: `https://github.com/o/r/issues/${BLOCKING}`, in_authorized_repository: true,
      }]);
      assert.deepEqual(result.blocking.map((entry) => entry.number), [30]);
      assert.ok(!JSON.stringify(result).includes(String(BLOCKING_ID)), "the REST database id never reaches the caller");
    });
  });

  it("reports an issue with no dependencies as empty arrays rather than an error", async () => {
    await withRepo(async (repoDir, resolver) => {
      const result = await call(repoDir, resolver, ghSeam(baseRoutes()));
      assert.equal(result.ok, true);
      assert.deepEqual(result.blocked_by, []);
      assert.deepEqual(result.blocking, []);
    });
  });

  it("paginates both dependency lists and pins the API host", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes());
      await call(repoDir, resolver, seam);
      const lists = seam.calls.filter((c) => c.path.includes("/dependencies/"));
      assert.equal(lists.length, 2);
      for (const list of lists) {
        assert.ok(list.args.includes("--paginate"), "a first page is not the dependency set");
        assert.ok(list.args.includes("--slurp"));
        assert.ok(list.args.includes("--hostname"));
        assert.equal(list.args[list.args.indexOf("--hostname") + 1], "github.com");
        assert.ok(list.path.endsWith("?per_page=100"));
      }
    });
  });

  // The launch-workspace authorization confines the caller to one repository, but the host
  // credential may read others. A relationship created elsewhere can name an issue in one of
  // them, so returning that record verbatim would make this tool a cross-repository read deputy.
  it("redacts a dependency naming another repository in both directions", async () => {
    await withRepo(async (repoDir, resolver) => {
      const foreign = issue(77, 7777, { slug: "private/elsewhere", title: "confidential roadmap item" });
      const seam = ghSeam(baseRoutes({ [BLOCKED_BY]: [[foreign]], [BLOCKING_LIST]: [[foreign]] }));
      const result = await call(repoDir, resolver, seam);
      assert.equal(result.ok, true);
      const redacted = {
        repository: "private/elsewhere", number: 77, title: null, state: null, url: null,
        in_authorized_repository: false,
      };
      // The edge itself stays visible — a silently dropped blocker reads as no blocker at all.
      assert.deepEqual(result.blocked_by, [redacted]);
      assert.deepEqual(result.blocking, [redacted]);
      assert.ok(!JSON.stringify(result).includes("confidential roadmap item"));
      assert.ok(!JSON.stringify(result).includes("github.com/private/elsewhere"));
    });
  });

  it("refuses a blocking issue number on a read, which has no operand", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes());
      const result = await call(repoDir, resolver, seam, { blockingIssueNumber: BLOCKING });
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_blocking_issue_number_invalid");
      assert.equal(seam.calls.length, 0);
    });
  });
});

describe("gc_issue_dependency — mutating", () => {
  it("adds the blocker with its numeric REST id in a typed issue_id field", async () => {
    await withRepo(async (repoDir, resolver) => {
      let added = false;
      const seam = ghSeam(baseRoutes({
        [BLOCKED_BY]: () => (added ? [[issue(BLOCKING, BLOCKING_ID)]] : [[]]),
        [ADD]: () => { added = true; return issue(BLOCKED, BLOCKED_ID); },
      }));
      const result = await call(repoDir, resolver, seam, { action: "add", blockingIssueNumber: BLOCKING });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "changed");
      assert.deepEqual(result.blocked_by.map((entry) => entry.number), [BLOCKING]);
      const write = seam.writes()[0];
      assert.equal(write.path, `/repos/o/r/issues/${BLOCKED}/dependencies/blocked_by`);
      // -F, not -f: gh stringifies a -f value and GitHub answers 422.
      assert.equal(write.args[write.args.indexOf("-F") + 1], `issue_id=${BLOCKING_ID}`);
      assert.ok(!write.args.includes("-f"), "the id must not be sent as a string field");
      assert.ok(!write.args.some((arg) => arg === `issue_id=${BLOCKING}`), "the issue number is not the id");
    });
  });

  it("removes the blocker by its REST id in the delete path", async () => {
    await withRepo(async (repoDir, resolver) => {
      let removed = false;
      const seam = ghSeam(baseRoutes({
        [BLOCKED_BY]: () => (removed ? [[]] : [[issue(BLOCKING, BLOCKING_ID)]]),
        [REMOVE]: () => { removed = true; return ""; },
      }));
      const result = await call(repoDir, resolver, seam, { action: "remove", blockingIssueNumber: BLOCKING });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "changed");
      assert.deepEqual(result.blocked_by, []);
      assert.equal(seam.writes()[0].path, `/repos/o/r/issues/${BLOCKED}/dependencies/blocked_by/${BLOCKING_ID}`);
    });
  });

  it("replays an add of an existing blocker as a no-op", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes({ [BLOCKED_BY]: [[issue(BLOCKING, BLOCKING_ID)]] }));
      const result = await call(repoDir, resolver, seam, { action: "add", blockingIssueNumber: BLOCKING });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "already_satisfied");
      assert.deepEqual(result.blocked_by.map((entry) => entry.number), [BLOCKING]);
      assert.deepEqual(seam.writes(), []);
    });
  });

  it("replays a remove of an absent blocker as a no-op", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes());
      const result = await call(repoDir, resolver, seam, { action: "remove", blockingIssueNumber: BLOCKING });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "already_satisfied");
      assert.deepEqual(seam.writes(), []);
    });
  });

  it("redacts a foreign dependency in the terminal state a mutation reports", async () => {
    await withRepo(async (repoDir, resolver) => {
      const foreign = issue(77, 7777, { slug: "private/elsewhere", title: "confidential roadmap item" });
      let added = false;
      const seam = ghSeam(baseRoutes({
        [BLOCKED_BY]: () => (added ? [[foreign, issue(BLOCKING, BLOCKING_ID)]] : [[foreign]]),
        [ADD]: () => { added = true; return issue(BLOCKED, BLOCKED_ID); },
      }));
      const result = await call(repoDir, resolver, seam, { action: "add", blockingIssueNumber: BLOCKING });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "changed");
      assert.ok(!JSON.stringify(result).includes("confidential roadmap item"));
      assert.deepEqual(
        result.blocked_by.map((entry) => entry.in_authorized_repository),
        [false, true],
      );
    });
  });

  it("matches an existing blocker on repository identity, not issue number alone", async () => {
    await withRepo(async (repoDir, resolver) => {
      // Same number in another repository: the relationship this call would create is absent.
      const seam = ghSeam(baseRoutes({
        [BLOCKED_BY]: [[issue(BLOCKING, 9999, { slug: "other/repo" })]],
        [ADD]: issue(BLOCKED, BLOCKED_ID),
      }));
      const result = await call(repoDir, resolver, seam, { action: "add", blockingIssueNumber: BLOCKING });
      assert.equal(result.ok, false, "the post-write read still lacks the requested relationship");
      assert.equal(seam.writes().length, 1, "a foreign blocker with the same number is not this one");
    });
  });

  it("calls a failed write whose intended state now holds reconciled, not changed", async () => {
    await withRepo(async (repoDir, resolver) => {
      let reads = 0;
      const seam = ghSeam(baseRoutes({
        // A concurrent writer (GitHub's UI, another client) established the state.
        [BLOCKED_BY]: () => (++reads === 1 ? [[]] : [[issue(BLOCKING, BLOCKING_ID)]]),
        [ADD]: ghError("gh: Validation Failed (HTTP 422)"),
      }));
      const result = await call(repoDir, resolver, seam, { action: "add", blockingIssueNumber: BLOCKING });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "reconciled", "this process cannot claim it made the change");
      assert.deepEqual(result.blocked_by.map((entry) => entry.number), [BLOCKING]);
    });
  });

  it("refuses a rejected relationship whose state does not hold afterwards", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes({ [ADD]: ghError("gh: Validation Failed (HTTP 422)") }));
      const result = await call(repoDir, resolver, seam, { action: "add", blockingIssueNumber: BLOCKING });
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_rejected");
      assert.ok(!result.message.includes("gh:"), "raw gh output must not escape");
    });
  });
});

describe("gc_issue_dependency — refusals", () => {
  it("refuses a self-dependency before any GitHub call", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes());
      const result = await call(repoDir, resolver, seam, { action: "add", blockingIssueNumber: BLOCKED });
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_self_dependency");
      assert.equal(seam.calls.length, 0);
    });
  });

  it("refuses a blocking issue that does not exist rather than reporting a no-op", async () => {
    await withRepo(async (repoDir, resolver) => {
      const routes = baseRoutes();
      delete routes[`GET /repos/o/r/issues/${BLOCKING}`];
      const seam = ghSeam(routes);
      const result = await call(repoDir, resolver, seam, { action: "remove", blockingIssueNumber: BLOCKING });
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_blocking_issue_not_found");
      assert.deepEqual(seam.writes(), []);
    });
  });

  it("refuses a blocked issue that does not exist", async () => {
    await withRepo(async (repoDir, resolver) => {
      const routes = baseRoutes();
      delete routes[`GET /repos/o/r/issues/${BLOCKED}`];
      const result = await call(repoDir, resolver, ghSeam(routes));
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_blocked_issue_not_found");
    });
  });

  it("refuses a pull-request-shaped record as a dependency operand", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes({
        [`GET /repos/o/r/issues/${BLOCKING}`]: issue(BLOCKING, BLOCKING_ID, { pull: true }),
      }));
      const result = await call(repoDir, resolver, seam, { action: "add", blockingIssueNumber: BLOCKING });
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_not_an_issue");
      assert.deepEqual(seam.writes(), []);
    });
  });

  it("refuses a repo assertion naming another repository, the cross-repository case", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes());
      const result = await call(repoDir, resolver, seam, { repo: "someone/else" });
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_repo_mismatch");
      assert.equal(seam.calls.length, 0);
    });
  });

  it("accepts a repo assertion matching the checkout, whatever its case", async () => {
    await withRepo(async (repoDir, resolver) => {
      const result = await call(repoDir, resolver, ghSeam(baseRoutes()), { repo: "O/R" });
      assert.equal(result.ok, true);
    });
  });

  it("refuses a checkout outside the authorized launch workspace", async () => {
    await withRepo(async (repoDir) => {
      // The resolver is captured against a different repository than repo_path names.
      await withRepo(async (otherDir, otherResolver) => {
        const seam = ghSeam(baseRoutes());
        const result = await call(repoDir, otherResolver, seam);
        assert.equal(result.ok, false);
        assert.equal(result.error, "issue_dependency_repo_not_authorized");
        assert.equal(seam.calls.length, 0);
      }, "other/repo");
    });
  });

  it("refuses a repo_path that is not a Git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-issue-dependency-bare-"));
    try {
      const seam = ghSeam(baseRoutes());
      const result = await call(dir, workspaceAuthorizationFor(dir), seam);
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_repo_path_invalid");
      assert.equal(seam.calls.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names a forbidden response distinctly from a missing one", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes({
        [BLOCKED_BY]: ghError("gh: Resource not accessible by integration (HTTP 403)"),
      }));
      const result = await call(repoDir, resolver, seam);
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_forbidden");
    });
  });

  it("refuses a dependency record missing its identity fields", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes({ [BLOCKED_BY]: [[{ number: BLOCKING, title: "no id or repository" }]] }));
      const result = await call(repoDir, resolver, seam);
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_malformed_response");
    });
  });

  it("refuses an issue lookup whose payload answers a different number", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes({ [`GET /repos/o/r/issues/${BLOCKED}`]: issue(999, BLOCKED_ID) }));
      const result = await call(repoDir, resolver, seam);
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_malformed_response");
    });
  });

  it("reports an unreachable GitHub distinctly from a rejection", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes({ [BLOCKED_BY]: ghError("dial tcp: connection refused") }));
      const result = await call(repoDir, resolver, seam);
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_dependency_transport_unavailable");
    });
  });

  it("refuses malformed arguments before touching the filesystem or GitHub", async () => {
    await withRepo(async (repoDir, resolver) => {
      const seam = ghSeam(baseRoutes());
      const cases = [
        [{ action: "sabotage" }, "issue_dependency_action_invalid"],
        [{ blockedIssueNumber: 0 }, "issue_dependency_issue_number_invalid"],
        [{ blockedIssueNumber: 1.5 }, "issue_dependency_issue_number_invalid"],
        [{ action: "add" }, "issue_dependency_blocking_issue_number_invalid"],
        [{ action: "add", blockingIssueNumber: -1 }, "issue_dependency_blocking_issue_number_invalid"],
        [{ repo: "not-a-slug" }, "issue_dependency_repo_assertion_invalid"],
      ];
      for (const [overrides, error] of cases) {
        const result = await call(repoDir, resolver, seam, overrides);
        assert.equal(result.ok, false, `${error} must refuse`);
        assert.equal(result.error, error);
      }
      assert.equal(seam.calls.length, 0);
    });
  });

  it("refuses a relative repo_path", async () => {
    const result = await runIssueDependency(
      { repoPath: "relative/path", action: "read", blockedIssueNumber: BLOCKED },
      { execFile: ghSeam(baseRoutes()) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "issue_dependency_repo_path_invalid");
  });
});
