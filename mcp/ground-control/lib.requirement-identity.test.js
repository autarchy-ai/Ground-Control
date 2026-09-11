// readRequirementIdentity — strict working-tree identity for a write gate (issue #1569).
//
// readRequirementByUid applies an `id || uid` fallback so a missing or mismatched
// frontmatter id reads back as fine. That is tolerable for a read and not tolerable
// when the UID is about to be written into an issue's authoritative scope section,
// where the privileged MCP process also publishes the requirement's title.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPathOfOpenFile, readRequirementIdentity } from "./lib/requirement-files.js";

function makeRepo() {
  return mkdtempSync(join(tmpdir(), "gc-req-identity-"));
}

function writeRequirement(dir, uid, { id = uid, title = "Some Requirement", frontmatter = true } = {}) {
  const target = join(dir, "docs", "requirements", uid);
  mkdirSync(target, { recursive: true });
  const head = frontmatter
    ? ["---", `id: ${id}`, `title: "${title}"`, "status: ACTIVE", "---", ""].join("\n")
    : "no frontmatter here";
  writeFileSync(join(target, "requirement.md"), `${head}\n## Statement\n\nThe system shall work.\n`);
  return target;
}

describe("canonicalPathOfOpenFile", () => {
  it("resolves the file the descriptor holds, not whatever the pathname later names", async () => {
    // The race the pathname check loses: validating `path` after opening it lets an
    // attacker re-point the path between the two. Moving the opened file makes the two
    // answers differ deterministically — a pathname resolve cannot find it at all.
    const dir = makeRepo();
    try {
      const opened = join(dir, "opened.md");
      const moved = join(dir, "moved.md");
      writeFileSync(opened, "content\n");
      const handle = await fsp.open(opened, "r");
      try {
        renameSync(opened, moved);
        assert.equal(await canonicalPathOfOpenFile(handle), await fsp.realpath(moved));
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects rather than falling back to a pathname resolve when the descriptor cannot be named", async () => {
    // A pathname fallback IS the race this closes, so on a host without descriptor
    // canonicalization the check must fail rather than quietly accept a weaker one.
    const dir = makeRepo();
    try {
      const file = join(dir, "closed.md");
      writeFileSync(file, "content\n");
      const handle = await fsp.open(file, "r");
      await handle.close();
      await assert.rejects(() => canonicalPathOfOpenFile(handle));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readRequirementIdentity", () => {
  it("returns the raw frontmatter id rather than falling back to the directory name", async () => {
    const repo = makeRepo();
    try {
      writeRequirement(repo, "GC-O007", { id: "GC-O008" });
      const identity = await readRequirementIdentity(repo, "GC-O007");
      assert.equal(identity.found, true);
      assert.equal(identity.malformed, false);
      assert.equal(identity.frontmatterId, "GC-O008", "the id || uid fallback must not hide a mismatch");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports a missing frontmatter id as null instead of the directory name", async () => {
    const repo = makeRepo();
    try {
      const dir = join(repo, "docs", "requirements", "GC-O007");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "requirement.md"), '---\ntitle: "No id"\nstatus: ACTIVE\n---\n\n## Statement\n\nx\n');
      const identity = await readRequirementIdentity(repo, "GC-O007");
      assert.equal(identity.frontmatterId, null);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports a file without frontmatter as malformed", async () => {
    const repo = makeRepo();
    try {
      writeRequirement(repo, "GC-O007", { frontmatter: false });
      const identity = await readRequirementIdentity(repo, "GC-O007");
      assert.deepEqual(identity, { found: true, malformed: true });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a UID directory that is a symlink out of the requirements tree", async () => {
    const repo = makeRepo();
    const elsewhere = makeRepo();
    try {
      // A real requirement in another checkout, reachable only through a linked ancestor.
      writeRequirement(elsewhere, "GC-O007", { title: "Borrowed From Another Checkout" });
      mkdirSync(join(repo, "docs", "requirements"), { recursive: true });
      symlinkSync(join(elsewhere, "docs", "requirements", "GC-O007"), join(repo, "docs", "requirements", "GC-O007"));
      const identity = await readRequirementIdentity(repo, "GC-O007");
      assert.equal(identity.found, false,
        "an lstat of the leaf alone follows a symlinked ancestor into another repository");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a requirements root that is a symlink into another checkout", async () => {
    const repo = makeRepo();
    const elsewhere = makeRepo();
    try {
      // Canonicalizing `docs/requirements` itself would let that directory become an
      // external trust root: both sides would resolve outside this repository and
      // compare equal, disclosing another checkout's requirement title.
      writeRequirement(elsewhere, "GC-O007", { title: "Confidential Requirement Title" });
      mkdirSync(join(repo, "docs"), { recursive: true });
      symlinkSync(join(elsewhere, "docs", "requirements"), join(repo, "docs", "requirements"));
      const identity = await readRequirementIdentity(repo, "GC-O007");
      assert.equal(identity.found, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a docs directory that is a symlink into another checkout", async () => {
    const repo = makeRepo();
    const elsewhere = makeRepo();
    try {
      writeRequirement(elsewhere, "GC-O007");
      symlinkSync(join(elsewhere, "docs"), join(repo, "docs"));
      const identity = await readRequirementIdentity(repo, "GC-O007");
      assert.equal(identity.found, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a requirement.md that is itself a symlink", async () => {
    const repo = makeRepo();
    const elsewhere = makeRepo();
    try {
      writeRequirement(elsewhere, "GC-O007");
      const dir = join(repo, "docs", "requirements", "GC-O007");
      mkdirSync(dir, { recursive: true });
      symlinkSync(join(elsewhere, "docs", "requirements", "GC-O007", "requirement.md"), join(dir, "requirement.md"));
      const identity = await readRequirementIdentity(repo, "GC-O007");
      assert.equal(identity.found, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("accepts a real requirement file at the exact UID path", async () => {
    const repo = makeRepo();
    try {
      writeRequirement(repo, "GC-O007", { title: "Gated Agentic Development Loop" });
      const identity = await readRequirementIdentity(repo, "GC-O007");
      assert.equal(identity.frontmatterId, "GC-O007");
      assert.equal(identity.requirement.title, "Gated Agentic Development Loop");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a UID that is not a bounded requirement identifier", async () => {
    const repo = makeRepo();
    try {
      const identity = await readRequirementIdentity(repo, "../../etc");
      assert.equal(identity.found, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
