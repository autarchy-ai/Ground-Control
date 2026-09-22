import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_OBJECT_ID_RE } from "./codex-workflow.js";
import { runImplementGit } from "./codex-workflow-2.js";
import { assertSafeImplementCheckoutConfiguration, computeReviewDiff } from "./grc-legacy-compat-4.js";
import { execFile } from "./runtime-primitives.js";

/**
 * The Git tree `git add -A` would stage — exactly what the publish action commits.
 *
 * This is the identity that survives the commit, so it is the one a zero-finding
 * review can authorise (issue #1679). The review digest cannot serve: it binds
 * the head OID and the uncommitted diff text, both of which necessarily change
 * once the work is committed.
 *
 * Two properties make this staging safe and faithful, and both were review
 * findings against the first version of it:
 *
 * `git add -A` runs configured clean and process filters, so it executes
 * checkout-controlled code. Every other staging site in the workflow sits behind
 * the executable-configuration guard; this one must too, on every caller path,
 * because review reaches it directly and publication reaches it again later
 * (security-F1). The shared Git helper disables hooks and fsmonitor but not
 * filters, so the helper alone is not the guard.
 *
 * The temporary index is seeded from the repository's **current** index, not from
 * HEAD. The publisher stages against that index, so a path force-added from an
 * ignored location is tracked there and is committed; a HEAD-seeded index would
 * treat it as ignored and drop it, and the candidate tree would then differ from
 * the delivered tree for content nobody changed (core-F3).
 *
 * The caller's own index and working tree are untouched, and no file content
 * reaches argv.
 */
export async function captureCandidateTreeOid(repoRoot, {
  commandRunner = execFile,
  assertCheckoutConfiguration = assertSafeImplementCheckoutConfiguration,
} = {}) {
  try {
    await assertCheckoutConfiguration(repoRoot);
  } catch (error) {
    throw Object.assign(
      new Error(`refusing to stage a candidate tree in this checkout: ${error.message}`),
      { code: "review_checkout_configuration_unsafe" },
    );
  }
  const { stdout: gitDirOut } = await runImplementGit(repoRoot, ["rev-parse", "--absolute-git-dir"], commandRunner);
  const indexFile = join(tmpdir(), `gc-candidate-tree-${randomBytes(12).toString("hex")}.index`);
  const run = (argv) => runImplementGit(repoRoot, argv, commandRunner, { GIT_INDEX_FILE: indexFile });
  try {
    await seedCandidateIndex(gitDirOut.trim(), indexFile, run);
    await run(["add", "-A"]);
    const { stdout } = await run(["write-tree"]);
    const oid = stdout.trim();
    if (!GIT_OBJECT_ID_RE.test(oid)) {
      throw Object.assign(new Error("candidate tree capture did not produce an object id"),
        { code: "review_candidate_tree_unavailable" });
    }
    return oid;
  } finally {
    rmSync(indexFile, { force: true });
    rmSync(`${indexFile}.lock`, { force: true });
  }
}

// Git writes its index atomically through a lockfile and rename, so a plain copy
// reads one whole version of it. A repository that has no index yet has nothing
// staged, so HEAD is the same starting point.
//
// The copy keeps the index's own timestamps. Git re-reads any file modified no
// earlier than the index was written ("racily clean"), because its stat data
// cannot tell such an edit apart. A fresh mtime on the copy would switch that
// check off and miss a same-size edit made within the index's timestamp, so the
// captured tree would differ from what `git add -A` stages. Date carries whole
// milliseconds, truncating downward, which can only widen the check.
async function seedCandidateIndex(gitDir, indexFile, run) {
  const source = join(gitDir, "index");
  try {
    copyFileSync(source, indexFile);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same derived path as the copy above
    const { atime, mtime } = statSync(source);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the random temp name created above
    utimesSync(indexFile, atime, mtime);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await run(["read-tree", "HEAD"]);
  }
}

function lengthDelimited(parts) {
  return parts.map((part) => {
    const value = typeof part === "string" ? part : JSON.stringify(part);
    return `${Buffer.byteLength(value, "utf8")}:${value}`;
  }).join("|");
}

export function buildReviewRevision({
  headOid,
  baseOid,
  candidateTreeOid,
  diffText,
  manifest,
  unreviewedUntrackedPaths = [],
  trackedSymlinks = [],
}) {
  if (!GIT_OBJECT_ID_RE.test(String(headOid)) || !GIT_OBJECT_ID_RE.test(String(baseOid))) {
    throw new TypeError("review revision requires canonical HEAD and base object ids");
  }
  if (!GIT_OBJECT_ID_RE.test(String(candidateTreeOid))) {
    throw new TypeError("review revision requires the candidate tree object id");
  }
  if (typeof diffText !== "string" || typeof manifest !== "string") {
    throw new TypeError("review revision requires diffText and manifest strings");
  }
  const paths = [...unreviewedUntrackedPaths];
  if (paths.some((path) => typeof path !== "string" || path.length === 0)) {
    throw new TypeError("unreviewed paths must be non-empty strings");
  }
  paths.sort((left, right) => left.localeCompare(right, "en"));
  const symlinks = trackedSymlinks.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry == null || typeof entry.path !== "string" || typeof entry.target !== "string"
      || typeof entry.escapes_repo !== "boolean") return "";
    return JSON.stringify({ path: entry.path, target: entry.target, escapes_repo: entry.escapes_repo });
  });
  if (symlinks.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error("tracked symlinks are invalid");
  symlinks.sort((left, right) => left.localeCompare(right, "en"));
  const digest = createHash("sha256").update(lengthDelimited([
    headOid, baseOid, diffText, manifest, paths, symlinks,
  ])).digest("hex");
  return {
    head_oid: headOid,
    base_oid: baseOid,
    // Not folded into `digest`: the digest binds what the reviewers received,
    // while this binds what a delivery would carry. They are different questions
    // and the gates ask them separately (issue #1679).
    candidate_tree_oid: candidateTreeOid,
    digest,
    unreviewed_untracked_paths: paths,
    tracked_symlinks: symlinks,
  };
}

async function resolveHead(repoRoot, commandRunner) {
  try {
    const { stdout } = await commandRunner("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
    const oid = stdout.trim();
    if (GIT_OBJECT_ID_RE.test(oid)) return oid;
  } catch { /* reported below as an unresolvable revision */ }
  return null;
}

export async function captureReviewRevision({
  repoRoot,
  baseBranch,
  uncommitted,
  reviewDiff = null,
}, {
  commandRunner = execFile,
  computeDiff = computeReviewDiff,
  captureCandidateTree = captureCandidateTreeOid,
  assertCheckoutConfiguration = assertSafeImplementCheckoutConfiguration,
} = {}) {
  const capture = async (providedDiff = null) => {
    const beforeHead = await resolveHead(repoRoot, commandRunner);
    const diff = providedDiff ?? await computeDiff(repoRoot, baseBranch, uncommitted);
    const afterHead = await resolveHead(repoRoot, commandRunner);
    if (beforeHead !== afterHead) {
      throw Object.assign(new Error("review revision changed during capture"), { code: "review_revision_changed_during_capture" });
    }
    return { revision: buildReviewRevision({
      headOid: afterHead,
      // The object the patch was generated from, never a re-resolved ref: the
      // base ref can advance without moving the diff base (issue #1694).
      baseOid: diff.baseOid,
      candidateTreeOid: await captureCandidateTree(repoRoot, { commandRunner, assertCheckoutConfiguration }),
      diffText: diff.diffText,
      manifest: diff.manifest,
      unreviewedUntrackedPaths: diff.unreviewedUntrackedPaths,
      trackedSymlinks: diff.trackedSymlinks,
    }), diff };
  };
  if (reviewDiff != null) return capture(reviewDiff);
  const first = await capture();
  const second = await capture();
  // The candidate tree is compared too: it is not part of `digest`, and it is the
  // only identity that notices a change to untracked file *content* (issue #1679).
  if (first.revision.digest !== second.revision.digest
    || first.revision.candidate_tree_oid !== second.revision.candidate_tree_oid) {
    throw Object.assign(new Error("review input changed during capture"), { code: "review_revision_changed_during_capture" });
  }
  return second;
}

const REVIEW_DRIFT_MESSAGES = {
  head_moved: "HEAD moved after the review ran, so the reviewed candidate is no longer the checkout's.",
  candidate_changed: "The candidate tree changed after the review ran.",
  base_moved: "The review's diff base moved after it ran while HEAD and the candidate tree did not; re-run the review against the current base.",
  review_input_changed: "The reviewed input changed after the review ran (tracked diff, untracked path set, or tracked symlinks).",
};
export const REVIEW_DRIFT_CAUSES = Object.freeze(Object.keys(REVIEW_DRIFT_MESSAGES));

/**
 * Why a retained revision no longer matches the live one, or null when it still
 * does. The digest binds what the reviewers saw and the candidate tree binds what
 * a delivery would carry, so either moving makes the review stale; the cause
 * keeps a base-only move from being reported as a working-tree change.
 */
export function describeReviewRevisionDrift(retained, observed) {
  let cause = null;
  if (retained.head_oid !== observed.head_oid) cause = "head_moved";
  else if (retained.candidate_tree_oid !== observed.candidate_tree_oid) cause = "candidate_changed";
  else if (retained.base_oid !== observed.base_oid) cause = "base_moved";
  else if (retained.digest !== observed.digest) cause = "review_input_changed";
  return cause && { cause, message: reviewDriftMessage(cause) };
}

export function reviewDriftMessage(cause) {
  return REVIEW_DRIFT_MESSAGES[cause] ?? "The review input changed after the review ran.";
}
