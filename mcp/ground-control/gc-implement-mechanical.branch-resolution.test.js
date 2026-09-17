import { _resetAsyncJobsForTest } from "./lib/async-job-registry.js";
import { beforeEach } from "node:test";
beforeEach(_resetAsyncJobsForTest);
// Branch resolution for publish/monitor (issue #1507 shakeout).
//
// The /implement orchestrator hit `branchName is required for action=publish`
// (and again for monitor) because the band contract never told the driver to
// re-declare a branch bootstrap had already created and checked out. The fix
// makes branchName OPTIONAL: derive it from the checkout's current branch when
// omitted, but only when that branch belongs to THIS issue — an explicit
// branchName is still asserted to match, and a base/unrelated branch is refused
// rather than silently pushed or watched.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveIssueBranch } from "./implement/gate-helpers.js";
import { runMonitor, runPublish } from "./implement/publish.js";

const ISSUE_BRANCH = "1507-remove-telemetry-summarizer";

describe("resolveIssueBranch", () => {
  it("accepts an explicit branch that matches the checkout", () => {
    const r = resolveIssueBranch({
      branchName: ISSUE_BRANCH,
      activeBranch: ISSUE_BRANCH,
      issueNumber: 1507,
      action: "publish",
    });
    assert.deepEqual(r, { ok: true, branchName: ISSUE_BRANCH });
  });

  it("refuses an explicit branch that does not match the checkout", () => {
    const r = resolveIssueBranch({
      branchName: ISSUE_BRANCH,
      activeBranch: "some-other-branch",
      issueNumber: 1507,
      action: "publish",
    });
    assert.equal(r.ok, false);
    assert.equal(r.failure.error, "implement_mechanical_branch_mismatch");
  });

  it("derives the branch from the checkout when omitted and it is this issue's branch", () => {
    for (const branchName of [undefined, null, ""]) {
      const r = resolveIssueBranch({
        branchName,
        activeBranch: `  ${ISSUE_BRANCH}\n`,
        issueNumber: 1507,
        action: "monitor",
      });
      assert.deepEqual(r, { ok: true, branchName: ISSUE_BRANCH }, `branchName=${branchName}`);
    }
  });

  it("refuses to derive from a base branch (dev/main)", () => {
    for (const base of ["dev", "main"]) {
      const r = resolveIssueBranch({
        activeBranch: base,
        issueNumber: 1507,
        action: "publish",
      });
      assert.equal(r.ok, false, base);
      assert.equal(r.failure.error, "implement_mechanical_branch_unresolved");
    }
  });

  it("refuses to derive from a detached HEAD (empty active branch)", () => {
    const r = resolveIssueBranch({
      activeBranch: "",
      issueNumber: 1507,
      action: "monitor",
    });
    assert.equal(r.ok, false);
    assert.equal(r.failure.error, "implement_mechanical_branch_unresolved");
  });

  it("refuses to derive from another issue's branch", () => {
    const r = resolveIssueBranch({
      activeBranch: "1234-other-issue",
      issueNumber: 1507,
      action: "publish",
    });
    assert.equal(r.ok, false);
    assert.equal(r.failure.error, "implement_mechanical_branch_unresolved");
  });
});

function execWith(activeBranch) {
  return async (file, argv = []) =>
    file === "git" && argv.includes("--show-current")
      ? { stdout: `${activeBranch}\n`, stderr: "" }
      : { stdout: "", stderr: "" };
}

const passGit = async (repoRoot, argv, commandRunner) =>
  commandRunner("git", argv, { cwd: repoRoot });

describe("runPublish branch derivation", () => {
  it("derives the branch from the checkout when branchName is omitted", async () => {
    const seen = [];
    const result = await runPublish(
      {
        action: "publish",
        repoPath: "/repo",
        issueNumber: 1507,
        // branchName intentionally omitted
        synchronization: {
          record_id: "a".repeat(32),
          pre_sync_sha: "b".repeat(40),
          fetched_base_sha: "c".repeat(40),
          outcome: "merged_clean",
        },
      },
      {
        authorizeRepo: async () => ({ ok: true, repoRoot: "/repo" }),
        getContext: async () => ({ status: "ok", workflow: {} }),
        authorizeRequirementUid: async () => ({ ok: true, requirementUid: null }),
        runGit: passGit,
        execFile: execWith(ISSUE_BRANCH),
        synchronize: async (params) => {
          seen.push(params);
          return { ok: true, status: "complete", recordId: "a".repeat(32) };
        },
        // Publish recovery seams (issue #1495): stubbed so this branch-derivation
        // unit test does not touch a real filesystem lease.
        resolvePublishGitDir: async () => "/repo/.git",
        acquirePublishLock: async () => async () => {},
        reconcileInterruptedPublish: async () => ({ proceed: true }),
        writePublishJournal: () => {},
        removePublishJournal: () => {},
      },
    );
    assert.equal(result.ok, true);
    assert.equal(seen[0].branchName, ISSUE_BRANCH, "synchronize received the derived branch");
  });

  it("refuses to publish when omitted and the checkout is a base branch", async () => {
    const result = await runPublish(
      { action: "publish", repoPath: "/repo", issueNumber: 1507 },
      {
        authorizeRepo: async () => ({ ok: true, repoRoot: "/repo" }),
        getContext: async () => ({ status: "ok", workflow: {} }),
        authorizeRequirementUid: async () => ({ ok: true, requirementUid: null }),
        runGit: passGit,
        execFile: execWith("dev"),
        synchronize: async () => assert.fail("synchronize must not run on an unresolved branch"),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_mechanical_branch_unresolved");
  });
});

describe("runMonitor branch derivation", () => {
  const stubEmitter = { station: async (_name, fn) => { await fn(); } };

  it("watches the authoritative PR head branch when branchName is omitted", async () => {
    let watchedBranch;
    const result = await runMonitor(
      { action: "monitor", repoPath: "/repo", issueNumber: 1507, prNumber: 99 },
      {
        runGit: passGit,
        execFile: execWith(ISSUE_BRANCH),
        emitter: stubEmitter,
        remoteSnapshot: async () => ({ ok: true, head_sha: "a".repeat(40), branch: ISSUE_BRANCH, failures: [], passed: true }),
    monitorSleep: async () => new Promise((resolve) => setImmediate(resolve)),
    watchCi: async ({ branch }) => {
          watchedBranch = branch;
          return { ok: true, conclusion: "success" };
        },
        watchSonar: async () => ({ ok: true, skipped: true }),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(watchedBranch, ISSUE_BRANCH);
  });

  it("refuses when the authoritative PR snapshot is unavailable", async () => {
    let ciRan = false;
    const result = await runMonitor(
      { action: "monitor", repoPath: "/repo", issueNumber: 1507, prNumber: 99 },
      {
        runGit: passGit,
        execFile: execWith("main"),
        emitter: stubEmitter,
        remoteSnapshot: async () => ({ ok: false, error: "remote_gate_evidence_unavailable" }),
    monitorSleep: async () => new Promise((resolve) => setImmediate(resolve)),
    watchCi: async () => { ciRan = true; return { ok: true, conclusion: "success" }; },
        watchSonar: async () => ({ ok: true, skipped: true }),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "remote_gate_evidence_unavailable");
    assert.equal(ciRan, false, "CI must not be watched on an unresolved branch");
  });
});
