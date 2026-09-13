// The pre-push codex findings record is observation evidence (issue #1578).
//
// Replay only accepts a superseding `reobserved` when the record it cites leads with a
// `gc:station-verdict` marker for the same station. This drives the real runner against codex and
// gh shims to prove the runner writes that marker and binds every recovered obligation to it,
// before the cycle marker.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseExecutionObligationMarkers, parseLeadingStationVerdictMarker, runCodexReview } from "./lib.js";

function makeShims() {
  const repoDir = mkdtempSync(join(tmpdir(), "gc-codex-verdict-repo-"));
  execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", "796-x"]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
  writeFileSync(join(repoDir, "README"), "x\n");
  execFileSync("git", ["-C", repoDir, "add", "README"]);
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
  execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
  const binDir = mkdtempSync(join(tmpdir(), "gc-codex-verdict-bin-"));
  const logPath = join(binDir, "posts.jsonl");
  writeFileSync(join(binDir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const log = ${JSON.stringify(logPath)};
if (argv[0] === "repo" && argv[1] === "view") { process.stdout.write(JSON.stringify({ nameWithOwner: "fake/repo" })); process.exit(0); }
if (argv.includes("GET")) { process.stdout.write(argv.some((a) => a.endsWith("/permission")) ? "write\\n" : "[[]]"); process.exit(0); }
const f = argv.indexOf("-f");
if (f !== -1) {
  fs.appendFileSync(log, JSON.stringify(argv[f + 1].slice("body=".length)) + "\\n");
  const id = 8000 + fs.readFileSync(log, "utf8").trim().split("\\n").length;
  const url = "https://github.com/fake/repo/issues/796#issuecomment-" + id;
  process.stdout.write(argv.includes("--jq") ? url + "\\n" : JSON.stringify({ id, html_url: url }));
  process.exit(0);
}
process.stderr.write("gh shim: unhandled " + JSON.stringify(argv)); process.exit(2);
`, { mode: 0o755 });
  writeFileSync(join(binDir, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = args[args.indexOf("--output-last-message") + 1];
const tail = 'Clean.\\n\\n===REVIEW===\\n{"verdict":"ship","architectural_read":"Reviewed.","blocking":[]}\\n===END===\\n';
process.stdin.on("data", () => {});
process.stdin.on("end", () => { if (out) fs.writeFileSync(out, tail); process.stdout.write(tail); process.exit(0); });
`, { mode: 0o755 });
  return {
    repoDir,
    binDir,
    posts: () => readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    cleanup() {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}

describe("runCodexReview pre-push records its verdict for the station ledger", () => {
  it("stamps the findings record and resolves recovered obligations before the cycle marker", async () => {
    const shims = makeShims();
    const oldPath = process.env.PATH;
    process.env.PATH = `${shims.binDir}:${oldPath}`;
    try {
      const result = await runCodexReview({
        repoPath: shims.repoDir,
        uncommitted: true,
        stationObservations: [
          { obligationId: "STATION-OBS-CODEX-REVIEW-C1", stationId: "codex_review", logicalCycle: 1 },
        ],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const [record, resolution, cycleMarker] = shims.posts();
      assert.deepEqual(parseLeadingStationVerdictMarker(record), {
        issue_number: 796, station: "codex_review", cycle: 1,
      });
      const [event] = parseExecutionObligationMarkers([resolution], 796);
      assert.equal(event.disposition, "reobserved");
      assert.equal(event.observation_record_id, 8001);
      assert.equal(event.observed_cycle, 1);
      assert.match(cycleMarker, /gc:codex-prepush-cycle/);
    } finally {
      process.env.PATH = oldPath;
      shims.cleanup();
    }
  });
});
