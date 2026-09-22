// Issue #1694: an uncommitted pre-push review must cover the feature candidate
// against its requested integration base, not the index against the feature
// branch's old HEAD. Real-git fixtures, because the defect lives in which
// objects git is asked to compare.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { captureReviewRevision, computeReviewDiff } from "./lib.js";

function git(repoDir, ...args) {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
}

function commitFile(repoDir, path, content, message) {
  writeFileSync(join(repoDir, path), content);
  git(repoDir, "add", path);
  git(repoDir, "commit", "-q", "-m", message);
}

// dev: shared.txt; feature (1694-feature): committed feature.txt + shared edit;
// dev then advances with base-only.txt and a conflicting shared.txt edit.
function makeDivergedRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), "gc-reviewdiff-base-"));
  git(repoDir, "init", "-q", "--initial-branch", "dev");
  git(repoDir, "config", "user.email", "t@example.com");
  git(repoDir, "config", "user.name", "t");
  commitFile(repoDir, "shared.txt", "line one\n", "init");
  const forkPoint = git(repoDir, "rev-parse", "HEAD");
  git(repoDir, "checkout", "-q", "-b", "1694-feature");
  commitFile(repoDir, "feature.txt", "committed feature work\n", "feature");
  commitFile(repoDir, "shared.txt", "feature edit\n", "feature shared edit");
  git(repoDir, "checkout", "-q", "dev");
  commitFile(repoDir, "base-only.txt", "incoming integration history\n", "base work");
  commitFile(repoDir, "shared.txt", "base edit\n", "base shared edit");
  git(repoDir, "checkout", "-q", "1694-feature");
  return { repoDir, forkPoint };
}

function mergeBaseWithResolvedConflict(repoDir) {
  try {
    git(repoDir, "merge", "--no-commit", "--no-ff", "dev");
  } catch { /* the shared.txt conflict is expected */ }
  writeFileSync(join(repoDir, "shared.txt"), "resolved edit\n");
  git(repoDir, "add", "shared.txt");
}

describe("computeReviewDiff against the requested base (#1694)", () => {
  it("reviews only the feature candidate during a resolved pending merge", async () => {
    const { repoDir } = makeDivergedRepo();
    try {
      mergeBaseWithResolvedConflict(repoDir);
      const devTip = git(repoDir, "rev-parse", "dev");

      const result = await computeReviewDiff(repoDir, "dev", true);

      assert.equal(result.baseOid, devTip);
      assert.equal(result.baseRefDescriptor, "dev");
      assert.ok(!result.diffText.includes("base-only.txt"), "incoming base history reviewed as feature work");
      assert.ok(!result.manifest.includes("base-only.txt"));
      assert.ok(result.diffText.includes("+committed feature work"), "committed feature work omitted");
      assert.ok(result.diffText.includes("+resolved edit"), "staged conflict resolution omitted");
      assert.ok(result.diffText.includes("-base edit"), "resolution not shown against the base");
      assert.ok(result.manifest.includes(`# base: dev merge base ${devTip}`));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("includes committed implementation on a resumed branch alongside staged and unstaged edits", async () => {
    const { repoDir, forkPoint } = makeDivergedRepo();
    try {
      writeFileSync(join(repoDir, "staged.txt"), "staged addition\n");
      git(repoDir, "add", "staged.txt");
      writeFileSync(join(repoDir, "feature.txt"), "committed feature work\nunstaged addition\n");

      const result = await computeReviewDiff(repoDir, "dev", true);

      assert.equal(result.baseOid, forkPoint);
      assert.ok(result.diffText.includes("+committed feature work"));
      assert.ok(result.diffText.includes("+feature edit"));
      assert.ok(result.diffText.includes("+staged addition"));
      assert.ok(result.diffText.includes("+unstaged addition"));
      // Unmerged base advances are not the candidate's work in either direction.
      assert.ok(!result.diffText.includes("base-only.txt"));
      assert.ok(!result.diffText.includes("base edit"));
      assert.match(result.manifest, /A\tfeature\.txt/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("binds the branch-mode diff to the same resolved base object", async () => {
    const { repoDir, forkPoint } = makeDivergedRepo();
    try {
      const result = await computeReviewDiff(repoDir, "dev", false);
      assert.equal(result.baseOid, forkPoint);
      assert.equal(result.baseRefDescriptor, "dev");
      assert.ok(result.diffText.includes("+committed feature work"));
      assert.ok(!result.diffText.includes("base-only.txt"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("captureReviewRevision under base-only movement (#1694)", () => {
  it("keeps the revision when only the base ref advances past a pending merge", async () => {
    const { repoDir } = makeDivergedRepo();
    try {
      mergeBaseWithResolvedConflict(repoDir);
      const before = await captureReviewRevision({ repoRoot: repoDir, baseBranch: "dev", uncommitted: true });
      // Advance the base without touching HEAD, the index, or the worktree.
      const devTip = git(repoDir, "rev-parse", "dev");
      const blob = execFileSync("git", ["-C", repoDir, "hash-object", "-w", "--stdin"], { input: "later\n" })
        .toString().trim();
      const tree = execFileSync("git", ["-C", repoDir, "mktree"], { input: `100644 blob ${blob}\tlater.txt\n` })
        .toString().trim();
      const advanced = git(repoDir, "commit-tree", tree, "-p", devTip, "-m", "base advances");
      git(repoDir, "update-ref", "refs/heads/dev", advanced);

      const after = await captureReviewRevision({ repoRoot: repoDir, baseBranch: "dev", uncommitted: true });

      assert.equal(after.revision.base_oid, before.revision.base_oid);
      assert.equal(after.revision.candidate_tree_oid, before.revision.candidate_tree_oid);
      assert.equal(after.revision.digest, before.revision.digest);
      assert.equal(before.revision.base_oid, devTip);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
