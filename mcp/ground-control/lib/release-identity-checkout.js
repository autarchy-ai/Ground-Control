// Launch-checkout facts gc_release_identity relies on (issue #1579, ADR-097): where a derived path
// would land when the caller writes it, and which branch the run is on. Both are read by the
// server from the authorized checkout, never taken from the caller.

import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { runImplementGit } from "./codex-workflow-2.js";
import { assertRealpathInRepo } from "./repo-context-2.js";
import { resolveRepoRelativePath } from "./repo-context.js";

/**
 * A symlink component must resolve. `assertRealpathInRepo` walks up past a missing path, which is
 * right for a file not yet written but would pass a dangling link whose target lies outside the
 * checkout — the very write the caller is about to make would then follow it.
 */
function hasUnresolvableLink(repoRoot, path) {
  let cursor = repoRoot;
  for (const segment of path.split("/")) {
    cursor = join(cursor, segment);
    let stat;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- components of a validated repo-relative path
      stat = lstatSync(cursor);
    } catch {
      return false;
    }
    if (!stat.isSymbolicLink()) continue;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- components of a validated repo-relative path
      realpathSync(cursor);
    } catch {
      return true;
    }
  }
  return false;
}

/** The key of the first derived path that does not provably resolve inside the checkout, or null. */
export function releasePathOutsideCheckout(repoRoot, paths) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repoRoot is the authorized launch checkout
  const root = realpathSync(repoRoot);
  for (const [key, path] of Object.entries(paths)) {
    const lexical = resolveRepoRelativePath(repoRoot, path, `paths.${key}`);
    let contained;
    try {
      contained = lexical.ok && !hasUnresolvableLink(repoRoot, path) && assertRealpathInRepo(root, lexical.abs, `paths.${key}`).ok;
    } catch {
      // A name the filesystem refuses (too long, not permitted) cannot be proven contained.
      contained = false;
    }
    if (!contained) return key;
  }
  return null;
}

/** The checked-out branch, or null for a detached or unreadable HEAD. */
export async function readReleaseCheckoutBranch(repoRoot) {
  try {
    return (await runImplementGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  } catch {
    return null;
  }
}
