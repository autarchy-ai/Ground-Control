// Shared hermetic `gh` shim for the close-path suites (issue #1686).
//
// Two suites drive `runCloseIssueAfterMerge` against a throwaway repository and a
// PATH-shimmed `gh`: the close gates themselves, and the pickup-label lifecycle. The shim
// was defined inside the first of them until the second needed it; duplicating it into two
// files is how two copies drift.
//
// Named `.test.js` rather than `.test-helpers.js` because the environment-inventory parity
// gate classifies every other `.js` here as server source and would demand this file's
// `process.env.PATH` read be inventoried as a server variable. It carries its own
// self-check rather than being an empty suite: the shim is generated source, and its argv
// log is what every "no request was made" assertion rests on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

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
// Every invocation is recorded, not just the routed ones. A best-effort caller swallows
// this shim's unhandled-argv failure, so without a log "no request was made" and "a request
// was made against a route that does not exist" are the same observation, and any assertion
// that something was NOT requested passes vacuously (issue #1686).
fs.appendFileSync(cfg.argv_log, JSON.stringify(argv) + "\n");
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
  const argvLog = join(binDir, "argv.log");
  writeFileSync(configPath, JSON.stringify({ ...ghHandler, argv_log: argvLog }));
  writeFileSync(join(binDir, "gh"), buildGhRouteShimSource(configPath), { mode: 0o755 });
  return {
    repoDir, binDir,
    /** Every argv this shim was invoked with, routed or not. */
    calls() {
      if (!existsSync(argvLog)) return [];
      return readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    cleanup() { rmSync(repoDir, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); },
  };
}

async function withShimPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

// Repeated fixture literals, hoisted to named constants (Sonar S1192).
export const PR_MERGED_AT = "2026-05-30T10:00:00Z";
export const LINKED_PR_URL = "https://github.com/fake/repo/pull/42";
export const ISSUE_API_PATH = "/repos/fake/repo/issues/1058";
// Proof that merged requirement-state validation ran: the trusted final-report
// marker on the issue thread (issue #1541). By close time in the real flow, the
// post-merge completion assertion has posted it.
export const FINAL_REPORT_MARKER = '<!-- gc:final-report issue="1058" pr="42" -->';
// `gh api --paginate --slurp` wraps each page's array in an outer array.
export const slurpComments = (comments) => JSON.stringify([comments]);
// Routes that satisfy the final-report marker gate: a trusted (repo-write author)
// comment carrying the marker, plus the collaborator-permission lookup trust uses.
export const MARKER_TRUST_ROUTES = [
  {
    argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
    stdout: slurpComments([{ body: FINAL_REPORT_MARKER, user: { login: "fake" }, author_association: "OWNER" }]),
  },
  {
    argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/fake/permission"],
    stdout: "write\n",
  },
];

export function makeShimRepo({ ghHandler }) {
  return makeRouteShimRepo({ ghHandler, repoPrefix: "gc-close-test-", binPrefix: "gc-close-bin-" });
}

// Runs runCloseIssueAfterMerge against `shim` (on the shimmed PATH) and hands
// the structured result to `assertResult`, then cleans the shim up. Removes
// the import + path-wrap + try/finally cleanup boilerplate repeated by the
// result-asserting cases.
export async function withCloseResult(shim, issueNumber, assertResult) {
  try {
    await withShimPath(shim.binDir, async () => {
      const { runCloseIssueAfterMerge } = await import("./lib.js");
      const r = await runCloseIssueAfterMerge({ repoPath: shim.repoDir, issueNumber }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
      assertResult(r);
    });
  } finally {
    shim.cleanup();
  }
}

export { GH_NAME_WITH_OWNER, initGitRepo, makeRouteShimRepo, withShimPath };

describe("close-path gh shim fixture", () => {
  it("replays a routed call and records every invocation, routed or not", async () => {
    const shim = makeRouteShimRepo({
      ghHandler: { routes: [{ argv_prefix: ["api", "/routed"], stdout: '{"ok":true}' }] },
      repoPrefix: "gc-shim-fixture-repo-",
      binPrefix: "gc-shim-fixture-bin-",
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const out = execFileSync("gh", ["api", "/routed"], { env: process.env }).toString();
        assert.deepEqual(JSON.parse(out), { ok: true });
        // An unrouted call still lands in the log, which is the whole point of having one.
        assert.throws(() => execFileSync("gh", ["api", "/unrouted"], { env: process.env, stdio: "pipe" }));
      });
      assert.deepEqual(shim.calls(), [["api", "/routed"], ["api", "/unrouted"]]);
    } finally {
      shim.cleanup();
    }
  });
});
