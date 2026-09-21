import { _resetAsyncJobsForTest } from "./lib/async-job-registry.js";
import { beforeEach } from "node:test";
beforeEach(_resetAsyncJobsForTest);
// Split from gc-implement-mechanical.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runImplementMechanical } from "./gc-implement-mechanical.js";
import { requestedRequirementUidAuthorization } from "./lib.js";

const SHA_A = "a".repeat(40);

const SHA_B = "b".repeat(40);

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
    // Readiness binds the delivery handoff to the head whose hosted checks it read (#1671).
    readRemoteGates: async () => ({ ok: true, passed: true, state: "OPEN", head_sha: "a".repeat(40) }),
    recordDeliveryReadiness: async () => ({ ok: true, record_comment_id: 4242 }),
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
    // Mechanical-publish recovery seams (issue #1495): stubbed so the publish
    // tests exercise staging/commit/sync without touching a real filesystem lease.
    resolvePublishGitDir: async () => "/repo/.git",
    acquirePublishLock: async () => async () => {},
    reconcileInterruptedPublish: async () => ({ proceed: true }),
    writePublishJournal: () => {},
    removePublishJournal: () => {},
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
  deps.preCommit ??= async (repoRoot, commandRunner, context) =>
    commandRunner(
      "bash",
      ["-c", context?.workflow?.precommit_command ?? "pre-commit run --hook-stage pre-commit"],
      { cwd: repoRoot },
    );
  return deps;
}

function publishExec({ paths = ["src/change.js"] } = {}) {
  const calls = [];
  return {
    calls,
    execFile: async (file, argv) => {
      calls.push([file, ...argv]);
      if (file === "git" && argv.includes("--show-current")) {
        return { stdout: "1426-script-phases\n", stderr: "" };
      }
      if (file === "git" && argv.includes("-z")) {
        if (argv.includes("--cached") || argv.includes("--others")) {
          return { stdout: "", stderr: "" };
        }
        return { stdout: paths.map((path) => `${path}\0`).join(""), stderr: "" };
      }
      if (file === "git" && argv.includes("--cached") && argv.includes("--name-only")) {
        return { stdout: paths.join("\n"), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  };
}

function completionInput() {
  return {
    requirements: [],
    files: { modified: ["src/change.js"] },
    reviews: [{ reviewer: "review-cycle", summary: "passed" }],
    ci_status: "green",
    sonar_status: "passed",
    plain_english_outcome: "Mechanical workflow stages now run without model turns.",
  };
}

describe("runImplementMechanical publish", () => {
  it("refuses an unauthorized checkout before any Git or hook command", async () => {
    let commandCalls = 0;
    const result = await runImplementMechanical({
      action: "publish",
      repoPath: "/other-repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      commitMessage: "feat: automate implement phases",
    }, baseDeps({
      authorizeRepo: async () => ({
        ok: false,
        error: "implement_repo_not_authorized",
        message: "outside the launch workspace",
      }),
      execFile: async () => {
        commandCalls += 1;
        return { stdout: "", stderr: "" };
      },
    }));

    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_repo_not_authorized");
    assert.equal(commandCalls, 0);
  });

  it("refuses an invalid repository context before staging or hooking (#1429)", async () => {
    // The pre-publish hook command comes from .ground-control.yaml, so a
    // broken config must refuse rather than fall through to the default
    // boundary command and publish anyway.
    let commandCalls = 0;
    let preCommitCalls = 0;
    const result = await runImplementMechanical({
      action: "publish",
      repoPath: "/repo",
      issueNumber: 1429,
      branchName: "1426-script-phases",
      commitMessage: "fix: derive the implement policy gate from repository configuration",
    }, baseDeps({
      getContext: async () => ({
        status: "invalid_ground_control_yaml",
        errors: ["workflow.precommit_command must be a non-empty string when set"],
      }),
      execFile: async () => {
        commandCalls += 1;
        return { stdout: "", stderr: "" };
      },
      preCommit: async () => {
        preCommitCalls += 1;
        return { stdout: "" };
      },
    }));

    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_mechanical_context_invalid");
    assert.equal(commandCalls, 0);
    assert.equal(preCommitCalls, 0);
  });

  it("passes the repository context to the pre-commit boundary so its command is configurable (#1429)", async () => {
    const git = publishExec();
    const preCommitArgs = [];
    await runImplementMechanical({
      action: "publish",
      repoPath: "/repo",
      issueNumber: 1429,
      branchName: "1426-script-phases",
      commitMessage: "fix: derive the implement policy gate from repository configuration",
    }, baseDeps({
      execFile: git.execFile,
      getContext: async () => ({
        status: "ok",
        project: "ground-control",
        workflow: {
          base_branch: "dev",
          completion_command: "make check",
          precommit_command: "lefthook run pre-commit",
        },
      }),
      preCommit: async (repoRoot, commandRunner, context) => {
        preCommitArgs.push([repoRoot, context?.workflow?.precommit_command]);
        return { stdout: "" };
      },
      synchronize: async () => ({ ok: true, status: "complete", recordId: RECORD_ID }),
    }));

    assert.deepEqual(preCommitArgs, [["/repo", "lefthook run pre-commit"]]);
  });

  it("carries the requested requirement UID to the pre-commit and synchronization gates (#1434)", async () => {
    const git = publishExec();
    const preCommitUids = [];
    const syncUids = [];
    const result = await runImplementMechanical({
      action: "publish",
      repoPath: "/repo",
      issueNumber: 1434,
      branchName: "1426-script-phases",
      requestedRequirementUid: "GC-O007",
      commitMessage: "fix: carry requirement identity into repository gates",
    }, baseDeps({
      execFile: git.execFile,
      preCommit: async (repoRoot, commandRunner, context, requestedRequirementUid) => {
        preCommitUids.push(requestedRequirementUid);
        return { stdout: "" };
      },
      synchronize: async (input) => {
        syncUids.push(input.requestedRequirementUid);
        return { ok: true, status: "complete", recordId: RECORD_ID };
      },
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(preCommitUids, ["GC-O007"]);
    // Publish reaches synchronization through `start`, whose completion runs the
    // final-tree gates that need the same requirement identity.
    assert.deepEqual(syncUids, ["GC-O007"]);
  });

  for (const [label, uid, expected] of [
    ["an invalid", "DSL-437; rm -rf /", "implement_requested_requirement_uid_invalid"],
    ["an out-of-scope", "OTHER-999", "implement_requested_requirement_uid_out_of_scope"],
  ]) {
    it(`refuses ${label} requirement UID before staging, hooks, or synchronization (#1434)`, async () => {
      const git = publishExec();
      let preCommitCalls = 0;
      let syncCalls = 0;
      const result = await runImplementMechanical({
        action: "publish",
        repoPath: "/repo",
        issueNumber: 1434,
        branchName: "1426-script-phases",
        requestedRequirementUid: uid,
        commitMessage: "fix: carry requirement identity into repository gates",
      }, baseDeps({
        execFile: git.execFile,
        preCommit: async () => {
          preCommitCalls += 1;
          return { stdout: "" };
        },
        synchronize: async () => {
          syncCalls += 1;
          return { ok: true, status: "complete", recordId: RECORD_ID };
        },
      }));

      assert.equal(result.ok, false);
      assert.equal(result.agent_required, true);
      assert.equal(result.error, expected);
      assert.equal(git.calls.length, 0, "no Git command may run before the UID is authorized");
      assert.equal(preCommitCalls, 0);
      assert.equal(syncCalls, 0);
    });
  }

  it("stages, checks, commits, pushes, and completes a clean synchronization", async () => {
    const git = publishExec();
    const syncCalls = [];
    const result = await runImplementMechanical({
      action: "publish",
      repoPath: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      commitMessage: "feat: automate implement phases",
    }, baseDeps({
      execFile: git.execFile,
      synchronize: async (input) => {
        syncCalls.push(input);
        if (input.action === "start") {
          return {
            ok: true,
            status: "merge_ready",
            recordId: RECORD_ID,
            preSyncSha: SHA_A,
            fetchedBaseSha: SHA_B,
            outcome: "merged_clean",
          };
        }
        return { ok: true, status: "complete", recordId: RECORD_ID };
      },
    }));

    assert.equal(result.ok, true);
    assert.equal(result.phase, "publish_complete");
    assert.deepEqual(syncCalls.map(({ action }) => action), ["start", "complete"]);
    assert.equal(
      git.calls.filter(([file, ...argv]) => file === "bash" && argv.includes("pre-commit run --hook-stage pre-commit")).length,
      1,
      "publish owns exactly one explicit hook boundary",
    );
    const commit = git.calls.find(([file, ...argv]) => file === "git" && argv.includes("commit"));
    assert.ok(commit);
    assert.ok(commit.includes("core.hooksPath=/dev/null"), "the following commit must not dispatch installed hooks again");
    assert.ok(git.calls.some(([file, ...argv]) => file === "git" && argv.includes("push")));
  });

  // A credential basename is sensitive as an artifact, not as source code (#1649);
  // a `credential(s)` directory name alone no longer marks a source file sensitive
  // (#1692), but a non-source artifact under one, and a secret directory, still do.
  for (const [path, refused] of [
    [".env.local", true],
    ["config/credentials.json", true],
    // A non-source artifact under a `credentials` directory is still a credential
    // location; a recognized source module under one is ordinary code (#1692).
    ["config/credentials/prod.json", true],
    ["app/credentials/credentials.py", false],
    ["frontend/src/features/credentials/AccessCredentialsPage.tsx", false],
    // A source module inside a secret directory stays sensitive by location.
    ["app/.secret/token_loader.ts", true],
    // A shell script named `credentials.sh` is a credential loader far more often
    // than it is an ordinary module, and `git add -A` would stage it untracked.
    ["scripts/credentials.sh", true],
    ["deploy/credentials.bash", true],
    [".env.example", false],
    ["app/auth/credentials.py", false],
  ]) {
    it(`${refused ? "refuses" : "allows"} '${path}' before staging it`, async () => {
      const git = publishExec({ paths: [path] });
      const result = await runImplementMechanical({
        action: "publish",
        repoPath: "/repo",
        issueNumber: 1426,
        branchName: "1426-script-phases",
        commitMessage: "fix: safe change",
      }, baseDeps({ execFile: git.execFile }));

      assert.equal(result.ok, !refused);
      if (refused) assert.equal(result.error, "implement_mechanical_sensitive_path_present");
      assert.equal(
        git.calls.some(([file, ...argv]) => file === "git" && argv.includes("add")),
        !refused,
      );
    });
  }

  it("still refuses a secret-bearing source module at the scanner boundary (#1649)", async () => {
    const git = publishExec({ paths: ["app/auth/credentials.py"] });
    const result = await runImplementMechanical({
      action: "publish",
      repoPath: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      commitMessage: "fix: safe change",
    }, baseDeps({
      execFile: git.execFile,
      preCommit: async () => {
        throw Object.assign(new Error("secret scan: high-entropy literal in the staged module"), { code: 1 });
      },
    }));

    assert.equal(result.ok, false);
    assert.ok(git.calls.every(([file, ...argv]) => !(file === "git" && argv.includes("push"))));
  });

  it("returns durable retry input on conflict and completes from it after resolution", async () => {
    const git = publishExec();
    const conflict = await runImplementMechanical({
      action: "publish",
      repoPath: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      commitMessage: "feat: automate implement phases",
    }, baseDeps({
      execFile: git.execFile,
      synchronize: async () => ({
        ok: true,
        status: "conflicts",
        recordId: RECORD_ID,
        preSyncSha: SHA_A,
        fetchedBaseSha: SHA_B,
        outcome: "merged_conflicts_resolved",
      }),
    }));

    assert.equal(conflict.agent_required, true);
    assert.deepEqual(conflict.retry_input, {
      record_id: RECORD_ID,
      pre_sync_sha: SHA_A,
      fetched_base_sha: SHA_B,
      outcome: "merged_conflicts_resolved",
    });

    let completionCall;
    const resumed = await runImplementMechanical({
      action: "publish",
      repoPath: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      synchronization: conflict.retry_input,
    }, baseDeps({
      execFile: git.execFile,
      synchronize: async (input) => {
        completionCall = input;
        return { ok: true, status: "complete", recordId: RECORD_ID };
      },
    }));

    assert.equal(resumed.ok, true);
    assert.equal(completionCall.action, "complete");
    assert.equal(completionCall.recordId, RECORD_ID);
  });
});

describe("runImplementMechanical monitor and completion", () => {
  it("waits for CI and Sonar and returns compact successful status", async () => {
    const result = await runImplementMechanical({
      action: "monitor",
      repoPath: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      prNumber: 99,
    }, baseDeps());

    assert.equal(result.ok, true);
    assert.equal(result.ci_status, "green");
    assert.equal(result.sonar_status, "passed");
  });

  it("starts Sonar concurrently with CI and returns an actionable failure", async () => {
    let sonarCalls = 0;
    const result = await runImplementMechanical({
      action: "monitor",
      repoPath: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      prNumber: 99,
    }, baseDeps({
      remoteSnapshot: async () => ({ ok: true, head_sha: "a".repeat(40), branch: "1426-script-phases", failures: [], passed: true }),
    monitorSleep: async () => new Promise((resolve) => setImmediate(resolve)),
    watchCi: async () => ({ ok: true, conclusion: "failure", log_summary: "lint failed" }),
      watchSonar: async () => {
        sonarCalls += 1;
        return { ok: true, skipped: true };
      },
    }));

    assert.equal(result.agent_required, true);
    assert.equal(result.failed_stage, "ci");
    assert.equal(sonarCalls, 1);
  });

  it("runs post-merge close without waiting on additional hosted actions", async () => {
    const calls = [];
    const deps = baseDeps({
      watchCi: async () => { throw new Error("finalize must not wait for post-merge CI"); },
      watchSonar: async () => { throw new Error("finalize must not wait for post-merge Sonar"); },
      assertCompletion: async ({ phase }) => {
        calls.push(phase);
        return { ok: true, readiness_report: "ready", head_sha: "a".repeat(40) };
      },
      closeIssue: async () => {
        calls.push("close");
        return { ok: true, closed: true };
      },
    });
    const readiness = await runImplementMechanical({
      action: "readiness",
      repoPath: "/repo",
      issueNumber: 1426,
      prNumber: 99,
      completion: completionInput(),
    }, deps);
    const finalized = await runImplementMechanical({
      action: "finalize",
      repoPath: "/repo",
      issueNumber: 1426,
      prNumber: 99,
      completion: completionInput(),
    }, deps);

    assert.equal(readiness.ok, true);
    assert.equal(finalized.ok, true);
    assert.deepEqual(calls, ["pre_merge", "post_merge", "close"]);
  });
});
