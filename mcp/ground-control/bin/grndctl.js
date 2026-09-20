#!/usr/bin/env node
// grndctl — the installed Ground Control command (issue #1587).
//
//   grndctl mcp              start the MCP server for the current directory
//   grndctl install-skills   copy the packaged workflow skills into the agent skill directories
//   grndctl init             set up Ground Control for the repository in the current directory
//   grndctl doctor           check this host and repository, naming the fix for anything wrong
//   grndctl finalize-merged-pr  finish Phase E for a merged delivery PR (the Actions job runs this)
//   grndctl sandbox         set up the local Incus sandbox and fetch or build its guest template
//   grndctl --version        print the installed version
//
// The server always runs from this installed package, never from a checkout, so what an agent
// runs is exactly the published version it installed.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const USAGE = `usage: grndctl <command>

commands:
  mcp              start the Ground Control MCP server (launch directory = current directory)
  install-skills   install the packaged skills (--dry-run, --force, --claude-dir, --codex-dir, --cursor-dir, --no-codex, --no-cursor)
  init             set up this repository: confirm each value, preview the changes, then write
                   (--dry-run; --non-interactive with every value as a flag, e.g. --project, --github-repo)
  doctor           check this host and repository
  finalize-merged-pr  finish Phase E for an already-merged Ground Control delivery PR (--pr <number>)
  sandbox          local Incus sandbox: setup <install|refresh|rollback>, image [REFERENCE], build-image, push-image, path
  --version        print the installed version
`;

function packageVersion() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

const [command, ...args] = process.argv.slice(2);

if (command === "mcp") {
  await import("../index.js");
} else if (command === "install-skills") {
  const { runInstallSkillsCli } = await import("../lib/install-skills.js");
  process.exitCode = runInstallSkillsCli(args);
} else if (command === "init") {
  const { runInit } = await import("../lib/grndctl-init.js");
  const interactive = Boolean(process.stdin.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    process.exitCode = await runInit(args, { ask: (question) => rl.question(question), interactive });
  } finally {
    rl?.close();
  }
} else if (command === "finalize-merged-pr") {
  const { runFinalizeMergedPrCli } = await import("../lib/grndctl-finalize.js");
  process.exitCode = await runFinalizeMergedPrCli(args);
} else if (command === "sandbox") {
  const { runSandboxCli } = await import("../lib/sandbox-cli.js");
  process.exitCode = runSandboxCli(args);
} else if (command === "doctor") {
  const { runDoctor } = await import("../lib/grndctl-doctor.js");
  process.exitCode = await runDoctor({ version: packageVersion() });
} else if (command === "--version" || command === "-v" || command === "version") {
  process.stdout.write(`${packageVersion()}\n`);
} else {
  process.stderr.write(USAGE);
  process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 2;
}
