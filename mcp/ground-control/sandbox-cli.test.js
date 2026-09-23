import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  configuredProvider,
  grndctlConfigPath,
  incusPayloadDirectory,
  resolveProvider,
  runSandboxCli,
  sandboxCommand,
} from "./lib/sandbox-cli.js";

const DIRECTORY = "/usr/lib/node_modules/grndctl/sandbox/";
const noConfig = () => undefined;

test("the sandbox front end delegates only its closed host verbs through sudo", () => {
  assert.deepEqual(sandboxCommand(["setup", "install"], DIRECTORY), [
    "/usr/bin/sudo", "--", "/usr/bin/bash", `${DIRECTORY}setup.sh`, "install",
  ]);
  assert.deepEqual(sandboxCommand(["setup", "upgrade"], DIRECTORY), [
    "/usr/bin/sudo", "--", "/usr/bin/bash", `${DIRECTORY}setup.sh`, "upgrade",
  ]);
  assert.deepEqual(sandboxCommand(["build-image", "images:almalinux/10/cloud"], DIRECTORY), [
    "/usr/bin/sudo", "--", "/usr/bin/python3", `${DIRECTORY}build_image.py`, "images:almalinux/10/cloud",
  ]);
  assert.deepEqual(sandboxCommand(["build-image", "images:almalinux/10/cloud", "other"], DIRECTORY).at(-1), "other");
  // Fetching the published template is the default path; it needs no argument.
  assert.deepEqual(sandboxCommand(["image"], DIRECTORY), [
    "/usr/bin/sudo", "--", "/usr/bin/python3", `${DIRECTORY}registry_image.py`, "pull",
  ]);
  assert.deepEqual(sandboxCommand(["image", "ghcr.io/owner/name:tag"], DIRECTORY).at(-1), "ghcr.io/owner/name:tag");
  assert.deepEqual(sandboxCommand(["push-image", "ghcr.io/owner/name:tag", "a".repeat(64)], DIRECTORY), [
    "/usr/bin/sudo", "--", "/usr/bin/python3", `${DIRECTORY}registry_image.py`, "push",
    "ghcr.io/owner/name:tag", "a".repeat(64),
  ]);
  assert.throws(() => sandboxCommand(["image", "a", "b"], DIRECTORY), /image \[REFERENCE\]/);
  assert.throws(() => sandboxCommand(["push-image", "ghcr.io/owner/name:tag"], DIRECTORY), /push-image/);
  assert.throws(() => sandboxCommand(["setup", "reinstall"], DIRECTORY), /install\|upgrade\|refresh\|rollback/);
  assert.throws(() => sandboxCommand(["setup"], DIRECTORY), /install\|upgrade\|refresh\|rollback/);
  assert.throws(() => sandboxCommand(["build-image"], DIRECTORY), /BASE/);
  assert.throws(() => sandboxCommand(["shell", "agent-1"], DIRECTORY), /usage/);
});

test("the front end names the privileged command, runs no shell, and returns its status", async () => {
  const calls = [];
  const written = [];
  const status = await runSandboxCli(["setup", "refresh"], {
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 3 };
    },
    write: (text) => written.push(text),
    readConfigured: noConfig,
  });
  assert.equal(status, 3);
  assert.equal(calls[0].command, "/usr/bin/sudo");
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(calls[0].args.some((argument) => argument.includes("sh -c")), false);
  assert.match(written.join(""), /running: .*setup\.sh refresh/);
});

test("lifecycle verbs run through the provider's own client, not a second command", async () => {
  const seen = [];
  const loadClient = async (directory) => ({
    runProgram: (argv) => seen.push({ directory, argv }),
  });
  for (const argv of [["create", "agent-1"], ["attach", "agent-1"], ["delete", "agent-1", "--confirm", "agent-1"],
    ["prepare", "agent-1", "bundle", "/src", "HEAD"], ["task-start", "agent-1"], ["list"]]) {
    assert.equal(await runSandboxCli(argv, { loadClient, readConfigured: noConfig, write: () => {} }), 0);
  }
  assert.deepEqual(seen.map(({ argv }) => argv[0]), ["create", "attach", "delete", "prepare", "task-start", "list"]);
  assert.match(seen[0].directory, /tools\/incus_sandbox\/$/);
  assert.deepEqual(seen[2].argv, ["delete", "agent-1", "--confirm", "agent-1"]);
});

test("a lifecycle refusal is reported as a failure with the client's reason", async () => {
  const written = [];
  const loadClient = async () => ({
    runProgram: () => { throw new Error("delete confirmation requires --confirm followed by the exact sandbox name"); },
  });
  const status = await runSandboxCli(["delete", "agent-1"], {
    loadClient, readConfigured: noConfig, write: (text) => written.push(text),
  });
  assert.equal(status, 1);
  assert.match(written.join(""), /exact sandbox name/);
});

test("the real lifecycle client is what the front end loads", async () => {
  // Validation happens before any helper runs, so a refused name proves the wiring without sudo.
  const written = [];
  const status = await runSandboxCli(["create", "Not_Valid"], { readConfigured: noConfig, write: (text) => written.push(text) });
  assert.equal(status, 1);
  assert.match(written.join(""), /sandbox name is invalid/);
});

test("the provider comes from the switch, then configuration, then the default", () => {
  assert.deepEqual(resolveProvider(["list"], noConfig), { provider: "incus", args: ["list"] });
  assert.deepEqual(resolveProvider(["list"], () => "incus"), { provider: "incus", args: ["list"] });
  assert.deepEqual(resolveProvider(["--provider", "incus", "list"], () => "other"), { provider: "incus", args: ["list"] });
  assert.deepEqual(resolveProvider(["--provider=incus", "attach", "a"], noConfig), { provider: "incus", args: ["attach", "a"] });
  assert.throws(() => resolveProvider(["list"], () => "docker"), /unknown sandbox provider "docker"; supported: incus/);
  assert.throws(() => resolveProvider(["--provider", "docker", "list"], noConfig), /unknown sandbox provider/);
  assert.throws(() => resolveProvider(["--provider"], noConfig), /needs a sandbox provider name/);
});

test("an unknown provider stops before anything runs", async () => {
  const calls = [];
  const status = await runSandboxCli(["--provider", "docker", "setup", "install"], {
    run: (...call) => calls.push(call), readConfigured: noConfig, write: () => {},
  });
  assert.equal(status, 2);
  assert.deepEqual(calls, []);
});

test("provider configuration is read from the grndctl config file, and a broken one is an error", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grndctl-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = grndctlConfigPath({ XDG_CONFIG_HOME: root });
  assert.equal(path, join(root, "grndctl", "config.json"));
  assert.equal(configuredProvider(path), undefined);
  mkdirSync(join(root, "grndctl"));
  writeFileSync(path, JSON.stringify({ sandbox: { provider: "incus" } }));
  assert.equal(configuredProvider(path), "incus");
  writeFileSync(path, JSON.stringify({ other: true }));
  assert.equal(configuredProvider(path), undefined);
  writeFileSync(path, "{not json");
  assert.throws(() => configuredProvider(path), /not valid JSON/);
  writeFileSync(path, JSON.stringify({ sandbox: { provider: 7 } }));
  assert.throws(() => configuredProvider(path), /must be a string/);
  assert.throws(() => configuredProvider(path, () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }),
    /cannot read .*denied/);
});

test("an unsupported request reports usage without running anything", async () => {
  const calls = [];
  const status = await runSandboxCli(["build-image"], { run: (...call) => calls.push(call), readConfigured: noConfig, write: () => {} });
  assert.equal(status, 2);
  assert.deepEqual(calls, []);
  const written = [];
  assert.equal(await runSandboxCli(["--help"], { write: (text) => written.push(text) }), 0);
  assert.match(written.join(""), /attach NAME/);
  assert.equal(await runSandboxCli([], { write: () => {} }), 2);
});

test("a spawn failure is reported rather than read as success", async () => {
  const status = await runSandboxCli(["setup", "install"], {
    run: () => ({ error: new Error("sudo missing") }), readConfigured: noConfig, write: () => {},
  });
  assert.equal(status, 1);
});

test("the payload resolves to the programs this checkout ships", () => {
  assert.match(incusPayloadDirectory(), /tools\/incus_sandbox\/$/);
});

test("a packaged installation uses its own programs, and an incomplete one says so", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grndctl-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(join(root, "lib", "sandbox-cli.js")).href;
  assert.throws(() => incusPayloadDirectory(moduleUrl), /ships no sandbox programs/);
  mkdirSync(join(root, "sandbox"));
  assert.equal(incusPayloadDirectory(moduleUrl), `${join(root, "sandbox")}/`);
});
