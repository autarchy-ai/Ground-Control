// Settlement is the tree this delivery's own work produced, and it has to survive
// a base merge. Split from gc-implement-base-sync.pre-pr-implement-synchronization.test.js
// for the 500-line limit (docs/CODING_STANDARDS.md); the harness below is the
// subset this scenario needs.

import { execFile as execFileCb } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSynchronizeImplementBranch, selectLatestSyncRecord } from "./lib.js";

const execFile = promisify(execFileCb);
const REPO_ROOT = realpathSync(new URL("../..", import.meta.url).pathname);
const ISSUE = 1421;
const BRANCH = "1421-merge-dev-before-pr";
const PRE = "1".repeat(40);
const BASE = "2".repeat(40);
const RESULT = "3".repeat(40);
const RECORD = "4".repeat(32);
const TREE = "5".repeat(40);

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

const context = () => ({
  status: "ok",
  workflow: { base_branch: "dev", completion_command: "make check", policy_command: "make policy", pr_title: null },
});

const requirementsThreadReader = (body = "## Requirements\n- DSL-437\n") => async () => ({ ok: true, body });

function gitOperation(args) {
  const marker = args.indexOf("-C");
  return args.slice(marker + 2);
}

// core-F3 (cycle 2): settlement is the tree this delivery's own work produced. A
// base merge moves the feature head, so a second synchronization - which happens
// whenever the base advances again before the PR is created - would otherwise
// offer the merged tree as the settlement and be refused against the reviewed
// one, demanding another review cycle for a routine base update.
describe("repeated base synchronization keeps the original settlement (#1679)", () => {
  const MERGED_TREE = "7".repeat(40);

  function completeRunnerWithTree(treeByRef) {
    return async (command, args) => {
      if (command === "bash" || command === "make") return { stdout: "" };
      const op = gitOperation(args);
      if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
      if (op[0] === "status") return { stdout: "" };
      if (op[0] === "rev-parse") {
        const ref = op[op.length - 1];
        if (ref.startsWith("MERGE_HEAD")) {
          throw Object.assign(new Error("missing MERGE_HEAD"), { code: 128 });
        }
        if (ref.endsWith("^{tree}")) return { stdout: `${treeByRef(ref)}\n` };
        return { stdout: `${RESULT}\n` };
      }
      if (op[0] === "write-tree") return { stdout: `${TREE}\n` };
      if (op[0] === "show") return { stdout: `${PRE} ${BASE}\n` };
      if (op[0] === "push") return { stdout: "" };
      if (op[0] === "ls-remote") return { stdout: `${RESULT}\trefs/heads/${BRANCH}\n` };
      throw new Error(`UNEXPECTED_OP: ${command} ${args.join(" ")}`);
    };
  }

  const priorRecord = {
    valid: true,
    schemaVersion: 2,
    // The previous synchronization's own record.
    recordId: "6".repeat(32),
    issueNumber: ISSUE,
    branchName: BRANCH,
    baseBranch: "dev",
    remoteRef: "refs/remotes/origin/dev",
    preSyncSha: "9".repeat(40),
    fetchedBaseSha: BASE,
    outcome: "merged_clean",
    // The head the previous synchronization produced; the feature has not moved
    // since, so its settlement still describes this delivery.
    resultingFeatureSha: PRE,
    verifiedTreeSha: TREE,
    settledTreeSha: TREE,
    reviewPublicationId: REVIEW_EVIDENCE.publication_id,
    reviewRevisionDigest: REVIEW_EVIDENCE.revision_digest,
    lane: "implement",
  };

  // The record this synchronization should build. An existing record must match
  // field for field, so if the settlement were recomputed from the merged head
  // instead of carried forward, this comparison is what would catch it.
  const expectedRecord = {
    valid: true,
    schemaVersion: 2,
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
  };

  async function synchronizeAgain(latestRecord, {
    evidence = REVIEW_EVIDENCE,
    existing = expectedRecord,
    latestSyncRecordReader = async () => ({ ok: true, record: latestRecord }),
  } = {}) {
    return runSynchronizeImplementBranch({
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
      reviewEvidenceReader: async () => evidence,
      // Only the settlement lookup sees the merge's tree; every other tree read
      // keeps the value the rest of this suite uses.
      commandRunner: completeRunnerWithTree((ref) => (ref.startsWith(PRE) ? MERGED_TREE : TREE)),
      contextResolver: async () => context(),
      issueThreadReader: requirementsThreadReader(),
      syncRecordReader: async () => ({
        ok: true,
        record: existing,
        commentId: 100,
        commentUrl: "https://github.com/autarchy-ai/Ground-Control/issues/1421#issuecomment-100",
      }),
      latestSyncRecordReader,
    });
  }

  it("carries the prior settlement forward when the feature head has not moved", async () => {
    const result = await synchronizeAgain(priorRecord);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.settledTreeSha, TREE, "the reviewed tree, not the merge's tree");
  });

  // core-F1 (cycle 6): the second synchronization posted its record but the
  // response was lost. The retry must carry forward from the record that
  // preceded it, as the first attempt did, not from the record it already wrote.
  it("reconciles a retried completion whose own record is already the newest", async () => {
    const thread = [
      { comment: { id: 50 }, record: priorRecord },
      { comment: { id: 100 }, record: expectedRecord },
    ];
    const result = await synchronizeAgain(null, {
      latestSyncRecordReader: async (_root, _owner, _name, _issue, branch, options) => ({
        ok: true,
        record: selectLatestSyncRecord(thread, branch, options)?.record ?? null,
      }),
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.settledTreeSha, TREE, "the settlement the first attempt recorded");
  });
});

describe("selecting a branch's synchronization record (#1679)", () => {
  const record = (recordId, overrides = {}) => ({ schemaVersion: 2, branchName: BRANCH, recordId, ...overrides });
  const thread = [
    { comment: { id: 30 }, record: record("c") },
    { comment: { id: 10 }, record: record("a") },
    { comment: { id: 20 }, record: record("b") },
    { comment: { id: 40 }, record: record("d", { branchName: "1421-other-branch" }) },
    { comment: { id: 50 }, record: record("e", { schemaVersion: 1 }) },
  ];

  it("selects the newest binding-bearing record for the branch", () => {
    assert.equal(selectLatestSyncRecord(thread, BRANCH).record.recordId, "c");
  });

  it("selects the record that preceded a given one, whatever was posted after it", () => {
    assert.equal(selectLatestSyncRecord(thread, BRANCH, { before: "b" }).record.recordId, "a");
    assert.equal(selectLatestSyncRecord(thread, BRANCH, { before: "a" }), null);
  });

  it("selects the newest record when the given one has not been posted yet", () => {
    assert.equal(selectLatestSyncRecord(thread, BRANCH, { before: "f" }).record.recordId, "c");
  });
});
