// completion and policy run through one shared, size-safe implementation so
// Step 6 verify and Step 8.5 base synchronization cannot drift apart (#1497),
// and the working-tree content identity must equal the tree a real staged
// commit produces.

import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  runImplementCompletionPolicyGates,
  runVerifiedGateBoundary,
  dominantGate,
  readImplementWorkingTreeOid,
  produceVerificationAttestation,
  parseRepoIdentity,
  isVerificationAttestationActive,
  resolveVerificationReuse,
  postFreshVerificationAttestation,
  resolveToolchainFingerprintDigest,
} from "./lib/verification-gates.js";

const execFile = promisify(execFileCb);

function ctx(overrides = {}) {
  return { status: "ok", workflow: { completion_command: "make mcp-test", policy_command: "make policy", ...overrides } };
}

describe("runImplementCompletionPolicyGates", () => {
  it("runs completion then policy in order and returns per-phase timings", async () => {
    const calls = [];
    const runner = async (file, args) => {
      calls.push(args.at(-1));
      return { stdout: "", stderr: "" };
    };
    const progress = [];
    const { timings } = await runImplementCompletionPolicyGates({
      repoRoot: "/repo",
      context: ctx(),
      gateEnv: { X: "1" },
      commandRunner: runner,
      reportProgress: (snapshot) => progress.push(snapshot),
    });
    assert.deepEqual(calls, ["make mcp-test", "make policy"]);
    assert.deepEqual(progress.map((s) => s.phase), ["completion", "policy"]);
    // Snapshots carry only numeric, non-sensitive fields.
    assert.deepEqual(Object.keys(progress[0]).sort(), [
      "last_activity_ms", "phase", "phase_started_ms", "stderr_bytes", "stdout_bytes",
    ]);
    assert.deepEqual(timings.map((t) => [t.phase, t.outcome]), [
      ["completion", "passed"],
      ["policy", "passed"],
    ]);
  });

  it("throws with the failing gate phase and never reaches policy when completion fails", async () => {
    const calls = [];
    const runner = async (file, args) => {
      calls.push(args.at(-1));
      if (args.at(-1) === "make mcp-test") throw Object.assign(new Error("boom"), { code: 2 });
      return { stdout: "", stderr: "" };
    };
    await assert.rejects(
      runImplementCompletionPolicyGates({ repoRoot: "/repo", context: ctx(), gateEnv: {}, commandRunner: runner }),
      (error) => {
        assert.equal(error.gatePhase, "completion");
        assert.equal(error.timings.at(-1).outcome, "failed");
        return true;
      },
    );
    assert.deepEqual(calls, ["make mcp-test"]);
  });

  it("throws when no completion command is configured", async () => {
    await assert.rejects(
      runImplementCompletionPolicyGates({
        repoRoot: "/repo",
        context: { status: "ok", workflow: { policy_command: "make policy" } },
        gateEnv: {},
        commandRunner: async () => ({ stdout: "", stderr: "" }),
      }),
      (error) => error.code === "implement_completion_command_missing",
    );
  });
});

describe("runVerifiedGateBoundary", () => {
  const FP = "fp-cmd";
  function boundaryCtx(fingerprint = FP) {
    return { status: "ok", workflow: { completion_command: "make check", policy_command: "make policy", verification: { toolchain_fingerprint_command: fingerprint } } };
  }
  function runner(fingerprintOut = `${"e".repeat(64)}\n`) {
    return async (file, args) => (file === "bash" && args.at(-1) === FP ? { stdout: fingerprintOut, stderr: "" } : { stdout: "", stderr: "" });
  }
  const stableTree = async () => "a".repeat(40);
  const stableStatus = async () => "";

  it("binds the tree + toolchain and returns per-gate timings when the checkout is stable", async () => {
    const boundary = await runVerifiedGateBoundary({
      repoRoot: "/r", context: boundaryCtx(), gateEnv: {}, commandRunner: runner(),
      readTreeOid: stableTree, readStatus: stableStatus,
    });
    assert.equal(boundary.treeOid, "a".repeat(40));
    assert.equal(boundary.toolchainDigest, "e".repeat(64));
    assert.deepEqual(boundary.timings.map((t) => t.phase), ["completion", "policy"]);
  });

  it("runs no fingerprint and binds a null toolchain when the feature is off", async () => {
    let bash = 0;
    const boundary = await runVerifiedGateBoundary({
      repoRoot: "/r",
      context: { status: "ok", workflow: { completion_command: "make check", policy_command: "make policy" } },
      gateEnv: {}, commandRunner: async (file) => { if (file === "bash") bash++; return { stdout: "", stderr: "" }; },
      readTreeOid: stableTree, readStatus: stableStatus,
    });
    assert.equal(boundary.toolchainDigest, null);
    assert.equal(bash, 2); // completion + policy only — never the fingerprint
  });

  it("aborts when the fingerprint command mutates the checkout", async () => {
    let n = 0;
    const readTreeOid = async () => (n++ === 0 ? "a".repeat(40) : "b".repeat(40)); // changes right after the fingerprint
    await assert.rejects(
      runVerifiedGateBoundary({ repoRoot: "/r", context: boundaryCtx(), gateEnv: {}, commandRunner: runner(), readTreeOid, readStatus: stableStatus }),
      (e) => e.code === "implement_mechanical_gate_tree_changed",
    );
  });

  it("aborts when a gate mutates a bound input between gates", async () => {
    const seq = ["a", "a", "b"].map((c) => c.repeat(40)); // baseline, post-fingerprint, post-completion
    let n = 0;
    const readTreeOid = async () => seq[Math.min(n++, seq.length - 1)];
    await assert.rejects(
      runVerifiedGateBoundary({ repoRoot: "/r", context: boundaryCtx(), gateEnv: {}, commandRunner: runner(), readTreeOid, readStatus: stableStatus }),
      (e) => e.code === "implement_mechanical_gate_tree_changed",
    );
  });

  it("rejects the boundary when a gate changed a fingerprinted input", async () => {
    let fp = 0;
    const r = async (file, args) => (file === "bash" && args.at(-1) === FP ? { stdout: `${(fp++ === 0 ? "e" : "f").repeat(64)}\n`, stderr: "" } : { stdout: "", stderr: "" });
    await assert.rejects(
      runVerifiedGateBoundary({
        repoRoot: "/r", context: boundaryCtx(), gateEnv: {}, commandRunner: r,
        readTreeOid: stableTree, readStatus: stableStatus,
      }),
      (error) => error.code === "implement_verification_inputs_changed",
    );
  });

});

describe("dominantGate", () => {
  it("returns the longest-running completed gate", () => {
    assert.equal(
      dominantGate([
        { phase: "completion", duration_ms: 900000, outcome: "passed" },
        { phase: "policy", duration_ms: 20000, outcome: "passed" },
      ]),
      "completion",
    );
    assert.equal(dominantGate([]), null);
    assert.equal(dominantGate([
      { phase: "completion", duration_ms: 0, outcome: "reused" },
      { phase: "policy", duration_ms: 0, outcome: "reused" },
    ]), null);
  });
});

describe("produceVerificationAttestation", () => {
  function deps(overrides = {}) {
    const posted = [];
    const base = {
      execFile: async (file, args) => {
        if (file === "git" && args.includes("write-tree")) return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
        if (file === "git") return { stdout: "", stderr: "" };
        if (file === "bash") return { stdout: `${"e".repeat(64)}\n`, stderr: "" };
        return { stdout: "", stderr: "" };
      },
      runGit: async (repoRoot, args) => {
        if (args.includes("--show-current")) return { stdout: "1497-tier-publish-verification\n", stderr: "" };
        if (args.includes("rev-parse")) return { stdout: `${"c".repeat(40)}\n`, stderr: "" };
        return { stdout: "", stderr: "" };
      },
      readVerificationAttestations: async () => ({ ok: true, records: [] }),
      postVerificationAttestation: async (r, o, n, att) => {
        posted.push(att);
        return { commentId: 1 };
      },
    };
    Object.assign(base, overrides);
    return { deps: base, posted };
  }
  function context(workflowOverrides = {}) {
    return {
      github_repo: "autarchy-ai/Ground-Control",
      workflow: {
        completion_command: "make mcp-test",
        policy_command: "make policy",
        base_branch: "dev",
        precommit_command: "pre-commit run --all-files",
        verification: { toolchain_fingerprint_command: "node --version | shasum -a 256" },
        ...workflowOverrides,
      },
    };
  }
  const args = { issueNumber: 1497 };
  // verify supplies the tree + toolchain bindings it captured before the gates
  // and re-validated after them; the producer no longer samples them itself.
  const bindings = { treeOid: "a".repeat(40), toolchainDigest: "e".repeat(64) };

  it("computes and posts an attestation on the happy path", async () => {
    const { deps: d, posted } = deps();
    const att = await produceVerificationAttestation({ deps: d, args, context: context(), repoRoot: "/repo", requirementUid: "GC-O007", ...bindings });
    assert.ok(att);
    assert.match(att.id, /^[0-9a-f]{64}$/);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].id, att.id);
  });

  it("does not repost when an identical trusted attestation already exists (idempotent)", async () => {
    const { deps: d, posted } = deps();
    const first = await produceVerificationAttestation({ deps: d, args, context: context(), repoRoot: "/repo", requirementUid: "GC-O007", ...bindings });
    // A parsed-shaped record: structurally valid AND authenticated by this process.
    d.readVerificationAttestations = async () => ({ ok: true, records: [{ record: { ...first, valid: true, authenticated: true }, commentId: 5 }] });
    const again = await produceVerificationAttestation({ deps: d, args, context: context(), repoRoot: "/repo", requirementUid: "GC-O007", ...bindings });
    assert.equal(again.id, first.id);
    assert.equal(posted.length, 1); // still just the first post
  });

  it("reposts when the only matching marker is unauthenticated (a forgery is not an idempotent hit)", async () => {
    const { deps: d, posted } = deps();
    const first = await produceVerificationAttestation({ deps: d, args, context: context(), repoRoot: "/repo", requirementUid: "GC-O007", ...bindings });
    d.readVerificationAttestations = async () => ({ ok: true, records: [{ record: { ...first, valid: true, authenticated: false }, commentId: 5 }] });
    await produceVerificationAttestation({ deps: d, args, context: context(), repoRoot: "/repo", requirementUid: "GC-O007", ...bindings });
    assert.equal(posted.length, 2);
  });

  it("returns null (fail-closed, no reuse) without a toolchain fingerprint command", async () => {
    const { deps: d, posted } = deps();
    const att = await produceVerificationAttestation({
      deps: d, args, context: context({ verification: { toolchain_fingerprint_command: null } }), repoRoot: "/repo", requirementUid: null, ...bindings,
    });
    assert.equal(att, null);
    assert.equal(posted.length, 0);
  });

  it("returns null when verify could not establish stable pre/post bindings", async () => {
    const { deps: d, posted } = deps();
    const att = await produceVerificationAttestation({ deps: d, args, context: context(), repoRoot: "/repo", requirementUid: null, treeOid: null, toolchainDigest: null });
    assert.equal(att, null);
    assert.equal(posted.length, 0);
  });

  it("returns null when the base commit is unresolvable", async () => {
    const { deps: d } = deps({ runGit: async (r, a) => (a.includes("rev-parse") ? Promise.reject(new Error("no ref")) : { stdout: "1497-x\n", stderr: "" }) });
    const att = await produceVerificationAttestation({ deps: d, args, context: context(), repoRoot: "/repo", requirementUid: null, ...bindings });
    assert.equal(att, null);
  });

  it("never throws: a dep fault returns null", async () => {
    const { deps: d } = deps({ postVerificationAttestation: async () => { throw new Error("gh down"); } });
    const att = await produceVerificationAttestation({ deps: d, args, context: context(), repoRoot: "/repo", requirementUid: null, ...bindings });
    assert.equal(att, null);
  });

  it("parseRepoIdentity splits owner/name and rejects other shapes", () => {
    assert.deepEqual(parseRepoIdentity("autarchy-ai/Ground-Control"), { owner: "autarchy-ai", name: "Ground-Control" });
    assert.equal(parseRepoIdentity("nope"), null);
    assert.equal(parseRepoIdentity(null), null);
  });
});

describe("resolveToolchainFingerprintDigest", () => {
  const run = (out) => async () => ({ stdout: out, stderr: "" });

  it("accepts exactly one lowercase sha256 and rejects every other shape", async () => {
    const digest = "a".repeat(64);
    assert.equal(await resolveToolchainFingerprintDigest("/r", "cmd", run(`${digest}\n`)), digest);
    // Uppercase is not accepted (contract requires lowercase; no case folding).
    assert.equal(await resolveToolchainFingerprintDigest("/r", "cmd", run(`${"A".repeat(64)}\n`)), null);
    // Preceding output means the command did not emit exactly one value.
    assert.equal(await resolveToolchainFingerprintDigest("/r", "cmd", run(`noise\n${digest}\n`)), null);
    assert.equal(await resolveToolchainFingerprintDigest("/r", "cmd", run("not-a-digest")), null);
    assert.equal(await resolveToolchainFingerprintDigest("/r", "cmd", run("")), null);
  });
});

describe("resolveVerificationReuse / postFreshVerificationAttestation", () => {
  function commandRunner(fingerprint = `${"e".repeat(64)}\n`) {
    return async (file, args) => {
      if (file === "git" && args.includes("write-tree")) return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      if (file === "git") return { stdout: "", stderr: "" };
      if (file === "bash") return { stdout: fingerprint, stderr: "" };
      return { stdout: "", stderr: "" };
    };
  }
  function ctx(fingerprint = "node --version | shasum -a 256") {
    return {
      github_repo: "autarchy-ai/Ground-Control",
      workflow: {
        completion_command: "make mcp-test",
        policy_command: "make policy",
        base_branch: "dev",
        precommit_command: "pre-commit run --all-files",
        verification: { toolchain_fingerprint_command: fingerprint },
      },
    };
  }
  const shared = {
    repoRoot: "/repo",
    owner: "autarchy-ai",
    name: "Ground-Control",
    issueNumber: 1497,
    branchName: "1497-tier-publish-verification",
    baseSha: "c".repeat(40),
    requirementUid: "GC-O007",
  };

  it("reports the feature inactive when no fingerprint command is configured", () => {
    assert.equal(isVerificationAttestationActive({ workflow: {} }), false);
    assert.equal(isVerificationAttestationActive(ctx()), true);
  });

  it("returns active:false and keeps prior behavior when the feature is off", async () => {
    const reuse = await resolveVerificationReuse({
      ...shared,
      context: { workflow: {} },
      commandRunner: commandRunner(),
      attestationReader: async () => ({ ok: true, records: [] }),
    });
    assert.deepEqual(reuse, { active: false, attestation: null, reused: false });
  });

  it("returns reused:false with a fresh attestation when no trusted match exists", async () => {
    const reuse = await resolveVerificationReuse({
      ...shared,
      context: ctx(),
      commandRunner: commandRunner(),
      attestationReader: async () => ({ ok: true, records: [] }),
    });
    assert.equal(reuse.active, true);
    assert.equal(reuse.reused, false);
    assert.ok(reuse.attestation?.id);
  });

  it("returns reused:true when a trusted attestation matches the exact bindings", async () => {
    const first = await resolveVerificationReuse({
      ...shared,
      context: ctx(),
      commandRunner: commandRunner(),
      attestationReader: async () => ({ ok: true, records: [] }),
    });
    const reuse = await resolveVerificationReuse({
      ...shared,
      context: ctx(),
      commandRunner: commandRunner(),
      // A parsed-shaped record: structurally valid AND authenticated by this process.
      attestationReader: async () => ({ ok: true, records: [{ record: { ...first.attestation, valid: true, authenticated: true }, commentId: 3 }] }),
    });
    assert.equal(reuse.reused, true);
    assert.equal(reuse.attestation.id, first.attestation.id);
  });

  it("does not reuse when the matching marker is unauthenticated (forgery ignored)", async () => {
    const first = await resolveVerificationReuse({
      ...shared,
      context: ctx(),
      commandRunner: commandRunner(),
      attestationReader: async () => ({ ok: true, records: [] }),
    });
    const reuse = await resolveVerificationReuse({
      ...shared,
      context: ctx(),
      commandRunner: commandRunner(),
      attestationReader: async () => ({ ok: true, records: [{ record: { ...first.attestation, valid: true, authenticated: false }, commentId: 9 }] }),
    });
    assert.equal(reuse.reused, false);
  });

  it("fails closed (active:true, reused:false) with the feature on but a reader fault", async () => {
    const reuse = await resolveVerificationReuse({
      ...shared,
      context: ctx(),
      commandRunner: commandRunner(),
      attestationReader: async () => { throw new Error("gh down"); },
    });
    assert.equal(reuse.active, true);
    assert.equal(reuse.reused, false);
  });

  it("fails closed when the toolchain fingerprint has the wrong shape", async () => {
    const reuse = await resolveVerificationReuse({
      ...shared,
      context: ctx(),
      commandRunner: commandRunner("not-a-digest\n"),
      attestationReader: async () => ({ ok: true, records: [] }),
    });
    assert.equal(reuse.active, true);
    assert.equal(reuse.reused, false);
    assert.equal(reuse.attestation, null);
  });

  it("postFreshVerificationAttestation posts once for an active feature and no-ops when inactive", async () => {
    const posted = [];
    const writer = async (r, o, n, att) => { posted.push(att); };
    const args = {
      ...shared,
      // Both bindings are supplied by the verification boundary; postFresh never
      // runs the fingerprint command itself.
      treeOid: "a".repeat(40),
      toolchainDigest: "e".repeat(64),
      commandRunner: commandRunner(),
      attestationReader: async () => ({ ok: true, records: [] }),
      attestationWriter: writer,
    };
    const att = await postFreshVerificationAttestation({ ...args, context: ctx() });
    assert.ok(att?.id);
    assert.equal(posted.length, 1);
    // Inactive: nothing posted.
    const none = await postFreshVerificationAttestation({ ...args, context: { workflow: {} } });
    assert.equal(none, null);
    assert.equal(posted.length, 1);
    // A missing toolchain digest (boundary could not prove it stable) also no-ops.
    const noTool = await postFreshVerificationAttestation({ ...args, context: ctx(), toolchainDigest: null });
    assert.equal(noTool, null);
    assert.equal(posted.length, 1);
  });
});

describe("readImplementWorkingTreeOid", () => {
  let repo;

  before(async () => {
    repo = mkdtempSync(join(tmpdir(), "gc-verify-tree-"));
    await execFile("git", ["-C", repo, "init", "-q"]);
    await execFile("git", ["-C", repo, "config", "user.email", "t@t.test"]);
    await execFile("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    await execFile("git", ["-C", repo, "add", "-A"]);
    await execFile("git", ["-C", repo, "commit", "-qm", "init"]);
  });

  after(() => rmSync(repo, { recursive: true, force: true }));

  it("computes the exact tree a real staged commit would produce, without touching the real index", async () => {
    // A tracked edit plus a brand-new untracked file — both must be captured.
    writeFileSync(join(repo, "a.txt"), "two\n");
    writeFileSync(join(repo, "b.txt"), "new\n");
    const oid = await readImplementWorkingTreeOid(repo, execFile);
    assert.match(oid, /^[0-9a-f]{40}$/);
    // The real index is untouched: nothing is staged after the call.
    const { stdout: staged } = await execFile("git", ["-C", repo, "diff", "--cached", "--name-only"]);
    assert.equal(staged.trim(), "");
    // The throwaway-index oid equals a real `git add -A` + write-tree.
    await execFile("git", ["-C", repo, "add", "-A"]);
    const { stdout: realTree } = await execFile("git", ["-C", repo, "write-tree"]);
    assert.equal(oid, realTree.trim().toLowerCase());
  });
});
