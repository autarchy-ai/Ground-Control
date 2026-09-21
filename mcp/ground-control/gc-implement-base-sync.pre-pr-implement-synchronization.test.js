// Split from gc-implement-base-sync.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { execFile as execFileCb } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REQUIREMENT_UID_GATE_ENV_VAR,
  buildImplementBaseSyncMarker,
  isDefaultImplementHooksPath,
  parseImplementBaseSyncMarkers,
  runSynchronizeImplementBranch,
} from "./lib.js";

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

function shellCommands(calls) {
  return calls.filter(([command]) => command === "bash").map(([, args]) => args[1]);
}

function gitOperation(args) {
  const marker = args.indexOf("-C");
  return args.slice(marker + 2);
}

function startRunner({ current = false, conflict = false, fetchFailure = false } = {}) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (command === "gh") {
      return {
        stdout: JSON.stringify({
          id: 99,
          html_url: "https://github.com/autarchy-ai/Ground-Control/issues/1421#issuecomment-99",
        }),
      };
    }
    const op = gitOperation(args);
    if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
    if (op[0] === "status") return { stdout: "" };
    if (op[0] === "fetch") {
      if (fetchFailure) {
        const error = new Error("fetch failed");
        error.stderr = "remote unavailable";
        throw error;
      }
      return { stdout: "" };
    }
    if (op[0] === "rev-parse") {
      const ref = op[op.length - 1];
      if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
      if (ref.startsWith("refs/remotes/origin/dev")) return { stdout: `${BASE}\n` };
      if (ref.startsWith("MERGE_HEAD")) return { stdout: `${BASE}\n` };
      return { stdout: `${PRE}\n` };
    }
    if (op[0] === "merge-base") {
      if (current) return { stdout: "" };
      const error = new Error("not ancestor");
      error.code = 1;
      throw error;
    }
    if (op[0] === "ls-remote") return { stdout: `${PRE}\trefs/heads/${BRANCH}\n` };
    if (op[0] === "merge") {
      if (conflict) {
        const error = new Error("merge conflict");
        error.code = 1;
        throw error;
      }
      return { stdout: "" };
    }
    if (op[0] === "ls-files") return { stdout: conflict ? "100644 a 1\tfile.txt\n" : "" };
    throw new Error(`unexpected git operation: ${op.join(" ")}`);
  };
  return { calls, runner };
}

describe("pre-PR implement synchronization", () => {
  it("accepts the canonical common hooks directory for a linked worktree", () => {
    assert.equal(isDefaultImplementHooksPath({
      repoRoot: "/repo/worktree",
      hooksPath: "/repo/main/.git/hooks",
      gitDir: "/repo/main/.git/worktrees/worktree",
      gitCommonDir: "/repo/main/.git",
    }), true);
    assert.equal(isDefaultImplementHooksPath({
      repoRoot: "/repo/worktree",
      hooksPath: "/tmp/caller-hooks",
      gitDir: "/repo/main/.git/worktrees/worktree",
      gitCommonDir: "/repo/main/.git",
    }), false);
  });


  it("renders and parses the complete versioned attestation", () => {
    const record = {
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
      // The delivery binding this record carries (issue #1679).
      settledTreeSha: TREE,
      reviewPublicationId: REVIEW_EVIDENCE.publication_id,
      reviewRevisionDigest: REVIEW_EVIDENCE.revision_digest,
      lane: "implement",
    };
    const parsed = parseImplementBaseSyncMarkers([buildImplementBaseSyncMarker(record)], ISSUE);
    assert.deepEqual(parsed, [{ valid: true, schemaVersion: 2, ...record }]);
  });


  it("rejects malformed and wrong-source attestation markers", () => {
    const marker = buildImplementBaseSyncMarker({
      recordId: RECORD,
      issueNumber: ISSUE,
      branchName: BRANCH,
      baseBranch: "dev",
      remoteRef: "refs/remotes/origin/dev",
      preSyncSha: PRE,
      fetchedBaseSha: BASE,
      outcome: "already_current",
      resultingFeatureSha: PRE,
    }).replace('source="refs/remotes/origin/dev"', 'source="refs/heads/dev"');
    assert.equal(parseImplementBaseSyncMarkers([marker], ISSUE)[0].valid, false);
  });


  it("records an already-current published feature without creating a merge", async () => {
    const { calls, runner } = startRunner({ current: true });
    const result = await runSynchronizeImplementBranch({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      action: "start",
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "complete");
    assert.equal(result.outcome, "already_current");
    assert.equal(calls.some(([, args]) => gitOperation(args)[0] === "merge"), false);
  });


  it("uses an explicit remote-tracking refspec and leaves a clean merge ready for final gates", async () => {
    const { calls, runner } = startRunner();
    const result = await runSynchronizeImplementBranch({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      action: "start",
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "merge_ready");
    assert.equal(result.outcome, "merged_clean");
    const fetch = calls.find(([, args]) => gitOperation(args)[0] === "fetch");
    assert.ok(fetch);
    assert.deepEqual(
      gitOperation(fetch[1]),
      ["fetch", "--no-tags", "origin", "+refs/heads/dev:refs/remotes/origin/dev"],
    );
    const merge = calls.find(([, args]) => gitOperation(args)[0] === "merge");
    assert.deepEqual(
      gitOperation(merge[1]),
      ["merge", "--no-ff", "--no-commit", "refs/remotes/origin/dev"],
    );
  });


  it("preserves conflict state and requires resolution in the feature checkout", async () => {
    const { runner } = startRunner({ conflict: true });
    const result = await runSynchronizeImplementBranch({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      action: "start",
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "conflicts");
    assert.equal(result.outcome, "merged_conflicts_resolved");
  });


  it("fails closed when the remote fetch fails even if local refs exist", async () => {
    const { runner } = startRunner({ fetchFailure: true });
    const result = await runSynchronizeImplementBranch({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      action: "start",
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_base_sync_fetch_failed");
  });


  it("verifies both merge parents before an ordinary push and durable record", async () => {
    const calls = [];
    let committed = false;
    const runner = async (command, args) => {
      calls.push([command, args]);
      if (command === "bash" || command === "make") return { stdout: "" };
      if (command === "gh") {
        return {
          stdout: JSON.stringify({
            id: 100,
            html_url: "https://github.com/autarchy-ai/Ground-Control/issues/1421#issuecomment-100",
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
    const result = await runSynchronizeImplementBranch({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      action: "complete",
      recordId: RECORD,
      preSyncSha: PRE,
      fetchedBaseSha: BASE,
      outcome: "merged_conflicts_resolved",
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
      syncRecordReader: async () => ({
        ok: false,
        error: "implement_pr_sync_record_missing",
      }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.resultingFeatureSha, RESULT);
    assert.ok(calls.some(([, args]) => gitOperation(args)[0] === "push"));
    assert.ok(calls.some(([command]) => command === "gh"));
  });


  it("synchronizes without executing configured completion or policy commands (#1629)", async () => {
    const { calls, runner } = completeRunner();
    const result = await runSynchronizeImplementBranch(completeInput(), {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context("dev", {
        policy_command: "python3 scripts/adr_guard/adr_guard.py --all --level ci",
      }),
      syncRecordReader: async () => ({ ok: false, error: "implement_pr_sync_record_missing" }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.policyCommand, undefined);
    assert.deepEqual(shellCommands(calls), []);
    assert.equal(
      calls.some(([command, args]) => command === "make" && args.includes("policy")),
      false,
      "the boundary must not fall back to a hardcoded make target",
    );
  });


  it("does not insert a default local policy gate", async () => {
    const { calls, runner } = completeRunner();
    const result = await runSynchronizeImplementBranch(completeInput(), {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context("dev", { policy_command: null }),
      syncRecordReader: async () => ({ ok: false, error: "implement_pr_sync_record_missing" }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(shellCommands(calls), []);
  });


  it("validates requirement scope without running local gates", async () => {
    const { calls, runner } = completeRunner();
    const result = await runSynchronizeImplementBranch({
      ...completeInput(),
      requestedRequirementUid: "DSL-437",
    }, {
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
    assert.equal(
      calls.some(([, args]) => args.some((arg) => String(arg).includes("DSL-437"))),
      false,
      "the UID must reach the gate through the environment, never through argv",
    );
  });
});
