// Split from gc-implement-base-sync.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { execFile as execFileCb } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REQUIREMENT_UID_GATE_ENV_VAR, runSynchronizeImplementBranch } from "./lib.js";

const execFile = promisify(execFileCb);

const REPO_ROOT = realpathSync(new URL("../..", import.meta.url).pathname);

const ISSUE = 1421;

const BRANCH = "1421-merge-dev-before-pr";

const PRE = "1".repeat(40);

const BASE = "2".repeat(40);

const RESULT = "3".repeat(40);

const RECORD = "4".repeat(32);

const TREE = "5".repeat(40);

// Issue #1679: synchronization is where a delivery is bound to the review that
// authorized it. A zero-finding review authorizes exactly the tree it read, so
// the fixture names that tree; the lane comes from the run's pickup record.
const REVIEW_EVIDENCE = {
  ok: true,
  published: true,
  cycle: 1,
  comment_id: 12,
  publication_id: "a".repeat(64),
  revision_digest: "c".repeat(64),
  candidate_tree_oid: TREE,
  findings_count: 0,
  branch: BRANCH,
};
const deliveryBindingDeps = {
  reviewEvidenceReader: async () => REVIEW_EVIDENCE,
  laneReader: async () => ({ ok: true, lane: "implement" }),
  // No earlier synchronization on this branch; the settlement is derived fresh.
  latestSyncRecordReader: async () => ({ ok: true, record: null }),
};

async function workspaceAuthorization() {
  const [gitDir, gitCommonDir, origin] = await Promise.all([
    execFile("git", ["-C", REPO_ROOT, "rev-parse", "--absolute-git-dir"]),
    execFile("git", ["-C", REPO_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    execFile("git", ["-C", REPO_ROOT, "remote", "get-url", "origin"]),
  ]);
  return {
    workspaceRoot: REPO_ROOT,
    gitDir: realpathSync(gitDir.stdout.trim()),
    gitCommonDir: realpathSync(gitCommonDir.stdout.trim()),
    origin: origin.stdout.trim(),
    owner: "autarchy-ai",
    name: "ground-control",
  };
}

function context(baseBranch = "dev", workflowOverrides = {}) {
  return {
    status: "ok",
    workflow: {
      base_branch: baseBranch,
      completion_command: "make check",
      policy_command: "make policy",
      pr_title: null,
      ...workflowOverrides,
    },
  };
}

// Drives `action=complete` down the fresh-merge path (MERGE_HEAD present,
// dirty tree) so a test can observe exactly which repository commands the
// final-tree boundary executes.
function completeRunner({ failCommand = null } = {}) {
  const calls = [];
  let committed = false;
  const runner = async (command, args, options) => {
    calls.push([command, args, options]);
    if (command === "bash") {
      if (failCommand != null && args[1] === failCommand) {
        const error = new Error(`${failCommand} failed`);
        error.stderr = "gate failed";
        throw error;
      }
      return { stdout: "" };
    }
    if (command === "make") return { stdout: "" };
    if (command === "gh") {
      return {
        stdout: JSON.stringify({
          id: 101,
          html_url: "https://github.com/autarchy-ai/Ground-Control/issues/1421#issuecomment-101",
        }),
      };
    }
    const op = gitOperation(args);
    if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
    if (op[0] === "status") return { stdout: "M  file.txt\n" };
    if (op[0] === "rev-parse") {
      const ref = op[op.length - 1];
      if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
      if (ref.startsWith("MERGE_HEAD")) return { stdout: `${BASE}\n` };
      return { stdout: `${committed ? RESULT : PRE}\n` };
    }
    if (op[0] === "write-tree") return { stdout: `${TREE}\n` };
    if (op[0] === "ls-files") return { stdout: "" };
    if (op[0] === "commit") {
      committed = true;
      return { stdout: "" };
    }
    if (op[0] === "push") return { stdout: "" };
    if (op[0] === "show") return { stdout: `${PRE} ${BASE}\n` };
    if (op[0] === "ls-remote") return { stdout: `${RESULT}\trefs/heads/${BRANCH}\n` };
    throw new Error(`unexpected git operation: ${op.join(" ")}`);
  };
  return { calls, runner };
}

// The issue Requirements section is the server-side binding for a requested
// requirement identity (issue #1434).
function requirementsThreadReader(body = "## Requirements\n- DSL-437\n") {
  return async () => ({ ok: true, body });
}

function completeInput() {
  return {
    repoPath: REPO_ROOT,
    issueNumber: ISSUE,
    branchName: BRANCH,
    action: "complete",
    recordId: RECORD,
    preSyncSha: PRE,
    fetchedBaseSha: BASE,
    outcome: "merged_clean",
  };
}

function gitOperation(args) {
  const marker = args.indexOf("-C");
  return args.slice(marker + 2);
}

describe("pre-PR implement synchronization", () => {

  it("synchronizes a requirement-scoped issue without running local gates", async () => {
    // A branch named for the issue number carries no UID to pass, so the gate
    // would otherwise fail requirement-context-missing. The issue's single
    // in-scope requirement is unambiguous context and reaches both gates.
    const { calls, runner } = completeRunner();
    const result = await runSynchronizeImplementBranch(completeInput(), {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
      issueThreadReader: requirementsThreadReader(),
      syncRecordReader: async () => ({ ok: false, error: "implement_pr_sync_record_missing" }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const gateEnvs = calls
      .filter(([command]) => command === "bash")
      .map(([, , options]) => options?.env?.[REQUIREMENT_UID_GATE_ENV_VAR]);
    assert.deepEqual(gateEnvs, []);
  });

  it("injects no requirement UID override when the issue lists multiple in-scope requirements (#1434 follow-up)", async () => {
    // Ambiguous scope must not be guessed: with more than one in-scope
    // requirement and no requested UID, the gate keeps deriving context as before.
    const { calls, runner } = completeRunner();
    const result = await runSynchronizeImplementBranch(completeInput(), {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
      issueThreadReader: requirementsThreadReader("## Requirements\n- DSL-437\n- DSL-438\n"),
      syncRecordReader: async () => ({ ok: false, error: "implement_pr_sync_record_missing" }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    for (const [command, , options] of calls.filter(([command]) => command === "bash")) {
      assert.equal(
        REQUIREMENT_UID_GATE_ENV_VAR in (options?.env ?? {}),
        false,
        `${command} gate must not receive an ambiguous requirement override`,
      );
    }
  });


  it("refuses an invalid requested requirement UID before running any gate (#1434)", async () => {
    const { calls, runner } = completeRunner();
    const result = await runSynchronizeImplementBranch({
      ...completeInput(),
      requestedRequirementUid: "DSL-437; rm -rf /",
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
      issueThreadReader: requirementsThreadReader(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_requested_requirement_uid_invalid");
    assert.equal(calls.length, 0);
  });


  it("authorizes the workspace before reading the issue thread (#1434)", async () => {
    // Reading the thread first would let a caller who is not authorized for
    // this workspace make the server query an arbitrary repository's issue,
    // and the authorized/out-of-scope split would then leak whether a guessed
    // UID appears in a private issue.
    let threadReads = 0;
    const { calls, runner } = completeRunner();
    const result = await runSynchronizeImplementBranch({
      ...completeInput(),
      requestedRequirementUid: "DSL-437",
    }, {
      workspaceAuthorizationResolver: async () => {
        throw new Error("workspace not authorized");
      },
      commandRunner: runner,
      contextResolver: async () => context(),
      issueThreadReader: async () => {
        threadReads += 1;
        return { ok: true, body: "## Requirements\n- DSL-437\n" };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(threadReads, 0, "no issue read may precede workspace authorization");
    assert.equal(calls.some(([command]) => command === "bash"), false);
  });


  it("refuses a requirement UID the target issue does not list (#1434)", async () => {
    // This tool is directly callable, so it cannot rely on bootstrap having
    // bound the UID to the issue. A valid-looking UID from another issue or
    // project must not become the gate's requirement identity.
    const { calls, runner } = completeRunner();
    const result = await runSynchronizeImplementBranch({
      ...completeInput(),
      requestedRequirementUid: "OTHER-999",
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
      issueThreadReader: requirementsThreadReader(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_requested_requirement_uid_out_of_scope");
    assert.equal(calls.length, 0);
  });




  it("refuses to bind a verified tree while unstaged work is on disk (#1429)", async () => {
    // The gates execute against the working tree; the merge commit is built
    // from the index. An unstaged edit means the content that passed the gates
    // is not the content that ships, which silently voids the attestation's
    // verified-tree guarantee.
    const calls = [];
    const runner = async (command, args) => {
      calls.push([command, args]);
      if (command === "bash" || command === "make") return { stdout: "" };
      const op = gitOperation(args);
      if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
      if (op[0] === "status") return { stdout: "M  staged.txt\n M unstaged.txt\n" };
      if (op[0] === "rev-parse") {
        const ref = op[op.length - 1];
        if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
        if (ref.startsWith("MERGE_HEAD")) return { stdout: `${BASE}\n` };
        return { stdout: `${PRE}\n` };
      }
      if (op[0] === "write-tree") return { stdout: `${TREE}\n` };
      if (op[0] === "ls-files") return { stdout: "" };
      throw new Error(`unexpected git operation: ${op.join(" ")}`);
    };
    const result = await runSynchronizeImplementBranch(completeInput(), {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_base_sync_worktree_not_staged");
    assert.equal(
      calls.some(([command]) => command === "bash"),
      false,
      "the gates must not run against a tree that will not be committed",
    );
    assert.equal(calls.some(([, args]) => gitOperation(args)[0] === "commit"), false);
  });


  it("refuses an invalid repository context before touching the checkout (#1429)", async () => {
    const calls = [];
    const result = await runSynchronizeImplementBranch({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      action: "start",
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: async (command, args) => {
        calls.push([command, args]);
        return { stdout: "" };
      },
      contextResolver: async () => ({
        status: "invalid",
        errors: ["workflow.policy_command must be a non-empty string when set"],
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_base_sync_context_invalid");
    // A broken config must never fall through to the default base branch or
    // the default policy command.
    assert.equal(calls.length, 0);
  });


  it("resumes a valid committed merge and reuses its durable record", async () => {
    const calls = [];
    const runner = async (command, args) => {
      calls.push([command, args]);
      if (command === "bash" || command === "make") return { stdout: "" };
      const op = gitOperation(args);
      if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
      if (op[0] === "status") return { stdout: "" };
      if (op[0] === "rev-parse") {
        const ref = op[op.length - 1];
        if (ref.startsWith("MERGE_HEAD")) {
          const error = new Error("missing MERGE_HEAD");
          error.code = 128;
          throw error;
        }
        if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
        return { stdout: `${RESULT}\n` };
      }
      if (op[0] === "write-tree") return { stdout: `${TREE}\n` };
      if (op[0] === "show") return { stdout: `${PRE} ${BASE}\n` };
      if (op[0] === "push") return { stdout: "" };
      if (op[0] === "ls-remote") return { stdout: `${RESULT}\trefs/heads/${BRANCH}\n` };
      throw new Error(`unexpected operation: ${command} ${args.join(" ")}`);
    };
    const record = {
      valid: true,
      recordId: RECORD,
      issueNumber: ISSUE,
      branchName: BRANCH,
      baseBranch: "dev",
      remoteRef: "refs/remotes/origin/dev",
      preSyncSha: PRE,
      fetchedBaseSha: BASE,
      outcome: "merged_clean",
      resultingFeatureSha: RESULT,
      verifiedTreeSha: TREE,
      // An existing record must match field for field, including the delivery
      // binding it now carries (issue #1679).
      settledTreeSha: TREE,
      reviewPublicationId: REVIEW_EVIDENCE.publication_id,
      reviewRevisionDigest: REVIEW_EVIDENCE.revision_digest,
      lane: "implement",
    };
    const result = await runSynchronizeImplementBranch({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      action: "complete",
      recordId: RECORD,
      preSyncSha: PRE,
      fetchedBaseSha: BASE,
      outcome: "merged_clean",
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
      syncRecordReader: async () => ({
        ok: true,
        record,
        commentId: 100,
        commentUrl: "https://github.com/autarchy-ai/Ground-Control/issues/1421#issuecomment-100",
      }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.resultingFeatureSha, RESULT);
    assert.equal(calls.some(([, args]) => gitOperation(args)[0] === "commit"), false);
    assert.equal(calls.some(([command]) => command === "gh"), false);
  });


  it("committed retry validates requirement scope without executing broad gates", async () => {
    const calls = [];
    const runner = async (command, args, options) => {
      calls.push([command, args, options]);
      if (command === "bash" || command === "make") return { stdout: "" };
      const op = gitOperation(args);
      if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
      if (op[0] === "status") return { stdout: "" };
      if (op[0] === "rev-parse") {
        const ref = op[op.length - 1];
        if (ref.startsWith("MERGE_HEAD")) {
          const error = new Error("missing MERGE_HEAD");
          error.code = 128;
          throw error;
        }
        if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
        return { stdout: `${RESULT}\n` };
      }
      if (op[0] === "write-tree") return { stdout: `${TREE}\n` };
      if (op[0] === "show") return { stdout: `${PRE} ${BASE}\n` };
      if (op[0] === "push") return { stdout: "" };
      if (op[0] === "ls-remote") return { stdout: `${RESULT}\trefs/heads/${BRANCH}\n` };
      throw new Error(`unexpected operation: ${command} ${args.join(" ")}`);
    };
    const result = await runSynchronizeImplementBranch({
      ...completeInput(),
      requestedRequirementUid: "DSL-437",
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
      issueThreadReader: requirementsThreadReader(),
      syncRecordReader: async () => ({
        ok: true,
        record: {
          valid: true,
          recordId: RECORD,
          issueNumber: ISSUE,
          branchName: BRANCH,
          baseBranch: "dev",
          remoteRef: "refs/remotes/origin/dev",
          preSyncSha: PRE,
          fetchedBaseSha: BASE,
          outcome: "merged_clean",
          resultingFeatureSha: RESULT,
          verifiedTreeSha: TREE,
          settledTreeSha: TREE,
          reviewPublicationId: REVIEW_EVIDENCE.publication_id,
          reviewRevisionDigest: REVIEW_EVIDENCE.revision_digest,
          lane: "implement",
        },
        commentId: 100,
        commentUrl: "https://github.com/autarchy-ai/Ground-Control/issues/1421#issuecomment-100",
      }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const gateEnvs = calls
      .filter(([command]) => command === "bash")
      .map(([, , options]) => options?.env?.[REQUIREMENT_UID_GATE_ENV_VAR]);
    assert.deepEqual(gateEnvs, []);
  });
});
