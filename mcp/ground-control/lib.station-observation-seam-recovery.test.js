// A station observation opened by one cycle-tool invocation is resolved by a later one (issue #1582).
//
// The obligation's "opened" state used to live only in one invocation's memory. When the station
// was re-run by a separate invocation — the documented recovery — that invocation rendered the
// verdict without the `reobserved` resolution, and the obligation stranded open forever.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _runStationWithObservationLedger } from "./lib.js";

const LEDGER = Object.freeze({ repoRoot: "/repo", owner: "fake", name: "repo" });
const VERDICT = Object.freeze({ ok: true, next_action: "proceed_clean", finding_count: 0 });
const NON_VERDICT = Object.freeze({ ok: false, error: "review_coverage_incomplete" });

function stationObservation({ station = "codex_review", cycle = 1, schemaVersion = 2, kind = "station_observation", id } = {}) {
  return {
    obligation_id: id ?? `STATION-OBS-${station.toUpperCase().replace(/_/g, "-")}-C${cycle}`,
    schema_version: schemaVersion,
    kind,
    station,
    cycle,
  };
}

function harness({ openObligations = [], readState = null, logicalCycle = 1, envelopes = [VERDICT] } = {}) {
  const carried = [];
  const opened = [];
  const escalated = [];
  let calls = 0;
  const deps = {
    readContext: async () => ({ workflow: { codex_review: { non_verdict_retry_limit: 1 } } }),
    resolveLedgerTarget: async (_repoPath, cached) => cached ?? LEDGER,
    resolveLogicalCycle: async () => logicalCycle,
    readObligationState: readState ?? (async () => ({
      ok: true,
      open_obligation_ids: openObligations.map((o) => o.obligation_id),
      open_obligations: openObligations,
      clear: openObligations.length === 0,
    })),
    postOpened: async (args) => {
      opened.push(args);
      return { ok: true, obligation_id: `STATION-OBS-CODEX-REVIEW-C${args.logicalCycle}` };
    },
    postEscalation: async (args) => {
      escalated.push(args);
      return { ok: true };
    },
  };
  const run = () => _runStationWithObservationLedger({
    reviewer: "codex",
    repoPath: "/repo",
    issueNumber: 2123,
    deps,
    invokeReview: async ({ stationObservation }) => {
      carried.push(stationObservation);
      return envelopes[Math.min(calls++, envelopes.length - 1)];
    },
  });
  return { run, carried, opened, escalated };
}

describe("station-observation seam: recovery across invocations (issue #1582)", () => {
  it("carries an obligation an earlier invocation opened into the first attempt", async () => {
    // The Shifter #2123 shape: opened by one call, verdict rendered by a later, separate call.
    const h = harness({ openObligations: [stationObservation()] });
    const result = await h.run();
    assert.equal(result.observed, true);
    assert.deepEqual(h.carried, [
      { obligationId: "STATION-OBS-CODEX-REVIEW-C1", stationId: "codex_review", logicalCycle: 1 },
    ]);
    assert.equal(h.opened.length, 0, "an already-open obligation is not opened a second time");
  });

  it("carries nothing when no obligation is open for this station", async () => {
    const h = harness();
    await h.run();
    assert.deepEqual(h.carried, [null]);
  });

  it("does not carry an obligation for another logical cycle, station, or marker family", async () => {
    // A resolution is bound to one station and cycle; carrying anything else would post a
    // re-observation replay rightly refuses, and leave the real obligation open.
    for (const obligation of [
      stationObservation({ cycle: 2 }),
      stationObservation({ station: "review_station_b" }),
      stationObservation({ schemaVersion: 1, kind: null }),
    ]) {
      const h = harness({ openObligations: [obligation] });
      await h.run();
      assert.deepEqual(h.carried, [null], JSON.stringify(obligation));
    }
  });

  it("escalates a recovered obligation when this invocation is still unobserved", async () => {
    const h = harness({ openObligations: [stationObservation()], envelopes: [NON_VERDICT] });
    const result = await h.run();
    assert.equal(result.exhaustedNonVerdict, true);
    assert.equal(h.opened.length, 0);
    assert.equal(h.escalated.length, 1);
    assert.equal(h.escalated[0].logicalCycle, 1);
    assert.equal(result.obligationId, "STATION-OBS-CODEX-REVIEW-C1");
  });

  it("still opens, then resolves on the re-attempt, an obligation first seen in this invocation", async () => {
    const h = harness({ envelopes: [NON_VERDICT, VERDICT] });
    await h.run();
    assert.equal(h.opened.length, 1);
    assert.deepEqual(h.carried, [
      null,
      { obligationId: "STATION-OBS-CODEX-REVIEW-C1", stationId: "codex_review", logicalCycle: 1 },
    ]);
  });

  it("lets a working station render its verdict when the ledger cannot be read", async () => {
    for (const readState of [
      async () => { throw new Error("gh: HTTP 502"); },
      async () => ({ ok: false, error: "execution_obligation_provenance_unverifiable" }),
    ]) {
      const h = harness({ readState });
      const result = await h.run();
      assert.equal(result.observed, true);
      assert.deepEqual(h.carried, [null]);
    }
  });
});
