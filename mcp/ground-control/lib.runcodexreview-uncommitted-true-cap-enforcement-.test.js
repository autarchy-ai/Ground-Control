// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CODEX_REVIEW_PREPUSH_HARD_CAP, buildCodexReviewPrePushCycleMarker, runCodexReview } from "./lib.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

async function withShimPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

describe("runCodexReview uncommitted=true cap enforcement (hermetic gh shim)", () => {
  // These tests exercise the actual cap-enforcement wiring: read prior markers
  // from the issue thread, evaluate the cap, refuse cycle 3+ with the right
  // structured error. We cannot mock node:child_process execFile directly
  // (ESM imports), so we shadow `gh` via a fake binary at the front of PATH.
  // The cap-refusal short-circuit happens BEFORE codex is spawned, so we only
  // need to fake `gh` (not `codex`) for these paths.

  function makeShimRepo({ branch, ghHandler }) {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-shim-repo-"));
    execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", branch]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
    writeFileSync(join(repoDir, "README"), "x\n");
    execFileSync("git", ["-C", repoDir, "add", "README"]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
    // Real origin so owner/repo resolves from the git remote, as production does. git ignores
    // GH_REPO; the `gh repo view` fallback honours it.
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);

    const binDir = mkdtempSync(join(tmpdir(), "gc-shim-bin-"));
    // Persist routing data in a JSON file so the shim — a separate process —
    // can read it. Each test owns its own shim dir / config.
    const configPath = join(binDir, "config.json");
    writeFileSync(configPath, JSON.stringify(ghHandler));
    // Fake `gh`: dispatch on argv to canned responses keyed by argv-prefix.
    const ghShim = `#!/usr/bin/env node
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
process.stderr.write("gh shim: unhandled argv: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
    const ghPath = join(binDir, "gh");
    writeFileSync(ghPath, ghShim, { mode: 0o755 });
    return {
      repoDir,
      binDir,
      cleanup() {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      },
    };
  }

  async function withShimPath(binDir, fn) {
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = oldPath;
    }
  }

  function commentBody(marker) {
    return JSON.stringify([{ id: 1, body: marker, user: { login: "tester" } }]);
  }

  it("refuses cycle 4 with codex_review_prepush_cap_reached when 3 prior markers exist", async () => {
    // Cap-3 (issue #804): refusal kicks in at the 4th cycle attempt.
    const m1 = buildCodexReviewPrePushCycleMarker({
      issueNumber: 796,
      branchName: "796-x",
      cycleNumber: 1,
    });
    const m2 = buildCodexReviewPrePushCycleMarker({
      issueNumber: 796,
      branchName: "796-x",
      cycleNumber: 2,
    });
    const m3 = buildCodexReviewPrePushCycleMarker({
      issueNumber: 796,
      branchName: "796-x",
      cycleNumber: 3,
    });
    // gh api --paginate --slurp wraps pages in an outer array.
    const slurpedComments = JSON.stringify([
      [
        { id: 1, body: m1, user: { login: "tester" } },
        { id: 2, body: m2, user: { login: "tester" } },
        { id: 3, body: m3, user: { login: "tester" } },
      ],
    ]);

    const shim = makeShimRepo({
      branch: "796-x",
      ghHandler: {
        routes: [
          {
            argv_prefix: ["repo", "view", "--json", "nameWithOwner"],
            stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
          },
          {
            // Phase markers are believed only from an author with repository permission.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"],
            stdout: "write\n",
          },
          {
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: slurpedComments,
          },
        ],
      },
    });

    try {
      await withShimPath(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, false);
        assert.equal(result.error, "codex_review_prepush_cap_reached");
        assert.equal(result.prior_cycles, 3);
        assert.equal(result.cap, CODEX_REVIEW_PREPUSH_HARD_CAP);
        assert.equal(result.issue_number, 796);
        assert.equal(result.branch, "796-x");
        assert.equal(result.next_action, "ask_over_cap_or_proceed");
        assert.equal(result.finding_count, 0);
        assert.deepEqual(result.comments, []);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("does NOT refuse on cycle 1 when no prior markers exist (positive path through cap evaluation)", async () => {
    // Empty issue thread: 0 prior markers → cap evaluator returns ok with
    // cycle 1. The function then progresses to computing diff and spawning
    // codex, which we don't have. We accept either a thrown shell-exec
    // failure or a returned non-cap-error envelope as proof we got past the
    // cap-refusal short-circuit.
    const shim = makeShimRepo({
      branch: "796-x",
      ghHandler: {
        routes: [
          {
            argv_prefix: ["repo", "view", "--json", "nameWithOwner"],
            stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
          },
          {
            // Phase markers are believed only from an author with repository permission.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"],
            stdout: "write\n",
          },
          {
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: JSON.stringify([[]]), // one empty page
          },
        ],
      },
    });

    try {
      await withShimPath(shim.binDir, async () => {
        let result;
        let thrown;
        try {
          result = await runCodexReview({
            repoPath: shim.repoDir,
            uncommitted: true,
          }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        } catch (err) {
          thrown = err;
        }
        // The cap-refusal short-circuit must NOT have fired, regardless of
        // whether the function went on to throw (downstream tooling failure
        // in this hermetic shim) or returned an envelope. Both paths must
        // assert something — leaving the throw branch un-asserted would let
        // any future regression in the cap evaluator pass silently.
        if (thrown !== undefined) {
          assert.doesNotMatch(
            String(thrown && thrown.message ? thrown.message : thrown),
            /codex_review_prepush_cap_reached/,
            "cap-refusal short-circuit must not surface as a thrown error on cycle 1",
          );
        } else {
          assert.notEqual(result.error, "codex_review_prepush_cap_reached");
        }
      });
    } finally {
      shim.cleanup();
    }
  });

  it("branch rename does NOT bypass cap — markers from any branch on the issue count", async () => {
    // Per #800 review cycle 2: under per-(issue, branch) keying a noncompliant
    // agent could rename the branch to evade the cap. Per-issue keying closes
    // that bypass: 3 markers exist for issue #796 on branch '796-different',
    // current branch is '796-x' (rename), cycle 4 must still be refused.
    // Cap-3 (issue #804): the cap is now 3, so the bypass test simulates 3
    // prior markers and asserts cycle 4 is refused.
    const otherBranchM1 = buildCodexReviewPrePushCycleMarker({
      issueNumber: 796,
      branchName: "796-different-branch",
      cycleNumber: 1,
    });
    const otherBranchM2 = buildCodexReviewPrePushCycleMarker({
      issueNumber: 796,
      branchName: "796-different-branch",
      cycleNumber: 2,
    });
    const otherBranchM3 = buildCodexReviewPrePushCycleMarker({
      issueNumber: 796,
      branchName: "796-different-branch",
      cycleNumber: 3,
    });
    const slurpedComments = JSON.stringify([
      [
        { id: 1, body: otherBranchM1, user: { login: "tester" } },
        { id: 2, body: otherBranchM2, user: { login: "tester" } },
        { id: 3, body: otherBranchM3, user: { login: "tester" } },
      ],
    ]);

    const shim = makeShimRepo({
      branch: "796-x", // renamed branch
      ghHandler: {
        routes: [
          {
            argv_prefix: ["repo", "view", "--json", "nameWithOwner"],
            stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
          },
          {
            // Phase markers are believed only from an author with repository permission.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"],
            stdout: "write\n",
          },
          {
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: slurpedComments,
          },
        ],
      },
    });

    try {
      await withShimPath(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, false);
        assert.equal(result.error, "codex_review_prepush_cap_reached");
        assert.equal(result.prior_cycles, 3);
        assert.equal(result.branch, "796-x"); // current branch reflected
      });
    } finally {
      shim.cleanup();
    }
  });

  // Single-token reference so eslint-no-unused-vars is happy when the helper
  // is otherwise indirectly used.
  void commentBody;
});
