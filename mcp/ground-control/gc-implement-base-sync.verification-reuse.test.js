// With the tiered-verification feature active (a toolchain fingerprint command
// configured), base synchronization must consult the content-addressed
// attestation before trusting an already-current tree (issue #1497): a miss
// re-runs the authoritative gates and attests the result; a hit skips them.

import { execFile as execFileCb } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeVerificationAttestation, resolveVerificationReuse, runSynchronizeImplementBranch } from "./lib.js";

const execFile = promisify(execFileCb);
const REPO_ROOT = realpathSync(new URL("../..", import.meta.url).pathname);
const ISSUE = 1421;
const BRANCH = "1421-merge-dev-before-pr";
const PRE = "1".repeat(40);
const BASE = "2".repeat(40);
const TREE = "5".repeat(40);
const TOOLCHAIN = "e".repeat(64);
const FINGERPRINT_CMD = "gc-test-fingerprint";

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
      verification: { toolchain_fingerprint_command: FINGERPRINT_CMD },
    },
  };
}

function gitOp(args) {
  const marker = args.indexOf("-C");
  return args.slice(marker + 2);
}

// A runner for the already-current start flow with the attestation feature on.
function activeRunner() {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (command === "gh") {
      return { stdout: JSON.stringify({ id: 99, html_url: "https://github.com/autarchy-ai/Ground-Control/issues/1421#issuecomment-99" }) };
    }
    if (command === "bash") {
      const script = args[args.length - 1];
      if (script === FINGERPRINT_CMD) return { stdout: `${TOOLCHAIN}\n`, stderr: "" };
      return { stdout: "", stderr: "" }; // completion / policy gates pass
    }
    const op = gitOp(args);
    switch (op[0]) {
      case "symbolic-ref": return { stdout: `${BRANCH}\n` };
      case "status": return { stdout: "" };
      case "fetch": return { stdout: "" };
      case "read-tree": return { stdout: "" };
      case "add": return { stdout: "" };
      case "write-tree": return { stdout: `${TREE}\n` };
      case "merge-base": return { stdout: "" }; // fetched base is an ancestor → already_current
      case "ls-remote": return { stdout: `${PRE}\trefs/heads/${BRANCH}\n` };
      case "rev-parse": {
        const ref = op[op.length - 1];
        if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
        if (ref.startsWith("refs/remotes/origin/dev")) return { stdout: `${BASE}\n` };
        return { stdout: `${PRE}\n` };
      }
      default:
        throw new Error(`unexpected git operation: ${op.join(" ")}`);
    }
  };
  return { calls, runner };
}

function ranCompletionGate(calls) {
  return calls.some(([command, args]) => command === "bash" && args[args.length - 1] === "make check");
}

async function runStart({ records, writer, calls, runner }) {
  return runSynchronizeImplementBranch({
    repoPath: REPO_ROOT,
    issueNumber: ISSUE,
    branchName: BRANCH,
    action: "start",
  }, {
    workspaceAuthorizationResolver: workspaceAuthorization,
    commandRunner: runner,
    contextResolver: async () => context(),
    attestationReader: async () => ({ ok: true, records }),
    attestationWriter: async (repoRoot, owner, name, att) => { writer.push(att); return { commentId: 7 }; },
  });
}

describe("base synchronization verification reuse (issue #1497)", () => {
  it("re-verifies and attests an already-current tree when no trusted attestation matches", async () => {
    const { calls, runner } = activeRunner();
    const writer = [];
    const result = await runStart({ records: [], writer, calls, runner });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.outcome, "already_current");
    // A miss runs the authoritative gates and posts a fresh attestation.
    assert.equal(ranCompletionGate(calls), true, "completion gate must run on a cache miss");
    assert.equal(writer.length, 1);
    assert.match(writer[0].id, /^[0-9a-f]{64}$/);
  });

  it("skips the gates when a trusted attestation already covers the exact tree", async () => {
    // First run (miss) yields the attestation the tree would produce.
    const first = activeRunner();
    const firstWriter = [];
    await runStart({ records: [], writer: firstWriter, calls: first.calls, runner: first.runner });
    const attestation = firstWriter[0];
    assert.ok(attestation?.id);

    // Second run with that attestation present must reuse it: no gates, no post.
    const second = activeRunner();
    const secondWriter = [];
    const result = await runStart({
      // The real reader returns parsed markers (structurally valid + authenticated
      // by this process); mirror that shape so the content-address + HMAC match.
      records: [{ record: { ...attestation, valid: true, authenticated: true }, commentId: 5 }],
      writer: secondWriter,
      calls: second.calls,
      runner: second.runner,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.outcome, "already_current");
    assert.equal(ranCompletionGate(second.calls), false, "a hit must not re-run the completion gate");
    assert.equal(secondWriter.length, 0, "a hit must not post a new attestation");
  });

  it("reuses trusted verification when recovering an already-committed merge", async () => {
    const RESULT = "3".repeat(40);
    const RECORD = "4".repeat(32);
    const calls = [];
    const runner = async (command, args) => {
      calls.push([command, args]);
      if (command === "bash") {
        const script = args.at(-1);
        if (script === FINGERPRINT_CMD) return { stdout: `${TOOLCHAIN}\n`, stderr: "" };
        return { stdout: "", stderr: "" };
      }
      if (command === "gh") {
        return { stdout: JSON.stringify({ id: 7, html_url: "https://github.test/comment/7" }) };
      }
      const op = gitOp(args);
      if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
      if (op[0] === "status") return { stdout: "" };
      if (op[0] === "rev-parse") {
        const ref = op.at(-1);
        if (ref.startsWith("MERGE_HEAD")) throw new Error("no merge head");
        if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
        return { stdout: `${RESULT}\n` };
      }
      if (op[0] === "show") return { stdout: `${PRE} ${BASE}\n` };
      if (op[0] === "write-tree") return { stdout: `${TREE}\n` };
      if (op[0] === "push") return { stdout: "" };
      if (op[0] === "ls-remote") return { stdout: `${RESULT}\trefs/heads/${BRANCH}\n` };
      throw new Error(`unexpected git operation: ${op.join(" ")}`);
    };
    const attestation = computeVerificationAttestation({
      issueNumber: ISSUE,
      branchName: BRANCH,
      baseSha: BASE,
      treeOid: TREE,
      requirementUid: null,
      completionCommand: "make check",
      policyCommand: "make policy",
      toolchainFingerprintCommand: FINGERPRINT_CMD,
      config: { base_branch: "dev", precommit_command: null },
      toolchainDigest: TOOLCHAIN,
    });
    const attestationReader = async () => ({
      ok: true,
      records: [{ record: { ...attestation, valid: true, authenticated: true }, commentId: 5 }],
    });
    const directReuse = await resolveVerificationReuse({
      context: context(), repoRoot: REPO_ROOT, owner: "autarchy-ai", name: "ground-control",
      issueNumber: ISSUE, branchName: BRANCH, baseSha: BASE, requirementUid: null,
      commandRunner: runner, attestationReader, treeOid: TREE,
    });
    assert.equal(directReuse.reused, true);
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
      commandRunner: runner,
      contextResolver: async () => context(),
      syncRecordReader: async () => ({ ok: false, error: "implement_pr_sync_record_missing" }),
      issueThreadReader: async () => ({ ok: true, body: "## Requirements\n" }),
      attestationReader,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.verification_decision, "reused");
    assert.equal(result.broad_gates_executed, 0);
    assert.equal(ranCompletionGate(calls), false);
  });
});
