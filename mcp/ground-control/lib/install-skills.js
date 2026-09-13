// `grndctl install-skills` (issue #1587): copy the skills shipped in this package into the agent
// skill directories.
//
// Copies, never symlinks: a symlink into a checkout makes every agent read whatever branch that
// checkout has checked out, which is the failure publishing to npm removes. A target is replaced
// only when it is ours to replace — a symlink (the old checkout install) or a byte-identical copy.
// Anything else is left alone and reported, unless --force.

import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGED_SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

function listFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = join(prefix, entry.name);
    return entry.isDirectory() ? listFiles(join(dir, entry.name), rel) : [rel];
  });
}

/** Whether `target` is an install this command may replace without --force. */
export function isManagedTarget(source, target) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return true;
  if (!stat.isDirectory()) return false;
  const sourceFiles = listFiles(source).sort();
  const targetFiles = listFiles(target).sort();
  return sourceFiles.length === targetFiles.length
    && sourceFiles.every((file, i) => file === targetFiles[i]
      && readFileSync(join(source, file)).equals(readFileSync(join(target, file))));
}

/**
 * What installing `source` at `target` should do: "installed" (nothing there), "replaced" (a
 * checkout symlink, or a differing copy under --force), "current" (an identical copy), or
 * "skipped" (a differing copy without --force).
 */
export function planSkillTarget(source, target, force) {
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (!existing) return "installed";
  // A symlink is the old checkout install: always ours to replace with a real copy.
  if (existing.isSymbolicLink()) return "replaced";
  if (isManagedTarget(source, target)) return "current";
  return force ? "replaced" : "skipped";
}

/**
 * Install every packaged skill into each target root. Returns one result per skill and root:
 * `{ root, skill, action: "installed" | "current" | "replaced" | "skipped" }`.
 */
export function installSkills({ skillsDir = PACKAGED_SKILLS_DIR, roots, force = false, dryRun = false }) {
  const skills = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const results = [];
  for (const root of roots) {
    for (const skill of skills) {
      const source = join(skillsDir, skill);
      const target = join(root, skill);
      const action = planSkillTarget(source, target, force);
      const writes = action === "installed" || action === "replaced";
      if (writes && !dryRun) {
        mkdirSync(root, { recursive: true });
        rmSync(target, { recursive: true, force: true });
        cpSync(source, target, { recursive: true });
      }
      results.push({ root, skill, action });
    }
  }
  return results;
}

export function resolveSkillRoots(args, home = homedir()) {
  const value = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const roots = [value("--claude-dir", join(home, ".claude", "skills"))];
  if (!args.includes("--no-codex")) roots.push(value("--codex-dir", join(home, ".codex", "skills")));
  if (!args.includes("--no-cursor")) roots.push(value("--cursor-dir", join(home, ".cursor", "skills")));
  return roots;
}

export function runInstallSkillsCli(args, { log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const results = installSkills({
    roots: resolveSkillRoots(args),
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
  });
  for (const { root, skill, action } of results) log(`${action.padEnd(9)} ${join(root, skill)}`);
  const skipped = results.filter((r) => r.action === "skipped");
  if (skipped.length > 0) {
    log(`${skipped.length} target(s) differ from the packaged skill and were left untouched; re-run with --force to replace them.`);
    return 1;
  }
  return 0;
}
