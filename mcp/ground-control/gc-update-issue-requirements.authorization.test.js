// gc_update_issue_requirements — who may write, and under what serialization (issue #1569).
//
// Companion to gc-update-issue-requirements.test.js: repository binding, the trusted
// removal authorization, public-text refusals, cache coherence, the workspace lease, and
// direct-caller input validation. Split when the single file crossed the 500-line limit
// (ADR-092); both halves share one fixture module rather than a copied one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { acquireIssueScopeLock, peekIssueThreadCacheForTest, readGitIdentity, runUpdateIssueRequirements, seedIssueThreadCacheForTest } from "./lib.js";
import { ISSUE, launchAuthorizationFor, makeGhShim, update, withFixture, withShim, makeGitRepoWithOrigin, repoTopLevel, writeRequirement } from "./gc-update-issue-requirements.fixture.test.js";

describe("gc_update_issue_requirements — repository binding", () => {
  it("refuses a repo assertion that disagrees with the authorized checkout, before any gh call", async () => {
    await withFixture({ body: "## Requirements\n\n" }, async ({ repoDir, shim, resolver }) => {
      const result = await update(repoDir, resolver, { repo: "someone-else/elsewhere" });
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_requirements_repo_mismatch");
      assert.equal(shim.calls().length, 0);
    });
  });

  it("accepts a matching repo assertion case-insensitively", async () => {
    await withFixture({ body: "## Requirements\n\n" }, async ({ repoDir, resolver }) => {
      const result = await update(repoDir, resolver, { repo: "O/R" });
      assert.equal(result.ok, true);
    });
  });

  it("refuses a checkout outside the MCP launch workspace", async () => {
    await withFixture({ body: "## Requirements\n\n" }, async ({ repoDir, shim }) => {
      const elsewhere = makeGitRepoWithOrigin("o/r");
      try {
        const result = await runUpdateIssueRequirements(
          { repoPath: repoDir, issueNumber: ISSUE, operation: "add", requirementUids: ["GC-O007"] },
          { workspaceAuthorizationResolver: await launchAuthorizationFor(elsewhere) },
        );
        assert.equal(result.ok, false);
        assert.equal(result.error, "implement_repo_not_authorized");
        assert.equal(shim.calls().length, 0);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });

  it("rejects an API object that is a pull request", async () => {
    const repoDir = makeGitRepoWithOrigin();
    writeRequirement(repoDir, { uid: "GC-O007" });
    const shim = makeGhShim({ issue: { number: ISSUE, body: "## Requirements\n\n", pull_request: { url: "x" } } });
    try {
      const resolver = await launchAuthorizationFor(repoDir);
      const result = await withShim(shim.binDir, () => update(repoDir, resolver));
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_requirements_target_not_an_issue");
      assert.equal(shim.patchCalls().length, 0);
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("gc_update_issue_requirements — public-text safety", () => {
  it("refuses a candidate body carrying a reserved workflow marker, before any write", async () => {
    await withFixture({ body: "## Requirements\n\n<!-- gc:final-report -->\n" },
      async ({ repoDir, shim, resolver }) => {
        const result = await update(repoDir, resolver);
        assert.equal(result.ok, false);
        assert.equal(result.error, "issue_requirements_reserved_marker");
        assert.equal(shim.patchCalls().length, 0);
      });
  });

  it("refuses a candidate body carrying sensitive content, before any write", async () => {
    await withFixture({ body: "## Requirements\n\nghp_0123456789012345678901234567890123456789\n" },
      async ({ repoDir, shim, resolver }) => {
        const result = await update(repoDir, resolver);
        assert.equal(result.ok, false);
        assert.equal(result.error, "issue_requirements_body_rejected");
        assert.equal(shim.patchCalls().length, 0);
      });
  });

  it("refuses a candidate body over the public-text cap, before any write", async () => {
    await withFixture({ body: `## Requirements\n\n${"x".repeat(65535)}\n` },
      async ({ repoDir, shim, resolver }) => {
        const result = await update(repoDir, resolver);
        assert.equal(result.ok, false);
        assert.equal(result.error, "issue_requirements_body_too_large");
        assert.equal(shim.patchCalls().length, 0);
      });
  });
});

describe("gc_update_issue_requirements — cache coherence and write verification", () => {
  it("invalidates the issue-thread cache entry after a successful write", async () => {
    await withFixture({ body: "## Requirements\n\n" }, async ({ repoDir, resolver }) => {
      const root = repoTopLevel(repoDir);
      seedIssueThreadCacheForTest(root, ISSUE, "stale-hash");
      const result = await update(repoDir, resolver);
      assert.equal(result.ok, true);
      assert.equal(peekIssueThreadCacheForTest(root, ISSUE), null,
        "a stale hash would let bootstrap accept the pre-edit body as unchanged");
    });
  });

  it("invalidates the cache when the write outcome is uncertain", async () => {
    await withFixture({ body: "## Requirements\n\n", failPatch: true },
      async ({ repoDir, resolver }) => {
        const root = repoTopLevel(repoDir);
        seedIssueThreadCacheForTest(root, ISSUE, "stale-hash");
        const result = await update(repoDir, resolver);
        assert.equal(result.ok, false);
        assert.equal(result.error, "issue_requirements_write_failed");
        assert.equal(peekIssueThreadCacheForTest(root, ISSUE), null);
      });
  });

  it("refuses a malformed update response instead of reading it as an empty scope", async () => {
    for (const [label, payload] of [
      ["no body field", { number: ISSUE }],
      ["null body", { number: ISSUE, body: null }],
      ["a pull request", { number: ISSUE, body: "## Requirements\n\n", pull_request: { url: "x" } }],
      ["another issue", { number: ISSUE + 1, body: "## Requirements\n\n" }],
    ]) {
      await withFixture({
        body: "## Requirements\n\n- GC-X999 — gone\n",
        requirements: ["GC-O007"],
        comments: [{ id: 11, body: "/ground-control authorize-scope-removal 7 GC-X999", user: { login: "maintainer" } }],
        patchPayloadOverride: payload,
      }, async ({ repoDir, shim, resolver }) => {
        const root = repoTopLevel(repoDir);
        seedIssueThreadCacheForTest(root, ISSUE, "stale-hash");
        const result = await update(repoDir, resolver, { operation: "remove", requirementUids: ["GC-X999"] });
        assert.equal(result.ok, false, label);
        assert.equal(result.error, "issue_requirements_write_unverified", label);
        assert.equal(shim.patchCalls().length, 1, "no compensating overwrite");
        assert.equal(peekIssueThreadCacheForTest(root, ISSUE), null, label);
      });
    }
  });

  it("fails when the returned body does not read back as the intended scope", async () => {
    await withFixture({ body: "## Requirements\n\n", patchBodyOverride: "## Requirements\n\nnothing here\n" },
      async ({ repoDir, shim, resolver }) => {
        const root = repoTopLevel(repoDir);
        seedIssueThreadCacheForTest(root, ISSUE, "stale-hash");
        const result = await update(repoDir, resolver);
        assert.equal(result.ok, false);
        assert.equal(result.error, "issue_requirements_write_unverified");
        assert.equal(shim.patchCalls().length, 1, "no compensating overwrite");
        assert.equal(peekIssueThreadCacheForTest(root, ISSUE), null);
      });
  });
});

describe("gc_update_issue_requirements — serialization", () => {
  it("performs the whole read-modify-write under a workspace lease", async () => {
    // Without the lease, two concurrent `add` calls interleave and the slower one PATCHes
    // a body derived from a scope read before the faster one's write, dropping its UID —
    // a narrowing `add` must be structurally incapable of. Holding the lease externally
    // proves the write really is inside the critical section, with no timing dependence.
    await withFixture({ body: "## Requirements\n\n" }, async ({ repoDir, shim, resolver }) => {
      const identity = await readGitIdentity(repoDir);
      const release = await acquireIssueScopeLock(identity.gitDir, { retries: 0 });
      try {
        const result = await runUpdateIssueRequirements(
          { repoPath: repoDir, issueNumber: ISSUE, operation: "add", requirementUids: ["GC-O007"] },
          {
            workspaceAuthorizationResolver: resolver,
            acquireLock: (gitDir) => acquireIssueScopeLock(gitDir, { retries: 0 }),
          },
        );
        assert.equal(result.ok, false);
        assert.equal(result.error, "issue_requirements_scope_lock_contended");
        assert.equal(shim.patchCalls().length, 0, "no write happens outside the lease");
      } finally {
        await release();
      }
    });
  });

  it("keeps both UIDs when one add follows another on the same issue", async () => {
    await withFixture({ body: "## Requirements\n\n", requirements: ["GC-O007", "GC-O016"] },
      async ({ repoDir, shim, resolver }) => {
        await update(repoDir, resolver, { requirementUids: ["GC-O007"] });
        const second = await update(repoDir, resolver, { requirementUids: ["GC-O016"] });
        assert.deepEqual(second.requirement_uids, ["GC-O007", "GC-O016"]);
        const written = shim.patchCalls().at(-1).find((a) => a.startsWith("body=")).slice(5);
        assert.ok(written.includes("GC-O007") && written.includes("GC-O016"));
      });
  });
});

describe("gc_update_issue_requirements — input validation for direct library callers", () => {
  it("refuses a relative repo path", async () => {
    const result = await runUpdateIssueRequirements({
      repoPath: "relative/path", issueNumber: ISSUE, operation: "add", requirementUids: ["GC-O007"],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "issue_requirements_repo_path_invalid");
  });

  it("refuses a non-positive issue number", async () => {
    const result = await runUpdateIssueRequirements({
      repoPath: "/tmp", issueNumber: 0, operation: "add", requirementUids: ["GC-O007"],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "issue_requirements_issue_number_invalid");
  });

  it("refuses an implicit replace mode", async () => {
    const result = await runUpdateIssueRequirements({
      repoPath: "/tmp", issueNumber: ISSUE, operation: "set", requirementUids: ["GC-O007"],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "issue_requirements_operation_invalid");
  });

  it("refuses an empty UID list rather than clearing the section", async () => {
    const result = await runUpdateIssueRequirements({
      repoPath: "/tmp", issueNumber: ISSUE, operation: "remove", requirementUids: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "issue_requirements_uids_invalid");
  });
});
