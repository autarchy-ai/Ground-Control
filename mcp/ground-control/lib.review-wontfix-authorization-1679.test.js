// `wontfix` is the one review disposition that closes a real finding without
// repairing it, so ADR-029 requires explicit user authorization for it. The
// validators only ever checked that `user_authorization` was a non-empty string
// of bounded length, which the agent writing the disposition supplies itself —
// so the agent could self-authorize walking past its own reviewer's finding
// (issue #1679).
//
// Authorization is now verified at the repository boundary, before the first
// publication write: an issue-comment URL for this repository and issue, whose
// comment is an exact `/ground-control authorize-review-wontfix <finding-id>`
// command from someone with effective write permission.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewRevision,
  createReviewResult,
  runPublishReviewResult,
  isExactReviewWontfixAuthorizationCommand,
  verifyReviewWontfixAuthorizations,
} from "./lib.js";

const OWNER = "fake";
const NAME = "repo";
const ISSUE = 1679;
const FINDING = "codex-F1";
const AUTH_URL = `https://github.com/${OWNER}/${NAME}/issues/${ISSUE}#issuecomment-4242`;
// When the retained review run began. An authorization counts only for a run
// already under way when it was posted, so nobody has to type a run identifier.
const REVIEW_STARTED_AT = "2026-09-21T10:00:00.000Z";
const AFTER_REVIEW = "2026-09-21T10:20:00Z";
const BEFORE_REVIEW = "2026-09-21T09:00:00Z";
const COMMAND = `/ground-control authorize-review-wontfix ${FINDING}`;

function comments({ body = COMMAND, login = "maintainer", createdAt = AFTER_REVIEW } = {}) {
  return [{ id: 4242, body, authorLogin: login, createdAt }];
}

function trust(writers = ["maintainer"]) {
  return async () => ({
    isTrusted: (comment) => writers.includes(comment.authorLogin),
    isRepositoryAutomation: () => false,
  });
}

function verify(findings, options = {}) {
  return verifyReviewWontfixAuthorizations(
    { repoRoot: "/repo", owner: OWNER, name: NAME, issueNumber: ISSUE, reviewStartedAt: REVIEW_STARTED_AT, findings },
    {
      readComments: async () => options.comments ?? comments(),
      resolveTrust: options.resolveTrust ?? trust(),
    },
  );
}

const wontfix = (overrides = {}) => [{ id: FINDING, decision: "wontfix", user_authorization: AUTH_URL, ...overrides }];

describe("review wontfix authorization is verified, not asserted (#1679)", () => {
  it("accepts an exact command from a repository writer, bound to this run's finding", async () => {
    assert.equal((await verify(wontfix())).ok, true);
  });

  it("reads nothing and accepts when no finding is dispositioned wontfix", async () => {
    let read = 0;
    const result = await verifyReviewWontfixAuthorizations(
      { repoRoot: "/repo", owner: OWNER, name: NAME, issueNumber: ISSUE, findings: [{ id: FINDING, decision: "fix" }] },
      { readComments: async () => { read += 1; return []; }, resolveTrust: trust() },
    );
    assert.equal(result.ok, true);
    assert.equal(read, 0, "the common path must not spend a GitHub read");
  });

  for (const [label, findings, options] of [
    ["free-form approval prose", wontfix({ user_authorization: "the maintainer said this is fine" }), {}],
    ["a comment URL for another issue", wontfix({
      user_authorization: `https://github.com/${OWNER}/${NAME}/issues/999#issuecomment-4242`,
    }), {}],
    ["a comment URL for another repository", wontfix({
      user_authorization: `https://github.com/other/repo/issues/${ISSUE}#issuecomment-4242`,
    }), {}],
    ["a comment that does not exist", wontfix({
      user_authorization: `https://github.com/${OWNER}/${NAME}/issues/${ISSUE}#issuecomment-9999`,
    }), {}],
    ["an author without write permission", wontfix(), { resolveTrust: trust([]) }],
    ["a command naming a different finding", wontfix(), {
      comments: comments({ body: "/ground-control authorize-review-wontfix codex-F2" }),
    }],
    // security-F4 (cycle 4): finding ids are positional and recur in every cycle,
    // so an approval posted for an earlier run's codex-F1 must not close this
    // run's codex-F1. The binding is by time, not by anything the person types.
    ["an approval posted before this review run began", wontfix(), {
      comments: comments({ createdAt: BEFORE_REVIEW }),
    }],
    ["an approval with no readable timestamp", wontfix(), {
      comments: comments({ createdAt: null }),
    }],
    ["a quotation of the command", wontfix(), {
      comments: comments({ body: `> ${COMMAND}` }),
    }],
    ["a negation carrying the command text", wontfix(), {
      comments: comments({ body: `do NOT ${COMMAND}` }),
    }],
    ["a missing authorization", wontfix({ user_authorization: undefined }), {}],
  ]) {
    it(`refuses ${label}`, async () => {
      const result = await verify(findings, options);
      assert.equal(result.ok, false);
      assert.equal(result.error, "review_wontfix_authorization_unverifiable");
      assert.equal(result.finding_id, FINDING);
    });
  }
});

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function retained() {
  return createReviewResult({
    repositoryId: `${OWNER}/${NAME}`,
    issueNumber: ISSUE,
    reviewer: "codex",
    expectedCycle: 1,
    cap: 1,
    branch: "1679-review-gate-ci-fixes",
    baseBranch: "dev",
    revision: buildReviewRevision({
      headOid: HEAD,
      candidateTreeOid: "d".repeat(40), baseOid: BASE, diffText: "diff", manifest: "1\t0\ta.js", unreviewedUntrackedPaths: [],
    }),
    coverage: { complete: true, chunks_total: 1, chunks_completed: 1 },
    findings: [{
      id: FINDING, reviewer: "codex", path: "a.js", line: 7,
      title: "A real finding", body: "Body.", classification: "one-off",
    }],
    verdict: "ship-with-fixes",
    notes: [],
    architecturalRead: "Read.",
    terminal: { ok: true, next_action: "fix_findings_then_ask_over_cap_or_proceed" },
  }, { random: () => Buffer.alloc(24, 2), now: () => "2026-09-21T00:00:00.000Z" });
}

function sanitized(userAuthorization) {
  return {
    verdict: "ship-with-fixes",
    notes: [],
    architectural_read: "Read.",
    findings: [{
      id: FINDING, title: "A real finding", classification: "one-off",
      decision: "wontfix", rationale: "Authorized.", user_authorization: userAuthorization,
    }],
  };
}

function publicationDeps(record, writes, commentBody) {
  return {
    resolveRepository: async () => ({ ok: true, repoRoot: "/repo", owner: OWNER, name: NAME }),
    readIdentity: async () => ({ gitDir: "/repo/.git" }),
    readResult: () => ({ ok: true, record }),
    writeResult: (_gitDir, next) => { writes.push("write"); return next; },
    captureRevision: async () => ({ revision: record.revision }),
    readPriorCycleCount: async () => 0,
    readProgress: async () => ({ findings: null, cycle: false, decision: null }),
    publishFindings: async () => { writes.push("findings"); return { id: 10, url: "https://example.test/10" }; },
    publishCycle: async () => { writes.push("cycle"); return { id: 11, url: "https://example.test/11" }; },
    publishDecision: async () => { writes.push("decision"); return { ok: true, comment_id: 12, comment_url: "https://example.test/12" }; },
    acquireLock: async () => async () => {},
    readComments: async () => comments({ body: commentBody, createdAt: "2026-09-21T01:00:00Z" }),
    resolveTrust: trust(),
  };
}

// A review run is only known where a retained review is being published. The
// direct decision-record surface has none, so it cannot bind a wontfix to the
// decision it answers and refuses it outright.
describe("wontfix needs the review run it answers (#1679)", () => {
  it("refuses a wontfix on a surface that carries no review run", async () => {
    const result = await verifyReviewWontfixAuthorizations(
      { repoRoot: "/repo", owner: OWNER, name: NAME, issueNumber: ISSUE, findings: wontfix() },
      { readComments: async () => comments(), resolveTrust: trust() },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_wontfix_requires_publication");
  });

  it("still passes a surface with no review run when nothing is dispositioned wontfix", async () => {
    const result = await verifyReviewWontfixAuthorizations(
      { repoRoot: "/repo", owner: OWNER, name: NAME, issueNumber: ISSUE, findings: [{ id: FINDING, decision: "fix" }] },
      { readComments: async () => [], resolveTrust: trust() },
    );
    assert.equal(result.ok, true);
  });

  it("asks for nothing beyond the finding id", () => {
    // The same shape as the repository's existing obligation-wontfix command.
    assert.equal(isExactReviewWontfixAuthorizationCommand(COMMAND, FINDING), true);
    assert.equal(isExactReviewWontfixAuthorizationCommand(`${COMMAND} extra`, FINDING), false);
  });
});

describe("wontfix authorization fails closed when GitHub cannot answer (#1679)", () => {
  const input = { repoRoot: "/repo", owner: OWNER, name: NAME, issueNumber: ISSUE, reviewStartedAt: REVIEW_STARTED_AT, findings: wontfix() };
  const unavailable = async () => { throw new Error("gh api 502"); };

  it("refuses when the issue thread cannot be read", async () => {
    const result = await verifyReviewWontfixAuthorizations(input, { readComments: unavailable, resolveTrust: trust() });
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_wontfix_authorization_unverifiable");
  });

  it("refuses when the authorizing comment's permission cannot be resolved", async () => {
    const result = await verifyReviewWontfixAuthorizations(input, { readComments: async () => comments(), resolveTrust: unavailable });
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_wontfix_authorization_unverifiable");
  });
});

describe("review publication verifies wontfix authorization before its first write (#1679)", () => {
  it("refuses a self-asserted authorization without posting anything", async () => {
    const record = retained();
    const writes = [];
    const result = await runPublishReviewResult(
      { repoPath: "/repo", reviewHandle: record.review_handle, sanitized: sanitized("the user approved this in chat") },
      publicationDeps(record, writes, COMMAND),
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "review_wontfix_authorization_unverifiable");
    assert.deepEqual(writes, [], "no GitHub record may be written for an unauthorized disposition");
  });

  it("publishes when the authorization resolves to a writer's exact command", async () => {
    const record = retained();
    const writes = [];
    const result = await runPublishReviewResult(
      { repoPath: "/repo", reviewHandle: record.review_handle, sanitized: sanitized(AUTH_URL) },
      publicationDeps(record, writes, COMMAND),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(writes, ["findings", "cycle", "decision", "write"]);
  });
});
