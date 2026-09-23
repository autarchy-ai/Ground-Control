// The unprivileged front end for the sandbox tooling this package ships: the one command an
// operator uses for host setup, guest templates, and every VM lifecycle verb. It validates a
// closed verb vocabulary and delegates to the packaged programs; privileged work goes through
// sudo to the fixed root-side helpers, and it acquires no VM authority of its own (ADR-101).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SUDO = "/usr/bin/sudo";
const PYTHON = "/usr/bin/python3";
const SETUP_VERBS = new Set(["install", "upgrade", "refresh", "rollback"]);
// Verbs the provider's own lifecycle client validates and carries out.
const LIFECYCLE_VERBS = new Set([
  "create", "list", "attach", "stop", "start", "delete", "status", "diagnose",
  "prepare", "export", "import", "migrate", "task-start", "task-restart", "task-stop",
]);

export function incusPayloadDirectory(moduleUrl = import.meta.url) {
  const packaged = fileURLToPath(new URL("../sandbox/", moduleUrl));
  if (existsSync(packaged)) return packaged;
  // A checkout runs the same programs from their source directory.
  const checkout = fileURLToPath(new URL("../../../tools/incus_sandbox/", moduleUrl));
  if (existsSync(checkout)) return checkout;
  throw new Error("this installation ships no sandbox programs");
}

// The sandbox kinds this package ships, each resolving to its reviewed program payload.
// The set is closed: configuration picks one by name and never names a program or path.
export const SANDBOX_PROVIDERS = new Map([["incus", incusPayloadDirectory]]);
const DEFAULT_PROVIDER = "incus";
const PROVIDER_NAMES = [...SANDBOX_PROVIDERS.keys()].join(", ");

const USAGE = `usage: grndctl sandbox [--provider NAME] <command>

sandboxes:
  create NAME | start NAME | stop NAME | status NAME | diagnose NAME | list
  attach NAME                          join the task session running in the sandbox
  delete NAME --confirm NAME           delete a sandbox; the name must be repeated
  prepare NAME <bundle|clone> CHECKOUT REVISION  put a committed source in the sandbox
  migrate NAME CHECKOUT < REQUEST      move uncommitted work into the sandbox
  export CHECKOUT < REQUEST > PACKET   save uncommitted work; import NAME < PACKET loads it
  task-start NAME | task-restart NAME | task-stop NAME

host:
  setup <install|upgrade|refresh|rollback>  run the privileged sandbox setup shipped with this package
  image [REFERENCE]                  fetch the published guest template from the registry (default)
  build-image <BASE> [ALIAS]         build the guest template locally from a pinned base image
  push-image <REFERENCE> <FINGERPRINT>  publish a built template; reads a registry token on stdin
  path                               print the directory holding the sandbox programs

The provider is --provider, else "sandbox.provider" in $XDG_CONFIG_HOME/grndctl/config.json
(default ~/.config/grndctl/config.json), else ${DEFAULT_PROVIDER}. Providers: ${PROVIDER_NAMES}.
`;

export function grndctlConfigPath(environment = process.env) {
  const base = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "grndctl", "config.json");
}

/** Read the configured provider; an absent file means no preference, a malformed one is an error. */
export function configuredProvider(path, read = readFileSync) {
  let text;
  try {
    text = read(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const provider = document?.sandbox?.provider;
  if (provider !== undefined && typeof provider !== "string") {
    throw new Error(`${path}: sandbox.provider must be a string`);
  }
  return provider;
}

/** Split a leading --provider switch from the command, then resolve switch > config > default. */
export function resolveProvider(args, readConfigured = () => configuredProvider(grndctlConfigPath())) {
  let rest = args;
  let requested;
  if (args[0] === "--provider") {
    if (args.length < 2) throw new Error("--provider needs a sandbox provider name");
    requested = args[1];
    rest = args.slice(2);
  } else if (args[0]?.startsWith("--provider=")) {
    requested = args[0].slice("--provider=".length);
    rest = args.slice(1);
  }
  const provider = requested ?? readConfigured() ?? DEFAULT_PROVIDER;
  if (!SANDBOX_PROVIDERS.has(provider)) {
    throw new Error(`unknown sandbox provider "${provider}"; supported: ${PROVIDER_NAMES}`);
  }
  return { provider, args: rest };
}

export function isLifecycleVerb(command) {
  return LIFECYCLE_VERBS.has(command);
}

export function sandboxCommand(args, directory) {
  const [command, ...rest] = args;
  if (command === "setup") {
    if (rest.length !== 1 || !SETUP_VERBS.has(rest[0])) {
      throw new Error("usage: grndctl sandbox setup <install|upgrade|refresh|rollback>");
    }
    return [SUDO, "--", "/usr/bin/bash", `${directory}setup.sh`, rest[0]];
  }
  if (command === "image") {
    if (rest.length > 1) throw new Error("usage: grndctl sandbox image [REFERENCE]");
    return [SUDO, "--", PYTHON, `${directory}registry_image.py`, "pull", ...rest];
  }
  if (command === "build-image") {
    if (rest.length < 1 || rest.length > 2) throw new Error("usage: grndctl sandbox build-image <BASE> [ALIAS]");
    return [SUDO, "--", PYTHON, `${directory}build_image.py`, ...rest];
  }
  if (command === "push-image") {
    if (rest.length !== 2) throw new Error("usage: grndctl sandbox push-image <REFERENCE> <FINGERPRINT>");
    return [SUDO, "--", PYTHON, `${directory}registry_image.py`, "push", ...rest];
  }
  throw new Error(USAGE);
}

async function loadLifecycleClient(directory) {
  return import(pathToFileURL(`${directory}client.mjs`).href);
}

export async function runSandboxCli(args, {
  run = spawnSync,
  write = (text) => process.stderr.write(text),
  readConfigured,
  loadClient = loadLifecycleClient,
} = {}) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    write(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  let directory;
  let command;
  try {
    const resolved = resolveProvider(args, readConfigured);
    command = resolved.args;
    directory = SANDBOX_PROVIDERS.get(resolved.provider)();
  } catch (error) {
    write(`${error.message}\n`);
    return 2;
  }
  if (command[0] === "path") {
    process.stdout.write(`${directory}\n`);
    return 0;
  }
  if (isLifecycleVerb(command[0])) {
    try {
      const { runProgram } = await loadClient(directory);
      runProgram(command);
      return 0;
    } catch (error) {
      write(`${error.message}\n`);
      return 1;
    }
  }
  let argv;
  try {
    argv = sandboxCommand(command, directory);
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
