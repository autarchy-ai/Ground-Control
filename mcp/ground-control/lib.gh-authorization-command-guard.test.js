// The MCP server never publishes a Ground Control authorization command (issue #1578).
//
// `/ground-control waive-station`, `authorize-wontfix`, and `authorize-scope-removal` are authority
// only because a human with write access typed them. The server posts under a write-permitted
// identity — often the same account as that human — so replay cannot tell the two apart by author.
// The guarantee therefore lives at the one boundary every server-side GitHub write passes through:
// a `gh` invocation whose published body carries such a command is refused before it spawns.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, findGroundControlCommandInGhArgv } from "./lib.js";

const COMMANDS = [
  "/ground-control waive-station test_quality_review STATION-OBS-TEST-QUALITY-REVIEW-C1",
  "/ground-control authorize-wontfix OB-1",
  "/ground-control authorize-scope-removal 1578 GC-O007",
];

async function withSentinelGh(fn) {
  const bin = mkdtempSync(join(tmpdir(), "gc-command-guard-"));
  const sentinel = join(bin, "spawned");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\necho ok\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    return await fn(() => existsSync(sentinel));
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

describe("gh authorization-command publication guard", () => {
  for (const command of COMMANDS) {
    it(`refuses to spawn gh publishing '${command.split(" ")[1]}'`, async () => {
      await withSentinelGh(async (spawned) => {
        for (const body of [command, `Remediation notes\n\n  ${command}\n`]) {
          await assert.rejects(
            execFile("gh", ["api", "--method", "POST", "/repos/o/r/issues/1/comments", "-f", `body=${body}`]),
            (error) => error.code === "GC_AUTHORIZATION_COMMAND_REFUSED",
          );
        }
        await assert.rejects(
          execFile("gh", ["pr", "comment", "7", "--body", command]),
          (error) => error.code === "GC_AUTHORIZATION_COMMAND_REFUSED",
        );
        assert.equal(spawned(), false, "gh must not run when the body carries an authorization command");
      });
    });
  }

  it("still publishes ordinary bodies, including ones that mention a command inline", async () => {
    await withSentinelGh(async (spawned) => {
      const body = "Post `/ground-control waive-station <station_id> <ID>` to waive.";
      const { stdout } = await execFile("gh", ["api", "/repos/o/r/issues/1/comments", "-f", `body=${body}`]);
      assert.equal(stdout.trim(), "ok");
      assert.equal(spawned(), true);
    });
  });

  it("inspects only published body fields", () => {
    assert.equal(findGroundControlCommandInGhArgv(["api", "-F", "per_page=100", "/repos/o/r/issues/1/comments"]), null);
    assert.notEqual(findGroundControlCommandInGhArgv(["api", `--raw-field=body=${COMMANDS[0]}`]), null);
    assert.notEqual(findGroundControlCommandInGhArgv(["issue", "comment", "1", `--body=${COMMANDS[1]}`]), null);
    // A file-sourced body cannot be inspected, so it is refused rather than trusted.
    for (const argv of [["api", "-F", "body=@/tmp/comment.md"], ["api", "--field", "body=@/tmp/c.md"], ["api", "--field=body=@/tmp/c.md"]]) {
      assert.notEqual(findGroundControlCommandInGhArgv(argv), null, JSON.stringify(argv));
    }
    // A raw field publishes `@...` literally, so it is inspected as text rather than refused.
    assert.equal(findGroundControlCommandInGhArgv(["api", "--raw-field=body=@mention thanks"]), null);
  });
});
