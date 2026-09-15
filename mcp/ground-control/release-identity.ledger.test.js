// Release-identity log validation: a log that is not fully understood is never allocated from
// (issue #1579, ADR-097).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReleaseEventMessage, parseReleaseEventMessage } from "./lib.js";
import { withReleaseFixture } from "./release-identity.fixture.test.js";

const CLAIM = (slot) => `refs/gc/release-identities/coverage/claims/${slot}`;

/** Append a hand-built event at `ref`, bypassing the server, as a repository writer could. */
async function plant(github, ref, event, { parent, tree } = {}) {
  const base = github.commits.get(github.refs.get("refs/heads/dev"));
  const { sha } = await github.restJson(null, "/repos/o/r/git/commits", {
    method: "POST",
    fields: { message: buildReleaseEventMessage(event), tree: tree ?? base.tree, "parents[]": parent ?? event.base_revision },
  });
  github.refs.set(ref, sha);
}

describe("release-identity event codec", () => {
  it("round-trips a server event and rejects any change to its closed shape", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      await call({ action: "reserve" });
      const event = github.readEvent(CLAIM(1));
      assert.deepEqual(parseReleaseEventMessage(buildReleaseEventMessage(event)), event);
      for (const [label, mutated] of [
        ["extra key", { ...event, note: "x" }],
        ["unknown schema", { ...event, schema: "gc.release-identity-event/v2" }],
        ["version not rendered from its definition", { ...event, version: "9.0.0" }],
        ["path not rendered from its definition", { ...event, paths: { snapshot: "docs/other.json" } }],
        ["digest of another definition", { ...event, family_digest: "0".repeat(64) }],
        ["definition the normalizer would not produce", { ...event, family_definition: { ...event.family_definition, extra: 1 } }],
      ]) {
        assert.equal(parseReleaseEventMessage(buildReleaseEventMessage(mutated)), null, label);
      }
      const message = buildReleaseEventMessage(event).replace("slot 1 #8", "slot 1 #9");
      assert.equal(parseReleaseEventMessage(message), null, "subject disagreeing with the body");
    });
  });
});

describe("release-identity log fold", () => {
  const cases = [
    ["an event naming another repository", (event) => ({ ...event, repository: "someone/else" })],
    ["a predecessor that is not the previous claim", (event) => ({ ...event, previous_claim: "a".repeat(40) })],
    ["a sequence that does not increase", (event) => ({ ...event, sequence: 8, version: "8.0.0", paths: { snapshot: "docs/coverage/execution-snapshot-v8.json" } })],
    ["a repeated idempotency identity", (event, first) => ({ ...event, issue_number: first.issue_number, idempotency_hash: first.idempotency_hash })],
  ];
  for (const [label, corrupt] of cases) {
    it(`fails closed on ${label}`, async () => {
      await withReleaseFixture({ issues: { 7: "open", 8: "open", 9: "open" } }, async ({ github, call }) => {
        await call({ action: "reserve" });
        await call({ action: "reserve", issueNumber: 8 });
        const first = github.readEvent(CLAIM(1));
        const second = github.readEvent(CLAIM(2));
        github.refs.delete(CLAIM(2));
        await plant(github, CLAIM(2), corrupt(second, first));
        const result = await call({ action: "reserve", issueNumber: 9 });
        assert.equal(result.error, "release_identity_log_malformed", label);
        assert.equal(github.ledgerRefs().length, 2, "nothing was allocated from the malformed log");
      });
    });
  }

  it("fails closed when a claim commit does not reuse its base revision's tree", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      await call({ action: "reserve" });
      const claim = github.readEvent(CLAIM(1));
      const unrelated = github.commitBase("unrelated", { "not-the-base.txt": "different tree" });
      github.refs.delete(CLAIM(1));
      await plant(github, CLAIM(1), claim, { tree: github.commits.get(unrelated).tree });

      const result = await call({ action: "reserve", issueNumber: 8 });
      assert.equal(result.error, "release_identity_log_malformed");
      assert.equal(github.ledgerRefs().length, 1, "nothing was allocated from the malformed log");
    });
  });

  it("fails closed on an outcome that does not descend from its claim", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      await call({ action: "reserve" });
      const claim = github.readEvent(CLAIM(1));
      const outcome = {
        schema: claim.schema, repository: claim.repository, family: claim.family, slot: 1, sequence: claim.sequence,
        event: "abandoned", issue_number: claim.issue_number, idempotency_hash: claim.idempotency_hash, reason: "superseded",
      };
      await plant(github, "refs/gc/release-identities/coverage/outcomes/1", outcome, { parent: claim.base_revision });
      assert.equal((await call({ action: "reserve", issueNumber: 8 })).error, "release_identity_log_malformed");
    });
  });
});
