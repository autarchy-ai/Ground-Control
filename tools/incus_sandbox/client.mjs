#!/usr/bin/env node
// The user-facing side of the sandbox boundary deliberately has no Incus client.

import { spawnSync } from "node:child_process";

import { prepareSource } from "./source.mjs";

const ACTIONS = new Set(["create", "list", "attach", "stop", "start", "delete", "status", "diagnose"]);
const NAME = /^[a-z][a-z0-9-]{0,47}$/;
const HELPER = "/usr/local/lib/gc-incus-sandbox/helper.py";

export function parseArguments(argv) {
  if (argv.length < 1 || argv.length > 2 || !ACTIONS.has(argv[0])) {
    throw new Error("unsupported lifecycle action");
  }
  const [action, name] = argv;
  if (action === "list") {
    if (name !== undefined) throw new Error("list does not accept a sandbox name");
    return { action, name: undefined };
  }
  if (!NAME.test(name ?? "")) throw new Error("sandbox name is invalid");
  return { action, name };
}

export function runClient(argv, spawn = spawnSync) {
  const { action, name } = parseArguments(argv);
  const result = spawn("/usr/bin/sudo", ["--", HELPER, action, ...(name ? [name] : [])], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`sandbox helper failed with status ${result.status ?? "unknown"}`);
}

export function runProgram(argv, run = ({ command, args, options }) => spawnSync(command, args, options), environment = process.env) {
  if (argv[0] === "prepare") {
    prepareSource(argv.slice(1), run, environment);
    return;
  }
  runClient(argv, (command, args, options) => run({ command, args, options }));
}

if (import.meta.main) {
  try {
    runProgram(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 64;
  }
}
