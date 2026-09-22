// Extracted from grc-legacy-compat-4.js to keep it under the 500-line limit (docs/CODING_STANDARDS.md, Sonar S104).
// Review-diff + single-codex-review helpers; re-exported through grc-legacy-compat-4.js so the import surface is unchanged.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { codexEngineEnv } from "./codex-engine-env.js";
import { buildCodexReviewExecArgs } from "./grc-legacy-compat.js";
import { execFile, execFileWithInput, getDefaultCodexTimeoutMs } from "./runtime-primitives.js";
import { GIT_OBJECT_ID_RE, readGeneratedCodexSummary } from "./codex-workflow.js";

// Issue #1557: a numstat row cannot state a deletion — `0\t297\tfoo.mjs` is
// byte-identical to an emptied-but-retained file, and #650 shows a reviewer
// reading it the wrong way round. `--name-status` states the kind. It is an
// ADDITIVE block: the numstat rows above it stay byte-compatible because
// parseNumstatManifest and the review-cap disposition scorer consume them, and
// both manifest parsers skip these rows rather than treating them as a second
// schema (a status column is never an integer).
const NAME_STATUS_FLAG = "--name-status";
const CHANGE_KIND_HEADER =
  "# change kinds — `git diff --name-status` (A added, C copied, D deleted, M modified, R renamed, T type changed)";

async function collectUnreviewedUntrackedPaths(repoRoot) {
  const { stdout } = await execFile(
    "git",
    ["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.split("\0").filter((p) => p !== "");
}
// Issue #1557 security cycle 1: the reviewer may now read the working tree to
// verify a repository fact, and a tracked symlink's target is attacker-supplied
// content that need not stay inside the checkout — `--sandbox read-only` blocks
// writes but does not confine reads. Git stores a symlink as a blob holding its
// target path, so the recorded target IS the link's entire content: handing it
// to the reviewer removes any reason to dereference one. The list is normally
// empty and is bounded so it can never dominate the prompt.
const TRACKED_SYMLINK_LIMIT = 50;
export async function collectTrackedSymlinks(repoRoot) {
  const { stdout } = await execFile(
    "git",
    ["-C", repoRoot, "ls-files", "-s", "-z"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const symlinks = [];
  for (const record of stdout.split("\0")) {
    if (record === "" || !record.startsWith("120000 ")) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const path = record.slice(tab + 1);
    const sha = record.slice(0, tab).split(" ")[1];
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const blob = await execFile("git", ["-C", repoRoot, "cat-file", "blob", sha], {
      maxBuffer: 1024 * 1024,
    });
    const target = blob.stdout.trim();
    const resolved = isAbsolute(target)
      ? target
      : resolvePath(repoRoot, dirname(path), target);
    const rel = relative(repoRoot, resolved);
    symlinks.push({
      path,
      target,
      escapes_repo: rel === "" || rel.startsWith("..") || isAbsolute(rel),
    });
    if (symlinks.length >= TRACKED_SYMLINK_LIMIT) break;
  }
  return symlinks;
}
const git = (repoRoot, args, maxBuffer = 10 * 1024 * 1024) =>
  execFile("git", ["-C", repoRoot, ...args], { maxBuffer });

async function revParseCommit(repoRoot, ref) {
  const { stdout } = await git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const oid = stdout.trim();
  if (!GIT_OBJECT_ID_RE.test(oid)) throw new Error(`${ref} did not resolve to an object id`);
  return oid;
}

// A resolved-but-uncommitted merge is the candidate commit's other parent(s).
// MERGE_HEAD holds one object id per line (several for an octopus merge).
async function readPendingMergeHeads(repoRoot) {
  const { stdout } = await git(repoRoot, ["rev-parse", "--git-path", "MERGE_HEAD"]);
  let text;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from git rev-parse --git-path
    text = readFileSync(resolvePath(repoRoot, stdout.trim()), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const heads = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (heads.some((oid) => !GIT_OBJECT_ID_RE.test(oid))) throw new Error("MERGE_HEAD is not a list of object ids");
  return heads;
}

/**
 * The one object a review diff is generated from (issue #1694). It is the merge
 * base of the requested base ref and the candidate commit - HEAD plus any
 * pending merge heads - so incoming base history a pending merge brings in is
 * part of the base, committed feature work is part of the candidate, and a base
 * that merely advances does not move it. Diffing against the base tip instead
 * would show every unmerged base change as a reverse-applied feature change.
 */
async function resolveReviewDiffBase(repoRoot, baseBranch, candidateParents) {
  const candidates = [`origin/${baseBranch}`, baseBranch, "origin/main", "main"];
  for (const ref of candidates) {
    try {
      const refOid = await revParseCommit(repoRoot, ref);
      const { stdout } = await git(repoRoot, ["merge-base", refOid, ...candidateParents]);
      const baseOid = stdout.trim();
      if (GIT_OBJECT_ID_RE.test(baseOid)) return { ref, baseOid };
    } catch {
      continue;
    }
  }
  throw new Error(`Unable to compute review diff: none of ${candidates.join(", ")} share history with the candidate in ${repoRoot}`);
}

async function diffWithKinds(repoRoot, range) {
  const patch = await git(repoRoot, ["diff", ...range], 50 * 1024 * 1024);
  const numstat = await git(repoRoot, ["diff", ...range, "--numstat"]);
  const kinds = await git(repoRoot, ["diff", ...range, NAME_STATUS_FLAG]);
  return { patch: patch.stdout, numstat: numstat.stdout.trim(), kinds: kinds.stdout.trim() };
}

export async function computeReviewDiff(repoRoot, baseBranch, uncommitted) {
  const headOid = await revParseCommit(repoRoot, "HEAD").catch(() => {
    throw new Error(`Unable to compute review diff: HEAD does not name a commit in ${repoRoot}`);
  });
  const parents = uncommitted ? [headOid, ...await readPendingMergeHeads(repoRoot)] : [headOid];
  const { ref, baseOid } = await resolveReviewDiffBase(repoRoot, baseBranch, parents);
  const baseLine = `# base: ${ref} merge base ${baseOid}`;
  if (uncommitted) {
    // Base-to-index plus index-to-worktree: the index is the candidate Git
    // tracks, so a path it does not track can never reach the patch.
    const staged = await diffWithKinds(repoRoot, ["--cached", baseOid]);
    const unstaged = await diffWithKinds(repoRoot, []);
    const unreviewedUntrackedPaths = await collectUnreviewedUntrackedPaths(repoRoot);
    const trackedSymlinks = await collectTrackedSymlinks(repoRoot);
    return {
      diffText: `${staged.patch}\n${unstaged.patch}`.trim(),
      manifest: [
        baseLine,
        "# staged",
        staged.numstat || "(none)",
        "",
        "# unstaged",
        unstaged.numstat || "(none)",
        "",
        CHANGE_KIND_HEADER,
        "# staged",
        staged.kinds || "(none)",
        "",
        "# unstaged",
        unstaged.kinds || "(none)",
        // Count only: the manifest goes into the reviewer prompt, and a path
        // can itself be revealing. The caller gets the full list off-prompt.
        ...(unreviewedUntrackedPaths.length > 0
          ? [
              "",
              `# untracked: ${unreviewedUntrackedPaths.length} path(s) present but NOT staged and NOT included in this review`,
            ]
          : []),
      ].join("\n"),
      baseRefDescriptor: ref,
      baseOid,
      unreviewedUntrackedPaths,
      trackedSymlinks,
    };
  }
  const committed = await diffWithKinds(repoRoot, [baseOid, headOid]);
  return {
    diffText: committed.patch,
    manifest: [
      baseLine,
      committed.numstat || "(no files changed)",
      "",
      CHANGE_KIND_HEADER,
      committed.kinds || "(no files changed)",
    ].join("\n"),
    baseRefDescriptor: ref,
    baseOid,
    unreviewedUntrackedPaths: [],
    trackedSymlinks: await collectTrackedSymlinks(repoRoot),
  };
}
export async function runSingleCodexReview({ repoRoot, prompt, signal = undefined }) {
  const tempDir = mkdtempSync(join(tmpdir(), "gc-codex-review-"));
  const outputPath = join(tempDir, "codex-last-message.txt");
  try {
    await execFileWithInput(
      "codex",
      buildCodexReviewExecArgs({ repoPath: repoRoot, outputPath }),
      {
        input: prompt,
        cwd: repoRoot,
        maxBuffer: 10 * 1024 * 1024,
        env: codexEngineEnv(),
        timeoutMs: getDefaultCodexTimeoutMs(),
        signal,
      },
    );
    return readGeneratedCodexSummary(outputPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
