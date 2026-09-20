import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments, runClient } from "./client.mjs";

test("accepts closed lifecycle verbs and invokes only the fixed root helper", () => {
  assert.deepEqual(parseArguments(["create", "agent-1"]), { action: "create", name: "agent-1" });
  const calls = [];
  runClient(["attach", "agent-1"], (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  });
  assert.deepEqual(calls, [{
    command: "sudo",
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
