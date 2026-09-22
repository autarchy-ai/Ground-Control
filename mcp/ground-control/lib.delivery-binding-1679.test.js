// Delivery authority is the synchronized branch and its recorded lane. Review
// records remain observability, but issue #1693 removes them from this boundary.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertDeliveryBindingCurrent, parseImplementBaseSyncMarkers, resolveDeliveryBinding } from "./lib.js";

const REVIEWED_TREE = "1".repeat(40);
const OTHER_TREE = "2".repeat(40);
const BRANCH = "1679-review-gate-ci-fixes";
const implementLane = { ok: true, lane: "implement" };
const quickfixLane = { ok: true, lane: "quickfix" };
const record = (overrides = {}) => ({
  settledTreeSha: REVIEWED_TREE,
  reviewPublicationId: "-",
  reviewRevisionDigest: "-",
  lane: "implement",
  ...overrides,
});

describe("delivery binding at the synchronization boundary (#1693)", () => {
  it("records the settled tree and lane without review evidence", async () => {
    const result = await resolveDeliveryBinding({ evidence: null, lane: implementLane, settledTreeSha: REVIEWED_TREE });
    assert.equal(result.ok, true);
    assert.deepEqual(result.binding, {
      settledTreeSha: REVIEWED_TREE, reviewPublicationId: "-", reviewRevisionDigest: "-", lane: "implement",
    });
  });

  it("does not make review coverage of a later tree a delivery condition", async () => {
    const result = await resolveDeliveryBinding({ evidence: null, lane: implementLane, settledTreeSha: OTHER_TREE });
    assert.equal(result.ok, true);
    assert.equal(result.binding.settledTreeSha, OTHER_TREE);
  });

  it("accepts absent or malformed review observability", async () => {
    for (const evidence of [{ ok: true, published: false }, { ok: false, error: "review_publication_evidence_malformed" }, null]) {
      const result = await resolveDeliveryBinding({ evidence, lane: implementLane, settledTreeSha: REVIEWED_TREE });
      assert.equal(result.ok, true);
    }
  });

  it("records quickfix as its own lane without special review treatment", async () => {
    const result = await resolveDeliveryBinding({ evidence: null, lane: quickfixLane, settledTreeSha: OTHER_TREE });
    assert.equal(result.ok, true);
    assert.equal(result.binding.lane, "quickfix");
  });

  it("propagates an unverifiable lane", async () => {
    const refusal = { ok: false, error: "run_lane_unverifiable", message: "no identity" };
    assert.deepEqual(await resolveDeliveryBinding({ evidence: null, lane: refusal, settledTreeSha: REVIEWED_TREE }), refusal);
  });
});

describe("delivery binding at delivery gates (#1693)", () => {
  it("accepts a record without review evidence", () => {
    assert.equal(assertDeliveryBindingCurrent({ record: record(), branchName: BRANCH }).ok, true);
  });

  it("still rejects a record from the wrong lane", () => {
    const result = assertDeliveryBindingCurrent({ record: record({ lane: "quickfix" }), branchName: BRANCH, lane: "implement" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_delivery_binding_lane_mismatch");
  });

  it("accepts a record whose lane matches the delivery", () => {
    assert.equal(assertDeliveryBindingCurrent({ record: record(), branchName: BRANCH, lane: "implement" }).ok, true);
  });
});

describe("historical synchronization records stay readable (#1679)", () => {
  const v1 = '<!-- gc:implement-base-sync schema="gc.implement.remote-base-sync/v1" '
    + `record="${"4".repeat(32)}" issue="1679" branch="1679-review-gate-ci-fixes" base="dev" source="refs/remotes/origin/dev" `
    + `pre="${"e".repeat(40)}" fetched="${"f".repeat(40)}" outcome="merged_clean" result="${"a".repeat(40)}" verified="${"5".repeat(40)}" -->`;
  const v2 = '<!-- gc:implement-base-sync schema="gc.implement.remote-base-sync/v2" '
    + `record="${"6".repeat(32)}" issue="1679" branch="1679-review-gate-ci-fixes" base="dev" source="refs/remotes/origin/dev" `
    + `pre="${"e".repeat(40)}" fetched="${"f".repeat(40)}" outcome="merged_clean" result="${"a".repeat(40)}" verified="${"5".repeat(40)}" settled="${"1".repeat(40)}" review="-" revision="-" lane="implement" -->`;

  it("parses historical and current records", () => {
    const records = parseImplementBaseSyncMarkers([v1, v2], 1679);
    assert.ok(records.every((entry) => entry.valid));
    assert.deepEqual(records.map((entry) => entry.schemaVersion), [1, 2]);
  });
});
