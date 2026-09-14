// Orchestration coverage for runPublish's lease + write-ahead journal + recovery
// wiring (issue #1495). The primitives are unit-tested elsewhere; this pins the
// load-bearing glue that the earlier publish tests only exercised through blanket
// no-op stubs: the journal phase sequence, journal removal keyed on a live
// MERGE_HEAD, the ELOCKED contention mapping, lease release via `finally` even
// when a mutating step throws, git-dir resolution failure mapping, and the
// reconciliation short-circuit.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPublish } from "./implement/publish.js";

const BRANCH = "1495-publish-recovery";
const ISSUE = 1495;
const HEAD = "e".repeat(40);
const RECORD_ID = "c".repeat(32);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

// A git command runner covering every op runPublish + readPublishPaths touch.
// `mergeHead: null` makes `rev-parse --verify --quiet MERGE_HEAD` fail (exit 1),
// the ordinary "no merge in progress" signal; a SHA makes it report a live merge.
function gitRunner({ mergeHead = null, stagedPaths = ["src/x.js"] } = {}) {
  const calls = [];
  const exec = async (file, argv = []) => {
    calls.push([file, ...argv]);
    if (file === "bash") return { stdout: "", stderr: "" };
    if (argv.includes("--show-current")) return { stdout: `${BRANCH}\n`, stderr: "" };
    if (argv.includes("-z")) {
      if (argv.includes("--cached") || argv.includes("--others")) return { stdout: "", stderr: "" };
      return { stdout: stagedPaths.map((p) => `${p}\0`).join(""), stderr: "" };
    }
    if (argv.includes("--cached") && argv.includes("--name-only")) {
      return { stdout: stagedPaths.join("\n"), stderr: "" };
    }
    if (argv.includes("rev-parse") && argv.includes("MERGE_HEAD")) {
      if (mergeHead == null) {
        const error = new Error("MERGE_HEAD absent");
        error.code = 1;
        throw error;
      }
      return { stdout: `${mergeHead}\n`, stderr: "" };
    }
    if (argv.includes("rev-parse") && argv.includes("HEAD")) return { stdout: `${HEAD}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { calls, exec };
}

function captureDeps(overrides = {}) {
  const captured = { journalPhases: [], removed: 0, released: 0, reconcileCalls: 0, lockDir: null };
  const git = overrides.git ?? gitRunner();
  const deps = {
    authorizeRepo: async (path) => ({ ok: true, repoRoot: path }),
    getContext: async () => ({ status: "ok", workflow: { base_branch: "dev", completion_command: "make check" } }),
    authorizeRequirementUid: async () => ({ ok: true, requirementUid: null }),
    runGit: async (repoRoot, argv, commandRunner) => commandRunner("git", ["-C", repoRoot, ...argv], { cwd: repoRoot }),
    commit: async (repoRoot, argv, commandRunner) => {
      await commandRunner("git", ["-C", repoRoot, "commit", ...argv], { cwd: repoRoot });
      return { ok: true };
    },
    execFile: git.exec,
    preCommit: async () => ({ stdout: "" }),
    synchronize: async (input) => (input.action === "start"
      ? { ok: true, status: "merge_ready", recordId: RECORD_ID, preSyncSha: SHA_A, fetchedBaseSha: SHA_B, outcome: "merged_clean" }
      : { ok: true, status: "complete", recordId: RECORD_ID }),
    resolvePublishGitDir: async () => "/repo/.git",
    acquirePublishLock: async (dir) => {
      captured.lockDir = dir;
      return async () => { captured.released += 1; };
    },
    reconcileInterruptedPublish: async () => { captured.reconcileCalls += 1; return { proceed: true }; },
    writePublishJournal: (_dir, fields) => { captured.journalPhases.push(fields.phase); },
    removePublishJournal: () => { captured.removed += 1; },
    ...overrides.deps,
  };
  return { deps, captured, git };
}

function publishArgs(extra = {}) {
  return {
    action: "publish",
    repoPath: "/repo",
    issueNumber: ISSUE,
    branchName: BRANCH,
    commitMessage: "fix: bounded publish recovery",
    ...extra,
  };
}

describe("runPublish lease + journal orchestration (#1495)", () => {
  it("records the write-ahead phase sequence and clears the journal on success", async () => {
    const { deps, captured } = captureDeps();
    const result = await runPublish(publishArgs(), deps);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(captured.journalPhases, ["initializing", "feature_committed", "feature_pushed", "merge_staged"]);
    assert.equal(captured.removed, 1, "a successful publish clears its journal");
    assert.equal(captured.released, 1, "the lease is released on the success path");
    assert.equal(captured.lockDir, "/repo/.git");
  });

  it("clears the journal on a failure with no live MERGE_HEAD", async () => {
    const { deps, captured } = captureDeps({
      git: gitRunner({ mergeHead: null }),
      deps: { synchronize: async () => ({ ok: false, error: "implement_base_sync_failed", message: "sync failed" }) },
    });
    const result = await runPublish(publishArgs(), deps);
    assert.equal(result.ok, false);
    assert.equal(captured.removed, 1, "an ordinary failure with a clean checkout clears the journal");
    assert.equal(captured.released, 1);
  });

  it("preserves the journal when a failure leaves a live MERGE_HEAD", async () => {
    const { deps, captured } = captureDeps({
      git: gitRunner({ mergeHead: SHA_B }),
      deps: { synchronize: async () => ({ ok: false, error: "implement_base_sync_failed", message: "sync failed" }) },
    });
    const result = await runPublish(publishArgs(), deps);
    assert.equal(result.ok, false);
    assert.equal(captured.removed, 0, "an interrupted merge must keep its recovery journal");
    assert.equal(captured.released, 1);
  });

  it("maps a contended lease to implement_publish_lease_contended without mutating", async () => {
    const { deps, captured, git } = captureDeps({
      deps: {
        acquirePublishLock: async () => {
          const error = new Error("held");
          error.code = "ELOCKED";
          throw error;
        },
      },
    });
    const result = await runPublish(publishArgs(), deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_publish_lease_contended");
    assert.equal(result.agent_required, true);
    assert.equal(captured.journalPhases.length, 0);
    assert.equal(git.calls.some(([file, ...argv]) => file === "git" && argv.includes("commit")), false);
  });

  it("releases the lease even when a mutating step throws", async () => {
    const { deps, captured } = captureDeps({
      deps: { synchronize: async () => { throw new Error("git exploded mid-sync"); } },
    });
    await assert.rejects(() => runPublish(publishArgs(), deps));
    assert.equal(captured.released, 1, "the lease must be released via finally on a thrown mutation");
  });

  it("maps a git-dir resolution failure to a bounded agent_required envelope", async () => {
    const { deps, captured } = captureDeps({
      deps: { resolvePublishGitDir: async () => { throw new Error("not a git dir"); } },
    });
    const result = await runPublish(publishArgs(), deps);
    assert.equal(result.ok, false);
    assert.equal(result.agent_required, true);
    assert.equal(captured.released, 0, "no lease is acquired when the git dir cannot be resolved");
  });

  it("short-circuits and returns the reconciliation envelope unmodified", async () => {
    const resolved = {
      ok: false,
      action: "publish",
      error: "implement_publish_interrupted_merge_present",
      message: "recorded staged merge",
      agent_required: true,
      next_action: "complete_the_preserved_synchronization_then_retry_publish",
    };
    const { deps, captured, git } = captureDeps({
      deps: { reconcileInterruptedPublish: async () => ({ resolved }) },
    });
    const result = await runPublish(publishArgs(), deps);
    assert.deepEqual(result, resolved);
    assert.equal(captured.journalPhases.length, 0, "no journal is written when reconciliation short-circuits");
    assert.equal(captured.released, 1, "the lease is still released after a reconciliation short-circuit");
    assert.equal(git.calls.some(([file, ...argv]) => file === "git" && (argv.includes("commit") || argv.includes("push"))), false);
  });
});
