// Durable recovery of station-observation obligations across invocations (issue #1578).
//
// The #378 failure: a station that rendered no verdict opened an obligation, and a LATER
// invocation of the same review cycle tool rendered a verdict. Because the seam only carried the
// pending obligation inside the invocation that opened it, the later verdict resolved nothing and
// completion stayed blocked forever on a gate that had since been observed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _runStationWithObservationLedger,
  buildCodexReviewFindingsComments,
  buildStationVerdictMarker,
  parseExecutionObligationMarkers,
  parseLeadingStationVerdictMarker,
  postFindingsRecordAndCycleMarker,
} from "./lib.js";

const VERDICT = Object.freeze({ ok: true, next_action: "proceed_clean", finding_count: 0 });

describe("_runStationWithObservationLedger durable recovery", () => {
  it("hands an obligation left open by an earlier invocation to the first attempt", async () => {
    const seen = [];
    const run = await _runStationWithObservationLedger({
      reviewer: "codex",
      repoPath: "/nonexistent-gc-1578",
      issueNumber: 378,
      readOpenStationObservations: async ({ stationId }) => [
        { obligationId: "STATION-OBS-CODEX-REVIEW-C1", stationId, logicalCycle: 1 },
      ],
      invokeReview: async ({ stationObservations }) => {
        seen.push(stationObservations);
        return VERDICT;
      },
    });
    assert.equal(run.observed, true);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], [
      { obligationId: "STATION-OBS-CODEX-REVIEW-C1", stationId: "codex_review", logicalCycle: 1 },
    ]);
  });

  it("only recovers obligations for the station that is actually running", async () => {
    const seen = [];
    await _runStationWithObservationLedger({
      reviewer: "test-quality",
      repoPath: "/nonexistent-gc-1578",
      issueNumber: 378,
      readOpenStationObservations: async () => [
        { obligationId: "STATION-OBS-CODEX-REVIEW-C1", stationId: "codex_review", logicalCycle: 1 },
        {
          obligationId: "STATION-OBS-TEST-QUALITY-REVIEW-C1",
          stationId: "test_quality_review",
          logicalCycle: 1,
        },
      ],
      invokeReview: async ({ stationObservations }) => {
        seen.push(stationObservations);
        return VERDICT;
      },
    });
    assert.deepEqual(
      seen[0].map((o) => o.obligationId),
      ["STATION-OBS-TEST-QUALITY-REVIEW-C1"],
    );
  });

  it("passes no obligation when the durable ledger has none open", async () => {
    const seen = [];
    await _runStationWithObservationLedger({
      reviewer: "codex",
      repoPath: "/nonexistent-gc-1578",
      issueNumber: 378,
      readOpenStationObservations: async () => [],
      invokeReview: async ({ stationObservations }) => {
        seen.push(stationObservations);
        return VERDICT;
      },
    });
    assert.deepEqual(seen[0], []);
  });
});

describe("station-owned writers stamp the verdict they record", () => {
  it("leads a pre-push codex findings record with the verdict marker", () => {
    const [primary] = buildCodexReviewFindingsComments({
      cycleNumber: 2, cap: 3, mode: "pre-push", issueNumber: 378, branch: "378-x",
      coreReviewText: "no findings", securityReviewText: "no findings",
      stationVerdictMarker: buildStationVerdictMarker({ issueNumber: 378, stationId: "codex_review", logicalCycle: 2 }),
    });
    assert.deepEqual(parseLeadingStationVerdictMarker(primary), {
      issue_number: 378, station: "codex_review", cycle: 2,
    });
  });

  it("posts the stamped test-quality record, then resolutions, then the cycle marker", async () => {
    const bin = mkdtempSync(join(tmpdir(), "gc-tq-writer-"));
    const logPath = join(bin, "posts.jsonl");
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const body = argv[argv.indexOf("-f") + 1].slice("body=".length);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(body) + "\\n");
const id = fs.readFileSync(${JSON.stringify(logPath)}, "utf8").trim().split("\\n").length + 7000;
process.stdout.write("https://github.com/fake/repo/issues/378#issuecomment-" + id + "\\n");
`, { mode: 0o755 });
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    try {
      const result = await postFindingsRecordAndCycleMarker({
        repoRoot: bin, owner: "fake", name: "repo", issueNumber: 378, branchName: "378-x",
        cycleNumber: 2, override: false, overrideReason: null, recordBody: "## findings",
        stationObservations: [
          { obligationId: "STATION-OBS-TEST-QUALITY-REVIEW-C2", stationId: "test_quality_review", logicalCycle: 2 },
          // A later cycle cannot be evidenced by this record and must be left open.
          { obligationId: "STATION-OBS-TEST-QUALITY-REVIEW-C3", stationId: "test_quality_review", logicalCycle: 3 },
        ],
      });
      assert.equal(result.ok, true);
      const posts = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(posts.length, 3);
      assert.deepEqual(parseLeadingStationVerdictMarker(posts[0]), {
        issue_number: 378, station: "test_quality_review", cycle: 2,
      });
      const [resolution] = parseExecutionObligationMarkers([posts[1]], 378);
      assert.equal(resolution.obligation_id, "STATION-OBS-TEST-QUALITY-REVIEW-C2");
      assert.equal(resolution.disposition, "reobserved");
      assert.equal(resolution.observation_record_id, 7001);
      assert.equal(resolution.observed_cycle, 2);
      assert.match(posts[2], /gc:test-quality-review-cycle/);
    } finally {
      process.env.PATH = old;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
