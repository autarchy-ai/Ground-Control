// The policy that decides whether a published review authorizes a delivery
// (issue #1679). It is deliberately asymmetric, and both halves matter:
//
//   - a zero-finding cycle had nothing to repair, so any later tree is work no
//     reviewer has seen and the binding is exact;
//   - a finding-bearing cycle is *expected* to be followed by repairs (ADR-099),
//     so its settled tree is recorded without claiming Codex reviewed it.
//
// Requiring exact equality in both cases would quietly reverse ADR-099 into a
// clean-terminal-verdict requirement; requiring it in neither leaves the hole
// this issue reports.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertDeliveryBindingCurrent, parseImplementBaseSyncMarkers, resolveDeliveryBinding } from "./lib.js";

const REVIEWED_TREE = "1".repeat(40);
const OTHER_TREE = "2".repeat(40);
const BRANCH = "1679-review-gate-ci-fixes";
const PUBLICATION = "a".repeat(64);
const REVISION = "c".repeat(64);

const evidence = (overrides = {}) => ({
  ok: true,
  published: true,
  cycle: 1,
  comment_id: 12,
  publication_id: PUBLICATION,
  revision_digest: REVISION,
  candidate_tree_oid: REVIEWED_TREE,
  findings_count: 0,
  branch: BRANCH,
  ...overrides,
});

const implementLane = { ok: true, lane: "implement" };
const quickfixLane = { ok: true, lane: "quickfix" };

const record = (overrides = {}) => ({
  settledTreeSha: REVIEWED_TREE,
  reviewPublicationId: PUBLICATION,
  reviewRevisionDigest: REVISION,
  lane: "implement",
  ...overrides,
});

describe("resolveDeliveryBinding at the synchronization boundary (#1679)", () => {
  it("binds a zero-finding review to exactly the tree it read", async () => {
    const result = await resolveDeliveryBinding({
      evidence: evidence(), lane: implementLane, settledTreeSha: REVIEWED_TREE,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.binding, {
      settledTreeSha: REVIEWED_TREE,
      reviewPublicationId: PUBLICATION,
      reviewRevisionDigest: REVISION,
      lane: "implement",
    });
  });

  it("refuses a delivery whose tree a clean review never saw", async () => {
    const result = await resolveDeliveryBinding({
      evidence: evidence(), lane: implementLane, settledTreeSha: OTHER_TREE,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_base_sync_reviewed_tree_changed");
  });

  it("records a finding-bearing review's settled tree without calling it reviewed", async () => {
    // ADR-099: the repairs that follow the last cycle are delivered unreviewed by
    // design. Refusing here would make a clean verdict mandatory.
    const result = await resolveDeliveryBinding({
      evidence: evidence({ findings_count: 2 }), lane: implementLane, settledTreeSha: OTHER_TREE,
    });
    assert.equal(result.ok, true);
    assert.equal(result.binding.settledTreeSha, OTHER_TREE);
  });

  it("refuses when no publication authorizes an /implement delivery", async () => {
    for (const absent of [
      { ok: true, published: false },
      { ok: false, error: "review_publication_evidence_malformed" },
      null,
    ]) {
      const result = await resolveDeliveryBinding({
        evidence: absent, lane: implementLane, settledTreeSha: REVIEWED_TREE,
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, "implement_base_sync_review_publication_missing");
    }
  });

  it("records no publication for the quickfix lane, which publishes none", async () => {
    const result = await resolveDeliveryBinding({
      evidence: null, lane: quickfixLane, settledTreeSha: OTHER_TREE,
    });
    assert.equal(result.ok, true);
    assert.equal(result.binding.lane, "quickfix");
    assert.equal(result.binding.reviewPublicationId, "-");
    assert.equal(result.binding.settledTreeSha, OTHER_TREE);
  });

  it("propagates an undeterminable lane instead of picking one", async () => {
    const refusal = { ok: false, error: "run_lane_unverifiable", message: "no identity" };
    assert.deepEqual(
      await resolveDeliveryBinding({ evidence: evidence(), lane: refusal, settledTreeSha: REVIEWED_TREE }),
      refusal,
    );
  });
});

describe("assertDeliveryBindingCurrent at the delivery gates (#1679)", () => {
  it("accepts a record still bound to the issue's current publication", () => {
    assert.equal(
      assertDeliveryBindingCurrent({ record: record(), evidence: evidence(), branchName: BRANCH }).ok,
      true,
    );
  });

  it("refuses a record bound to a publication the issue has since replaced", () => {
    const result = assertDeliveryBindingCurrent({
      record: record(),
      evidence: evidence({ publication_id: "b".repeat(64) }),
      branchName: BRANCH,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_delivery_binding_stale");
  });

  it("refuses a record whose recorded revision digest no longer matches", () => {
    const result = assertDeliveryBindingCurrent({
      record: record(),
      evidence: evidence({ revision_digest: "d".repeat(64) }),
      branchName: BRANCH,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_delivery_binding_stale");
  });

  it("refuses a review that ran on a different branch", () => {
    const result = assertDeliveryBindingCurrent({
      record: record(),
      evidence: evidence({ branch: "1679-somewhere-else" }),
      branchName: BRANCH,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_delivery_binding_branch_mismatch");
  });

  it("refuses when a clean review's tree is not the one that settled", () => {
    const result = assertDeliveryBindingCurrent({
      record: record({ settledTreeSha: OTHER_TREE }),
      evidence: evidence(),
      branchName: BRANCH,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_delivery_binding_tree_mismatch");
  });

  it("allows a finding-bearing review's repaired tree", () => {
    assert.equal(
      assertDeliveryBindingCurrent({
        record: record({ settledTreeSha: OTHER_TREE }),
        evidence: evidence({ findings_count: 1 }),
        branchName: BRANCH,
      }).ok,
      true,
    );
  });

  it("accepts the quickfix lane, which names no publication", () => {
    assert.equal(
      assertDeliveryBindingCurrent({
        record: record({ lane: "quickfix", reviewPublicationId: "-", reviewRevisionDigest: "-" }),
        evidence: null,
        branchName: BRANCH,
      }).ok,
      true,
    );
  });

  // security-F1 (cycle 3): the record's lane decides which checks apply, so a
  // record from another lane cannot be the one a delivery is judged against.
  // Without this, a quickfix record carried into an implement run reaches the
  // quickfix early return and skips the implement checks entirely.
  it("refuses a quickfix record presented for an implement delivery", () => {
    const result = assertDeliveryBindingCurrent({
      record: record({ lane: "quickfix", reviewPublicationId: "-", reviewRevisionDigest: "-" }),
      evidence: evidence(),
      branchName: BRANCH,
      lane: "implement",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_delivery_binding_lane_mismatch");
  });

  it("refuses an implement record presented for a quickfix delivery", () => {
    const result = assertDeliveryBindingCurrent({
      record: record(), evidence: null, branchName: BRANCH, lane: "quickfix",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_delivery_binding_lane_mismatch");
  });

  it("accepts a record whose lane matches the delivery", () => {
    assert.equal(
      assertDeliveryBindingCurrent({
        record: record(), evidence: evidence(), branchName: BRANCH, lane: "implement",
      }).ok,
      true,
    );
  });

  it("refuses a quickfix record that claims a review authorized it", () => {
    const result = assertDeliveryBindingCurrent({
      record: record({ lane: "quickfix" }),
      evidence: null,
      branchName: BRANCH,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_delivery_binding_inconsistent");
  });
});

// core-F4 (cycle 2): the synchronization schema bump made every historical record
// parse as malformed, and the reader rejects a malformed marker anywhere on the
// issue before it selects one — so an issue that already carried a record could
// never re-synchronize. History stays readable; it just is not authorization.
describe("historical synchronization records stay readable (#1679)", () => {
  const v1 = '<!-- gc:implement-base-sync schema="gc.implement.remote-base-sync/v1" '
    + `record="${"4".repeat(32)}" issue="1679" branch="1679-review-gate-ci-fixes" base="dev" `
    + 'source="refs/remotes/origin/dev" '
    + `pre="${"e".repeat(40)}" fetched="${"f".repeat(40)}" outcome="merged_clean" `
    + `result="${"a".repeat(40)}" verified="${"5".repeat(40)}" -->`;
  const v2 = '<!-- gc:implement-base-sync schema="gc.implement.remote-base-sync/v2" '
    + `record="${"6".repeat(32)}" issue="1679" branch="1679-review-gate-ci-fixes" base="dev" `
    + 'source="refs/remotes/origin/dev" '
    + `pre="${"e".repeat(40)}" fetched="${"f".repeat(40)}" outcome="merged_clean" `
    + `result="${"a".repeat(40)}" verified="${"5".repeat(40)}" settled="${"1".repeat(40)}" `
    + `review="${"a".repeat(64)}" revision="${"c".repeat(64)}" lane="implement" -->`;

  it("parses a historical record as well-formed rather than malformed", () => {
    const [record] = parseImplementBaseSyncMarkers([v1], 1679);
    assert.equal(record.valid, true, "a malformed record would poison the whole read");
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.settledTreeSha, undefined, "it names no binding, so it cannot authorize one");
  });

  it("parses a current record with its binding", () => {
    const [record] = parseImplementBaseSyncMarkers([v2], 1679);
    assert.equal(record.valid, true);
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.settledTreeSha, "1".repeat(40));
    assert.equal(record.lane, "implement");
  });

  it("rejects a record that mixes the two schemas", () => {
    const mixed = v1.replace(" -->", ` settled="${"1".repeat(40)}" -->`);
    assert.equal(parseImplementBaseSyncMarkers([mixed], 1679)[0].valid, false);
    const stripped = v2.replace(` settled="${"1".repeat(40)}"`, "");
    assert.equal(parseImplementBaseSyncMarkers([stripped], 1679)[0].valid, false);
  });

  it("reads a current record from a thread that also carries a historical one", () => {
    const records = parseImplementBaseSyncMarkers([v1, v2], 1679);
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.valid));
    assert.deepEqual(records.map((record) => record.schemaVersion), [1, 2]);
  });
});
