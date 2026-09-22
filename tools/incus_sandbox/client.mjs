#!/usr/bin/env node
// The user-facing side of the sandbox boundary deliberately has no Incus client.

import { spawnSync } from "node:child_process";
import { readSync } from "node:fs";

import { captureMigration, parseMigrationSpec, prepareSource, transferMigration } from "./source.mjs";
import { isTaskAction, runTaskCommand } from "./task_client.mjs";

const ACTIONS = new Set(["create", "list", "attach", "stop", "start", "delete", "status", "diagnose"]);
const NAME = /^[a-z][a-z0-9-]{0,47}$/;
const HELPER = "/usr/local/lib/gc-incus-sandbox/helper.py";

export function parseArguments(argv) {
  if (argv.length < 1 || argv.length > 4 || !ACTIONS.has(argv[0])) {
    throw new Error("unsupported lifecycle action");
  }
  const [action, name] = argv;
  if (action === "list") {
    if (name !== undefined) throw new Error("list does not accept a sandbox name");
    return { action, name: undefined };
  }
  if (!NAME.test(name ?? "")) throw new Error("sandbox name is invalid");
  if (action === "delete") {
    if (argv.length !== 4 || argv[2] !== "--confirm" || argv[3] !== name) {
      throw new Error("delete confirmation requires --confirm followed by the exact sandbox name");
    }
    return { action, name, confirmation: argv[3] };
  }
  if (argv.length !== 2) throw new Error("lifecycle action has unexpected arguments");
  return { action, name };
}

export function runClient(argv, spawn = spawnSync) {
  const { action, name, confirmation } = parseArguments(argv);
  const arguments_ = ["--", HELPER, action, ...(name ? [name] : []), ...(confirmation ? [confirmation] : [])];
  const result = spawn("/usr/bin/sudo", arguments_, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`sandbox helper failed with status ${result.status ?? "unknown"}`);
}

function readBounded(fd, maxBytes) {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(1024 * 1024, maxBytes - total + 1));
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > maxBytes) throw new Error("standard input exceeds the limit");
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks);
}

export function runProgram(argv, run = ({ command, args, options }) => spawnSync(command, args, options),
  environment = process.env, io = null) {
  if (argv[0] === "prepare") {
    prepareSource(argv.slice(1), run, environment);
    return;
  }
  const input = (limit) => io?.read ? io.read(limit) : readBounded(0, limit);
  if (argv[0] === "export") {
    if (argv.length !== 2) throw new Error("usage: export SOURCE_CHECKOUT");
    const packet = captureMigration(argv[1], parseMigrationSpec(input(64 * 1024)));
    if (io?.write) io.write(packet); else process.stdout.write(packet);
    return;
  }
  if (argv[0] === "import") {
    if (argv.length !== 2) throw new Error("usage: import SANDBOX");
    transferMigration(argv[1], input(1024 * 1024 * 1024), run);
    return;
  }
  if (argv[0] === "migrate") {
    if (argv.length !== 3) throw new Error("usage: migrate SANDBOX SOURCE_CHECKOUT");
    const packet = captureMigration(argv[2], parseMigrationSpec(input(64 * 1024)));
    transferMigration(argv[1], packet, run);
    return;
  }
  if (isTaskAction(argv[0])) {
    runTaskCommand(argv, run, environment, io ?? {});
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
