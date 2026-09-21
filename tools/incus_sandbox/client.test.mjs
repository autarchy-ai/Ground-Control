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
    if (args.includes("show")) return { status: 128, stdout: Buffer.alloc(0) };
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

test("task start sends the fixed repository declaration over stdin rather than argv", () => {
  const calls = [];
  const declaration = Buffer.from(JSON.stringify({
    schema: "gc.incus-sandbox.task-environment/v1",
    repository: "example/private",
    variables: [{ name: "REGION", literal: "eu-central-1" }],
  }));
  runProgram(["task-start", "agent-1"], ({ command, args, options }) => {
    calls.push({ command, args, options });
    if (command === "/usr/bin/git" && args.includes("--show-toplevel")) {
      return { status: 0, stdout: "/work/repository\n" };
    }
    if (command === "/usr/bin/git") {
      return { status: 0, stdout: "git@github.com:example/private.git\n" };
    }
    return { status: 0 };
  }, { GH_TOKEN: "ambient-canary" }, {
    readFile: (path) => {
      assert.equal(path, "/work/repository/.gc-sandbox-env.json");
      return declaration;
    },
  });
  const privileged = calls.at(-1);
  assert.deepEqual(privileged.args, [
    "--", "/usr/local/lib/gc-incus-sandbox/task_environment.py", "start", "agent-1",
  ]);
  assert.deepEqual(privileged.options.stdio, ["pipe", "inherit", "inherit"]);
  assert.doesNotMatch(JSON.stringify(privileged.args), /eu-central|ambient-canary/);
  const request = JSON.parse(privileged.options.input);
  assert.equal(request.repository, "example/private");
  assert.deepEqual(Buffer.from(request.declaration_b64, "base64"), declaration);
});

test("task lifecycle has a closed command vocabulary", () => {
  const calls = [];
  for (const action of ["task-stop"]) {
    runProgram([action, "agent-1"], ({ command, args, options }) => {
      calls.push({ command, args, options });
      return { status: 0 };
    }, {});
  }
  assert.deepEqual(calls.map((call) => call.args.slice(2)), [["stop", "agent-1"]]);
  assert.throws(() => runProgram(["task-status", "agent-1"], () => ({ status: 0 }), {}), /unsupported/);
  assert.throws(() => runProgram(["task-start", "agent-1", "alias"], () => ({ status: 0 }), {}),
    /task action/);
});
