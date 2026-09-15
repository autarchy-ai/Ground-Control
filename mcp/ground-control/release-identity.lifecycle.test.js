// gc_release_identity publish / abandon / status — the reservation lifecycle (issue #1579).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COVERAGE, blobSha, familyYaml, withReleaseFixture } from "./release-identity.fixture.test.js";

const SNAPSHOT_8 = "docs/coverage/execution-snapshot-v8.json";
const CONFIG = { ".ground-control.yaml": familyYaml({ coverage: COVERAGE }) };

function landArtifact(github, files = { [SNAPSHOT_8]: "{\"release\":8}" }) {
  return github.commitBase("dev", { ...CONFIG, ...files });
}

async function statesFor(call, issueNumber = 7) {
  const status = await call({ action: "status", issueNumber, idempotencyKey: undefined });
  assert.equal(status.ok, true, JSON.stringify(status));
  return status.reservations.map((r) => [r.sequence, r.state, r.reason ?? null]);
}

describe("gc_release_identity publish", () => {
  it("refuses while the artifact is not a regular file on the base branch, leaving the reservation reserved", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      await call({ action: "reserve" });
      const missing = await call({ action: "publish" });
      assert.equal(missing.error, "release_identity_artifacts_missing_on_base");
      assert.deepEqual(missing.missing_path_keys, ["snapshot"]);
      landArtifact(github, { [SNAPSHOT_8]: { symlink: "elsewhere.json" } });
      assert.equal((await call({ action: "publish" })).error, "release_identity_artifacts_missing_on_base", "a symlink is not the artifact");
      assert.deepEqual(await statesFor(call), [[8, "reserved", null]]);
    });
  });

  it("links the published artifact's revision and blob, and replays without re-reading the branch", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      await call({ action: "reserve" });
      const landed = landArtifact(github);
      const published = await call({ action: "publish" });
      assert.equal(published.ok, true, JSON.stringify(published));
      assert.equal(published.reservation.state, "published");
      assert.equal(published.reservation.published_revision, landed);
      assert.deepEqual(published.reservation.artifacts, { snapshot: blobSha("{\"release\":8}") });
      assert.ok(github.comments().some((c) => c.body.includes('event="published"') && c.body.includes(blobSha("{\"release\":8}"))));

      github.commitBase("dev", CONFIG);
      const before = github.calls.length;
      const again = await call({ action: "publish" });
      assert.equal(again.ok, true);
      assert.equal(again.reused, true);
      assert.equal(again.reservation.published_revision, landed, "the stored outcome, not today's branch");
      assert.ok(!github.calls.slice(before).some((c) => /\/git\/trees\//.test(c.path)), "no artifact re-verification on replay");
      assert.equal(github.comments().filter((c) => c.body.includes('event="published"')).length, 1);
    });
  });

  it("records the head it verified when the base advances between observations", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      await call({ action: "reserve" });
      const first = landArtifact(github);
      let advanced = null;
      const real = github.restJson;
      github.restJson = async (root, path, options) => {
        const result = await real(root, path, options);
        if (advanced == null && /\/git\/trees\//.test(path) && github.refs.get("refs/heads/dev") === first) {
          advanced = landArtifact(github, { [SNAPSHOT_8]: "{\"release\":8,\"rebuilt\":true}" });
        }
        return result;
      };
      const published = await call({ action: "publish" });
      assert.equal(published.ok, true, JSON.stringify(published));
      assert.equal(published.reservation.published_revision, advanced);
      assert.deepEqual(published.reservation.artifacts, { snapshot: blobSha("{\"release\":8,\"rebuilt\":true}") });
    });
  });

  it("records publication for a closed issue and backfills a reservation record that was never posted", async () => {
    const issues = { 7: "open" };
    await withReleaseFixture({ issues }, async ({ github, call }) => {
      github.fail({ method: "POST", match: /\/issues\/7\/comments$/ });
      assert.equal((await call({ action: "reserve" })).error, "release_identity_issue_record_failed");
      issues[7] = "closed";
      landArtifact(github);
      const published = await call({ action: "publish" });
      assert.equal(published.ok, true, JSON.stringify(published));
      assert.deepEqual(github.comments().map((c) => /event="(\w+)"/.exec(c.body)[1]), ["reserved", "published"]);
    });
  });

  it("reports an undecided write when the log read after the outcome create does not show it yet, and recovers on retry", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      await call({ action: "reserve" });
      landArtifact(github);
      const real = github.restJson;
      let outcomeCreated = false;
      let lagged = false;
      github.restJson = async (root, path, options = {}) => {
        const result = await real(root, path, options);
        if (options.method === "POST" && path.endsWith("/git/refs") && options.fields.ref.includes("/outcomes/")) outcomeCreated = true;
        if (outcomeCreated && !lagged && /\/git\/matching-refs\/gc\/release-identities\/coverage\/$/.test(path)) {
          lagged = true;
          return result.filter((entry) => !entry.ref.includes("/outcomes/"));
        }
        return result;
      };
      const lagging = await call({ action: "publish" });
      assert.equal(lagging.error, "release_identity_write_undecided", JSON.stringify(lagging));
      const retry = await call({ action: "publish" });
      assert.equal(retry.ok, true);
      assert.equal(retry.reservation.state, "published");
    });
  });

  it("refuses to publish an identity that has no reservation for this key", async () => {
    await withReleaseFixture({}, async ({ call }) => {
      assert.equal((await call({ action: "publish" })).error, "release_identity_reservation_not_found");
    });
  });
});

describe("gc_release_identity abandon", () => {
  it("burns the identity: it is recorded, never reissued, and cannot later be published", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      await call({ action: "reserve" });
      const abandoned = await call({ action: "abandon", reason: "capture_not_needed" });
      assert.equal(abandoned.ok, true, JSON.stringify(abandoned));
      assert.equal(abandoned.reservation.state, "abandoned");
      assert.ok(github.comments().some((c) => c.body.includes('event="abandoned"') && c.body.includes("capture_not_needed")));

      assert.equal((await call({ action: "reserve", issueNumber: 8 })).reservation.sequence, 9);
      landArtifact(github);
      const publish = await call({ action: "publish" });
      assert.equal(publish.error, "release_identity_reservation_abandoned");
      assert.equal(publish.reservation.state, "abandoned", "the refusal carries the authoritative state");

      const replay = await call({ action: "reserve" });
      assert.equal(replay.ok, true);
      assert.equal(replay.reservation.state, "abandoned", "the same key never silently allocates a replacement");
      assert.match(replay.next_action, /new_idempotency_key/);
      assert.equal(github.ledgerRefs().length, 2);
    });
  });

  it("repeats an identical abandonment and refuses a conflicting reason or a published reservation", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      await call({ action: "reserve" });
      await call({ action: "abandon", reason: "superseded" });
      assert.equal((await call({ action: "abandon", reason: "superseded" })).reused, true);
      assert.equal((await call({ action: "abandon", reason: "run_abandoned" })).error, "release_identity_reservation_abandoned");

      await call({ action: "reserve", issueNumber: 8 });
      landArtifact(github, { "docs/coverage/execution-snapshot-v9.json": "{}" });
      assert.equal((await call({ action: "publish", issueNumber: 8 })).ok, true);
      assert.equal((await call({ action: "abandon", issueNumber: 8, reason: "superseded" })).error, "release_identity_already_published");
    });
  });

  it("lets exactly one of a concurrent publish and abandon win, and both report the winner", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      await call({ action: "reserve" });
      landArtifact(github);
      const [published, abandoned] = await Promise.all([
        call({ action: "publish" }),
        call({ action: "abandon", reason: "run_abandoned" }),
      ]);
      assert.equal([published.ok, abandoned.ok].filter(Boolean).length, 1, JSON.stringify([published, abandoned]));
      const [[, state]] = await statesFor(call);
      assert.equal(state, published.ok ? "published" : "abandoned");
      assert.equal((published.ok ? abandoned : published).reservation.state, state);
      assert.equal(github.ledgerRefs("coverage", "outcomes").length, 1);
    });
  });

  it("refuses a reason outside the closed set, and a reason on any other action", async () => {
    await withReleaseFixture({}, async ({ call }) => {
      assert.equal((await call({ action: "abandon", reason: "duplicate_claim" })).error, "release_identity_reason_invalid");
      assert.equal((await call({ action: "publish", reason: "superseded" })).error, "release_identity_reason_invalid");
    });
  });
});

describe("gc_release_identity status", () => {
  it("lists every reservation in the family with its lifecycle state and completeness, optionally for one issue", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ call }) => {
      await call({ action: "reserve" });
      await call({ action: "reserve", issueNumber: 8 });
      await call({ action: "abandon", issueNumber: 8, reason: "generation_failed" });
      const all = await call({ action: "status", issueNumber: undefined, idempotencyKey: undefined });
      assert.equal(all.complete, true);
      assert.deepEqual(all.reservations.map((r) => [r.sequence, r.issue_number, r.state]), [[8, 7, "reserved"], [9, 8, "abandoned"]]);
      assert.deepEqual(await statesFor(call, 8), [[9, "abandoned", "generation_failed"]]);
      assert.equal((await call({ action: "status" })).error, "release_identity_idempotency_key_invalid", "status takes no key");
    });
  });
});
