// Unprivileged task-environment request builder. Values travel only in stdin.

import { readFileSync } from "node:fs";

import { safeGitEnvironment } from "./source.mjs";
import { canonicalRepositoryIdentity } from "./repository_identity.mjs";

export { canonicalRepositoryIdentity } from "./repository_identity.mjs";

const GIT = "/usr/bin/git";
const SUDO = "/usr/bin/sudo";
const HELPER = "/usr/local/lib/gc-incus-sandbox/task_environment.py";
const NAME = /^[a-z][a-z0-9-]{0,47}$/;
const TASK_ACTIONS = new Map([
  ["task-start", "start"], ["task-restart", "restart"],
  ["task-stop", "stop"],
]);

function checked(run, command, args, options) {
  const result = run({ command, args, options });
  if (result?.status !== 0) throw new Error("task source discovery failed");
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

export function taskStartRequest(run, baseEnvironment = process.env, io = {}) {
  const environment = safeGitEnvironment(baseEnvironment);
  const top = checked(run, GIT, ["rev-parse", "--show-toplevel"], { env: environment, encoding: "utf8" });
  const repository = top;
  const remote = checked(run, GIT, ["-C", repository, "remote", "get-url", "origin"], {
    env: environment, encoding: "utf8",
  });
  const identity = canonicalRepositoryIdentity(remote);
  const readFile = io.readFile ?? readFileSync;
  const declaration = readFile(`${repository}/.gc-sandbox-env.json`);
  if (!Buffer.isBuffer(declaration) || declaration.length === 0 || declaration.length > 64 * 1024) {
    throw new Error("repository task environment declaration is missing or oversized");
  }
  return Buffer.from(JSON.stringify({
    schema: "gc.incus-sandbox.task-start/v1", repository: identity,
    declaration_b64: declaration.toString("base64"),
  }));
}

export function runTaskCommand(argv, run, environment = process.env, io = {}) {
  if (argv.length !== 2 || !TASK_ACTIONS.has(argv[0]) || !NAME.test(argv[1])) {
    throw new Error("task action requires one valid sandbox name");
  }
  const action = TASK_ACTIONS.get(argv[0]);
  const input = ["start", "restart"].includes(action) ? taskStartRequest(run, environment, io) : null;
  const options = input === null ? { stdio: "inherit" }
    : { input, stdio: ["pipe", "inherit", "inherit"] };
  const result = run({ command: SUDO, args: ["--", HELPER, action, argv[1]], options });
  if (result?.status !== 0) throw new Error("task environment helper failed");
}

export function isTaskAction(value) {
  return TASK_ACTIONS.has(value);
}
