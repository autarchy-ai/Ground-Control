// The deterministic post-merge executor (issue #1671).
//
// A merged delivery pull request must finish Phase E with no model or agent session. The
// executor is a trigger and an evidence loader: it resolves the issue from a trusted
// pointer, verifies the trusted readiness record against the merged head, and hands the
// recorded payload to the incumbent finalizer. It never validates merge state, requirement
// state, or gates itself — that is the finalizer's job and stays there.
//
// These tests pin the paths the issue's acceptance criteria name: merged, unmerged,
// duplicate delivery, invalid readiness, and a failed finalizer.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAutomatedPhaseE } from "./implement/phase-e-automation.js";

const ISSUE = 1671;
const PR = 1680;
const HEAD = "a".repeat(40);
const MERGE = "c".repeat(40);

const COMPLETION = {
  requirements: [{ uid: "GC-O007", title: "Gated Agentic Development Loop", status: "ACTIVE" }],
  files: { modified: ["mcp/ground-control/lib/delivery-readiness.js"] },
  reviews: [{ reviewer: "codex", summary: "cycle 1" }],
  ci_status: "green",
  sonar_status: "passed",
  plain_english_outcome: "Merging now finishes the workflow on its own.",
};

function deps(overrides = {}) {
  const posted = [];
  const base = {
    posted,
    resolveRepository: async () => ({ ok: true, repoRoot: "/repo", owner: "o", name: "r" }),
    fetchPr: async () => ({
      number: PR,
      state: "MERGED",
      mergedAt: "2026-09-20T09:00:00Z",
      headRefOid: HEAD,
      baseRefName: "dev",
      mergeCommit: { oid: MERGE },
    }),
    readPointer: async () => ({ ok: true, pointer: { issue: ISSUE, pr: PR, record: 500 } }),
    readReadiness: async () => ({
      ok: true,
      record: { version: 1, lane: "implement", head: HEAD, commentId: 500, payload: COMPLETION },
    }),
    // The shape `runCloseIssueAfterMerge` actually returns: it reports whether it had to
    // act, never a `closed` field (issue #1683).
    finalize: async () => ({
      ok: true, action: "finalize", phase: "closed", close: { ok: true, already_closed: false },
    }),
    readComments: async () => [],
    postComment: async (_repoRoot, _owner, _name, number, body) => {
      posted.push({ number, body });
      return { id: 900, html_url: "https://github.test/c/900" };
    },
  };
  return { ...base, ...overrides, posted: overrides.posted ?? posted };
}

describe("automated Phase E", () => {
  it("replays the recorded payload through the incumbent finalizer", async () => {
    let seen;
    const d = deps({ finalize: async (input) => { seen = input; return { ok: true, phase: "closed" }; } });
    const result = await runAutomatedPhaseE({ repoPath: "/repo", prNumber: PR, automationRunId: 7 }, d);

    assert.equal(result.ok, true);
    assert.equal(result.status, "finalized");
    assert.equal(result.issue_number, ISSUE);
    assert.equal(seen.action, "finalize");
    assert.equal(seen.issueNumber, ISSUE);
    assert.equal(seen.prNumber, PR);
    assert.equal(seen.lane, "implement");
    assert.deepEqual(seen.completion, COMPLETION);
    // The run id is provenance the close gate verifies; it must reach the finalizer.
    assert.equal(seen.automationRunId, 7);
    assert.equal(d.posted.length, 0);
  });

  it("carries the quickfix lane through unchanged", async () => {
    let seen;
    const d = deps({
      readReadiness: async () => ({
        ok: true,
        record: { version: 1, lane: "quickfix", head: HEAD, commentId: 500, payload: { ...COMPLETION, requirements: [] } },
      }),
      finalize: async (input) => { seen = input; return { ok: true, phase: "closed" }; },
    });
    const result = await runAutomatedPhaseE({ repoPath: "/repo", prNumber: PR }, d);
    assert.equal(result.ok, true);
    assert.equal(seen.lane, "quickfix");
  });

  it("refuses a pull request that is not merged, and records nothing", async () => {
    const d = deps({
      fetchPr: async () => ({ number: PR, state: "CLOSED", mergedAt: null, headRefOid: HEAD }),
      finalize: async () => assert.fail("finalize must not run for an unmerged pull request"),
    });
    const result = await runAutomatedPhaseE({ repoPath: "/repo", prNumber: PR }, d);
    assert.equal(result.ok, false);
    assert.equal(result.error, "phase_e_pr_not_merged");
    assert.equal(d.posted.length, 0);
  });

  it("treats a pull request with no delivery pointer as none of its business", async () => {
    const d = deps({
      readPointer: async () => ({ ok: false, error: "delivery_pointer_missing", message: "no pointer" }),
      finalize: async () => assert.fail("finalize must not run without a delivery pointer"),
    });
    const result = await runAutomatedPhaseE({ repoPath: "/repo", prNumber: PR }, d);
    assert.equal(result.ok, true);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "delivery_pointer_missing");
    assert.equal(d.posted.length, 0);
  });

  it("refuses a readiness record bound to a head other than the merged one", async () => {
    const d = deps({
      readReadiness: async () => ({ ok: false, error: "delivery_readiness_head_mismatch", message: "stale head" }),
      finalize: async () => assert.fail("finalize must not replay a stale payload"),
    });
    const result = await runAutomatedPhaseE({ repoPath: "/repo", prNumber: PR }, d);
    assert.equal(result.ok, false);
    assert.equal(result.error, "delivery_readiness_head_mismatch");
    // Invalid readiness is still bound to a known issue, so it leaves a durable record.
    assert.equal(d.posted.length, 1);
    assert.equal(d.posted[0].number, ISSUE);
  });

  it("leaves one durable, reviewable record when the finalizer refuses, and does not close", async () => {
    const d = deps({
      finalize: async () => ({
        ok: false,
        error: "completion_requirement_state_unverified",
        message: "GC-O007 is DRAFT at the merge revision",
        next_action: "align_requirement_files_in_the_pr_and_remerge_or_post_a_trusted_override",
      }),
    });
    const result = await runAutomatedPhaseE({ repoPath: "/repo", prNumber: PR }, d);

    assert.equal(result.ok, false);
    assert.equal(result.error, "completion_requirement_state_unverified");
    assert.equal(d.posted.length, 1);
    const body = d.posted[0].body;
    assert.match(body, /gc:delivery-finalization-failed/);
    assert.match(body, /completion_requirement_state_unverified/);
    assert.match(body, new RegExp(`pr="${PR}"`));
  });

  it("does not repeat an identical failure record on replay", async () => {
    const first = deps({
      finalize: async () => ({ ok: false, error: "completion_pr_not_merged", message: "not merged yet" }),
    });
    await runAutomatedPhaseE({ repoPath: "/repo", prNumber: PR }, first);
    const existing = first.posted[0].body;

    const replay = deps({
      finalize: async () => ({ ok: false, error: "completion_pr_not_merged", message: "not merged yet" }),
      readComments: async () => [{ id: 900, body: existing, authorLogin: "github-actions[bot]" }],
    });
    const result = await runAutomatedPhaseE({ repoPath: "/repo", prNumber: PR }, replay);
    assert.equal(result.ok, false);
    assert.equal(replay.posted.length, 0);
  });

  // The envelope is what a maintainer reads when a run looks wrong, so it has to describe
  // the terminal state, not whether this particular call did the closing. The first live
  // finalization reported `closed: false` on an issue it had just closed (issue #1683).
  it("reports the issue as closed whether this run closed it or found it closed", async () => {
    for (const close of [{ ok: true, already_closed: false }, { ok: true, already_closed: true }]) {
      const d = deps({ finalize: async () => ({ ok: true, phase: "closed", close }) });
      const result = await runAutomatedPhaseE({ repoPath: "/repo", prNumber: PR }, d);
      assert.equal(result.ok, true);
      assert.equal(result.closed, true, JSON.stringify(close));
    }
  });

  it("converges on the closed issue when the delivery was already reported", async () => {
    const d = deps({
      finalize: async () => ({
        ok: true,
        phase: "closed",
        completion: { already_reported: true },
        close: { already_closed: true },
      }),
    });
    const result = await runAutomatedPhaseE({ repoPath: "/repo", prNumber: PR }, d);
    assert.equal(result.ok, true);
    assert.equal(result.status, "finalized");
    assert.equal(d.posted.length, 0);
  });

  it("never spends the host's credentials on an unauthorized checkout", async () => {
    const d = deps({
      resolveRepository: async () => ({ ok: false, error: "implement_repo_not_authorized", message: "outside" }),
      fetchPr: async () => assert.fail("no GitHub read before the repository is authorized"),
    });
    const result = await runAutomatedPhaseE({ repoPath: "/elsewhere", prNumber: PR }, d);
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_repo_not_authorized");
  });

  it("rejects a pull-request number that is not a positive integer", async () => {
    const d = deps({ resolveRepository: async () => assert.fail("validate the input first") });
    const result = await runAutomatedPhaseE({ repoPath: "/repo", prNumber: 0 }, d);
    assert.equal(result.ok, false);
    assert.equal(result.error, "phase_e_pr_number_invalid");
  });
});

describe("automation run provenance reaches the record", () => {
  it("threads the finalizer's run id from the executor to the rendered marker", async () => {
    const { mapCompletion } = await import("./lib/completion-mapping.js");
    const { buildFinalReport } = await import("./lib.js");
    const mapped = mapCompletion(
      { repoPath: "/repo", issueNumber: ISSUE, prNumber: PR, lane: "implement", automationRunId: 7, completion: COMPLETION },
      "post_merge",
    );
    assert.equal(mapped.automationRunId, 7);
    const body = buildFinalReport({ ...mapped, phase: "post_merge" });
    assert.match(body, new RegExp(`<!-- gc:final-report issue="${ISSUE}" pr="${PR}" -->`));
    assert.match(body, new RegExp(`<!-- gc:finalizer-run pr="${PR}" id="7" -->`));
  });

  it("omits the run attribute entirely when a human posts the report", async () => {
    const { mapCompletion } = await import("./lib/completion-mapping.js");
    const { buildFinalReport } = await import("./lib.js");
    const mapped = mapCompletion(
      { repoPath: "/repo", issueNumber: ISSUE, prNumber: PR, lane: "implement", completion: COMPLETION },
      "post_merge",
    );
    const body = buildFinalReport({ ...mapped, phase: "post_merge" });
    assert.match(body, new RegExp(`<!-- gc:final-report issue="${ISSUE}" pr="${PR}" -->`));
    assert.ok(!body.includes("gc:finalizer-run"), "a human-authored report carries no run provenance");
  });
});
