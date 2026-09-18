// Issue-thread record tools are pinned to the MCP launch workspace (issue #1583).
//
// Each tool here posts a durable issue-thread or pull-request record, creates or closes an issue,
// or reads a thread with the MCP host's GitHub credentials. A caller naming any other checkout on
// the host must be refused with a structured `<tool>_repo_not_authorized` envelope before a single
// `gh` or `codex` process starts — the recording shims prove nothing was spawned.

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createGitHubIssueFromRequirement,
  runAssertCompletion,
  runCloseIssueAfterMerge,
  runCodexArchitecturePreflight,
  runCodexReview,
  runCodexReviewCycle,
  runCodexVerifyFinding,
  runGetIssueThread,
  runPostDecisionRecord,
  runPostFinalReport,
  runPostImplementationPlan,
  runReconcileStationObservation,
  runReviewCapDisposition,
  verifyAutoDispositionGrant,
} from "./lib.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

function makeRepo(prefix, slug) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["-C", dir, "init", "-q", "--initial-branch", "1583-pinned"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README"), "x\n");
  execFileSync("git", ["-C", dir, "add", "README"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", `https://github.com/${slug}.git`]);
  return dir;
}

// `gh` and `codex` shims that record their argv and fail, so a refusal that leaked past
// the boundary shows up as a recorded invocation rather than a network call.
function makeRecordingBin() {
  const dir = mkdtempSync(join(tmpdir(), "gc-pinned-bin-"));
  const log = join(dir, "invocations.log");
  for (const tool of ["gh", "codex"]) {
    writeFileSync(
      join(dir, tool),
      `#!/bin/sh\nprintf '%s %s\\n' ${tool} "$*" >> ${JSON.stringify(log)}\nexit 1\n`,
      { mode: 0o755 },
    );
  }
  return {
    dir,
    reset: () => writeFileSync(log, ""),
    invocations: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
  };
}

async function withPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

const COMPLETION_PAYLOAD = {
  issueNumber: 1583,
  prNumber: 42,
  requirements: [],
  reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
  ciStatus: "green",
  sonarStatus: "passed",
  plainEnglishOutcome: "Issue-thread records land only in the launch workspace's repository.",
};

// One entry per pinned tool: the MCP tool name, its refusal namespace, and a call with input that
// passes every pre-authorization validation so the refusal is the authorization boundary itself.
const PINNED_SURFACES = [
  {
    tool: "gc_post_decision_record",
    prefix: "decision_record",
    call: (repoPath, opts) => runPostDecisionRecord({ repoPath, issueNumber: 1583, cycle: 1, reviewer: "codex", findings: [] }, opts),
  },
  {
    tool: "gc_post_implementation_plan",
    prefix: "plan",
    call: (repoPath, opts) => runPostImplementationPlan({ repoPath, issueNumber: 1583, planBody: "## Plan\n\nWork." }, opts),
  },
  {
    tool: "gc_close_issue_after_merge",
    prefix: "close",
    call: (repoPath, opts) => runCloseIssueAfterMerge({ repoPath, issueNumber: 1583, prNumber: 42 }, opts),
  },
  {
    tool: "gc_codex_review",
    prefix: "codex_review",
    call: (repoPath, opts) => runCodexReview({ repoPath, uncommitted: true, issueNumber: 1583 }, opts),
  },
  {
    tool: "gc_codex_review_cycle",
    prefix: "codex_review_cycle",
    call: (repoPath, opts) => runCodexReviewCycle({ repoPath, issueNumber: 1583, uncommitted: true }, opts),
  },
  {
    tool: "gc_codex_architecture_preflight",
    prefix: "architecture_preflight",
    call: (repoPath, opts) => runCodexArchitecturePreflight({ repoPath, issueNumber: 1583 }, opts),
  },
  {
    tool: "gc_codex_verify_finding",
    prefix: "codex_verify",
    call: (repoPath, opts) => runCodexVerifyFinding({ repoPath, prNumber: 42, commentId: 7 }, opts),
  },
  {
    tool: "gc_review_cap_disposition",
    prefix: "review_cap_disposition",
    call: (repoPath, opts) => runReviewCapDisposition({ repoPath, issueNumber: 1583, reviewer: "codex", cycle: 1, cap: 1 }, opts),
  },
  {
    tool: "gc_codex_review_cycle auto_grant verification",
    prefix: "verify_auto_disposition",
    call: (repoPath, opts) => verifyAutoDispositionGrant({ repoPath, issueNumber: 1583, reviewer: "codex" }, opts),
  },
  {
    tool: "gc_create_github_issue",
    prefix: "create_issue",
    call: (repoPath, opts) => createGitHubIssueFromRequirement({ uid: "GC-X001", repoRoot: repoPath }, opts),
  },
  {
    tool: "gc_get_issue_thread",
    prefix: "issue_thread",
    call: (repoPath, opts) => runGetIssueThread({ repoPath, issueNumber: 1583 }, opts),
  },
  {
    tool: "gc_post_final_report",
    prefix: "final_report",
    call: (repoPath, opts) => runPostFinalReport({ ...COMPLETION_PAYLOAD, repoPath, lane: "quickfix", reviews: [], summary: "Pinned." }, opts),
  },
  {
    tool: "gc_assert_completion",
    prefix: "completion",
    call: (repoPath, opts) => runAssertCompletion({ ...COMPLETION_PAYLOAD, repoPath, phase: "pre_merge" }, opts),
  },
  {
    tool: "gc_reconcile_station_observation",
    prefix: "station_observation_reconcile",
    call: (repoPath, opts) => runReconcileStationObservation({
      repoPath,
      issueNumber: 1583,
      obligationId: "STATION-OBS-CODEX-REVIEW-C1",
      findingsRecordUrl: "https://github.com/fake/launch/issues/1583#issuecomment-9001",
    }, opts),
  },
];

describe("issue-thread record tools refuse a checkout other than the MCP launch workspace (issue #1583)", () => {
  let launchRepo;
  let otherRepo;
  let bin;

  before(() => {
    launchRepo = makeRepo("gc-pinned-launch-", "fake/launch");
    otherRepo = makeRepo("gc-pinned-other-", "fake/other");
    bin = makeRecordingBin();
  });
  beforeEach(() => bin.reset());
  after(() => {
    for (const dir of [launchRepo, otherRepo, bin.dir]) rmSync(dir, { recursive: true, force: true });
  });

  for (const surface of PINNED_SURFACES) {
    it(`${surface.tool} refuses with ${surface.prefix}_repo_not_authorized and spawns nothing`, async () => {
      const result = await withPath(bin.dir, () =>
        surface.call(otherRepo, { workspaceAuthorizationResolver: workspaceAuthorizationFor(launchRepo) }));
      assert.equal(result.ok, false);
      assert.equal(result.error, `${surface.prefix}_repo_not_authorized`);
      assert.match(result.message, /\(implement_repo_not_authorized\)/);
      assert.equal(result.next_action, "run_from_the_mcp_launch_workspace_and_retry");
      assert.deepEqual(bin.invocations(), []);
    });
  }

  it("the production default resolver binds to the MCP launch workspace, not the caller's checkout", async () => {
    // No resolver injected: the tools run with the identity captured when this process launched.
    const result = await withPath(bin.dir, () =>
      runPostDecisionRecord({ repoPath: otherRepo, issueNumber: 1583, cycle: 1, reviewer: "codex", findings: [] }));
    assert.equal(result.ok, false);
    assert.equal(result.error, "decision_record_repo_not_authorized");
    assert.deepEqual(bin.invocations(), []);
  });

  it("the launch workspace itself passes the boundary and reaches GitHub", async () => {
    const result = await withPath(bin.dir, () =>
      runPostDecisionRecord(
        { repoPath: launchRepo, issueNumber: 1583, cycle: 1, reviewer: "codex", findings: [] },
        { workspaceAuthorizationResolver: workspaceAuthorizationFor(launchRepo) },
      ));
    assert.equal(result.error, "decision_record_post_failed");
    assert.ok(bin.invocations().some((line) => line.startsWith("gh api --method POST /repos/fake/launch/issues/1583/comments")));
  });
});
