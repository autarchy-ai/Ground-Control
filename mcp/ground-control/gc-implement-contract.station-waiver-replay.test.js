// Replay verification of waived and superseded station observations (issue #1578).
//
// The security property under test: a station-observation obligation closes only when the thread
// itself proves either a later validated verdict or an exact writer-authored waiver bound to that
// obligation's latest opening. Every forged, misplaced, or mis-scoped record must leave the
// obligation open, because an open obligation is what keeps completion refusing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildExecutionObligationMarker,
  buildExecutionObligationV2Marker,
  buildStationObservationObligationId,
  buildStationVerdictMarker,
  buildStationWaiverCommand,
  deriveStationObservationEvidence,
  evaluateExecutionObligations,
  filterAttestedStationResolutions,
  parseExecutionObligationMarkers,
  parseLeadingStationVerdictMarker,
  parseStationWaiverCommand,
} from "./lib.js";

const ISSUE = 378;
const MCP = "gc-mcp";
const WRITER = "maintainer";
const OUTSIDER = "drive-by";
const TQ = "test_quality_review";
const CODEX = "codex_review";
const TQ_C1 = buildStationObservationObligationId({ stationId: TQ, logicalCycle: 1 });
const CODEX_C1 = buildStationObservationObligationId({ stationId: CODEX, logicalCycle: 1 });

const trust = { isTrusted: (c) => [MCP, WRITER].includes(c.authorLogin) };

function thread(entries) {
  return entries.map(([authorLogin, body], i) => ({ id: 1000 + i, authorLogin, body }));
}

function v2({ id = TQ_C1, station = TQ, cycle = 1, event = "opened", ...rest } = {}) {
  return buildExecutionObligationV2Marker({
    issueNumber: ISSUE,
    obligationId: id,
    event,
    kind: "station_observation",
    stationId: station,
    logicalCycle: cycle,
    ...rest,
  });
}

function waived({ id = TQ_C1, station = TQ, source }) {
  return v2({ id, station, event: "resolved", disposition: "waived", authorizationCommentId: source });
}

function reobserved({ id = CODEX_C1, station = CODEX, cycle = 1, record, observedCycle }) {
  return v2({
    id, station, cycle, event: "resolved", disposition: "reobserved",
    observationRecordId: record, observedCycle,
  });
}

function verdictRecord(station, cycle, issueNumber = ISSUE) {
  return `${buildStationVerdictMarker({ issueNumber, stationId: station, logicalCycle: cycle })}\n\n## findings`;
}

async function replay(comments) {
  const markerComments = comments
    .map((comment) => ({ comment, events: parseExecutionObligationMarkers([comment.body], ISSUE) }))
    .filter(({ events }) => events.length > 0);
  const result = await filterAttestedStationResolutions({
    markerComments,
    comments,
    trust,
    resolveTrustedLogin: async () => MCP,
  });
  const evaluation = evaluateExecutionObligations(result.events);
  return {
    ...evaluation,
    evidence: deriveStationObservationEvidence({
      obligations: evaluation.obligations,
      openedIndex: result.openedIndex,
      comments,
      issueNumber: ISSUE,
      trustedLogin: result.trustedLogin,
      owner: "fake",
      name: "repo",
    }),
  };
}

describe("station waiver command", () => {
  it("parses only the exact command naming a station and a finite obligation set", () => {
    const command = buildStationWaiverCommand({ stationId: TQ, obligationIds: [TQ_C1] });
    assert.deepEqual(parseStationWaiverCommand(`  ${command}\n`), { station: TQ, obligation_ids: [TQ_C1] });
    for (const body of [
      `Yes, go ahead: ${command}`,
      `> ${command}`,
      `${command} please`,
      `/ground-control waive-station ${TQ}`,
      `/ground-control waive-station ${TQ} ${TQ_C1} ${TQ_C1}`,
      `/ground-control authorize-wontfix ${TQ_C1}`,
    ]) {
      assert.equal(parseStationWaiverCommand(body), null, body);
    }
  });
});

describe("station verdict marker", () => {
  it("is read from the first line only, so reviewer text cannot forge a verdict", () => {
    assert.deepEqual(parseLeadingStationVerdictMarker(verdictRecord(CODEX, 2)), {
      issue_number: ISSUE, station: CODEX, cycle: 2,
    });
    assert.equal(parseLeadingStationVerdictMarker(`## findings\n\n${verdictRecord(CODEX, 2)}`), null);
  });
});

describe("waived resolution", () => {
  it("closes an observation waived by an exact writer command and records it as unobserved", async () => {
    const comments = thread([
      [MCP, v2()],
      [WRITER, buildStationWaiverCommand({ stationId: TQ, obligationIds: [TQ_C1] })],
      [MCP, waived({ source: 1001 })],
    ]);
    const state = await replay(comments);
    assert.equal(state.clear, true);
    assert.deepEqual(state.evidence.unobserved_waived_stations, [TQ]);
    assert.equal(state.evidence.waivers[0].source_author, WRITER);
    assert.equal(state.evidence.waivers[0].observed_later, false);
  });

  const refusals = [
    ["no waiver command exists", [[MCP, v2()], [MCP, waived({ source: 4242 })]]],
    ["the command author lacks repository write permission", [
      [MCP, v2()],
      [OUTSIDER, buildStationWaiverCommand({ stationId: TQ, obligationIds: [TQ_C1] })],
      [MCP, waived({ source: 1001 })],
    ]],
    ["the command names a different station", [
      [MCP, v2()],
      [WRITER, `/ground-control waive-station ${CODEX} ${TQ_C1}`],
      [MCP, waived({ source: 1001 })],
    ]],
    ["the command does not name this obligation", [
      [MCP, v2()],
      [WRITER, buildStationWaiverCommand({ stationId: TQ, obligationIds: ["STATION-OBS-TEST-QUALITY-REVIEW-C2"] })],
      [MCP, waived({ source: 1001 })],
    ]],
    ["the command was edited into prose", [
      [MCP, v2()],
      [WRITER, `I think ${buildStationWaiverCommand({ stationId: TQ, obligationIds: [TQ_C1] })}`],
      [MCP, waived({ source: 1001 })],
    ]],
    ["the command predates the obligation's latest opening", [
      [MCP, v2()],
      [WRITER, buildStationWaiverCommand({ stationId: TQ, obligationIds: [TQ_C1] })],
      [MCP, v2()],
      [MCP, waived({ source: 1001 })],
    ]],
    ["the waiver record is authored by a writer rather than the MCP identity", [
      [MCP, v2()],
      [WRITER, buildStationWaiverCommand({ stationId: TQ, obligationIds: [TQ_C1] })],
      [WRITER, waived({ source: 1001 })],
    ]],
    ["the waiver record cites itself as the command", [
      [MCP, v2()],
      [MCP, waived({ source: 1001 })],
    ]],
  ];
  for (const [label, entries] of refusals) {
    it(`leaves the obligation open when ${label}`, async () => {
      const state = await replay(thread(entries));
      assert.deepEqual(state.open_obligation_ids, [TQ_C1]);
      assert.deepEqual(state.evidence.waivers, []);
    });
  }

  it("never closes a v1 problem obligation", async () => {
    const problem = "DEFECT-1";
    const comments = thread([
      [WRITER, buildExecutionObligationMarker({ issueNumber: ISSUE, obligationId: problem, event: "opened" })],
      [WRITER, `/ground-control waive-station ${TQ} ${problem}`],
      [MCP, waived({ id: problem, source: 1001 })],
    ]);
    const state = await replay(comments);
    assert.deepEqual(state.open_obligation_ids, [problem]);
  });
});

describe("superseding observation", () => {
  it("closes an earlier-cycle obligation against a later validated verdict", async () => {
    const comments = thread([
      [MCP, v2({ id: CODEX_C1, station: CODEX })],
      [MCP, verdictRecord(CODEX, 2)],
      [MCP, reobserved({ record: 1001, observedCycle: 2 })],
    ]);
    const state = await replay(comments);
    assert.equal(state.clear, true);
  });

  const refusals = [
    ["the verdict predates the opening", [
      [MCP, verdictRecord(CODEX, 1)],
      [MCP, v2({ id: CODEX_C1, station: CODEX })],
      [MCP, reobserved({ record: 1000, observedCycle: 1 })],
    ]],
    ["the verdict is for another station", [
      [MCP, v2({ id: CODEX_C1, station: CODEX })],
      [MCP, verdictRecord(TQ, 1)],
      [MCP, reobserved({ record: 1001, observedCycle: 1 })],
    ]],
    ["the verdict is for another issue", [
      [MCP, v2({ id: CODEX_C1, station: CODEX })],
      [MCP, verdictRecord(CODEX, 1, 999)],
      [MCP, reobserved({ record: 1001, observedCycle: 1 })],
    ]],
    ["the resolution misstates the observed cycle", [
      [MCP, v2({ id: CODEX_C1, station: CODEX })],
      [MCP, verdictRecord(CODEX, 3)],
      [MCP, reobserved({ record: 1001, observedCycle: 2 })],
    ]],
    ["the record carries no leading verdict marker", [
      [MCP, v2({ id: CODEX_C1, station: CODEX })],
      [MCP, `## findings\n\n${verdictRecord(CODEX, 1)}`],
      [MCP, reobserved({ record: 1001, observedCycle: 1 })],
    ]],
    ["the record was posted by a repository writer, not the MCP identity", [
      [MCP, v2({ id: CODEX_C1, station: CODEX })],
      [WRITER, verdictRecord(CODEX, 1)],
      [MCP, reobserved({ record: 1001, observedCycle: 1 })],
    ]],
  ];
  for (const [label, entries] of refusals) {
    it(`leaves the obligation open when ${label}`, async () => {
      const state = await replay(thread(entries));
      assert.deepEqual(state.open_obligation_ids, [CODEX_C1]);
    });
  }

  it("counts a waived station as observed only after a later verified verdict", async () => {
    const comments = thread([
      [MCP, v2()],
      [WRITER, buildStationWaiverCommand({ stationId: TQ, obligationIds: [TQ_C1] })],
      [MCP, waived({ source: 1001 })],
      [MCP, verdictRecord(TQ, 1)],
    ]);
    const state = await replay(comments);
    assert.equal(state.evidence.waivers[0].observed_later, true);
    assert.deepEqual(state.evidence.unobserved_waived_stations, []);
  });
});
