// runWatchCiRun refuses an unauthorized checkout before touching gh (issue #1559).
//
// The CI watcher resolved its GitHub destination from the caller-selected
// checkout's git origin and then spent the MCP host's credentials on it, so a
// caller could retarget a writable checkout's origin at a private repository the
// host's token can reach. The Sonar watcher's equivalent refusal is covered in
// lib.sonar-watcher-scope-precheck.test.js; this covers the CI sibling, where the
// refusal is terminal because the read *is* the whole operation.
//
// The gh shim records every invocation, so "it never called gh" is asserted
// against evidence rather than inferred from the returned error.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatchCiRun } from "./lib/ci-watcher.js";

function makeRecordingShim() {
  const repoDir = mkdtempSync(join(tmpdir(), "gc-ciauth-repo-"));
  execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", "main"]);
  execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/private-org/private-repo.git"]);

  const binDir = mkdtempSync(join(tmpdir(), "gc-ciauth-bin-"));
  const logPath = join(binDir, "gh-calls.log");
  writeFileSync(
    join(binDir, "gh"),
    `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("[]");
`,
    { mode: 0o755 },
  );
  return {
    repoDir,
    binDir,
    logPath,
    ghCalls: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean) : []),
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

describe("runWatchCiRun — the privileged run lookup is authorized", () => {
  it("returns the refusal and spends no GitHub call on an unauthorized checkout", async () => {
    const shim = makeRecordingShim();
    try {
      const result = await withShimPath(shim.binDir, () => runWatchCiRun({
        repoPath: shim.repoDir,
        branch: "main",
        authorizeRepoRead: async () => ({
          ok: false,
          error: "ci_watch_repo_not_authorized",
          message: "The requested repository is outside the MCP launch workspace authorized for this run",
        }),
      }));
      assert.equal(result.ok, false);
      assert.equal(result.error, "ci_watch_repo_not_authorized");
      assert.deepEqual(shim.ghCalls(), [], "gh must not be invoked for an unauthorized checkout");
    } finally {
      shim.cleanup();
    }
  });

  it("pins the run lookup to the authorized identity, not the checkout's own origin", async () => {
    const shim = makeRecordingShim();
    try {
      await withShimPath(shim.binDir, () => runWatchCiRun({
        repoPath: shim.repoDir,
        branch: "main",
        // The checkout's origin says private-org/private-repo; authorization says
        // otherwise, and the authorized identity is what reaches `--repo`.
        authorizeRepoRead: async () => ({ ok: true, repoSlug: "authorized-owner/authorized-repo" }),
      }));
      const calls = shim.ghCalls().map((line) => JSON.parse(line));
      assert.ok(calls.length > 0, "expected the branch-tip read to reach gh");
      // The branch-tip read (issue #1365) comes first. `gh api` takes no
      // `--repo`, so the authorized slug is pinned in its path instead.
      assert.deepEqual(
        calls[0],
        ["api", "repos/authorized-owner/authorized-repo/commits/main", "--jq", ".sha"],
      );
      assert.equal(
        calls.some((argv) => argv.includes("private-org/private-repo")),
        false,
        "the caller's origin must never become the read's destination",
      );
    } finally {
      shim.cleanup();
    }
  });
});
