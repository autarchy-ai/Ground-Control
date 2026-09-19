import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewRevision,
  createReviewResult,
  runPublishReviewResult,
  runCodexReviewWithPublication,
  validateSanitizedReviewPublication,
} from "./lib.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function retained(overrides = {}) {
  return createReviewResult({
    repositoryId: "fake/repo",
    issueNumber: 1632,
    reviewer: "codex",
    expectedCycle: 1,
    cap: 1,
    branch: "1632-review-publication",
    baseBranch: "dev",
    revision: buildReviewRevision({
      headOid: HEAD,
      baseOid: BASE,
      diffText: "diff",
      manifest: "1\t0\ta.js",
      unreviewedUntrackedPaths: [],
    }),
    coverage: { complete: true, chunks_total: 1, chunks_completed: 1 },
    findings: [{
      id: "core-F1",
      reviewer: "core",
      path: "secret-project.js",
      line: 7,
      title: "Internal identity leaked",
      body: "Names Project Nightingale.",
      classification: "one-off",
      sweep_evidence: "checked the diff",
    }],
    verdict: "ship-with-fixes",
    notes: [{ text: "Original private note." }],
    architecturalRead: "Original confidential architectural read.",
    terminal: { ok: true, next_action: "fix_findings_then_ask_over_cap_or_proceed" },
    ...overrides,
  }, { random: () => Buffer.alloc(24, 1), now: () => "2026-09-18T00:00:00.000Z" });
}

function sanitized() {
  return {
    verdict: "ship-with-fixes",
    notes: [{ text: "Sanitized note." }],
    architectural_read: "A sensitive identifier was generalized before publication.",
    findings: [{
      id: "core-F1",
      title: "Sensitive identifier leaked",
      classification: "one-off",
      decision: "fix",
      rationale: "Replaced it with a neutral label.",
      location: "module.js:7",
    }],
  };
}

function dependencies(record, calls) {
  return {
    resolveRepository: async () => ({ ok: true, repoRoot: "/repo", owner: "fake", name: "repo" }),
    readIdentity: async () => ({ gitDir: "/repo/.git" }),
    readResult: () => ({ ok: true, record }),
    writeResult: (_gitDir, next) => { calls.push(["write", next.publication_status]); return next; },
    captureRevision: async () => ({ revision: record.revision }),
    readPriorCycleCount: async () => 0,
    readProgress: async () => ({ findings: null, cycle: false, decision: null }),
    publishFindings: async (args) => { calls.push(["findings", args.body]); return { id: 10, url: "https://example.test/10" }; },
    publishReobservation: async () => { calls.push(["reobservation"]); return { id: 13, url: "https://example.test/13" }; },
    publishCycle: async (args) => { calls.push(["cycle", args.cycleNumber]); return { id: 11, url: "https://example.test/11" }; },
    publishDecision: async (args) => { calls.push(["decision", args.findings]); return { ok: true, comment_id: 12, comment_url: "https://example.test/12" }; },
    acquireLock: async () => async () => {},
  };
}

describe("review-result publication (#1632)", () => {
  it("routes direct automatic pre-push review through retained execution and the publisher", async () => {
    const calls = [];
    const result = await runCodexReviewWithPublication({
      repoPath: "/repo", issueNumber: 1632, uncommitted: true, publicationMode: "automatic",
    }, {
      reviewRunner: async (args) => { calls.push(["review", args.publicationMode]); return {
        ok: true, review_handle: `rvw_${"a".repeat(48)}`, verdict: "ship", notes: [],
        findings: [], architectural_read: "Reviewed.",
      }; },
      publisher: async (args) => { calls.push(["publish", args.sanitized.verdict]); return { ok: true }; },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [["review", "deferred"], ["publish", "ship"]]);
  });

  it("returns the retained handle and retry action when automatic publication refuses or throws", async () => {
    const reviewHandle = `rvw_${"a".repeat(48)}`;
    const input = { repoPath: "/repo", issueNumber: 1632, uncommitted: true, publicationMode: "automatic" };
    const reviewRunner = async () => ({ ok: true, review_handle: reviewHandle,
      verdict: "ship", notes: [], findings: [], architectural_read: "Reviewed." });
    for (const publisher of [
      async () => ({ ok: false, error: "decision_record_post_failed" }),
      async () => { throw new Error("post failed"); },
    ]) {
      const result = await runCodexReviewWithPublication(input, { reviewRunner, publisher });
      assert.equal(result.ok, false);
      assert.equal(result.review_handle, reviewHandle);
      assert.equal(result.publication_kind, "verdict");
      assert.equal(result.next_action, "retry_review_publication");
    }
  });

  it("publishes sanitized findings, one cycle marker, and validated dispositions", async () => {
    const record = retained();
    const calls = [];
    const result = await runPublishReviewResult({
      repoPath: "/repo",
      reviewHandle: record.review_handle,
      sanitized: sanitized(),
    }, dependencies(record, calls));
    assert.equal(result.ok, true);
    assert.equal(result.publication_status, "published");
    assert.deepEqual(calls.map(([kind]) => kind), ["findings", "cycle", "decision", "write"]);
    assert.doesNotMatch(calls[0][1], /Nightingale|secret-project/);
    assert.equal(calls[2][1][0].decision, "fix");
    assert.equal(result.receipt.cycle, 1);
    assert.match(result.receipt.original_digest, /^[0-9a-f]{64}$/);
    assert.match(result.receipt.sanitized_digest, /^[0-9a-f]{64}$/);
  });

  it("is idempotent after publication and performs no further writes", async () => {
    const original = retained();
    const digest = validateSanitizedReviewPublication(original, sanitized()).sanitized_digest;
    const record = {
      ...original,
      publication_status: "published",
      publication_receipt: { cycle: 1, publication_id: "p".repeat(64), sanitized_digest: digest },
    };
    const calls = [];
    const result = await runPublishReviewResult({
      repoPath: "/repo",
      reviewHandle: record.review_handle,
      sanitized: sanitized(),
    }, dependencies(record, calls));
    assert.equal(result.ok, true);
    assert.equal(result.already_published, true);
    assert.deepEqual(calls, []);
  });

  it("rejects an idempotent retry whose sanitized payload changed", async () => {
    const original = retained();
    const digest = validateSanitizedReviewPublication(original, sanitized()).sanitized_digest;
    const record = { ...original, publication_status: "published",
      publication_receipt: { cycle: 1, publication_id: "p".repeat(64), sanitized_digest: digest } };
    const changed = sanitized();
    changed.architectural_read = "Different sanitized content.";
    const calls = [];
    const result = await runPublishReviewResult({ repoPath: "/repo", reviewHandle: record.review_handle,
      sanitized: changed }, dependencies(record, calls));
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_publication_retry_conflict");
    assert.deepEqual(calls, []);
  });

  it("rejects a stale reviewed revision before any GitHub write", async () => {
    const record = retained();
    const calls = [];
    const deps = dependencies(record, calls);
    deps.captureRevision = async () => ({
      revision: { ...record.revision, digest: "f".repeat(64) },
    });
    const result = await runPublishReviewResult({
      repoPath: "/repo",
      reviewHandle: record.review_handle,
      sanitized: sanitized(),
    }, deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_revision_stale");
    assert.deepEqual(calls, []);
  });

  it("fails closed when the revision moves during publication capture", async () => {
    const record = retained();
    const calls = [];
    const deps = dependencies(record, calls);
    deps.captureRevision = async () => { throw Object.assign(new Error("moved"), {
      code: "review_revision_changed_during_capture",
    }); };
    const result = await runPublishReviewResult({ repoPath: "/repo",
      reviewHandle: record.review_handle, sanitized: sanitized() }, deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_revision_changed_during_capture");
    assert.deepEqual(calls, []);
  });

  it("rejects publication when another cycle consumed the retained slot", async () => {
    const record = retained();
    const calls = [];
    const deps = dependencies(record, calls);
    deps.readPriorCycleCount = async () => 1;
    const result = await runPublishReviewResult({
      repoPath: "/repo",
      reviewHandle: record.review_handle,
      sanitized: sanitized(),
    }, deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_publication_cycle_stale");
    assert.deepEqual(calls, []);
  });

  it("reconciles trusted partial progress and resumes without duplicate comments", async () => {
    const record = retained();
    const calls = [];
    const deps = dependencies(record, calls);
    deps.readProgress = async () => ({
      ok: true,
      findings: { id: 10, url: null },
      cycle: { id: 11, url: null },
      decision: null,
    });
    deps.readPriorCycleCount = async () => 1;
    const result = await runPublishReviewResult({
      repoPath: "/repo",
      reviewHandle: record.review_handle,
      sanitized: sanitized(),
    }, deps);
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([kind]) => kind), ["decision", "write"]);
    assert.equal(result.receipt.findings_record_id, 10);
    assert.equal(result.receipt.cycle_record_id, 11);
  });

  it("rebuilds the local receipt when all trusted remote stages already exist", async () => {
    const record = retained();
    const calls = [];
    const deps = dependencies(record, calls);
    deps.readProgress = async () => ({
      ok: true,
      findings: { id: 10, url: null },
      cycle: { id: 11, url: null },
      decision: { id: 12, url: null },
    });
    deps.readPriorCycleCount = async () => 1;
    const result = await runPublishReviewResult({
      repoPath: "/repo",
      reviewHandle: record.review_handle,
      sanitized: sanitized(),
    }, deps);
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([kind]) => kind), ["write"]);
    assert.equal(result.receipt.decision_record_id, 12);
  });

  it("resolves a recovered station observation between findings and the cycle marker", async () => {
    const record = retained({
      terminal: {
        ok: true,
        next_action: "fix_findings_then_ask_over_cap_or_proceed",
        station_observation: {
          obligationId: "STATION-OBS-CODEX-REVIEW-C1",
          stationId: "codex_review",
          logicalCycle: 1,
        },
      },
    });
    const calls = [];
    const result = await runPublishReviewResult({
      repoPath: "/repo",
      reviewHandle: record.review_handle,
      sanitized: sanitized(),
    }, dependencies(record, calls));
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(([kind]) => kind), [
      "findings", "reobservation", "cycle", "decision", "write",
    ]);
    assert.equal(result.receipt.reobservation_record_id, 13);
  });

  it("rejects an oversized decision body before posting findings or a cycle", async () => {
    const record = retained({ findings: [{ ...retained().findings[0], classification: "class",
      category: { shape: "Many instances", instances: ["a", "b"] } }] });
    const publicReview = sanitized();
    publicReview.findings[0].classification = "class";
    publicReview.findings[0].instances = Array.from({ length: 500 }, (_, index) =>
      `module-${index}-${"x".repeat(120)}.js:1`);
    const calls = [];
    const result = await runPublishReviewResult({ repoPath: "/repo",
      reviewHandle: record.review_handle, sanitized: publicReview }, dependencies(record, calls));
    assert.equal(result.ok, false);
    assert.equal(result.error, "decision_record_body_too_large");
    assert.deepEqual(calls, []);
  });
});
