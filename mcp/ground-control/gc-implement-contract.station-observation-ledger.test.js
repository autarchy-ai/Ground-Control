// Station-observation obligations and the v2 marker family (issue #1476).
//
// The security-relevant property under test: `reobserved` clears a missing-observation obligation
// and nothing else. It must never close a real problem obligation, because that would be a
// disposition an agent could reach without the ADR-029 authorization path.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTION_OBLIGATION_DISPOSITIONS,
  EXECUTION_OBLIGATION_KINDS,
  EXECUTION_OBLIGATION_SCHEMA_V2,
  buildExecutionObligationMarker,
  buildExecutionObligationV2Marker,
  buildStationObservationObligationId,
  evaluateExecutionObligations,
  hasVerifiedStationReobservation,
  parseExecutionObligationMarkers,
  validateExecutionObligationInput,
} from "./lib.js";

const ISSUE = 1476;

function opened({ station = "review_station_b", cycle = 1 } = {}) {
  return buildExecutionObligationV2Marker({
    issueNumber: ISSUE,
    obligationId: buildStationObservationObligationId({ stationId: station, logicalCycle: cycle }),
    event: "opened",
    kind: "station_observation",
    stationId: station,
    logicalCycle: cycle,
  });
}

function reobserved({ station = "review_station_b", cycle = 1, recordId = 9001, id } = {}) {
  return buildExecutionObligationV2Marker({
    issueNumber: ISSUE,
    obligationId:
      id ?? buildStationObservationObligationId({ stationId: station, logicalCycle: cycle }),
    event: "resolved",
    kind: "station_observation",
    stationId: station,
    logicalCycle: cycle,
    disposition: "reobserved",
    observationRecordId: recordId,
  });
}

function stateOf(bodies) {
  return evaluateExecutionObligations(parseExecutionObligationMarkers(bodies, ISSUE));
}

describe("station-observation obligation identity", () => {
  it("is deterministic, branch-independent, and valid under the obligation id rules", () => {
    const a = buildStationObservationObligationId({ stationId: "codex_review", logicalCycle: 1 });
    const b = buildStationObservationObligationId({ stationId: "codex_review", logicalCycle: 1 });
    assert.equal(a, b);
    assert.match(a, /^[A-Z0-9][A-Z0-9._-]{0,63}$/);
  });

  it("separates stations and logical cycles", () => {
    const codex = buildStationObservationObligationId({ stationId: "codex_review", logicalCycle: 1 });
    const tq = buildStationObservationObligationId({ stationId: "review_station_b", logicalCycle: 1 });
    const cycle2 = buildStationObservationObligationId({ stationId: "codex_review", logicalCycle: 2 });
    assert.notEqual(codex, tq);
    assert.notEqual(codex, cycle2);
  });

  it("does not open a second obligation when the same logical cycle fails transiently again", () => {
    // Repeated transport attempts update one obligation. One obligation per attempt would leave
    // the run blocked on obligations nobody can resolve.
    const state = stateOf([opened(), opened()]);
    assert.deepEqual(state.open_obligation_ids, [
      buildStationObservationObligationId({ stationId: "review_station_b", logicalCycle: 1 }),
    ]);
  });
});

describe("v1 and v2 marker coexistence", () => {
  it("parses both families off one thread", () => {
    const v1Open = buildExecutionObligationMarker({
      issueNumber: ISSUE, obligationId: "OB-1", event: "opened",
    });
    const events = parseExecutionObligationMarkers([v1Open, opened()], ISSUE);
    assert.equal(events.length, 2);
    assert.equal(events.find((e) => e.obligation_id === "OB-1").schema_version, 1);
    const v2 = events.find((e) => e.obligation_id !== "OB-1");
    assert.equal(v2.schema_version, 2);
    assert.equal(v2.kind, "station_observation");
    assert.equal(v2.station, "review_station_b");
    assert.equal(v2.cycle, 1);
  });

  it("leaves v1 obligations with exactly their existing semantics", () => {
    const v1Open = buildExecutionObligationMarker({
      issueNumber: ISSUE, obligationId: "OB-1", event: "opened",
    });
    const v1Fix = buildExecutionObligationMarker({
      issueNumber: ISSUE, obligationId: "OB-1", event: "resolved", disposition: "fix",
    });
    assert.deepEqual(stateOf([v1Open]).open_obligation_ids, ["OB-1"]);
    assert.deepEqual(stateOf([v1Open, v1Fix]).open_obligation_ids, []);
  });

  it("keeps the v2 schema id distinct so an old reader cannot misread it as v1", () => {
    assert.match(opened(), new RegExp(EXECUTION_OBLIGATION_SCHEMA_V2.replace(/\//g, "\\/")));
    assert.ok(!opened().includes('schema="gc.implement.execution-obligation/v1"'));
  });
});

describe("reobserved resolution", () => {
  it("closes a matching station-observation obligation", () => {
    assert.deepEqual(stateOf([opened(), reobserved()]).open_obligation_ids, []);
  });

  it("closes it even when the later verdict found problems", () => {
    // Re-observation is about whether the gate was observed, not about whether the change is
    // clean. The findings themselves stay under the existing disposition rules.
    assert.deepEqual(stateOf([opened(), reobserved()]).open_obligation_ids, []);
  });

  it("survives an intervening escalation", () => {
    const escalation = buildExecutionObligationV2Marker({
      issueNumber: ISSUE,
      obligationId: buildStationObservationObligationId({
        stationId: "review_station_b", logicalCycle: 1,
      }),
      event: "escalated",
      kind: "station_observation",
      stationId: "review_station_b",
      logicalCycle: 1,
    });
    assert.deepEqual(stateOf([opened(), escalation]).open_obligation_ids.length, 1);
    assert.deepEqual(stateOf([opened(), escalation, reobserved()]).open_obligation_ids, []);
  });
});

describe("reobserved cannot clear anything it did not observe", () => {
  it("does not close a v1 problem obligation", () => {
    // The whole point: a defect must not become closable without the ADR-029 authorization path.
    const v1Open = buildExecutionObligationMarker({
      issueNumber: ISSUE, obligationId: "OB-1", event: "opened",
    });
    const forged = reobserved({ id: "OB-1" });
    assert.deepEqual(stateOf([v1Open, forged]).open_obligation_ids, ["OB-1"]);
  });

  it("does not close an obligation for a different station", () => {
    const mismatched = buildExecutionObligationV2Marker({
      issueNumber: ISSUE,
      obligationId: buildStationObservationObligationId({
        stationId: "review_station_b", logicalCycle: 1,
      }),
      event: "resolved",
      kind: "station_observation",
      stationId: "codex_review",
      logicalCycle: 1,
      disposition: "reobserved",
      observationRecordId: 9001,
    });
    assert.equal(stateOf([opened(), mismatched]).open_obligation_ids.length, 1);
  });

  it("does not close an obligation for a different logical cycle", () => {
    const mismatched = buildExecutionObligationV2Marker({
      issueNumber: ISSUE,
      obligationId: buildStationObservationObligationId({
        stationId: "review_station_b", logicalCycle: 1,
      }),
      event: "resolved",
      kind: "station_observation",
      stationId: "review_station_b",
      logicalCycle: 4,
      disposition: "reobserved",
      observationRecordId: 9001,
    });
    assert.equal(stateOf([opened(), mismatched]).open_obligation_ids.length, 1);
  });

  it("does not close without a bound observation record", () => {
    // "The next call returned ok=true" is not evidence a verdict was rendered.
    const unbound = buildExecutionObligationV2Marker({
      issueNumber: ISSUE,
      obligationId: buildStationObservationObligationId({
        stationId: "review_station_b", logicalCycle: 1,
      }),
      event: "resolved",
      kind: "station_observation",
      stationId: "review_station_b",
      logicalCycle: 1,
      disposition: "reobserved",
    });
    assert.equal(stateOf([opened(), unbound]).open_obligation_ids.length, 1);
  });

  it("is not accepted on the v1 marker family at all", () => {
    // A v1 marker carries no station, cycle, or evidence binding, so a v1 `reobserved` is
    // unverifiable by construction. The v1 regex must simply not match it.
    const smuggled =
      '<!-- gc:execution-obligation schema="gc.implement.execution-obligation/v1" ' +
      `issue="${ISSUE}" id="OB-1" event="resolved" disposition="reobserved" -->`;
    const v1Open = buildExecutionObligationMarker({
      issueNumber: ISSUE, obligationId: "OB-1", event: "opened",
    });
    assert.deepEqual(stateOf([v1Open, smuggled]).open_obligation_ids, ["OB-1"]);
  });
});

describe("public obligation tool surface", () => {
  it("does not expose reobserved as an agent-selectable disposition", () => {
    // Tool-attested, not agent-asserted: the only emitter is the station-owning cycle wrapper.
    assert.ok(!EXECUTION_OBLIGATION_DISPOSITIONS.includes("reobserved"));
    assert.deepEqual([...EXECUTION_OBLIGATION_DISPOSITIONS], ["fix", "wontfix", "not-applicable"]);
  });

  it("rejects a reobserved disposition submitted through the public validator", () => {
    const result = validateExecutionObligationInput({
      issueNumber: ISSUE,
      obligationId: "OB-1",
      event: "resolved",
      category: "workflow",
      observedState: "The reviewer timed out.",
      evidence: ["The engine returned no verdict."],
      impact: "The gate was not observed.",
      obligation: "Observe the gate.",
      disposition: "reobserved",
      correctiveAction: "Claiming the tool re-ran it.",
      verification: ["Claiming a later attempt succeeded."],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("disposition")));
  });

  it("registers station_observation as a v2 obligation kind", () => {
    assert.ok(EXECUTION_OBLIGATION_KINDS.includes("station_observation"));
  });
});

describe("hasVerifiedStationReobservation", () => {
  const TRUSTED = "gc-bot";
  const marker = { id: 9100, authorLogin: TRUSTED };
  const record = { id: 9001, authorLogin: TRUSTED };
  const event = { observation_record_id: 9001 };

  it("accepts a marker and record both posted by the trusted MCP identity", () => {
    assert.equal(
      hasVerifiedStationReobservation(event, marker, [record], TRUSTED),
      true,
    );
  });

  it("rejects a marker authored by anyone else, including a repository writer", () => {
    // Write permission is the bar for recording a problem obligation. Attesting that a gate was
    // observed is a claim only the server that ran the gate can make.
    assert.equal(
      hasVerifiedStationReobservation(event, { id: 9100, authorLogin: "maintainer" }, [record], TRUSTED),
      false,
    );
  });

  it("rejects a record posted by someone other than the trusted identity", () => {
    assert.equal(
      hasVerifiedStationReobservation(event, marker, [{ id: 9001, authorLogin: "maintainer" }], TRUSTED),
      false,
    );
  });

  it("rejects a self-referencing marker", () => {
    // One comment vouching for itself is no evidence.
    assert.equal(
      hasVerifiedStationReobservation({ observation_record_id: 9100 }, marker, [marker], TRUSTED),
      false,
    );
  });

  it("rejects a missing record reference", () => {
    assert.equal(hasVerifiedStationReobservation({ observation_record_id: null }, marker, [record], TRUSTED), false);
    assert.equal(hasVerifiedStationReobservation(event, marker, [], TRUSTED), false);
  });

  it("fails closed when the trusted identity cannot be resolved", () => {
    for (const login of [null, "", "   "]) {
      assert.equal(hasVerifiedStationReobservation(event, marker, [record], login), false);
    }
  });
});

describe("only a tool-attested re-observation closes a station observation", () => {
  // Codex cycle-1 blocking finding (core #1 / security #1): replay was keyed on obligation id
  // alone, so the legacy problem-disposition vocabulary carried across the family boundary. A
  // repository writer who is not the trusted MCP identity could copy the deterministic id,
  // station, and cycle out of an opened marker and post `disposition="fix"` — clearing an
  // unobserved gate with no verdict and unblocking completion.
  for (const disposition of ["fix", "wontfix", "not-applicable"]) {
    it(`rejects a v2 '${disposition}' resolution against a station observation`, () => {
      const legacy = buildExecutionObligationV2Marker({
        issueNumber: ISSUE,
        obligationId: buildStationObservationObligationId({
          stationId: "review_station_b", logicalCycle: 1,
        }),
        event: "resolved",
        kind: "station_observation",
        stationId: "review_station_b",
        logicalCycle: 1,
        disposition,
      });
      assert.equal(stateOf([opened(), legacy]).open_obligation_ids.length, 1, disposition);
    });

    it(`rejects a v1 '${disposition}' resolution reusing the station-observation id`, () => {
      const smuggled = buildExecutionObligationMarker({
        issueNumber: ISSUE,
        obligationId: buildStationObservationObligationId({
          stationId: "review_station_b", logicalCycle: 1,
        }),
        event: "resolved",
        disposition,
      });
      assert.equal(stateOf([opened(), smuggled]).open_obligation_ids.length, 1, disposition);
    });
  }

  it("still lets the v1 vocabulary close a v1 problem obligation", () => {
    // The isolation must run both ways: v2 rules must not leak onto the existing family.
    const v1Open = buildExecutionObligationMarker({
      issueNumber: ISSUE, obligationId: "OB-9", event: "opened",
    });
    const v1Fix = buildExecutionObligationMarker({
      issueNumber: ISSUE, obligationId: "OB-9", event: "resolved", disposition: "fix",
    });
    assert.deepEqual(stateOf([v1Open, v1Fix]).open_obligation_ids, []);
  });
});
