import assert from "node:assert/strict";
import test from "node:test";

import { ciStationResult } from "./lib/ci-conclusion.js";

test("a rejecting verdict is the only conclusion that reads as a defect", () => {
  assert.equal(ciStationResult("failure"), "fail");
});

test("success is a pass", () => {
  assert.equal(ciStationResult("success"), "pass");
});

test("infrastructure and scheduling outcomes are not evaluable, not failures", () => {
  // The regression this locks: these four were classified `fail`, so an agent-side timeout or a
  // dead runner was counted as the change being rejected.
  for (const conclusion of ["timed_out", "startup_failure", "queued_too_long", "stale"]) {
    assert.equal(ciStationResult(conclusion), "not_evaluable", conclusion);
  }
});

test("a run waiting on a human approval rendered no verdict", () => {
  assert.equal(ciStationResult("action_required"), "not_evaluable");
});

test("cancellation has its own station result", () => {
  assert.equal(ciStationResult("cancelled"), "cancelled");
});

test("a run that inspected nothing is coverage, not a pass", () => {
  assert.equal(ciStationResult("skipped"), "skipped_station");
  assert.equal(ciStationResult("neutral"), "skipped_station");
});

test("an unrecognized or absent conclusion defaults away from fail", () => {
  assert.equal(ciStationResult("some_future_conclusion"), "not_evaluable");
  assert.equal(ciStationResult(null), "not_evaluable");
  assert.equal(ciStationResult(undefined), "not_evaluable");
  assert.equal(ciStationResult(""), "not_evaluable");
});
