// The unprivileged front end for the Incus sandbox tooling this package ships.
// It validates a closed verb vocabulary and delegates to the packaged root-side
// programs through sudo; it acquires no VM authority of its own (ADR-101).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SUDO = "/usr/bin/sudo";
const SETUP_VERBS = new Set(["install", "refresh", "rollback"]);
const USAGE = `usage: grndctl sandbox <command>

commands:
  setup <install|refresh|rollback>   run the privileged sandbox setup shipped with this package
  image [REFERENCE]                  fetch the published guest template from the registry (default)
  build-image <BASE> [ALIAS]         build the guest template locally from a pinned base image
  push-image <REFERENCE> <FINGERPRINT>  publish a built template; reads a registry token on stdin
  path                               print the directory holding the sandbox programs
`;

export function sandboxPayloadDirectory(moduleUrl = import.meta.url) {
  const packaged = fileURLToPath(new URL("../sandbox/", moduleUrl));
  if (existsSync(packaged)) return packaged;
  // A checkout runs the same programs from their source directory.
  const checkout = fileURLToPath(new URL("../../../tools/incus_sandbox/", moduleUrl));
  if (existsSync(checkout)) return checkout;
  throw new Error("this installation ships no sandbox programs");
}

export function sandboxCommand(args, directory) {
  const [command, ...rest] = args;
  if (command === "setup") {
    if (rest.length !== 1 || !SETUP_VERBS.has(rest[0])) throw new Error("usage: grndctl sandbox setup <install|refresh|rollback>");
    return [SUDO, "--", "/usr/bin/bash", `${directory}setup.sh`, rest[0]];
  }
  if (command === "image") {
    if (rest.length > 1) throw new Error("usage: grndctl sandbox image [REFERENCE]");
    return [SUDO, "--", "/usr/bin/python3", `${directory}registry_image.py`, "pull", ...rest];
  }
  if (command === "build-image") {
    if (rest.length < 1 || rest.length > 2) throw new Error("usage: grndctl sandbox build-image <BASE> [ALIAS]");
    return [SUDO, "--", "/usr/bin/python3", `${directory}build_image.py`, ...rest];
  }
  if (command === "push-image") {
    if (rest.length !== 2) throw new Error("usage: grndctl sandbox push-image <REFERENCE> <FINGERPRINT>");
    return [SUDO, "--", "/usr/bin/python3", `${directory}registry_image.py`, "push", ...rest];
  }
  throw new Error(USAGE);
}

export function runSandboxCli(args, run = spawnSync, write = (text) => process.stderr.write(text)) {
  let directory;
  try {
    directory = sandboxPayloadDirectory();
  } catch (error) {
    write(`${error.message}\n`);
    return 2;
  }
  if (args[0] === "path") {
    process.stdout.write(`${directory}\n`);
    return 0;
  }
  let argv;
  try {
    argv = sandboxCommand(args, directory);
  } catch (error) {
    write(`${error.message}\n`);
    return 2;
  }
  // A privileged action names itself before it asks for a password.
  write(`running: ${argv.slice(2).join(" ")}\n`);
  const result = run(argv[0], argv.slice(1), { stdio: "inherit" });
  if (result.error) {
    write(`${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}
