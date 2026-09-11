// Shared fixture for the gc_update_issue_requirements suites (issue #1569).
//
// Hermetic: a real throwaway git repo with real requirement files plus a PATH-shimmed
// `gh`, following lib.creategithubissuefromrequirement-filebased.test.js. The shim
// records every argv and persists what it patches, so the repository-bound `gh api`
// contract is asserted against the command actually built rather than a mock's
// expectations. Split out of the test file when that file crossed the 500-line limit
// (ADR-092); duplicating it into two suites is exactly how two copies drift.
//
// Named `.test.js` because the environment-inventory parity gate classifies every other
// `.js` here as server source and would demand this file's `process.env.PATH` read be
// inventoried as a server variable. It carries its own self-check rather than being an
// empty suite: the shim is generated source, and a quoting slip in it once made every
// `gh` call fail with a syntax error that looked like a writer bug.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  getOwnerRepo,
  readGitIdentity,
  resetIssueThreadCacheForTest,
  runUpdateIssueRequirements,
} from "./lib.js";

const ISSUE = 7;

function makeGitRepoWithOrigin(slug = "o/r") {
  const dir = mkdtempSync(join(tmpdir(), "gc-uir-repo-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", `https://github.com/${slug}.git`]);
  return dir;
}

function repoTopLevel(dir) {
  return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"]).toString().trim();
}

function writeRequirement(repoDir, { uid, id = uid, title = "Some Requirement" }) {
  const dir = join(repoDir, "docs", "requirements", uid);
  mkdirSync(dir, { recursive: true });
  const frontmatter = ["---"];
  if (id !== null) frontmatter.push(`id: ${id}`);
  frontmatter.push(`title: "${title}"`, "status: ACTIVE", "type: FUNCTIONAL", "priority: MUST", "wave: 2", "---", "");
  writeFileSync(join(dir, "requirement.md"), `${frontmatter.join("\n")}\n## Statement\n\nThe system shall work.\n`);
}

// The MCP launch authorization is captured once at import time against the real
// checkout. Tests re-capture it against the throwaway repo the same way the
// server does, so the authorization path under test is the production one.
async function launchAuthorizationFor(repoDir) {
  const identity = await readGitIdentity(repoDir);
  const { owner, name } = await getOwnerRepo(repoDir, { allowGhFallback: false });
  const authorization = {
    workspaceRoot: identity.topLevel,
    gitDir: identity.gitDir,
    gitCommonDir: identity.gitCommonDir,
    origin: identity.origin,
    owner: owner.toLowerCase(),
    name: name.toLowerCase(),
  };
  return async () => authorization;
}

// `gh` shim: records argv, serves the stored issue JSON on a read, and echoes the
// patched body back on a write (optionally a different body, to exercise a
// response that does not round-trip).
function makeGhShim({ issue, comments = [], permission = "write", patchBodyOverride = null, patchPayloadOverride = null, failPatch = false }) {
  const binDir = mkdtempSync(join(tmpdir(), "gc-uir-bin-"));
  const argvLog = join(binDir, "argv.json");
  const statePath = join(binDir, "issue.json");
  writeFileSync(statePath, JSON.stringify(issue));
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const log = ${JSON.stringify(argvLog)};
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : [];
calls.push(argv);
fs.writeFileSync(log, JSON.stringify(calls));
if (argv.includes("PATCH")) {
  if (${failPatch ? "true" : "false"}) { process.stderr.write("gh: 502 Bad Gateway\\n"); process.exit(1); }
  const field = argv.find((a) => a.startsWith("body="));
  const stored = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
  const written = ${patchBodyOverride === null ? "field.slice(5)" : JSON.stringify(patchBodyOverride)};
  const payload = ${patchPayloadOverride === null ? "{ ...stored, body: written }" : JSON.stringify(patchPayloadOverride)};
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ ...stored, body: written }));
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
const path = argv.find((a) => a.startsWith("/repos/") || a.startsWith("repos/")) || "";
if (path.endsWith("/comments")) {
  // readIssueCommentsWithAuthors uses --paginate --slurp, so stdout is an array of pages.
  process.stdout.write(JSON.stringify([${JSON.stringify(comments)}]));
  process.exit(0);
}
if (path.includes("/collaborators/")) {
  // getEffectiveRepositoryPermission passes --jq .permission, so gh prints the bare value.
  process.stdout.write(${JSON.stringify(permission)} + "\\n");
  process.exit(0);
}
process.stdout.write(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
`;
  writeFileSync(join(binDir, "gh"), script, { mode: 0o755 });
  return {
    binDir,
    calls() { return existsSync(argvLog) ? JSON.parse(readFileSync(argvLog, "utf8")) : []; },
    patchCalls() { return this.calls().filter((argv) => argv.includes("PATCH")); },
    cleanup() { rmSync(binDir, { recursive: true, force: true }); },
  };
}

async function withShim(binDir, run) {
  const previous = process.env.PATH;
  process.env.PATH = `${binDir}:${previous}`;
  try { return await run(); } finally { process.env.PATH = previous; }
}

// One fixture: throwaway repo + requirement files + gh shim + launch authorization.
async function withFixture({ body, requirements = ["GC-O007"], slug = "o/r", ...shimOptions }, run) {
  const repoDir = makeGitRepoWithOrigin(slug);
  for (const requirement of requirements) {
    writeRequirement(repoDir, typeof requirement === "string" ? { uid: requirement } : requirement);
  }
  const shim = makeGhShim({ issue: { number: ISSUE, body }, ...shimOptions });
  resetIssueThreadCacheForTest();
  try {
    const resolver = await launchAuthorizationFor(repoDir);
    return await withShim(shim.binDir, () => run({ repoDir, shim, resolver }));
  } finally {
    shim.cleanup();
    rmSync(repoDir, { recursive: true, force: true });
  }
}

function update(repoDir, resolver, overrides = {}) {
  return runUpdateIssueRequirements(
    { repoPath: repoDir, issueNumber: ISSUE, operation: "add", requirementUids: ["GC-O007"], ...overrides },
    { workspaceAuthorizationResolver: resolver },
  );
}


export {
  ISSUE,
  makeGitRepoWithOrigin,
  repoTopLevel,
  writeRequirement,
  launchAuthorizationFor,
  makeGhShim,
  withShim,
  withFixture,
  update,
};

describe("gc_update_issue_requirements fixture", () => {
  it("generates a gh shim that actually answers a read", async () => {
    const repoDir = makeGitRepoWithOrigin();
    const shim = makeGhShim({ issue: { number: ISSUE, body: "## Requirements\n\n" } });
    try {
      const out = await withShim(shim.binDir, async () =>
        execFileSync("gh", ["api", `repos/o/r/issues/${ISSUE}`], { env: process.env }).toString());
      assert.deepEqual(JSON.parse(out), { number: ISSUE, body: "## Requirements\n\n" });
      assert.deepEqual(shim.calls(), [["api", `repos/o/r/issues/${ISSUE}`]]);
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
