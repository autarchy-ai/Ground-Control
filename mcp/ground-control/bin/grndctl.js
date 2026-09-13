#!/usr/bin/env node
// grndctl — the installed Ground Control command (issue #1587).
//
//   grndctl mcp              start the MCP server for the current directory
//   grndctl install-skills   copy the packaged workflow skills into the agent skill directories
//   grndctl --version        print the installed version
//
// The server always runs from this installed package, never from a checkout, so what an agent
// runs is exactly the published version it installed.

import { readFileSync } from "node:fs";

const USAGE = `usage: grndctl <command>

commands:
  mcp              start the Ground Control MCP server (launch directory = current directory)
  install-skills   install the packaged skills (--dry-run, --force, --claude-dir, --codex-dir, --cursor-dir, --no-codex, --no-cursor)
  --version        print the installed version
`;

const [command, ...args] = process.argv.slice(2);

if (command === "mcp") {
  await import("../index.js");
} else if (command === "install-skills") {
  const { runInstallSkillsCli } = await import("../lib/install-skills.js");
  process.exitCode = runInstallSkillsCli(args);
} else if (command === "--version" || command === "-v" || command === "version") {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  process.stdout.write(`${pkg.version}\n`);
} else {
  process.stderr.write(USAGE);
  process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 2;
}
