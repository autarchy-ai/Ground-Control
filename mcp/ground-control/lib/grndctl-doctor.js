// `grndctl doctor` (issue #1587): check this host and this repository, and name the fix for
// anything wrong. Read-only: it never writes a file, and it never prints a credential value.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGroundControlYaml } from "./ground-control-config.js";
import { detectGithubRepo } from "./grndctl-detect.js";
import { MCP_SERVER_ENTRY } from "./grndctl-init.js";
import { PHASE_E_WORKFLOW_PATH, renderPhaseEWorkflow } from "./phase-e-workflow.js";
import { execFile } from "./runtime-primitives.js";
import { parseEnvFileLine } from "./server-env.js";

async function commandWorks(command, args) {
  try {
    await execFile(command, args, { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function check(name, ok, fix, { warn = false } = {}) {
  if (ok) return { name, status: "ok", fix: null };
  return { name, status: warn ? "warn" : "fail", fix };
}

function readConfig(cwd) {
  const path = join(cwd, ".ground-control.yaml");
  return existsSync(path) ? parseGroundControlYaml(readFileSync(path, "utf8")) : null;
}

async function yamlChecks(cwd, parsed) {
  if (parsed == null) return [check(".ground-control.yaml present", false, "run grndctl init")];
  if (!parsed.ok) return [check(".ground-control.yaml valid", false, parsed.errors.join("; "))];
  const origin = (await detectGithubRepo(cwd)).value;
  const declared = parsed.value.github_repo;
  return [
    check(".ground-control.yaml valid", true),
    check(
      "github_repo matches git origin",
      declared == null || origin == null || declared.toLowerCase() === origin.toLowerCase(),
      `github_repo is ${declared} but origin is ${origin}`,
    ),
  ];
}

function mcpCheck(cwd) {
  const path = join(cwd, ".mcp.json");
  let entry = null;
  try {
    entry = JSON.parse(readFileSync(path, "utf8")).mcpServers?.["ground-control"] ?? null;
  } catch {
    entry = null;
  }
  const ok = entry?.command === MCP_SERVER_ENTRY.command && JSON.stringify(entry.args) === JSON.stringify(MCP_SERVER_ENTRY.args);
  const detail = entry ? `ground-control runs ${entry.command} ${(entry.args ?? []).join(" ")}` : "no ground-control entry";
  return check(".mcp.json runs grndctl mcp", ok, `${detail}; run grndctl init`);
}

// Without the merged-pull-request workflow, Phase E never runs on its own and every
// delivered issue waits for someone to finish it by hand (issue #1671). A warning rather
// than a failure: a repository may deliberately finalize from an agent session.
//
// The file's content is fixed (issue #1688), so "drifted" is now simply "not the template"
// — there is nothing repo-specific in it to allow for. This repository's own copy runs the
// checkout instead of a release, which is the one legitimate difference.
function phaseEWorkflowCheck(cwd) {
  const path = join(cwd, PHASE_E_WORKFLOW_PATH);
  if (!existsSync(path)) {
    return check("Phase E workflow installed", false, `run grndctl init to add ${PHASE_E_WORKFLOW_PATH}`, { warn: true });
  }
  const text = readFileSync(path, "utf8");
  const current = text === renderPhaseEWorkflow() || text.includes("bin/grndctl.js");
  return check(
    "Phase E workflow installed",
    current && text.includes("pull_request.merged == true"),
    `${PHASE_E_WORKFLOW_PATH} has drifted from the current trigger; run grndctl init to replace it`,
    { warn: true },
  );
}

// The workflow reads the release it runs from here, so an enabled lane with no version is a
// job that fails at merge time rather than finalizing (issue #1688). Ground Control's own
// copy runs the checkout instead of a published release, so it consumes no version and the
// check does not apply to it.
function phaseEVersionCheck(cwd, config) {
  const path = join(cwd, PHASE_E_WORKFLOW_PATH);
  if (!existsSync(path) || readFileSync(path, "utf8").includes("bin/grndctl.js")) return [];
  const phaseE = config?.ok ? config.value.phase_e : null;
  return [check(
    "phase_e.version set",
    Boolean(phaseE?.enabled && phaseE.version),
    "add a phase_e block with the grndctl version to .ground-control.yaml; the workflow reads it",
    { warn: true },
  )];
}

async function envChecks(cwd, sonarConfigured) {
  const path = join(cwd, ".env");
  if (!existsSync(path)) return [check(".env present", false, "run grndctl init, then fill in the credentials this repo needs")];
  const names = new Set(
    readFileSync(path, "utf8").split(/\r?\n/).map(parseEnvFileLine).filter(Boolean).filter(([, value]) => value !== "").map(([name]) => name),
  );
  return [
    check(".env ignored by git", await commandWorks("git", ["-C", cwd, "check-ignore", "-q", ".env"]), "add .env to .gitignore; it holds credentials"),
    ...(sonarConfigured
      ? [check("SONAR_TOKEN in .env", names.has("SONAR_TOKEN"), "the SonarCloud gate cannot read findings without it", { warn: true })]
      : []),
  ];
}

export async function runDoctorChecks({ cwd = process.cwd(), version, works = commandWorks } = {}) {
  const [major] = process.versions.node.split(".").map(Number);
  const config = readConfig(cwd);
  return [
    check(`grndctl ${version}`, true),
    check("node 22 or newer", major >= 22, `node ${process.versions.node} is too old; install node 22+`),
    check("gh authenticated", await works("gh", ["api", "user", "--jq", ".login"]), "run gh auth login"),
    check("codex on PATH", await works("codex", ["--version"]), "install the Codex CLI; code review needs it", { warn: true }),
    check("inside a git repository", await works("git", ["-C", cwd, "rev-parse", "--show-toplevel"]), "run grndctl doctor from a repository"),
    ...(await yamlChecks(cwd, config)),
    mcpCheck(cwd),
    phaseEWorkflowCheck(cwd),
    ...phaseEVersionCheck(cwd, config),
    ...(await envChecks(cwd, Boolean(config?.ok && config.value.sonarcloud))),
  ];
}

export async function runDoctor({ cwd = process.cwd(), version, print = console.log, works } = {}) {
  const results = await runDoctorChecks({ cwd, version, works });
  for (const result of results) {
    const fix = result.fix ? ` - ${result.fix}` : "";
    print(`${result.status.padEnd(4)} ${result.name}${fix}`);
  }
  return results.some((result) => result.status === "fail") ? 1 : 0;
}
