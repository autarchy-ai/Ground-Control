// The installed `grndctl` command and its skill installer (issue #1587).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installSkills, resolveSkillRoots } from "./lib/install-skills.js";

const BIN = fileURLToPath(new URL("./bin/grndctl.js", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

function skillsFixture() {
  const dir = mkdtempSync(join(tmpdir(), "grndctl-skills-"));
  mkdirSync(join(dir, "skills", "implement", "steps"), { recursive: true });
  writeFileSync(join(dir, "skills", "implement", "SKILL.md"), "# implement\n");
  writeFileSync(join(dir, "skills", "implement", "steps", "step-01.md"), "step\n");
  mkdirSync(join(dir, "skills", "quickfix"));
  writeFileSync(join(dir, "skills", "quickfix", "SKILL.md"), "# quickfix\n");
  return { dir, skills: join(dir, "skills"), root: join(dir, "home", "skills") };
}

describe("grndctl command", () => {
  it("prints the installed package version", () => {
    assert.equal(execFileSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).trim(), PKG.version);
  });

  it("rejects an unknown command with usage and a non-zero exit", () => {
    const result = spawnSync(process.execPath, [BIN, "deploy-everything"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: grndctl <command>/);
  });

  it("is declared as the package bin and ships no tests", () => {
    assert.deepEqual(PKG.bin, { grndctl: "bin/grndctl.js" });
    assert.ok(PKG.files.includes("!**/*.test.js"));
    assert.equal(PKG.private, undefined);
  });
});

describe("installSkills", () => {
  it("installs copies, replaces a checkout symlink, and reports an unchanged copy as current", () => {
    const { dir, skills, root } = skillsFixture();
    try {
      mkdirSync(root, { recursive: true });
      symlinkSync(join(dir, "skills", "implement"), join(root, "implement"));
      const first = installSkills({ skillsDir: skills, roots: [root] });
      assert.deepEqual(first.map((r) => [r.skill, r.action]), [["implement", "replaced"], ["quickfix", "installed"]]);
      // A copy, not a link back into wherever the package or checkout lives.
      assert.equal(lstatSync(join(root, "implement")).isSymbolicLink(), false);
      assert.equal(readFileSync(join(root, "implement", "steps", "step-01.md"), "utf8"), "step\n");
      const second = installSkills({ skillsDir: skills, roots: [root] });
      assert.deepEqual(second.map((r) => r.action), ["current", "current"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a locally modified skill alone unless forced", () => {
    const { dir, skills, root } = skillsFixture();
    try {
      installSkills({ skillsDir: skills, roots: [root] });
      writeFileSync(join(root, "quickfix", "SKILL.md"), "# my local edits\n");
      const skipped = installSkills({ skillsDir: skills, roots: [root] });
      assert.equal(skipped.find((r) => r.skill === "quickfix").action, "skipped");
      assert.equal(readFileSync(join(root, "quickfix", "SKILL.md"), "utf8"), "# my local edits\n");
      const forced = installSkills({ skillsDir: skills, roots: [root], force: true });
      assert.equal(forced.find((r) => r.skill === "quickfix").action, "replaced");
      assert.equal(readFileSync(join(root, "quickfix", "SKILL.md"), "utf8"), "# quickfix\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing on a dry run", () => {
    const { dir, skills, root } = skillsFixture();
    try {
      const results = installSkills({ skillsDir: skills, roots: [root], dryRun: true });
      assert.deepEqual(results.map((r) => r.action), ["installed", "installed"]);
      assert.equal(lstatSync(root, { throwIfNoEntry: false }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("targets Claude, Codex, and Cursor skill directories, each overridable or skippable", () => {
    assert.deepEqual(resolveSkillRoots([], "/h"), ["/h/.claude/skills", "/h/.codex/skills", "/h/.cursor/skills"]);
    assert.deepEqual(resolveSkillRoots(["--claude-dir", "/c", "--no-codex", "--no-cursor"], "/h"), ["/c"]);
  });
});
