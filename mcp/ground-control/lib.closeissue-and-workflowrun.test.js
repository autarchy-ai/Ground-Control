// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { restLinkedPullRequestRoutes } from "./github-rest.test-helpers.js";

// ---------------------------------------------------------------------------
// gc_assert_traceability_reconciled (issue #1058)
// ---------------------------------------------------------------------------

// Shared module-scope helpers for the traceability/final-report/close-issue
// suites below. Hoisted out of the individual `describe` callbacks so the
// route-replaying gh shim source, the git-init boilerplate, and the
// PATH-wrapping runner are defined exactly once (Sonar S7721/S4144/S138).
const GH_NAME_WITH_OWNER = "nameWithOwner";

function initGitRepo(dir) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README"), "x\n");
  execFileSync("git", ["-C", dir, "add", "README"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  // Real origin so owner/repo resolves from the git remote, as production does. git ignores
  // GH_REPO; the `gh repo view` fallback honours it.
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
  return dir;
}

// Source for a hermetic `gh` shim that replays cfg.routes by argv prefix.
// String.raw keeps the `\n` in the unhandled-argv diagnostic literal (S7780).
function buildGhRouteShimSource(configPath) {
  return String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
const argv = process.argv.slice(2);
function match(prefix) { return prefix.every((p, i) => argv[i] === p); }
for (const route of cfg.routes) {
  if (match(route.argv_prefix)) {
    if (route.exit_code != null && route.exit_code !== 0) {
      process.stderr.write(route.stderr || "");
      process.exit(route.exit_code);
    }
    process.stdout.write(route.stdout || "");
    process.exit(0);
  }
}
process.stderr.write("gh shim: unhandled argv: " + JSON.stringify(argv) + "\n");
process.exit(2);
`;
}

// Materializes a git repo + a bin dir holding a `gh` shim that replays
// `ghHandler.routes`. Returns { repoDir, binDir, cleanup }.
function makeRouteShimRepo({ ghHandler, repoPrefix, binPrefix }) {
  const repoDir = initGitRepo(mkdtempSync(join(tmpdir(), repoPrefix)));
  const binDir = mkdtempSync(join(tmpdir(), binPrefix));
  const configPath = join(binDir, "config.json");
  writeFileSync(configPath, JSON.stringify(ghHandler));
  writeFileSync(join(binDir, "gh"), buildGhRouteShimSource(configPath), { mode: 0o755 });
  return {
    repoDir, binDir,
    cleanup() { rmSync(repoDir, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); },
  };
}

async function withShimPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

// ---------------------------------------------------------------------------
// gc_close_issue_after_merge (issue #1058)
// ---------------------------------------------------------------------------

describe("runCloseIssueAfterMerge", () => {
  // Repeated fixture literals, hoisted to named constants (Sonar S1192).
  const PR_MERGED_AT = "2026-05-30T10:00:00Z";
  const LINKED_PR_URL = "https://github.com/fake/repo/pull/42";
  const ISSUE_API_PATH = "/repos/fake/repo/issues/1058";
  // Proof that merged requirement-state validation ran: the trusted final-report
  // marker on the issue thread (issue #1541). By close time in the real flow, the
  // post-merge completion assertion has posted it.
  const FINAL_REPORT_MARKER = '<!-- gc:final-report issue="1058" pr="42" -->';
  // `gh api --paginate --slurp` wraps each page's array in an outer array.
  const slurpComments = (comments) => JSON.stringify([comments]);
  // Routes that satisfy the final-report marker gate: a trusted (repo-write author)
  // comment carrying the marker, plus the collaborator-permission lookup trust uses.
  const MARKER_TRUST_ROUTES = [
    {
      argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
      stdout: slurpComments([{ body: FINAL_REPORT_MARKER, user: { login: "fake" }, author_association: "OWNER" }]),
    },
    {
      argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/fake/permission"],
      stdout: "write\n",
    },
  ];

  function makeShimRepo({ ghHandler }) {
    return makeRouteShimRepo({ ghHandler, repoPrefix: "gc-close-test-", binPrefix: "gc-close-bin-" });
  }

  // Runs runCloseIssueAfterMerge against `shim` (on the shimmed PATH) and hands
  // the structured result to `assertResult`, then cleans the shim up. Removes
  // the import + path-wrap + try/finally cleanup boilerplate repeated by the
  // result-asserting cases.
  async function withCloseResult(shim, issueNumber, assertResult) {
    try {
      await withShimPath(shim.binDir, async () => {
        const { runCloseIssueAfterMerge } = await import("./lib.js");
        const r = await runCloseIssueAfterMerge({ repoPath: shim.repoDir, issueNumber });
        assertResult(r);
      });
    } finally {
      shim.cleanup();
    }
  }

  it("throws on invalid issue_number (input validation)", async () => {
    const shim = makeShimRepo({ ghHandler: { routes: [] } });
    try {
      const { runCloseIssueAfterMerge } = await import("./lib.js");
      await assert.rejects(
        runCloseIssueAfterMerge({ repoPath: shim.repoDir, issueNumber: 0 }),
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
        const r = await runCloseIssueAfterMerge({ repoPath: shim.repoDir, issueNumber: 1058, prNumber: 99 });
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
        const r = await runCloseIssueAfterMerge({ repoPath: shim.repoDir, issueNumber: 1058, prNumber: 42 });
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
