import { _resetAsyncJobsForTest } from "./lib/async-job-registry.js";
import { beforeEach } from "node:test";
beforeEach(_resetAsyncJobsForTest);
// Re-homed from gc-implement-mechanical.test.js under issue #1473 (async
// mechanical transport) atop the issue #1467 500-LOC split
// (docs/CODING_STANDARDS.md). Test bodies are unchanged; the shared deps
// scaffolding mirrors the sibling runImplementMechanical split files.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gcImplementMechanicalToolHandler } from "./gc-implement-mechanical.js";
import { requestedRequirementUidAuthorization } from "./lib.js";
const RECORD_ID = "c".repeat(32);

function context() {
  return {
    status: "ok",
    project: "ground-control",
    workflow: { base_branch: "dev", completion_command: "make check" },
  };
}

function baseDeps(overrides = {}) {
  const deps = {
    authorizeRepo: async (path) => ({ ok: true, repoRoot: path }),
    getContext: async () => context(),
    prepareBranch: async () => ({
      ok: true,
      repo_path: "/repo",
      branch: "1426-script-phases",
    }),
    getIssueThread: async () => ({
      ok: true,
      title: "Script phases",
      body: "## Requirements\n- GC-O007\n",
      labels: ["enhancement"],
      comments: [],
      url: "https://github.test/issues/1426",
      hash: "thread-hash",
    }),
    getRequirement: async (uid) => ({
      id: `id-${uid}`,
      uid,
      title: "Requirement",
      statement: "The system shall work.",
      status: "DRAFT",
      wave: 1,
    }),
    getTraceabilityByArtifact: async () => [{ id: "link-1" }],
    markPickedUp: async () => ({ ok: true, comment_url: "https://github.test/pickup" }),
    synchronize: async () => ({ ok: true, status: "complete", recordId: RECORD_ID }),
    remoteSnapshot: async () => ({ ok: true, head_sha: "a".repeat(40), branch: "1426-script-phases", failures: [], passed: true }),
    monitorSleep: async () => new Promise((resolve) => setImmediate(resolve)),
    watchCi: async () => ({ ok: true, conclusion: "success" }),
    watchSonar: async () => ({
      ok: true,
      quality_gate: "OK",
      issues_summary: { open_count: 0 },
      hotspots_summary: { open_count: 0 },
    }),
    assertCompletion: async ({ phase }) => ({
      ok: true,
      phase,
      readiness_report: phase === "pre_merge" ? "ready" : undefined,
    }),
    closeIssue: async () => ({ ok: true, closed: true }),
    execFile: async () => ({ stdout: "", stderr: "" }),
  };
  Object.assign(deps, overrides);
  // Mirrors the production wiring: the authorizer binds the requested UID to
  // the same issue thread the rest of the run reads.
  deps.authorizeRequirementUid ??= async ({ requestedRequirementUid }) => {
    const thread = await deps.getIssueThread({});
    return requestedRequirementUidAuthorization(thread.body, requestedRequirementUid);
  };
  deps.runGit ??= async (repoRoot, argv, commandRunner) =>
    commandRunner("git", ["-C", repoRoot, ...argv], { cwd: repoRoot });
  deps.preCommit ??= async (repoRoot, context) =>
    deps.execFile(
      "bash",
      ["-c", context?.workflow?.precommit_command ?? "pre-commit run --hook-stage pre-commit"],
      { cwd: repoRoot },
    );
  return deps;
}

describe("gcImplementMechanicalToolHandler async transport", () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  for (const action of ["publish", "monitor"]) {
    it(`reuses one ${action} job for a repeated idempotent start`, async () => {
      const { _resetAsyncJobsForTest } = await import("./lib.js");
      _resetAsyncJobsForTest();
      const input = {
        action,
        repo_path: "/repo",
        issue_number: 1473,
        async: true,
        idempotency_key: `issue-1473-${action}-attempt-1`,
        ...(action === "publish"
          ? { branch_name: "1426-script-phases", commit_message: "fix: make mechanical work asynchronous" }
          : {}),
        ...(action === "monitor"
          ? { branch_name: "1426-script-phases", pr_number: 99 }
          : {}),
      };
      const deps = {
        ...baseDeps(),
        canonicalizeRepoPath: () => "/repo",
      };
      const first = await gcImplementMechanicalToolHandler(input, deps);
      const duplicate = await gcImplementMechanicalToolHandler(input, deps);
      assert.equal(first.ok, true);
      assert.equal(duplicate.ok, true);
      assert.match(first.job_id, /^job-/);
      assert.equal(duplicate.job_id, first.job_id);
    });
  }

  it("rejects changed mechanical input under one idempotency key", async () => {
    const { _resetAsyncJobsForTest } = await import("./lib.js");
    _resetAsyncJobsForTest();
    const common = {
      action: "publish",
      repo_path: "/repo",
      issue_number: 1473,
      async: true,
      idempotency_key: "issue-1473-verify-conflict",
    };
    const deps = {
      ...baseDeps(),
      canonicalizeRepoPath: () => "/repo",
    };
    const first = await gcImplementMechanicalToolHandler(
      { ...common, requirements: [] },
      deps,
    );
    const conflict = await gcImplementMechanicalToolHandler(
      { ...common, requirements: [{ uid: "GC-1473" }] },
      deps,
    );
    assert.equal(first.ok, true);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "job_idempotency_conflict");
  });

  it("prevents two publish attempts from racing on the same canonical checkout", async () => {
    const { _resetAsyncJobsForTest } = await import("./lib.js");
    _resetAsyncJobsForTest();
    const never = new Promise(() => {});
    const deps = {
      ...baseDeps({
        getContext: async () => never,
      }),
      canonicalizeRepoPath: () => "/canonical/repo",
    };
    const verify = await gcImplementMechanicalToolHandler({
      action: "publish",
      repo_path: "/repo-via-symlink",
      issue_number: 1473,
      async: true,
      idempotency_key: "issue-1473-verify-running",
    }, deps);
    const publish = await gcImplementMechanicalToolHandler({
      action: "publish",
      repo_path: "/canonical/repo",
      issue_number: 1473,
      branch_name: "1473-mechanical-async",
      commit_message: "fix: make mechanical actions asynchronous",
      async: true,
      idempotency_key: "issue-1473-publish-contended",
    }, deps);
    assert.equal(verify.ok, true);
    assert.equal(publish.ok, false);
    assert.equal(publish.error, "job_execution_contended");
    _resetAsyncJobsForTest();
  });

  for (const action of ["bootstrap", "readiness", "finalize"]) {
    it(`refuses async mode for short action ${action}`, async () => {
      const result = await gcImplementMechanicalToolHandler({
        action,
        repo_path: "/repo",
        issue_number: 1473,
        async: true,
        idempotency_key: `issue-1473-${action}-attempt-1`,
      }, {
        ...baseDeps(),
        canonicalizeRepoPath: () => "/repo",
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, "implement_mechanical_async_action_invalid");
      assert.equal(result.agent_required, false);
    });
  }

  it("requires an idempotency key for a background mechanical start", async () => {
    const result = await gcImplementMechanicalToolHandler({
      action: "publish",
      repo_path: "/repo",
      issue_number: 1473,
      async: true,
    }, {
      ...baseDeps(),
      canonicalizeRepoPath: () => "/repo",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_mechanical_idempotency_key_required");
  });

  it("returns a bounded transport failure when the repository path cannot be canonicalized", async () => {
    const result = await gcImplementMechanicalToolHandler({
      action: "publish",
      repo_path: "/missing/repo",
      issue_number: 1473,
      async: true,
      idempotency_key: "issue-1473-invalid-repo",
    }, {
      ...baseDeps(),
      canonicalizeRepoPath: () => {
        throw new Error("missing checkout");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_mechanical_async_repo_invalid");
    assert.equal(result.agent_required, false);
  });

  it("rejects the retired verify action for direct callers", async () => {
    const result = await gcImplementMechanicalToolHandler({
      action: "verify", repo_path: "/repo", issue_number: 1473,
    }, baseDeps());
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_mechanical_action_invalid");
  });
});
