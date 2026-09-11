// gc_update_issue_requirements — what it writes into the section (issue #1569).
//
// The section is scope INPUT four gates read, and nothing on the MCP surface could write
// it for an existing issue. These suites cover the write itself: bounded rewriting,
// idempotence, and the requirement-identity gate. The authorization, serialization, and
// cache-coherence suites live in gc-update-issue-requirements.authorization.test.js.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { peekIssueThreadCacheForTest, seedIssueThreadCacheForTest } from "./lib.js";
import { ISSUE, launchAuthorizationFor, makeGhShim, update, withFixture, withShim, writeRequirement, makeGitRepoWithOrigin, repoTopLevel } from "./gc-update-issue-requirements.fixture.test.js";

describe("gc_update_issue_requirements — writing the section", () => {
  it("adds a UID to a prose-only section and reports the resulting scope", async () => {
    await withFixture({ body: "## Problem\n\nx\n\n## Requirements\n\nDecide during planning.\n" },
      async ({ repoDir, shim, resolver }) => {
        const result = await update(repoDir, resolver);
        assert.equal(result.ok, true);
        assert.equal(result.changed, true);
        assert.deepEqual(result.requirement_uids, ["GC-O007"]);
        assert.equal(shim.patchCalls().length, 1);
        const written = shim.patchCalls()[0].find((a) => a.startsWith("body=")).slice(5);
        assert.ok(written.includes("Decide during planning."), "section prose is preserved");
        assert.ok(written.startsWith("## Problem\n\nx\n"), "earlier sections are preserved");
        assert.ok(written.includes("- GC-O007 — Some Requirement"));
      });
  });

  it("builds a repository-bound gh api PATCH that sends only the body field", async () => {
    await withFixture({ body: "## Requirements\n\n" }, async ({ repoDir, shim, resolver }) => {
      await update(repoDir, resolver);
      const [read] = shim.calls();
      assert.deepEqual(read, ["api", `repos/o/r/issues/${ISSUE}`]);
      const patch = shim.patchCalls()[0];
      assert.deepEqual(patch.slice(0, 5), ["api", `repos/o/r/issues/${ISSUE}`, "--method", "PATCH", "-f"]);
      assert.equal(patch.length, 6, "no field other than body is sent");
      assert.ok(patch[5].startsWith("body="));
    });
  });

  it("never echoes the issue body back to the caller", async () => {
    await withFixture({ body: "## Requirements\n\nsecret-ish prose\n" },
      async ({ repoDir, resolver }) => {
        const result = await update(repoDir, resolver);
        assert.ok(!JSON.stringify(result).includes("secret-ish prose"));
      });
  });

  it("refuses removal with no authorization on the issue, whatever the working tree says", async () => {
    await withFixture({
      body: "## Requirements\n\n- GC-O007 — Some Requirement\n- GC-O016 — Other\n",
      requirements: ["GC-O007", "GC-O016"],
    }, async ({ repoDir, shim, resolver }) => {
      const result = await update(repoDir, resolver, { operation: "remove", requirementUids: ["GC-O016"] });
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_requirements_removal_unauthorized");
      assert.equal(shim.patchCalls().length, 0);
    });
  });

  it("refuses removal authorized only by deleting the requirement file", async () => {
    // The feature-only case this tool exists to create: a requirement present on the
    // branch and absent from the integration branch. Absence from the mutable working
    // tree must not authorize narrowing, or an agent deletes the file, calls remove,
    // and restores it — emptying the scope Phase E verifies.
    await withFixture({
      body: "## Requirements\n\n- GC-O007 — Some Requirement\n",
      requirements: [],
    }, async ({ repoDir, shim, resolver }) => {
      const result = await update(repoDir, resolver, { operation: "remove", requirementUids: ["GC-O007"] });
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_requirements_removal_unauthorized");
      assert.equal(shim.patchCalls().length, 0, "an empty scope would make Phase E verify nothing");
    });
  });

  it("refuses an authorization whose author lacks repository write access", async () => {
    await withFixture({
      body: "## Requirements\n\n- GC-O007 — Some Requirement\n- GC-X999 — gone\n",
      comments: JSON.parse('[{ "id": 11, "body": "/ground-control authorize-scope-removal 7 GC-X999", "user": { "login": "maintainer" } }]'),
      permission: "read",
    }, async ({ repoDir, shim, resolver }) => {
      const result = await update(repoDir, resolver, { operation: "remove", requirementUids: ["GC-X999"] });
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_requirements_removal_unauthorized");
      assert.equal(shim.patchCalls().length, 0);
    });
  });

  it("refuses an authorization that names a different UID set", async () => {
    await withFixture({
      body: "## Requirements\n\n- GC-O007 — Some Requirement\n- GC-X999 — gone\n",
      comments: JSON.parse('[{ "id": 11, "body": "/ground-control authorize-scope-removal 7 GC-O016", "user": { "login": "maintainer" } }]'),
    }, async ({ repoDir, shim, resolver }) => {
      const result = await update(repoDir, resolver, { operation: "remove", requirementUids: ["GC-X999"] });
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_requirements_removal_unauthorized");
      assert.equal(shim.patchCalls().length, 0);
    });
  });

  it("removes a UID a repository writer authorized for this issue and exact UID set", async () => {
    await withFixture({
      body: "## Requirements\n\n- GC-O007 — Some Requirement\n- GC-X999 — gone\n",
      comments: JSON.parse('[{ "id": 11, "body": "/ground-control authorize-scope-removal 7 GC-X999", "user": { "login": "maintainer" } }]'),
    }, async ({ repoDir, shim, resolver }) => {
      const result = await update(repoDir, resolver, { operation: "remove", requirementUids: ["GC-X999"] });
      assert.equal(result.ok, true);
      assert.deepEqual(result.requirement_uids, ["GC-O007"]);
      const written = shim.patchCalls()[0].find((a) => a.startsWith("body=")).slice(5);
      assert.ok(!written.includes("GC-X999"));
    });
  });

});

describe("gc_update_issue_requirements — idempotence", () => {
  it("re-adding the current set performs no PATCH", async () => {
    await withFixture({ body: "## Requirements\n\n- GC-O007 — Some Requirement\n" },
      async ({ repoDir, shim, resolver }) => {
        const result = await update(repoDir, resolver);
        assert.equal(result.ok, true);
        assert.equal(result.changed, false);
        assert.equal(shim.patchCalls().length, 0, "an unchanged scope must not rewrite the body");
      });
  });

  it("invalidates a stale cache entry on a no-op, because the fresh read superseded it", async () => {
    await withFixture({ body: "## Requirements\n\n- GC-O007 — Some Requirement\n" },
      async ({ repoDir, shim, resolver }) => {
        const root = repoTopLevel(repoDir);
        seedIssueThreadCacheForTest(root, ISSUE, "stale-hash");
        const result = await update(repoDir, resolver);
        assert.equal(result.changed, false);
        assert.equal(shim.patchCalls().length, 0);
        assert.equal(peekIssueThreadCacheForTest(root, ISSUE), null);
      });
  });

  it("validates the requested addition even on a no-op", async () => {
    await withFixture({ body: "## Requirements\n\n- GC-GHOST — stale\n", requirements: [] },
      async ({ repoDir, shim, resolver }) => {
        const result = await update(repoDir, resolver, { requirementUids: ["GC-GHOST"] });
        assert.equal(result.ok, false);
        assert.equal(result.error, "issue_requirements_uid_unresolved");
        assert.equal(shim.patchCalls().length, 0);
      });
  });
});

describe("gc_update_issue_requirements — requirement identity", () => {
  it("refuses a UID with no repo-local requirement file, before any write", async () => {
    await withFixture({ body: "## Requirements\n\n", requirements: [] },
      async ({ repoDir, shim, resolver }) => {
        const result = await update(repoDir, resolver);
        assert.equal(result.ok, false);
        assert.equal(result.error, "issue_requirements_uid_unresolved");
        assert.equal(shim.patchCalls().length, 0);
      });
  });

  it("refuses a requirement whose frontmatter id does not match its directory", async () => {
    await withFixture({ body: "## Requirements\n\n", requirements: [{ uid: "GC-O007", id: "GC-O008" }] },
      async ({ repoDir, shim, resolver }) => {
        const result = await update(repoDir, resolver);
        assert.equal(result.ok, false);
        assert.equal(result.error, "issue_requirements_uid_unresolved");
        assert.equal(shim.patchCalls().length, 0);
      });
  });

  it("refuses when a UID already in the section no longer resolves", async () => {
    await withFixture({
      body: "## Requirements\n\n- GC-X999 — gone\n",
      requirements: ["GC-O007"],
    }, async ({ repoDir, shim, resolver }) => {
      const result = await update(repoDir, resolver);
      assert.equal(result.ok, false);
      assert.equal(result.error, "issue_requirements_uid_unresolved");
      assert.equal(shim.patchCalls().length, 0, "no partial edit");
    });
  });
});
