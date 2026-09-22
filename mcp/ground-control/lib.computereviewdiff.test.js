// Split from lib.planreviewslices.test.js under issue #1557 for the 500-LOC
// limit (docs/CODING_STANDARDS.md, ADR-092). Covers computeReviewDiff's review
// content, manifest, and tracked-symlink evidence surface.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { computeReviewDiff } from "./lib.js";

describe("computeReviewDiff uncommitted tree coverage (#1414)", () => {
  function makeRepo() {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-reviewdiff-"));
    execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", "dev"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
    writeFileSync(join(repoDir, "tracked.txt"), "base\n");
    writeFileSync(join(repoDir, "doomed.txt"), "delete me\n");
    writeFileSync(join(repoDir, ".gitignore"), "ignored.txt\n");
    execFileSync("git", ["-C", repoDir, "add", "-A"]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
    // Real origin so owner/repo resolves from the git remote, as production does. git ignores
    // GH_REPO; the `gh repo view` fallback honours it.
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
    return repoDir;
  }

  it("covers staged, unstaged, and deleted files in the diff and the manifest", async () => {
    const repoDir = makeRepo();
    try {
      writeFileSync(join(repoDir, "staged.txt"), "staged content\n");
      execFileSync("git", ["-C", repoDir, "add", "staged.txt"]);
      writeFileSync(join(repoDir, "tracked.txt"), "base\nunstaged content\n");
      execFileSync("git", ["-C", repoDir, "rm", "-q", "doomed.txt"]);

      const result = await computeReviewDiff(repoDir, "dev", true);

      assert.ok(result.diffText.includes("+staged content"), "staged content missing");
      assert.ok(result.diffText.includes("+unstaged content"), "unstaged content missing");
      // Deletion direction is preserved, not re-rendered as an addition.
      assert.ok(result.diffText.includes("-delete me"));
      // Uncommitted review is bound to its base too (#1694); here HEAD is the base tip.
      assert.equal(result.baseRefDescriptor, "dev");
      assert.deepEqual(result.unreviewedUntrackedPaths, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("states the change kind so a deletion is never read as an emptied file (#1557)", async () => {
    // #650 / PR #1556: `0\t297\ttools/packs/sync_packs.mjs` is byte-identical to
    // an emptied-but-retained file, so a reviewer whose slice held no deletion
    // hunk called three deleted paths "surviving". --name-status states `D`.
    const repoDir = makeRepo();
    try {
      writeFileSync(join(repoDir, "staged.txt"), "staged content\n");
      execFileSync("git", ["-C", repoDir, "add", "staged.txt"]);
      execFileSync("git", ["-C", repoDir, "rm", "-q", "doomed.txt"]);

      const result = await computeReviewDiff(repoDir, "dev", true);

      assert.match(result.manifest, /D\tdoomed\.txt/);
      assert.match(result.manifest, /A\tstaged\.txt/);
      // The numstat block is additive-compatible, not replaced: the cap
      // disposition scorer still parses it.
      assert.match(result.manifest, /0\t1\tdoomed\.txt/);
      assert.match(result.manifest, /1\t0\tstaged\.txt/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("reports a tracked symlink's recorded target and whether it escapes the repo (#1557)", async () => {
    // The reviewer is now told to verify repository facts, so a tracked symlink
    // pointing outside the checkout is an attacker-steerable read. Git stores
    // the target as the blob's content, so the server can hand it over and the
    // reviewer never needs to dereference the link.
    const repoDir = makeRepo();
    try {
      symlinkSync("/etc/hostname", join(repoDir, "escaping.link"));
      symlinkSync("tracked.txt", join(repoDir, "inner.link"));
      execFileSync("git", ["-C", repoDir, "add", "escaping.link", "inner.link"]);

      const result = await computeReviewDiff(repoDir, "dev", true);

      const escaping = result.trackedSymlinks.find((l) => l.path === "escaping.link");
      const inner = result.trackedSymlinks.find((l) => l.path === "inner.link");
      assert.equal(escaping.target, "/etc/hostname");
      assert.equal(escaping.escapes_repo, true);
      assert.equal(inner.target, "tracked.txt");
      assert.equal(inner.escapes_repo, false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("reports no tracked symlinks for an ordinary checkout (#1557)", async () => {
    const repoDir = makeRepo();
    try {
      const result = await computeReviewDiff(repoDir, "dev", true);
      assert.deepEqual(result.trackedSymlinks, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("never transmits untracked file bodies, and reports the omission by count", async () => {
    // Staging is the repository's explicit consent boundary for sending
    // working-tree content to the model provider. A filename or content
    // heuristic cannot authorize that egress: standard credential filenames
    // are unbounded (.pgpass, .dockercfg, ...) and an opaque token is
    // indistinguishable from ordinary text.
    const repoDir = makeRepo();
    try {
      writeFileSync(join(repoDir, ".pgpass"), "localhost:5432:app:admin:hunter2\n");
      writeFileSync(join(repoDir, "scratch.txt"), "ordinary untracked note\n");

      const result = await computeReviewDiff(repoDir, "dev", true);

      // No untracked body reaches the diff, whatever it is named.
      assert.ok(!result.diffText.includes("hunter2"));
      assert.ok(!result.diffText.includes("ordinary untracked note"));
      // The omission is reported, not silent: a count in the reviewer-visible
      // manifest, and the full list off-prompt for the caller.
      assert.match(result.manifest, /# untracked: 2 path\(s\) present but NOT staged/);
      assert.deepEqual(result.unreviewedUntrackedPaths.sort(), [".pgpass", "scratch.txt"]);
      // A path can itself be revealing, so the prompt-visible manifest carries
      // no filenames.
      assert.ok(!result.manifest.includes(".pgpass"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("reviews formerly untracked work once it is staged", async () => {
    // The /implement lane stages with `git add -A` before review, so genuinely
    // new files are reviewed as staged content rather than being skipped.
    const repoDir = makeRepo();
    try {
      writeFileSync(join(repoDir, "brand-new.txt"), "new module body\n");
      execFileSync("git", ["-C", repoDir, "add", "-A"]);

      const result = await computeReviewDiff(repoDir, "dev", true);

      assert.ok(result.diffText.includes("+new module body"));
      assert.ok(result.diffText.includes("diff --git a/brand-new.txt b/brand-new.txt"));
      assert.deepEqual(result.unreviewedUntrackedPaths, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("respects gitignore so ignored files are not even counted as unreviewed", async () => {
    const repoDir = makeRepo();
    try {
      writeFileSync(join(repoDir, "ignored.txt"), "secret-ish\n");

      const result = await computeReviewDiff(repoDir, "dev", true);

      assert.ok(!result.diffText.includes("secret-ish"));
      assert.deepEqual(result.unreviewedUntrackedPaths, []);
      assert.ok(!result.manifest.includes("# untracked:"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("keeps a clean tree empty rather than inventing untracked content", async () => {
    const repoDir = makeRepo();
    try {
      const result = await computeReviewDiff(repoDir, "dev", true);
      assert.equal(result.diffText, "");
      assert.deepEqual(result.unreviewedUntrackedPaths, []);
      assert.ok(!result.manifest.includes("# untracked:"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("computeReviewDiff branch-diff coverage (#1557)", () => {
  // The uncommitted branch and the `${ref}...HEAD` branch of computeReviewDiff
  // build the manifest and the symlink evidence independently, so the
  // committed-branch path needs its own assertions: test-quality review cycle 1
  // showed that reversing the diff direction in this branch failed no test.
  function makeBranchRepo() {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-reviewdiff-branch-"));
    execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", "dev"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
    writeFileSync(join(repoDir, "kept.txt"), "base\n");
    writeFileSync(join(repoDir, "doomed.txt"), "delete me\n");
    execFileSync("git", ["-C", repoDir, "add", "-A"]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
    execFileSync("git", ["-C", repoDir, "checkout", "-q", "-b", "1557-feature"]);
    return repoDir;
  }

  it("states the change kind against the base ref, in the direction of the branch", async () => {
    const repoDir = makeBranchRepo();
    try {
      writeFileSync(join(repoDir, "added.txt"), "new file\n");
      writeFileSync(join(repoDir, "kept.txt"), "base\nmore\n");
      execFileSync("git", ["-C", repoDir, "rm", "-q", "doomed.txt"]);
      execFileSync("git", ["-C", repoDir, "add", "-A"]);
      execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "change"]);

      const result = await computeReviewDiff(repoDir, "dev", false);

      assert.equal(result.baseRefDescriptor, "dev");
      // Direction matters: `doomed.txt` is deleted BY this branch, so it is `D`
      // and never `A`. A reversed `HEAD...ref` would swap exactly these.
      assert.match(result.manifest, /D\tdoomed\.txt/);
      assert.match(result.manifest, /A\tadded\.txt/);
      assert.match(result.manifest, /M\tkept\.txt/);
      assert.ok(!/A\tdoomed\.txt/.test(result.manifest), "deletion rendered as an addition");
      assert.ok(!/D\tadded\.txt/.test(result.manifest), "addition rendered as a deletion");
      // The numstat block is still present and additive-compatible.
      assert.match(result.manifest, /0\t1\tdoomed\.txt/);
      assert.match(result.manifest, /change kinds/);
      assert.ok(result.diffText.includes("-delete me"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("reports tracked symlinks on the branch-diff path too", async () => {
    const repoDir = makeBranchRepo();
    try {
      symlinkSync("/etc/hostname", join(repoDir, "escaping.link"));
      execFileSync("git", ["-C", repoDir, "add", "escaping.link"]);
      execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "link"]);

      const result = await computeReviewDiff(repoDir, "dev", false);

      assert.deepEqual(result.trackedSymlinks, [
        { path: "escaping.link", target: "/etc/hostname", escapes_repo: true },
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
