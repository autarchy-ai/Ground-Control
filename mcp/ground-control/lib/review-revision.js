import { createHash } from "node:crypto";
import { GIT_OBJECT_ID_RE } from "./codex-workflow.js";
import { computeReviewDiff } from "./grc-legacy-compat-4.js";
import { execFile } from "./runtime-primitives.js";

function lengthDelimited(parts) {
  return parts.map((part) => {
    const value = typeof part === "string" ? part : JSON.stringify(part);
    return `${Buffer.byteLength(value, "utf8")}:${value}`;
  }).join("|");
}

export function buildReviewRevision({
  headOid,
  baseOid,
  diffText,
  manifest,
  unreviewedUntrackedPaths = [],
  trackedSymlinks = [],
}) {
  if (!GIT_OBJECT_ID_RE.test(String(headOid)) || !GIT_OBJECT_ID_RE.test(String(baseOid))) {
    throw new TypeError("review revision requires canonical HEAD and base object ids");
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
    digest,
    unreviewed_untracked_paths: paths,
    tracked_symlinks: symlinks,
  };
}

async function resolveObjectId(repoRoot, refs, commandRunner) {
  for (const ref of refs) {
    try {
      const { stdout } = await commandRunner("git", ["-C", repoRoot, "rev-parse", "--verify", ref], { cwd: repoRoot });
      const oid = stdout.trim();
      if (GIT_OBJECT_ID_RE.test(oid)) return oid;
    } catch { /* try the next canonical ref */ }
  }
  return null;
}

export async function captureReviewRevision({
  repoRoot,
  baseBranch,
  uncommitted,
  reviewDiff = null,
}, { commandRunner = execFile, computeDiff = computeReviewDiff } = {}) {
  const capture = async (providedDiff = null) => {
    const beforeHead = await resolveObjectId(repoRoot, ["HEAD"], commandRunner);
    const diff = providedDiff ?? await computeDiff(repoRoot, baseBranch, uncommitted);
    const beforeBase = await resolveObjectId(
      repoRoot,
      [diff.baseRefDescriptor, `origin/${baseBranch}`, baseBranch, beforeHead].filter(Boolean),
      commandRunner,
    );
    const afterHead = await resolveObjectId(repoRoot, ["HEAD"], commandRunner);
    const afterBase = await resolveObjectId(
      repoRoot,
      [diff.baseRefDescriptor, `origin/${baseBranch}`, baseBranch, afterHead].filter(Boolean),
      commandRunner,
    );
    if (beforeHead !== afterHead || beforeBase !== afterBase) {
      throw Object.assign(new Error("review revision changed during capture"), { code: "review_revision_changed_during_capture" });
    }
    return { revision: buildReviewRevision({
      headOid: afterHead,
      baseOid: afterBase,
      diffText: diff.diffText,
      manifest: diff.manifest,
      unreviewedUntrackedPaths: diff.unreviewedUntrackedPaths,
      trackedSymlinks: diff.trackedSymlinks,
    }), diff };
  };
  if (reviewDiff != null) return capture(reviewDiff);
  const first = await capture();
  const second = await capture();
  if (first.revision.digest !== second.revision.digest) {
    throw Object.assign(new Error("review input changed during capture"), { code: "review_revision_changed_during_capture" });
  }
  return second;
}
