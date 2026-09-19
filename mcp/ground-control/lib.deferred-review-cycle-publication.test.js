import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCodexReview, runCodexReviewCycle, runGetReviewResult } from "./lib.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";
import { makeFullShimRepo, withShimPathFull } from "./review-shim.test-helpers.js";

describe("deferred review and cycle publication (hermetic codex+gh shims)", () => {
  it("deferred mode retains a locally inspectable clean result without any GitHub mutation", async () => {
    const shim = makeFullShimRepo({
      branch: "1632-deferred-review",
      ghHandler: {
        routes: [
          {
            argv_prefix: ["repo", "view", "--json", "nameWithOwner"],
            stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
          },
          {
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: JSON.stringify([[]]),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            exit_code: 99,
            stderr: "TEST_FAILURE: deferred review must not mutate GitHub\n",
          },
        ],
      },
      codexHandler: { tail: "Clean review.\n\n===REVIEW===\n{\"verdict\":\"ship\",\"architectural_read\":\"Reviewed locally.\",\"blocking\":[]}\n===END===\n" },
    });

    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
          issueNumber: 1632,
          publicationMode: "deferred",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, true);
        assert.equal(result.publication_status, "unpublished");
        assert.match(result.review_handle, /^rvw_[0-9a-f]{48}$/);
        assert.match(result.revision.digest, /^[0-9a-f]{64}$/);
        assert.equal(result.review_coverage.complete, true);
        assert.deepEqual(result.findings, []);
        assert.equal(result.cycle, null, "local execution does not consume the cycle");
        assert.equal(result.expected_cycle, 1);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("the deferred cycle wrapper does not post a decision or station record", async () => {
    const shim = makeFullShimRepo({
      branch: "1632-deferred-cycle",
      ghHandler: {
        routes: [
          {
            argv_prefix: ["repo", "view", "--json", "nameWithOwner"],
            stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
          },
          {
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: JSON.stringify([[]]),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            exit_code: 99,
            stderr: "TEST_FAILURE: deferred cycle must not mutate GitHub\n",
          },
        ],
      },
      codexHandler: { tail: "Clean review.\n\n===REVIEW===\n{\"verdict\":\"ship\",\"architectural_read\":\"Reviewed locally.\",\"blocking\":[]}\n===END===\n" },
    });
    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReviewCycle({
          repoPath: shim.repoDir,
          issueNumber: 1632,
          uncommitted: true,
          publicationMode: "deferred",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, true);
        assert.equal(result.publication_status, "unpublished");
        assert.equal(result.cycle, null);
        assert.equal(result.expected_cycle, 1);
        assert.match(result.review_handle, /^rvw_/);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("retains incomplete deferred coverage for diagnosis without publishing it", async () => {
    const shim = makeFullShimRepo({
      branch: "1632-deferred-incomplete",
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: JSON.stringify([[]]) },
          { argv_prefix: ["api", "--method", "POST"], exit_code: 99, stderr: "TEST_FAILURE: incomplete deferred review must not mutate GitHub\n" },
        ],
      },
      codexHandler: { tail: "Reviewer failed before producing a structured envelope.\n" },
    });
    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
          issueNumber: 1632,
          publicationMode: "deferred",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, false);
        assert.equal(result.error, "review_coverage_incomplete");
        assert.equal(result.publication_status, "not_publishable");
        assert.deepEqual(result.failure_causes, ["missing_tail"]);
        assert.match(result.review_handle, /^rvw_/);
        assert.equal(result.review_coverage.complete, false);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("does not open failure records when every deferred cycle attempt is non-evaluable", async () => {
    const shim = makeFullShimRepo({
      branch: "1632-deferred-nonverdict",
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: JSON.stringify([[]]) },
          { argv_prefix: ["api", "--method", "POST"], exit_code: 99, stderr: "TEST_FAILURE: deferred non-verdict must not mutate GitHub\n" },
        ],
      },
      codexHandler: { tail: "No structured verdict.\n" },
    });
    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReviewCycle({
          repoPath: shim.repoDir,
          issueNumber: 1632,
          uncommitted: true,
          publicationMode: "deferred",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, false);
        assert.equal(result.publication_status, "unpublished_failure");
        assert.equal(result.result_kind, "non_verdict");
        assert.deepEqual(result.failure_causes, ["missing_tail"]);
        assert.deepEqual(result.station_attempts.map((attempt) => attempt.attempt_ordinal), [1, 2]);
        assert.equal(result.next_action, "publish_non_verdict_failure");
        assert.match(result.review_handle, /^rvw_/);
        const retained = await runGetReviewResult({ repoPath: shim.repoDir,
          reviewHandle: result.review_handle },
        { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.deepEqual(retained.failure_causes, ["missing_tail"]);
        assert.equal(result.cycle, null);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("automatic exhausted non-verdict uses the separate station publisher without a cycle marker", async () => {
    const shim = makeFullShimRepo({
      branch: "1632-automatic-station-failure",
      ghHandler: { routes: [
        { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
        { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: JSON.stringify([[]]) },
        { argv_prefix: ["api", "/repos/fake/repo/issues/1632/comments"],
          stdout: "https://github.com/fake/repo/issues/1632#issuecomment-999\n" },
      ] },
      codexHandler: { tail: "No structured verdict.\n" },
    });
    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReviewCycle({
          repoPath: shim.repoDir, issueNumber: 1632, uncommitted: true,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.publication_status, "published_failure");
        assert.equal(result.cycle, null);
        assert.equal(result.station_attempts.length, 2);
        assert.equal(result.next_action, "escalate_unobserved_station_under_hard_external_dependency");
      });
    } finally {
      shim.cleanup();
    }
  });

  it("automatic cycle mode composes deferred execution with canonical publication", async () => {
    const shim = makeFullShimRepo({
      branch: "1632-automatic-composition",
      ghHandler: {
        routes: [
          {
            argv_prefix: ["repo", "view", "--json", "nameWithOwner"],
            stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
          },
          {
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: JSON.stringify([[]]),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            stdout: JSON.stringify({ id: 999, html_url: "https://example.test/c/999" }),
          },
        ],
      },
      codexHandler: { tail: "Clean review.\n\n===REVIEW===\n{\"verdict\":\"ship\",\"architectural_read\":\"Reviewed through the shared path.\",\"blocking\":[]}\n===END===\n" },
    });
    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReviewCycle({
          repoPath: shim.repoDir,
          issueNumber: 1632,
          uncommitted: true,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, true);
        assert.equal(result.publication_status, "published");
        assert.equal(result.status, "clean");
        assert.equal(result.cycle, 1);
        assert.match(result.review_handle, /^rvw_/);
        assert.match(result.receipt.publication_id, /^[0-9a-f]{64}$/);
        assert.equal(result.next_action, "post_clean_decision_record_and_advance_to_phase_c");
      });
    } finally {
      shim.cleanup();
    }
  });

  it("automatic verdict cycle preserves the retained handle after publication refusal", async () => {
    const shim = makeFullShimRepo({
      branch: "1632-automatic-verdict-refusal",
      ghHandler: { routes: [
        { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
        { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: JSON.stringify([[]]) },
      ] },
      codexHandler: { tail: '===REVIEW===\n{"verdict":"ship","architectural_read":"Reviewed.","blocking":[]}\n===END===\n' },
    });
    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReviewCycle({ repoPath: shim.repoDir, issueNumber: 1632,
          uncommitted: true }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir),
          reviewPublisher: async () => ({ ok: false, error: "decision_record_post_failed" }) });
        assert.equal(result.ok, false);
        assert.match(result.review_handle, /^rvw_/);
        assert.equal(result.publication_kind, "verdict");
        assert.equal(result.next_action, "retry_review_publication");
      });
    } finally { shim.cleanup(); }
  });

  it("automatic non-verdict cycle preserves the retained handle after publication throws", async () => {
    const shim = makeFullShimRepo({
      branch: "1632-automatic-failure-throw",
      ghHandler: { routes: [
        { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
        { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: JSON.stringify([[]]) },
      ] },
      codexHandler: { tail: "No structured verdict.\n" },
    });
    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReviewCycle({ repoPath: shim.repoDir, issueNumber: 1632,
          uncommitted: true }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir),
          reviewPublisher: async () => { throw new Error("post failed"); } });
        assert.equal(result.ok, false);
        assert.match(result.review_handle, /^rvw_/);
        assert.equal(result.publication_kind, "non_verdict");
        assert.equal(result.next_action, "retry_review_publication");
      });
    } finally { shim.cleanup(); }
  });

  it("retains aggregate verdict and notes and publishes finding-bearing automatic cycles", async () => {
    const tail = `===REVIEW===
${JSON.stringify({
  verdict: "ship-with-fixes",
  architectural_read: "The change has one repairable finding.",
  blocking: [{ path: "README", line: 1, title: "Repair this finding", body: "A real finding.",
    classification: "one-off", sweep_evidence: "Adjacent inputs were checked." }],
  notes: [{ text: "Keep the revised boundary documented." }],
})}
===END===
`;
    const shim = makeFullShimRepo({
      branch: "1632-finding-bearing-composition",
      ghHandler: { routes: [
        { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
        { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: JSON.stringify([[]]) },
        { argv_prefix: ["api", "--method", "POST"], stdout: JSON.stringify({ id: 999,
          html_url: "https://github.com/fake/repo/issues/1632#issuecomment-999" }) },
      ] },
      codexHandler: { tail },
    });
    try {
      await withShimPathFull(shim.binDir, async () => {
        const authorization = workspaceAuthorizationFor(shim.repoDir);
        const result = await runCodexReviewCycle({
          repoPath: shim.repoDir, issueNumber: 1632, uncommitted: true,
        }, { workspaceAuthorizationResolver: authorization });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.publication_status, "published");
        assert.equal(result.findings_summary.one_off_count, 2);
        const retained = await runGetReviewResult({ repoPath: shim.repoDir,
          reviewHandle: result.review_handle }, { workspaceAuthorizationResolver: authorization });
        assert.equal(retained.ok, true);
        assert.equal(retained.verdict, "ship-with-fixes");
        assert.deepEqual(retained.notes.map((note) => note.text), [
          "[core] Keep the revised boundary documented.",
          "[security] Keep the revised boundary documented.",
        ]);
      });
    } finally {
      shim.cleanup();
    }
  });
});
