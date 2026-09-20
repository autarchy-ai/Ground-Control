import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runSandboxCli, sandboxCommand, sandboxPayloadDirectory } from "./lib/sandbox-cli.js";

const DIRECTORY = "/usr/lib/node_modules/grndctl/sandbox/";

test("the sandbox front end delegates only its closed verbs through sudo", () => {
  assert.deepEqual(sandboxCommand(["setup", "install"], DIRECTORY), [
    "/usr/bin/sudo", "--", "/usr/bin/bash", `${DIRECTORY}setup.sh`, "install",
  ]);
  assert.deepEqual(sandboxCommand(["build-image", "images:almalinux/10/cloud"], DIRECTORY), [
    "/usr/bin/sudo", "--", "/usr/bin/python3", `${DIRECTORY}build_image.py`, "images:almalinux/10/cloud",
  ]);
  assert.deepEqual(sandboxCommand(["build-image", "images:almalinux/10/cloud", "other"], DIRECTORY).at(-1), "other");
  assert.throws(() => sandboxCommand(["setup", "reinstall"], DIRECTORY), /install\|refresh\|rollback/);
  assert.throws(() => sandboxCommand(["setup"], DIRECTORY), /install\|refresh\|rollback/);
  assert.throws(() => sandboxCommand(["build-image"], DIRECTORY), /BASE/);
  assert.throws(() => sandboxCommand(["attach", "agent-1"], DIRECTORY), /usage/);
});

test("the front end names the privileged command, runs no shell, and returns its status", () => {
  const calls = [];
  const written = [];
  const status = runSandboxCli(["setup", "refresh"], (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 3 };
  }, (text) => written.push(text));
  assert.equal(status, 3);
  assert.equal(calls[0].command, "/usr/bin/sudo");
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(calls[0].args.some((argument) => argument.includes("sh -c")), false);
  assert.match(written.join(""), /running: .*setup\.sh refresh/);
});

test("an unsupported request reports usage without running anything", () => {
  const calls = [];
  const status = runSandboxCli(["build-image"], (...call) => calls.push(call), () => {});
  assert.equal(status, 2);
  assert.deepEqual(calls, []);
});

test("a spawn failure is reported rather than read as success", () => {
  const status = runSandboxCli(["setup", "install"], () => ({ error: new Error("sudo missing") }), () => {});
  assert.equal(status, 1);
});

test("the payload resolves to the programs this checkout ships", () => {
  assert.match(sandboxPayloadDirectory(), /tools\/incus_sandbox\/$/);
});

test("a packaged installation uses its own programs, and an incomplete one says so", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grndctl-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(join(root, "lib", "sandbox-cli.js")).href;
  assert.throws(() => sandboxPayloadDirectory(moduleUrl), /ships no sandbox programs/);
  mkdirSync(join(root, "sandbox"));
  assert.equal(sandboxPayloadDirectory(moduleUrl), `${join(root, "sandbox")}/`);
});
