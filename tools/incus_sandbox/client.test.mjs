import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments, runClient, runProgram } from "./client.mjs";

test("accepts closed lifecycle verbs and invokes only the fixed root helper", () => {
  assert.deepEqual(parseArguments(["create", "agent-1"]), { action: "create", name: "agent-1" });
  const calls = [];
  runClient(["attach", "agent-1"], (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  });
  assert.deepEqual(calls, [{
    command: "/usr/bin/sudo",
    args: ["--", "/usr/local/lib/gc-incus-sandbox/helper.py", "attach", "agent-1"],
    options: { stdio: "inherit" },
  }]);
});

test("does not turn a failed helper call into a host command fallback", () => {
  assert.throws(() => runClient(["create", "agent-1"], () => ({ status: 75 })), /failed/);
  assert.throws(() => parseArguments(["exec", "agent-1"]), /unsupported/);
  assert.throws(() => parseArguments(["create", "agent;host-command"]), /sandbox name/);
  assert.throws(() => parseArguments(["list", "agent-1"]), /does not accept/);
});

test("routes preparation through the closed source-transfer path", () => {
  const calls = [];
  runProgram(["prepare", "agent-1", "clone", "/work/repository", "HEAD"], ({ command, args, options }) => {
    calls.push({ command, args, options });
    if (args.includes("rev-parse")) return { status: 0, stdout: `${"c".repeat(40)}\n` };
    if (args.includes("remote")) return { status: 0, stdout: "https://github.com/example/private.git\n" };
    return { status: 0 };
  }, {});
  assert.equal(calls.at(-1).command, "/usr/bin/sudo");
  assert.equal(calls.at(-1).args[2], "agent-1");
  assert.equal(calls.at(-1).args[3], "clone");
});

test("deletion requires the exact sandbox name as an explicit confirmation", () => {
  const calls = [];
  runClient(["delete", "agent-1", "--confirm", "agent-1"], (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  });
  assert.deepEqual(calls[0].args, [
    "--", "/usr/local/lib/gc-incus-sandbox/helper.py", "delete", "agent-1", "agent-1",
  ]);
  assert.throws(() => runClient(["delete", "agent-1"], () => ({ status: 0 })), /confirmation/);
  assert.throws(() => runClient(["delete", "agent-1", "--confirm", "agent-2"], () => ({ status: 0 })),
    /confirmation/);
});
