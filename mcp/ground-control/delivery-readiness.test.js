// Trusted pre-merge delivery handoff records (issue #1671).
//
// The record is the ONLY authority the post-merge executor reads: it carries the exact
// completion payload the finalizer replays, bound to one issue, one pull request, and the
// pull-request head OID whose required checks readiness actually verified. These tests pin
// the properties that make replaying it safe — a forged, corrupted, stale, ambiguous, or
// unprivileged record must fail closed rather than finalize something.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERY_READINESS_VERSION,
  buildDeliveryPointerRecord,
  buildDeliveryReadinessRecord,
  parseDeliveryPointerMarkers,
  parseDeliveryReadinessMarkers,
  readTrustedDeliveryPointer,
  readTrustedDeliveryReadiness,
} from "./lib/delivery-readiness.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);

function payload(overrides = {}) {
  return {
    issueNumber: 1671,
    prNumber: 1680,
    requirements: [{ uid: "GC-O007", title: "Gated Agentic Development Loop", status: "ACTIVE" }],
    files: { modified: ["mcp/ground-control/lib/delivery-readiness.js"] },
    reviews: [{ reviewer: "codex", summary: "cycle 1 clean" }],
    traceability: { added: ["IMPLEMENTS"], updated: [], deleted: [] },
    ciStatus: "green",
    sonarStatus: "passed",
    planCommentUrl: "https://github.com/o/r/issues/1671#issuecomment-1",
    summary: "Automate Phase E.",
    plainEnglishOutcome: "Merging a delivery PR now finishes the workflow on its own.",
    documentation_outcome: null,
    lane: "implement",
    ...overrides,
  };
}

function record(overrides = {}) {
  return buildDeliveryReadinessRecord({
    issueNumber: 1671,
    prNumber: 1680,
    lane: "implement",
    headSha: HEAD,
    payload: payload(),
    ...overrides,
  });
}

// A trusted repo-write author; `resolveTrust` is stubbed per test.
function comments(entries) {
  return entries.map((e, i) => ({
    id: e.id ?? 100 + i,
    body: e.body,
    authorLogin: e.author ?? "maintainer",
    authorAssociation: "MEMBER",
    authorType: e.authorType ?? "User",
  }));
}

function trustOnly(...logins) {
  const allowed = new Set(logins.map((l) => l.toLowerCase()));
  return async () => ({
    isTrusted: (c) => allowed.has((c.authorLogin ?? "").toLowerCase()),
    isRepositoryAutomation: () => false,
  });
}

async function read(entries, overrides = {}) {
  return readTrustedDeliveryReadiness(
    { repoRoot: "/repo", owner: "o", name: "r", issueNumber: 1671, prNumber: 1680, headSha: HEAD, ...overrides },
    { readComments: async () => comments(entries), resolveTrust: trustOnly("maintainer") },
  );
}

describe("delivery readiness record", () => {
  it("round-trips the completion payload through the rendered record", async () => {
    const result = await read([{ body: record() }]);
    assert.equal(result.ok, true);
    assert.equal(result.record.version, DELIVERY_READINESS_VERSION);
    assert.equal(result.record.lane, "implement");
    assert.equal(result.record.head, HEAD);
    assert.deepEqual(result.record.payload, payload());
  });

  it("keeps a hyphen-bearing payload from terminating the HTML comment", () => {
    const body = record({
      payload: payload({ summary: "see --> the note", files: { added: ["a-b/c--d.js"] } }),
    });
    const markerBody = body.slice(body.indexOf("<!--"));
    // Exactly one comment terminator: the record's own.
    assert.equal(markerBody.split("-->").length - 1, 1);
    const parsed = parseDeliveryReadinessMarkers(body);
    assert.equal(parsed.length, 1);
    assert.equal(JSON.parse(parsed[0].payloadText).summary, "see --> the note");
  });

  it("refuses a record whose digest does not cover its payload", async () => {
    const tampered = record().replace('"Automate Phase E."', '"Tampered."');
    const result = await read([{ body: tampered }]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_readiness_corrupt");
  });

  it("refuses a record authored outside the repository's write set", async () => {
    const result = await read([{ body: record(), author: "drive-by" }]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_readiness_untrusted");
  });

  it("refuses a record written for a different pull request", async () => {
    const result = await read([{ body: record({ prNumber: 9999 }) }]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_readiness_missing");
  });

  it("refuses a record bound to a head other than the merged one", async () => {
    const result = await read([{ body: record({ headSha: OTHER_HEAD }) }]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_readiness_head_mismatch");
  });

  it("refuses an unsupported envelope version instead of guessing its shape", async () => {
    const future = record().replace('version="1"', 'version="99"');
    const result = await read([{ body: future }]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_readiness_version_unsupported");
  });

  it("refuses two disagreeing records for the same head rather than picking one", async () => {
    const result = await read([
      { body: record() },
      { body: record({ payload: payload({ summary: "A different delivery." }) }) },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_readiness_conflicting");
  });

  it("accepts a re-recorded readiness for a new head without calling it a conflict", async () => {
    const result = await read([
      { body: record({ headSha: OTHER_HEAD, payload: payload({ summary: "Stale head." }) }) },
      { body: record() },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.record.payload.summary, "Automate Phase E.");
  });

  it("refuses a payload larger than the bound before parsing it", async () => {
    const huge = record({ payload: payload({ summary: "x".repeat(60000) }) });
    const result = await read([{ body: huge }]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_readiness_corrupt");
  });

  it("reports a missing record distinctly from an untrusted one", async () => {
    const result = await read([{ body: "just an ordinary comment" }]);
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_readiness_missing");
  });
});

describe("delivery pointer record", () => {
  it("resolves a merged pull request to its Ground Control issue", async () => {
    const body = buildDeliveryPointerRecord({ issueNumber: 1671, prNumber: 1680, recordCommentId: 42 });
    assert.equal(parseDeliveryPointerMarkers(body).length, 1);
    const result = await readTrustedDeliveryPointer(
      { repoRoot: "/repo", owner: "o", name: "r", prNumber: 1680 },
      { readComments: async () => comments([{ body }]), resolveTrust: trustOnly("maintainer") },
    );
    assert.equal(result.ok, true);
    assert.equal(result.pointer.issue, 1671);
    assert.equal(result.pointer.record, 42);
  });

  it("ignores a pointer planted by someone without write access", async () => {
    const body = buildDeliveryPointerRecord({ issueNumber: 4242, prNumber: 1680, recordCommentId: 42 });
    const result = await readTrustedDeliveryPointer(
      { repoRoot: "/repo", owner: "o", name: "r", prNumber: 1680 },
      { readComments: async () => comments([{ body, author: "drive-by" }]), resolveTrust: trustOnly("maintainer") },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_pointer_untrusted");
  });

  it("reports no pointer at all, so a non-delivery pull request is not an error", async () => {
    const result = await readTrustedDeliveryPointer(
      { repoRoot: "/repo", owner: "o", name: "r", prNumber: 1680 },
      { readComments: async () => comments([{ body: "LGTM" }]), resolveTrust: trustOnly("maintainer") },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_pointer_missing");
  });

  it("refuses two trusted pointers naming different issues", async () => {
    const a = buildDeliveryPointerRecord({ issueNumber: 1671, prNumber: 1680, recordCommentId: 42 });
    const b = buildDeliveryPointerRecord({ issueNumber: 1672, prNumber: 1680, recordCommentId: 43 });
    const result = await readTrustedDeliveryPointer(
      { repoRoot: "/repo", owner: "o", name: "r", prNumber: 1680 },
      { readComments: async () => comments([{ body: a }, { body: b }]), resolveTrust: trustOnly("maintainer") },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_pointer_conflicting");
  });
});
