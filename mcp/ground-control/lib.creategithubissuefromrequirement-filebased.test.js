// File-based createGitHubIssueFromRequirement (issue #1500, was #1162).
//
// Requirements are repo-local files now: the tool reads
// docs/requirements/<UID>/requirement.md and creates the GitHub issue via `gh`.
// There is no backend read and no backend traceability link — the implementing
// agent records the link in the requirement file's `## Traceability` section as
// part of its diff (thin-it). These tests are fully hermetic: a real throwaway
// git repo with a requirement file plus a PATH-shimmed `gh`; no fetch mock.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGitHubIssueFromRequirement } from "./lib.js";

describe("createGitHubIssueFromRequirement (issue #1500)", () => {
  function makeGhShim(number) {
    const binDir = mkdtempSync(join(tmpdir(), "gc-cgi-bin-"));
    const argvLog = join(binDir, "argv.json");
    const ghShim = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ number: ${number}, html_url: "https://github.com/o/r/issues/${number}" }));
process.exit(0);
`;
    writeFileSync(join(binDir, "gh"), ghShim, { mode: 0o755 });
    return {
      binDir, argvLog,
      ghCalled() { return existsSync(argvLog); },
      ghArgv() { return JSON.parse(readFileSync(argvLog, "utf8")); },
      cleanup() { rmSync(binDir, { recursive: true, force: true }); },
    };
  }

  // createGitHubIssue derives the target slug from the checkout's git origin
  // remote (GC-P026, #1383) and fails closed without one, so each test gets a
  // real throwaway repo whose origin matches the asserted `repo`.
  function makeGitRepoWithOrigin(slug) {
    const dir = mkdtempSync(join(tmpdir(), "gc-cgi-repo-"));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", `https://github.com/${slug}.git`]);
    return dir;
  }

  // Write docs/requirements/<uid>/requirement.md in the exporter's format.
  function writeRequirement(repoDir, { uid, title, status, type = "FUNCTIONAL", priority = "SHOULD", wave = 1, statement = "The system shall work.", rationale }) {
    const dir = join(repoDir, "docs", "requirements", uid);
    mkdirSync(dir, { recursive: true });
    const fm = ["---", `id: ${uid}`];
    if (title != null) fm.push(`title: ${title}`);
    fm.push(`status: ${status}`, `type: ${type}`, `priority: ${priority}`, `wave: ${wave}`, "---", "");
    let body = `## Statement\n\n${statement}\n`;
    if (rationale) body += `\n## Rationale\n\n${rationale}\n`;
    writeFileSync(join(dir, "requirement.md"), fm.join("\n") + "\n" + body);
  }

  async function withShim(binDir, run) {
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try { return await run(); } finally { process.env.PATH = oldPath; }
  }

  it("renders a real title and body and returns an IMPLEMENTS hint for an ACTIVE requirement", async () => {
    const shim = makeGhShim(431);
    const repoDir = makeGitRepoWithOrigin("o/r");
    writeRequirement(repoDir, {
      uid: "AGT-001",
      title: "Agent Orchestration / ReAct Planning Layer",
      status: "ACTIVE",
      statement: "The system shall orchestrate agents.",
      rationale: "Needed for planning.",
    });
    try {
      const result = await withShim(shim.binDir, () =>
        createGitHubIssueFromRequirement({
          uid: "AGT-001",
          repo: "o/r",
          repoRoot: repoDir,
          labels: ["requirement", "wave-1"],
          extraBody: "## Notes\n\nextra context",
        }),
      );

      assert.equal(result.url, "https://github.com/o/r/issues/431");
      assert.equal(result.number, 431);
      assert.equal(result.requirement_uid, "AGT-001");
      assert.equal(result.link_type, "IMPLEMENTS");
      // No backend link is created; the agent records it in the requirement file.
      assert.equal(result.traceability_link, undefined);
      assert.equal(result.traceability_error, undefined);

      // gh was invoked with a derived title/body — never the literal "undefined".
      assert.ok(shim.ghCalled(), "gh should have been called");
      const argv = shim.ghArgv();
      // REST issue creation (issue #1584): fields are `-f key=value` pairs on a pinned path.
      const field = (key) => argv.filter((arg) => arg.startsWith(`${key}=`)).map((arg) => arg.slice(key.length + 1));
      const [title] = field("title");
      const [body] = field("body");
      assert.equal(title, "AGT-001 — Agent Orchestration / ReAct Planning Layer");
      assert.notEqual(body, "undefined");
      assert.ok(body.includes("## Requirements"));
      assert.ok(body.includes("- AGT-001 — Agent Orchestration / ReAct Planning Layer"));
      assert.ok(body.includes("## Notes"));
      assert.deepEqual(argv.slice(0, 4), ["api", "--method", "POST", "/repos/o/r/issues"]);
      assert.deepEqual(field("labels[]"), ["requirement", "wave-1"]);
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("returns a DOCUMENTS hint for a non-ACTIVE (DRAFT) requirement", async () => {
    const shim = makeGhShim(99);
    const repoDir = makeGitRepoWithOrigin("o/r");
    writeRequirement(repoDir, { uid: "AGT-001", title: "Draft Req", status: "DRAFT" });
    try {
      const result = await withShim(shim.binDir, () =>
        createGitHubIssueFromRequirement({ uid: "AGT-001", repo: "o/r", repoRoot: repoDir }),
      );
      assert.equal(result.link_type, "DOCUMENTS");
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("throws before creating an issue when the requirement file does not exist", async () => {
    const shim = makeGhShim(1);
    const repoDir = makeGitRepoWithOrigin("o/r");
    try {
      await withShim(shim.binDir, async () => {
        await assert.rejects(
          () => createGitHubIssueFromRequirement({ uid: "NOPE-001", repo: "o/r", repoRoot: repoDir }),
          /not found/,
        );
      });
      assert.equal(shim.ghCalled(), false, "gh must not be called for a missing requirement");
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("rejects a blank uid before any file read or gh call", async () => {
    const shim = makeGhShim(1);
    const repoDir = makeGitRepoWithOrigin("o/r");
    try {
      await withShim(shim.binDir, async () => {
        await assert.rejects(
          () => createGitHubIssueFromRequirement({ uid: "  ", repoRoot: repoDir }),
          /'uid' is required/,
        );
      });
      assert.equal(shim.ghCalled(), false);
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
