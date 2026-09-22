import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildExecutionObligationV2Marker,
  buildReviewRevision,
  createReviewResult,
  runPublishReviewResult,
  validateReviewResult,
} from "./lib.js";

function retainedFailure() {
  return createReviewResult({
    kind: "non_verdict",
    repositoryId: "fake/repo",
    issueNumber: 1632,
    reviewer: "codex",
    expectedCycle: 1,
    cap: 1,
    branch: "1632-review-failure",
    baseBranch: "dev",
    revision: buildReviewRevision({
      headOid: "a".repeat(40),
      candidateTreeOid: "d".repeat(40), baseOid: "b".repeat(40),
      diffText: "diff", manifest: "manifest",
    }),
    coverage: { complete: false },
    findings: [],
    notes: [],
    terminal: { ok: false, error: "review_coverage_incomplete",
      attempts: [1, 2].map((ordinal) => ({ station_id: "codex_review",
        station_result: "not_evaluable", failure_class: "incomplete_reviewer_coverage",
        attempt_ordinal: ordinal })) },
    publicationStatus: "unpublished_failure",
  });
}

function harness({ escalationFailsOnce = false, stale = false } = {}) {
  let record = retainedFailure();
  const calls = [];
  const comments = [];
  let escalationFailures = escalationFailsOnce ? 1 : 0;
  const marker = (event) => buildExecutionObligationV2Marker({
    issueNumber: 1632, obligationId: "STATION-OBS-CODEX-REVIEW-C1",
    event, kind: "station_observation", stationId: "codex_review", logicalCycle: 1,
  });
  const addComment = (event) => {
    const id = event === "opened" ? 10 : 11;
    comments.push({ id, body: marker(event), authorLogin: "bot" });
    return { ok: true, url: `https://github.com/fake/repo/issues/1632#issuecomment-${id}` };
  };
  const deps = {
    resolveRepository: async () => ({ ok: true, repoRoot: "/repo", owner: "fake", name: "repo" }),
    readIdentity: async () => ({ gitDir: "/repo/.git" }),
    readResult: () => ({ ok: true, record }),
    acquireLock: async () => async () => {},
    failureDependencies: {
      captureRevision: async () => {
        if (!stale) return { revision: record.revision };
        return { revision: { ...record.revision, ...(stale === true ? { digest: "f".repeat(64) } : stale) } };
      },
      readPriorCycleCount: async () => 0,
      readComments: async () => [...comments],
      resolveTrust: async () => ({ isTrusted: () => true }),
      postOpened: async (args) => {
        calls.push(["opened", args.failureClass, args.attemptOrdinal]);
        return addComment("opened");
      },
      postEscalation: async (args) => {
        calls.push(["escalated", args.failureClasses, args.attemptCount]);
        if (escalationFailures-- > 0) return { ok: false, message: "transient post failure" };
        return addComment("escalated");
      },
      writeResult: (_dir, next) => { calls.push(["write", next.publication_status]); record = next; },
    },
  };
  const publish = (overrides = {}) => runPublishReviewResult({
    repoPath: "/repo", reviewHandle: record.review_handle, publicationKind: "non_verdict",
    ...overrides,
  }, deps);
  return { publish, calls, comments, getRecord: () => record };
}

describe("separate non-verdict review publication (#1632)", () => {
  it("accepts only a closed-code failure kind with bounded attempt ordinals", () => {
    const record = retainedFailure();
    assert.equal(validateReviewResult(record).ok, true);
    record.terminal.attempts[1].failure_class = "raw engine traceback";
    assert.equal(validateReviewResult(record).error, "review_result_digest_mismatch");
    const invalid = createReviewResult;
    assert.throws(() => invalid({
      kind: "non_verdict", repositoryId: "fake/repo", issueNumber: 1632,
      reviewer: "codex", expectedCycle: 1, cap: 1, branch: "1632-review-failure",
      baseBranch: "dev", revision: retainedFailure().revision, coverage: {},
      findings: [], terminal: { attempts: [{ station_id: "codex_review",
        station_result: "not_evaluable", failure_class: "raw stderr", attempt_ordinal: 1 }] },
      publicationStatus: "unpublished_failure",
    }), /review_result_failure_invalid/);
  });

  it("publishes only opened and escalated station records, without consuming a cycle", async () => {
    const h = harness();
    const result = await h.publish();
    assert.equal(result.ok, true);
    assert.equal(result.publication_status, "published_failure");
    assert.equal(result.cycle, null);
    assert.equal(result.next_action, "escalate_unobserved_station_under_hard_external_dependency");
    assert.deepEqual(h.calls.map(([kind]) => kind), ["opened", "escalated", "write"]);
    assert.deepEqual(h.calls[0].slice(1), ["incomplete_reviewer_coverage", 1]);
    assert.deepEqual(h.calls[1].slice(1), [
      ["incomplete_reviewer_coverage", "incomplete_reviewer_coverage"], 2,
    ]);
    const retry = await h.publish();
    assert.equal(retry.already_published, true);
    assert.equal(h.calls.length, 3);
  });

  it("reconciles a partial remote write instead of duplicating the opening", async () => {
    const h = harness({ escalationFailsOnce: true });
    const first = await h.publish();
    assert.equal(first.error, "review_failure_escalation_failed");
    const second = await h.publish();
    assert.equal(second.ok, true);
    assert.deepEqual(h.calls.map(([kind]) => kind), ["opened", "escalated", "escalated", "write"]);
    assert.equal(h.comments.length, 2);
  });

  it("rejects stale input and reviewer-prose injection before a remote write", async () => {
    const h = harness({ stale: true });
    const stale = await h.publish();
    assert.equal(stale.error, "review_revision_stale");
    assert.deepEqual(h.calls, []);
    const wrongKind = await h.publish({ sanitized: { architectural_read: "caller text" } });
    assert.equal(wrongKind.error, "review_publication_wrong_kind");
    assert.deepEqual(h.calls, []);
  });

  it("names base and candidate-tree drift with the verdict path's semantics (#1694)", async () => {
    for (const [change, cause] of [[{ base_oid: "f".repeat(40) }, "base_moved"],
      [{ candidate_tree_oid: "e".repeat(40) }, "candidate_changed"]]) {
      const h = harness({ stale: change });
      const stale = await h.publish();
      assert.equal(stale.error, "review_revision_stale");
      assert.equal(stale.stale_cause, cause);
      assert.equal(stale.next_action, "rerun_review_on_current_revision");
      assert.deepEqual(h.calls, []);
    }
  });

  it("holds the publication lock until non-verdict publication finishes", async () => {
    const record = retainedFailure();
    const events = [];
    let finishPublication;
    const publicationGate = new Promise((resolve) => { finishPublication = resolve; });
    const pending = runPublishReviewResult({ repoPath: "/repo",
      reviewHandle: record.review_handle, publicationKind: "non_verdict" }, {
      resolveRepository: async () => ({ ok: true, repoRoot: "/repo", owner: "fake", name: "repo" }),
      readIdentity: async () => ({ gitDir: "/repo/.git" }),
      readResult: () => ({ ok: true, record }),
      acquireLock: async () => () => { events.push("released"); },
      publishFailure: async () => { events.push("started"); await publicationGate;
        events.push("finished"); return { ok: true }; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["started"]);
    finishPublication();
    assert.equal((await pending).ok, true);
    assert.deepEqual(events, ["started", "finished", "released"]);
  });
});
