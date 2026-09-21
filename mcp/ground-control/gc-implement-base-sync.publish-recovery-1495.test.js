// Bounded, attributable mechanical-publish recovery (issue #1495).
//
// The async publish base-sync left the shared checkout in a staged merge while
// its final-tree gates ran for minutes. During that window an external recovery
// aborted the staged merge and staged a different one whose tree matched but
// whose parents did not; the resumed job committed that merge and then rejected
// it as `implement_base_sync_graph_invalid`. These tests pin the compare-and-swap
// that re-reads the merge control state immediately before the commit and stops
// without mutating when the checkout no longer matches the persisted attempt.

import { execFile as execFileCb } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSynchronizeImplementBranch } from "./lib.js";

const execFile = promisify(execFileCb);

const REPO_ROOT = realpathSync(new URL("../..", import.meta.url).pathname);

const ISSUE = 1421;
const BRANCH = "1421-merge-dev-before-pr";
const PRE = "1".repeat(40);
const BASE = "2".repeat(40);
const RESULT = "3".repeat(40);
const RECORD = "4".repeat(32);
const TREE = "5".repeat(40);

// Issue #1679: synchronization binds the delivery to the review that authorized it.
const deliveryBindingDeps = {
  reviewEvidenceReader: async () => ({
    ok: true, published: true, cycle: 1, comment_id: 12,
    publication_id: "a".repeat(64), revision_digest: "c".repeat(64),
    candidate_tree_oid: TREE, findings_count: 0, branch: BRANCH,
  }),
  laneReader: async () => ({ ok: true, lane: "implement" }),
};
// The base the external recovery re-merged against — a different integration
// commit than the one this attempt fetched and recorded.
const OTHER_BASE = "9".repeat(40);

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

function context() {
  return {
    status: "ok",
    workflow: {
      base_branch: "dev",
      completion_command: "make check",
      policy_command: "make policy",
      pr_title: null,
    },
  };
}

function gitOperation(args) {
  const marker = args.indexOf("-C");
  return args.slice(marker + 2);
}

function completeInput(overrides = {}) {
  return {
    repoPath: REPO_ROOT,
    issueNumber: ISSUE,
    branchName: BRANCH,
    action: "complete",
    recordId: RECORD,
    preSyncSha: PRE,
    fetchedBaseSha: BASE,
    outcome: "merged_clean",
    ...overrides,
  };
}

// Drives `action=complete` down the fresh-merge path. The `mergeHead` factory
// controls what `MERGE_HEAD` resolves to on each read; passing a function lets a
// test change the answer AFTER the final-tree gates run — the external-recovery
// window the incident exercised.
function recoveryRunner({ mergeHead, headAfterCommit = RESULT } = {}) {
  const calls = [];
  let committed = false;
  const currentMergeHead = typeof mergeHead === "function" ? mergeHead : () => mergeHead ?? BASE;
  const runner = async (command, args, options) => {
    calls.push([command, args, options]);
    if (command === "bash") return { stdout: "" };
    if (command === "make") return { stdout: "" };
    if (command === "gh") {
      return {
        stdout: JSON.stringify({
          id: 101,
          html_url: `https://github.com/autarchy-ai/Ground-Control/issues/${ISSUE}#issuecomment-101`,
        }),
      };
    }
    const op = gitOperation(args);
    if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
    if (op[0] === "status") return { stdout: "M  file.txt\n" };
    if (op[0] === "rev-parse") {
      const ref = op[op.length - 1];
      if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
      if (ref.startsWith("MERGE_HEAD")) return { stdout: `${currentMergeHead({ committed })}\n` };
      return { stdout: `${committed ? headAfterCommit : PRE}\n` };
    }
    if (op[0] === "write-tree") return { stdout: `${TREE}\n` };
    if (op[0] === "ls-files") return { stdout: "" };
    if (op[0] === "commit") {
      committed = true;
      return { stdout: "" };
    }
    if (op[0] === "push") return { stdout: "" };
    if (op[0] === "show") return { stdout: `${PRE} ${BASE}\n` };
    if (op[0] === "ls-remote") return { stdout: `${headAfterCommit}\trefs/heads/${BRANCH}\n` };
    throw new Error(`unexpected git operation: ${op.join(" ")}`);
  };
  return { calls, runner };
}

describe("bounded mechanical-publish recovery (#1495)", () => {
  it("refuses without committing when the staged merge changes under the boundary", async () => {
    // MERGE_HEAD is the recorded fetched base before the gates run, then a
    // different base once the gates have completed — the external-recovery race.
    let gatesRan = false;
    const { calls, runner } = recoveryRunner({
      mergeHead: () => (gatesRan ? OTHER_BASE : BASE),
    });
    const wrappedRunner = async (command, args, options) => {
      const result = await runner(command, args, options);
      if (command === "git" && gitOperation(args)[0] === "write-tree") gatesRan = true;
      return result;
    };
    const result = await runSynchronizeImplementBranch(completeInput(), {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: wrappedRunner,
      contextResolver: async () => context(),
      syncRecordReader: async () => ({ ok: false, error: "implement_pr_sync_record_missing" }),
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error, "implement_base_sync_merge_head_mismatch");
    assert.equal(
      calls.some(([, args]) => gitOperation(args)[0] === "commit"),
      false,
      "the boundary must not commit a merge it no longer owns",
    );
    assert.equal(
      calls.some(([, args]) => gitOperation(args)[0] === "push"),
      false,
      "no push may follow a refused commit",
    );
  });

  it("still completes a merge that is unchanged through the final-tree gates", async () => {
    const { calls, runner } = recoveryRunner({ mergeHead: () => BASE });
    const result = await runSynchronizeImplementBranch(completeInput(), {
      workspaceAuthorizationResolver: workspaceAuthorization,
      ...deliveryBindingDeps,
      commandRunner: runner,
      contextResolver: async () => context(),
      syncRecordReader: async () => ({ ok: false, error: "implement_pr_sync_record_missing" }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "complete");
    assert.equal(result.resultingFeatureSha, RESULT);
    assert.ok(calls.some(([, args]) => gitOperation(args)[0] === "commit"));
    assert.ok(calls.some(([, args]) => gitOperation(args)[0] === "push"));
  });
});
