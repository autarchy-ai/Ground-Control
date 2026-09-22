import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  _resetAsyncJobsForTest,
  cancelAsyncJob,
  pollAsyncJob,
  runReviewCycleTransport,
  startAsyncJob,
} from "./lib.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function trustedDeps(overrides = {}) {
  return {
    ensureRepo: async () => "/repo",
    canonicalizeRepoPath: (path) => path,
    workspaceAuthorizationResolver: async () => ({ workspaceRoot: "/repo" }),
    authorizeRepo: async () => ({ ok: true, workspaceRoot: "/repo" }),
    assertSafeCheckout: async () => {},
    startJob: startAsyncJob,
    ...overrides,
  };
}

function cycleInput(overrides = {}) {
  return {
    reviewer: "codex",
    repoPath: "/repo",
    issueNumber: 943,
    idempotencyKey: "issue-943-codex-cycle-1",
    asyncMode: undefined,
    cycleInput: {
      repoPath: "/repo",
      issueNumber: 943,
      baseBranch: "dev",
      uncommitted: true,
      overrideCap: false,
      overrideReason: null,
      autoGrant: false,
    },
    ...overrides,
  };
}

describe("review-cycle async transport (issue #943)", () => {
  it("starts asynchronously when async is omitted and preserves the exact terminal envelope", async () => {
    _resetAsyncJobsForTest();
    let resolveReview;
    let runCount = 0;
    const input = cycleInput({
      runCycle: () => {
        runCount += 1;
        return new Promise((resolve) => { resolveReview = resolve; });
      },
    });

    const started = await runReviewCycleTransport(input, trustedDeps());
    assert.equal(started.ok, true);
    assert.equal(started.status, "running");
    assert.equal(started.kind, "codex_review_cycle");
    await flush();
    assert.equal(runCount, 1);

    const envelope = {
      ok: false,
      status: "post_failed",
      next_action: "retry_after_github_recovers",
      findings_summary: { one_off_count: 1, class_count: 0 },
      findings_record_url: "https://github.test/findings",
      decision_record_url: null,
    };
    resolveReview(envelope);
    await flush();
    const done = pollAsyncJob(started.job_id);
    assert.equal(done.status, "done");
    assert.deepEqual(done.result, envelope);
  });

  it("never opens the synchronous path when async=false", async () => {
    _resetAsyncJobsForTest();
    let runCount = 0;
    const result = await runReviewCycleTransport(
      cycleInput({
        asyncMode: false,
        runCycle: async () => {
          runCount += 1;
          return { ok: true };
        },
      }),
      trustedDeps(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_cycle_async_required");
    assert.equal(runCount, 0);
  });

  it("authorizes the canonical repository before an idempotency lookup", async () => {
    _resetAsyncJobsForTest();
    const calls = [];
    const deps = trustedDeps({
      ensureRepo: async () => {
        calls.push("ensure");
        return "/repo-link";
      },
      canonicalizeRepoPath: () => {
        calls.push("canonicalize");
        return "/repo";
      },
      authorizeRepo: async () => {
        calls.push("authorize");
        return { ok: false, error: "implement_repo_not_authorized" };
      },
      startJob: () => {
        calls.push("start");
        throw new Error("must not start");
      },
    });
    const result = await runReviewCycleTransport(
      cycleInput({ runCycle: async () => ({ ok: true }) }),
      deps,
    );
    assert.deepEqual(calls, ["ensure", "canonicalize", "authorize"]);
    assert.equal(result.error, "implement_repo_not_authorized");
  });

  it("rejects invalid transport input before starting a job", async () => {
    _resetAsyncJobsForTest();
    let startCount = 0;
    const result = await runReviewCycleTransport(
      cycleInput({
        reviewer: "unknown",
        runCycle: async () => ({ ok: true }),
      }),
      trustedDeps({
        startJob: () => {
          startCount += 1;
          throw new Error("must not start");
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_cycle_transport_input_invalid");
    assert.equal(startCount, 0);
  });

  it("rejects a repository that cannot be canonicalized before starting a job", async () => {
    _resetAsyncJobsForTest();
    let startCount = 0;
    const result = await runReviewCycleTransport(
      cycleInput({ runCycle: async () => ({ ok: true }) }),
      trustedDeps({
        canonicalizeRepoPath: () => {
          throw new Error("unresolvable repository");
        },
        startJob: () => {
          startCount += 1;
          throw new Error("must not start");
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_cycle_repo_invalid");
    assert.equal(startCount, 0);
  });

  it("rejects unsafe checkout configuration before starting a job", async () => {
    _resetAsyncJobsForTest();
    let startCount = 0;
    const result = await runReviewCycleTransport(
      cycleInput({ runCycle: async () => ({ ok: true }) }),
      trustedDeps({
        assertSafeCheckout: async () => {
          throw new Error("unsafe checkout");
        },
        startJob: () => {
          startCount += 1;
          throw new Error("must not start");
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_cycle_repo_configuration_unsafe");
    assert.equal(startCount, 0);
  });

  it("reuses one running and terminal job for the same retained logical attempt", async () => {
    _resetAsyncJobsForTest();
    let resolveReview;
    let runCount = 0;
    const input = cycleInput({
      runCycle: () => {
        runCount += 1;
        return new Promise((resolve) => { resolveReview = resolve; });
      },
    });

    const first = await runReviewCycleTransport(input, trustedDeps());
    const duplicate = await runReviewCycleTransport(input, trustedDeps());
    assert.equal(duplicate.job_id, first.job_id);
    await flush();
    assert.equal(runCount, 1);

    resolveReview({ ok: true, status: "clean" });
    await flush();
    const terminalDuplicate = await runReviewCycleTransport(input, trustedDeps());
    assert.equal(terminalDuplicate.job_id, first.job_id);
    assert.equal(terminalDuplicate.status, "done");
    assert.deepEqual(terminalDuplicate.result, { ok: true, status: "clean" });
    assert.equal(runCount, 1);
  });

  it("rejects changed normalized input under one key", async () => {
    _resetAsyncJobsForTest();
    const first = await runReviewCycleTransport(
      cycleInput({ runCycle: () => new Promise(() => {}) }),
      trustedDeps(),
    );
    const conflict = await runReviewCycleTransport(
      cycleInput({
        cycleInput: {
          ...cycleInput().cycleInput,
          baseBranch: "main",
        },
        runCycle: async () => ({ ok: true }),
      }),
      trustedDeps(),
    );
    assert.equal(first.ok, true);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "job_idempotency_conflict");
  });

  it("serializes distinct keys within one repo, issue, and reviewer", async () => {
    _resetAsyncJobsForTest();
    const first = await runReviewCycleTransport(
      cycleInput({ runCycle: () => new Promise(() => {}) }),
      trustedDeps(),
    );
    const contended = await runReviewCycleTransport(
      cycleInput({
        idempotencyKey: "issue-943-codex-cycle-other",
        runCycle: async () => ({ ok: true }),
      }),
      trustedDeps(),
    );
    assert.equal(first.ok, true);
    assert.equal(contended.ok, false);
    assert.equal(contended.error, "job_execution_contended");
  });

  it("does not advertise cancellation as rollback", async () => {
    _resetAsyncJobsForTest();
    const started = await runReviewCycleTransport(
      cycleInput({ runCycle: () => new Promise(() => {}) }),
      trustedDeps(),
    );
    const cancelled = cancelAsyncJob(started.job_id);
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error, "job_not_cancellable");
    assert.equal(pollAsyncJob(started.job_id).status, "running");
  });
});
