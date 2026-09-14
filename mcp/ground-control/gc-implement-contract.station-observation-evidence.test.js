// Binding a stranded station observation to the verdict that observed it (issue #1582).
//
// The security-relevant property: only records the trusted MCP identity wrote, for the obligation's
// own station and logical cycle, after the obligation opened, and consumed by that cycle's marker,
// can justify a `reobserved` resolution. Anything a commenter can paste must not.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexReviewPrePushCycleMarker,
  buildExecutionObligationV2Marker,
  buildStationObservationObligationId,
  buildTestQualityReviewCycleMarker,
  buildTestQualityReviewFindingsComment,
  findStationObservationEvidence,
  hasTrustedReobservation,
  postStationReobservation,
} from "./lib.js";

const ISSUE = 2123;
const BRANCH = "2123-model-broker-boundary";
const TRUSTED = "gc-bot";

function obligationFor(station, cycle = 1) {
  return {
    obligation_id: buildStationObservationObligationId({ stationId: station, logicalCycle: cycle }),
    schema_version: 2,
    kind: "station_observation",
    station,
    cycle,
  };
}

function openedBody(station, cycle = 1) {
  return buildExecutionObligationV2Marker({
    issueNumber: ISSUE,
    obligationId: buildStationObservationObligationId({ stationId: station, logicalCycle: cycle }),
    event: "opened",
    kind: "station_observation",
    stationId: station,
    logicalCycle: cycle,
  });
}

function codexRecordBody({ cycle = 1, issue = ISSUE, branch = BRANCH } = {}) {
  return `**gc_codex_review** — cycle ${cycle} of 1 (pre-push) on issue #${issue} (branch \`${branch}\`)\n` +
    "**Diff mode:** inline\n\n## Core review\n\n**Verdict:** `ship-with-fixes`";
}

function codexMarkerBody({ cycle = 1, branch = BRANCH } = {}) {
  return buildCodexReviewPrePushCycleMarker({ issueNumber: ISSUE, branchName: branch, cycleNumber: cycle });
}

function comment(id, body, authorLogin = TRUSTED) {
  return { id, body, authorLogin };
}

// The Shifter #2123 thread, reduced to the records that matter.
function codexThread() {
  return [
    comment(5647811988, openedBody("codex_review")),
    comment(5648773109, codexRecordBody()),
    comment(5648773167, codexMarkerBody()),
  ];
}

function bind(comments, { station = "codex_review", recordId = null, trustedLogin = TRUSTED, cycle = 1 } = {}) {
  return findStationObservationEvidence({
    comments, issueNumber: ISSUE, obligation: obligationFor(station, cycle), trustedLogin, recordId,
  });
}

describe("findStationObservationEvidence: what proves a re-observation", () => {
  it("binds the Shifter #2123 sequence: opened, then codex findings record, then its cycle marker", () => {
    const evidence = bind(codexThread(), { recordId: 5648773109 });
    assert.equal(evidence.ok, true);
    assert.equal(evidence.record.id, 5648773109);
    assert.equal(evidence.cycleMarker.id, 5648773167);
  });

  it("locates the record itself when none is named", () => {
    const evidence = bind(codexThread());
    assert.equal(evidence.ok, true);
    assert.equal(evidence.record.id, 5648773109);
  });

  it("binds the test-quality station through its own record and marker family", () => {
    const record = buildTestQualityReviewFindingsComment({
      cycleNumber: 1, cap: 1, issueNumber: ISSUE, branch: BRANCH, findings: [],
    });
    const marker = buildTestQualityReviewCycleMarker({ issueNumber: ISSUE, branchName: BRANCH, cycleNumber: 1 });
    const comments = [
      comment(1, openedBody("test_quality_review")),
      comment(2, record),
      comment(3, marker),
    ];
    assert.equal(bind(comments, { station: "test_quality_review", recordId: 2 }).ok, true);
    // The codex station must not be satisfied by the other reviewer's verdict.
    const crossed = [comment(1, openedBody("codex_review")), comment(2, record), comment(3, marker)];
    assert.equal(bind(crossed, { recordId: 2 }).ok, false);
  });
});

describe("findStationObservationEvidence: what does not", () => {
  it("rejects a record posted before the obligation opened", () => {
    const [opened, record, marker] = codexThread();
    assert.deepEqual(
      bind([record, opened, marker], { recordId: record.id }),
      { ok: false, reason: "record_precedes_opened_event" },
    );
  });

  it("rejects a record or cycle marker not authored by the trusted MCP identity", () => {
    const [opened, record, marker] = codexThread();
    const forgedRecord = { ...record, authorLogin: "maintainer" };
    assert.equal(bind([opened, forgedRecord, marker], { recordId: record.id }).reason, "verdict_record_not_found");
    const forgedMarker = { ...marker, authorLogin: "maintainer" };
    assert.equal(bind([opened, record, forgedMarker], { recordId: record.id }).reason, "cycle_marker_not_found");
  });

  it("accepts an opening by another authorized writer; the ledger read already vouched for it", () => {
    // Only the verdict evidence must come from today's MCP identity. Tying the opening to it too
    // would strand every observation opened before a credential rotation.
    const [opened, record, marker] = codexThread();
    assert.equal(bind([{ ...opened, authorLogin: "previous-mcp-login" }, record, marker]).ok, true);
  });

  it("rejects a verdict for a different logical cycle", () => {
    const comments = [
      comment(1, openedBody("codex_review")),
      comment(2, codexRecordBody({ cycle: 2 })),
      comment(3, codexMarkerBody({ cycle: 2 })),
    ];
    assert.equal(bind(comments, { recordId: 2 }).reason, "verdict_record_not_found");
    assert.equal(bind(comments).reason, "verdict_record_not_found");
  });

  it("rejects a record whose cycle marker is missing, earlier, or on another branch", () => {
    const [opened, record, marker] = codexThread();
    assert.equal(bind([opened, record], { recordId: record.id }).reason, "cycle_marker_not_found");
    assert.equal(bind([opened, marker, record], { recordId: record.id }).reason, "verdict_record_not_found");
    const otherBranch = comment(marker.id, codexMarkerBody({ branch: "2123-other" }));
    assert.equal(bind([opened, record, otherBranch], { recordId: record.id }).reason, "verdict_record_not_found");
  });

  it("rejects a continuation chunk, a quoted header, and a post-push record", () => {
    const [opened, , marker] = codexThread();
    for (const body of [
      `**gc_codex_review** — cycle 1 of 1 (pre-push) — core continuation 2/2 (issue #${ISSUE})\nmore`,
      `> quoting the review:\n${codexRecordBody()}`,
      `**gc_codex_review** — cycle 1 of 1 (post-push) on PR #42 (issue #${ISSUE})\nbody`,
      codexRecordBody({ issue: 9999 }),
    ]) {
      assert.equal(bind([opened, comment(7, body), marker], { recordId: 7 }).ok, false, body);
    }
  });

  it("rejects a named comment that is not on the thread", () => {
    assert.equal(bind(codexThread(), { recordId: 42 }).reason, "record_not_found");
  });

  it("requires the verdict to follow the most recent opening", () => {
    // An obligation re-opened after a verdict is a new missing observation that verdict predates.
    const [opened, record, marker] = codexThread();
    const reopened = comment(5648773999, openedBody("codex_review"));
    assert.equal(bind([opened, record, marker, reopened], { recordId: record.id }).reason, "record_precedes_opened_event");
    assert.equal(bind([opened, record, marker, reopened]).reason, "verdict_record_not_found");
  });

  it("binds the record the marker consumed, not the first matching one", () => {
    // A record whose post attempt left no marker, then the retried record the marker consumed.
    const [opened, , marker] = codexThread();
    const orphan = comment(10, codexRecordBody());
    const consumed = comment(11, codexRecordBody());
    const comments = [opened, orphan, consumed, marker];
    assert.equal(bind(comments).record.id, 11);
    assert.equal(bind(comments, { recordId: 11 }).ok, true);
    assert.equal(bind(comments, { recordId: 10 }).reason, "record_is_not_the_consumed_verdict");
  });

  it("refuses a history where cycle markers consume different records", () => {
    const [opened] = codexThread();
    const comments = [
      opened,
      comment(10, codexRecordBody()),
      comment(11, codexMarkerBody()),
      comment(12, codexRecordBody()),
      comment(13, codexMarkerBody()),
    ];
    assert.equal(bind(comments).reason, "ambiguous_verdict_history");
    assert.equal(bind(comments, { recordId: 10 }).reason, "ambiguous_verdict_history");
  });

  it("fails closed without a trusted identity or for a non-station obligation", () => {
    for (const login of [null, "", "  "]) {
      assert.equal(bind(codexThread(), { trustedLogin: login }).reason, "trusted_identity_unresolved");
    }
    const problem = { obligation_id: "OB-1", schema_version: 1, kind: null, station: null, cycle: null };
    const evidence = findStationObservationEvidence({
      comments: codexThread(), issueNumber: ISSUE, obligation: problem, trustedLogin: TRUSTED,
    });
    assert.equal(evidence.reason, "not_a_station_observation");
    assert.equal(bind([]).reason, "opened_event_not_found");
  });
});

describe("hasTrustedReobservation", () => {
  const id = buildStationObservationObligationId({ stationId: "codex_review", logicalCycle: 1 });
  const resolved = buildExecutionObligationV2Marker({
    issueNumber: ISSUE,
    obligationId: id,
    event: "resolved",
    kind: "station_observation",
    stationId: "codex_review",
    logicalCycle: 1,
    disposition: "reobserved",
    observationRecordId: 5648773109,
  });

  const check = (comments, overrides = {}) => hasTrustedReobservation({
    comments, issueNumber: ISSUE, obligationId: id, station: "codex_review", cycle: 1,
    recordId: 5648773109, trustedLogin: TRUSTED, ...overrides,
  });

  it("recognizes a trusted resolution bound to the same record and ignores anyone else's", () => {
    assert.equal(check([comment(9, resolved)]), true);
    assert.equal(check([comment(9, resolved, "maintainer")]), false);
    assert.equal(check([comment(9, resolved)], { trustedLogin: null }), false);
  });

  it("does not report a resolution bound to a different record, station, or cycle as this one", () => {
    assert.equal(check([comment(9, resolved)], { recordId: 1 }), false);
    assert.equal(check([comment(9, resolved)], { station: "test_quality_review" }), false);
    assert.equal(check([comment(9, resolved)], { cycle: 2 }), false);
  });
});

describe("postStationReobservation corrective-action source", () => {
  it("refuses a source outside the closed set before any write", async () => {
    // Caller-chosen prose must not reach the durable record; the source only selects fixed text.
    const result = await postStationReobservation({
      repoRoot: "/nonexistent", owner: "fake", name: "repo", issueNumber: ISSUE,
      recordUrl: `https://github.com/fake/repo/issues/${ISSUE}#issuecomment-5648773109`,
      stationObservation: { obligationId: "STATION-OBS-CODEX-REVIEW-C1", stationId: "codex_review", logicalCycle: 1 },
      source: "the agent says it re-ran the review",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /unknown re-observation source/);
  });
});
