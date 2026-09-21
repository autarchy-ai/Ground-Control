import { _resetAsyncJobsForTest } from "./lib/async-job-registry.js";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runImplementMechanical } from "./gc-implement-mechanical.js";
import {
  SHA_A,
  SHA_B,
  RECORD_ID,
  baseDeps,
  publishExec,
} from "./gc-implement-mechanical.mechanical-fixtures.js";

beforeEach(_resetAsyncJobsForTest);
// Split from gc-implement-mechanical.test.js under issue #1467 for the 500-LOC
// limit (docs/CODING_STANDARDS.md); shared fixtures extracted under #1692. Test
// bodies are unchanged.

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
