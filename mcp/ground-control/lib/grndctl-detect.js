// Repository facts `grndctl init` proposes (issue #1587).
//
// Detection only ever proposes: every value carries the evidence it came from, and init shows it
// to the operator for confirmation before anything is written. Nothing here writes a file or
// calls GitHub.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseOwnerRepoFromRemoteUrl } from "./grc-legacy-compat-2.js";
import { execFile } from "./runtime-primitives.js";

const SONAR_PROPERTIES = "sonar-project.properties";
const ADR_DIR_CANDIDATES = ["architecture/adrs/", "docs/adrs/", "docs/adr/", "adr/", "docs/decisions/"];

async function git(cwd, args) {
  try {
    return (await execFile("git", ["-C", cwd, ...args])).stdout.trim();
  } catch {
    return null;
  }
}

function found(value, source) {
  return value == null || value === "" ? { value: null, source: null } : { value, source };
}

function trimHyphens(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "-") start += 1;
  while (end > start && text[end - 1] === "-") end -= 1;
  return text.slice(start, end);
}

export function detectProject(cwd) {
  return found(trimHyphens(basename(cwd).toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-")), "directory name");
}

export async function detectGithubRepo(cwd) {
  const url = await git(cwd, ["remote", "get-url", "origin"]);
  const parsed = url ? parseOwnerRepoFromRemoteUrl(url) : null;
  return found(parsed ? `${parsed.owner}/${parsed.name}` : null, "git remote origin");
}

export async function detectBaseBranch(cwd) {
  // Local remote-tracking refs only: detection makes no network call.
  if (await git(cwd, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/dev"])) return found("dev", "origin/dev exists");
  const head = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return found(head ? head.replace(/^origin\//, "") : null, "origin default branch");
}

function makeTargets(cwd) {
  const path = join(cwd, "Makefile");
  if (!existsSync(path)) return new Set();
  return new Set([...readFileSync(path, "utf8").matchAll(/^([A-Za-z0-9_.-]+):/gm)].map((m) => m[1]));
}

function packageScripts(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

/** A workflow command from the first Makefile target or package.json script that exists. */
export function detectCommand(cwd, names) {
  const targets = makeTargets(cwd);
  const target = names.find((name) => targets.has(name));
  if (target) return found(`make ${target}`, `Makefile target '${target}'`);
  const scripts = packageScripts(cwd);
  const script = names.find((name) => scripts[name]);
  if (script) return found(script === "test" ? "npm test" : `npm run ${script}`, `package.json script '${script}'`);
  return found(null, null);
}

function sonarProperty(cwd, key) {
  const path = join(cwd, SONAR_PROPERTIES);
  if (!existsSync(path)) return null;
  const line = readFileSync(path, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}

export function detectAdrDir(cwd) {
  const dir = ADR_DIR_CANDIDATES.find((candidate) => existsSync(join(cwd, candidate)));
  return found(dir ?? null, dir ? "existing directory" : null);
}

/** Every proposed value for a repository, each with the evidence it came from. */
export async function detectRepoFacts(cwd) {
  return {
    project: detectProject(cwd),
    github_repo: await detectGithubRepo(cwd),
    base_branch: await detectBaseBranch(cwd),
    test_command: detectCommand(cwd, ["test"]),
    completion_command: detectCommand(cwd, ["completion", "check", "verify", "test"]),
    lint_command: detectCommand(cwd, ["lint"]),
    format_command: detectCommand(cwd, ["format", "fmt"]),
    sonar_project_key: found(sonarProperty(cwd, "sonar.projectKey"), SONAR_PROPERTIES),
    sonar_organization: found(sonarProperty(cwd, "sonar.organization"), SONAR_PROPERTIES),
    adr_dir: detectAdrDir(cwd),
  };
}
