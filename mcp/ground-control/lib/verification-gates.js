// Shared verification-gate execution + working-tree content identity (#1497).
//
// completion and policy are the authoritative local full verification. They run
// through ONE implementation here so verify (Step 6) and base synchronization
// (Step 8.5) can never drift into separate runners, separate error shapes, or
// separate size-safety. The size-safe runner from #1501 is used for the
// production default; an injected runner (tests) is honored unchanged.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_OBJECT_ID_RE, implementNetworkGitEnvironment } from "./codex-workflow.js";
import { resolveWorkflowPolicyCommand } from "./repo-context.js";
import { execFile } from "./runtime-primitives.js";
import { runGateCommand } from "./gate-command-runner.js";
import { computeVerificationAttestation, verificationAttestationMatches } from "./verification-attestation.js";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// Coalesce chunk-level activity into at most one progress snapshot per interval;
// the poll cadence is coarse, so per-chunk reporting would be pure overhead.
const PROGRESS_THROTTLE_MS = 500;
const PHASE_CACHE_MAX = 1000;
const successfulPhaseCache = new Map();

function phaseCacheKey(reuseKey, phase) {
  return typeof reuseKey === "string" && reuseKey !== "" ? `${reuseKey}:${phase}` : null;
}

function rememberSuccessfulPhase(key) {
  if (!key) return;
  successfulPhaseCache.delete(key);
  successfulPhaseCache.set(key, true);
  if (successfulPhaseCache.size > PHASE_CACHE_MAX) {
    successfulPhaseCache.delete(successfulPhaseCache.keys().next().value);
  }
}

export function resetVerificationPhaseCacheForTest() {
  successfulPhaseCache.clear();
}

// Per-phase progress reporter: the initial-and-throttled snapshot emitter plus
// the onActivity byte counter the gate runner drives. Extracted so the gate loop
// stays under the cognitive-complexity budget (S3776); the closures are unchanged.
function _makeGateProgressReporter(report, phase, phaseStartedMs) {
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let lastReportMs = 0;
  const emit = () => {
    if (!report) return;
    report({
      phase,
      phase_started_ms: phaseStartedMs,
      last_activity_ms: Date.now(),
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
    });
  };
  const onActivity = report
    ? (stream, bytes) => {
      if (stream === "stdout") stdoutBytes += bytes;
      else stderrBytes += bytes;
      const now = Date.now();
      if (now - lastReportMs >= PROGRESS_THROTTLE_MS) {
        lastReportMs = now;
        emit();
      }
    }
    : undefined;
  return { emit, onActivity };
}

// Run one gate to completion and return its timing plus the caught failure (or
// null). Never throws for a gate failure — the caller owns the throw so it can
// attach the accumulated timings.
async function _runGatePhase({ phase, command, gateRunner, repoRoot, gateEnv, report }) {
  const phaseStartedMs = Date.now();
  const { emit, onActivity } = _makeGateProgressReporter(report, phase, phaseStartedMs);
  emit();
  let failure = null;
  try {
    await gateRunner("bash", ["-c", command], { cwd: repoRoot, env: gateEnv, onActivity });
  } catch (error) {
    failure = error;
  }
  return {
    timing: { phase, duration_ms: Date.now() - phaseStartedMs, outcome: failure ? "failed" : "passed" },
    failure,
  };
}

/**
 * Run the configured completion gate, then the policy gate, through one
 * size-safe boundary. Returns `{ timings }`: a phase-ordered list of
 * `{ phase, duration_ms, outcome }`. On a gate failure it throws the gate error
 * with `gatePhase` and the timings-so-far attached; the policy gate is not
 * reached once completion fails.
 */
export async function runImplementCompletionPolicyGates({
  repoRoot,
  context,
  gateEnv,
  commandRunner = execFile,
  reportProgress = null,
  revalidate = null,
  reuseKey = null,
}) {
  const completionCommand =
    context?.workflow?.completion_command ?? context?.workflow?.test_command;
  if (typeof completionCommand !== "string" || completionCommand.trim() === "") {
    const error = new Error("No completion command is configured");
    error.code = "implement_completion_command_missing";
    throw error;
  }
  // Only the exit status matters, and a full suite's stdout on a large tree
  // overflows execFile's maxBuffer before the child exits (#1501); swap the
  // production default for the size-safe runner while honoring an injected one.
  const gateRunner = commandRunner === execFile ? runGateCommand : commandRunner;
  const gates = [
    { phase: "completion", command: completionCommand },
    { phase: "policy", command: resolveWorkflowPolicyCommand(context) },
  ];
  const report = typeof reportProgress === "function" ? reportProgress : null;
  const timings = [];
  for (const { phase, command } of gates) {
    const cacheKey = phaseCacheKey(reuseKey, phase);
    if (cacheKey && successfulPhaseCache.has(cacheKey)) {
      if (typeof revalidate === "function") await revalidate();
      timings.push({ phase, duration_ms: 0, outcome: "reused" });
      continue;
    }
    // Snapshots carry only numbers and the phase name — never command text,
    // child output, paths, or environment (issue #1497).
    const { timing, failure } = await _runGatePhase({
      phase, command, gateRunner, repoRoot, gateEnv, report,
    });
    timings.push(timing);
    if (failure) {
      failure.gatePhase = phase;
      failure.timings = timings;
      throw failure;
    }
    // Prove the bound inputs survived THIS gate before running the next, so a
    // gate that mutates a binding another gate later restores cannot pass the
    // boundary (issue #1497 codex review). A revalidation fault aborts the run.
    if (typeof revalidate === "function") await revalidate();
    rememberSuccessfulPhase(cacheKey);
  }
  return { timings };
}

/**
 * The invariant-preserving verification boundary shared by verify (Step 6) and
 * base synchronization (Step 8.5). It binds one candidate — the tree oid plus the
 * toolchain digest — and re-validates the checkout after the fingerprint command
 * AND after every gate, so the returned bindings describe exactly the candidate
 * that each successful gate observed (issue #1497 codex review). The repo-authored
 * fingerprint command is treated as a mutation boundary like any gate: it runs
 * before the gates (never after — a post-gate, pre-push run could amend the
 * verified commit), and any change to the tree, status, or digest across a
 * boundary aborts with implement_mechanical_gate_tree_changed. A configured
 * fingerprint that starts valid and changes during a gate aborts with
 * implement_verification_inputs_changed; a fingerprint that cannot initially
 * be resolved leaves `toolchainDigest` null and disables reuse. `readTreeOid`/
 * `readStatus` are injected so the
 * base-sync boundary binds the staged index tree while verify binds the working
 * tree, without either module importing the other.
 */
export async function runVerifiedGateBoundary({
  repoRoot, context, gateEnv, commandRunner = execFile, reportProgress = null,
  readTreeOid, readStatus, reuseKey = null,
}) {
  const fingerprintCommand = context?.workflow?.verification?.toolchain_fingerprint_command ?? null;
  const baseTree = await readTreeOid();
  const baseStatus = await readStatus();
  const assertUnchanged = async () => {
    if ((await readTreeOid()) !== baseTree || (await readStatus()) !== baseStatus) {
      const error = new Error("A completion, policy, or fingerprint boundary changed the checkout");
      error.code = "implement_mechanical_gate_tree_changed";
      throw error;
    }
  };
  const fingerprint = async () => {
    try {
      return await resolveToolchainFingerprintDigest(repoRoot, fingerprintCommand, commandRunner);
    } catch {
      return null;
    } finally {
      await assertUnchanged();
    }
  };
  let toolchainDigest = null;
  if (fingerprintCommand) toolchainDigest = await fingerprint();
  const revalidate = async () => {
    await assertUnchanged();
    if (!fingerprintCommand || toolchainDigest == null) return;
    const recheck = await fingerprint();
    if (!recheck || recheck !== toolchainDigest) {
      const error = new Error("A completion or policy gate changed a fingerprinted verification input");
      error.code = "implement_verification_inputs_changed";
      throw error;
    }
  };
  const { timings } = await runImplementCompletionPolicyGates({
    repoRoot, context, gateEnv, commandRunner, reportProgress, revalidate, reuseKey,
  });
  return { treeOid: baseTree, toolchainDigest, timings };
}

/** The completed gate with the greatest duration — the latency dominator the
 * timing envelope reports. Returns null for an empty list. */
export function dominantGate(timings) {
  if (!Array.isArray(timings) || timings.length === 0) return null;
  const executed = timings.filter(({ outcome }) => outcome !== "reused");
  if (executed.length === 0) return null;
  // Explicit initial value (S6959) — the empty case already returned above.
  return executed.reduce(
    (max, entry) => (entry.duration_ms > max.duration_ms ? entry : max),
    executed[0],
  ).phase;
}

/**
 * Content identity of the working tree: the Git tree object of HEAD with every
 * tracked, staged, untracked-but-not-ignored, and deleted change applied,
 * computed in a THROWAWAY index so verify never mutates the real one. This is
 * the exact tree object the eventual `git add -A` + commit produces when the
 * working tree is unchanged, so it is the byte-exact content the attestation
 * binds.
 */
export async function readImplementWorkingTreeOid(repoRoot, commandRunner = execFile) {
  // The throwaway index MUST live outside the working tree. A repo that does not
  // ignore its build directory would otherwise capture the index file itself and
  // make the tree oid non-reproducible. An OS temp dir is never part of the
  // `git add` working-tree scan; object writes still go to the repo's object DB.
  const scratchDir = mkdtempSync(join(tmpdir(), "gc-verify-tree-"));
  const indexFile = join(scratchDir, "index");
  const env = { ...implementNetworkGitEnvironment(), GIT_INDEX_FILE: indexFile };
  const git = (args) =>
    commandRunner(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", repoRoot, ...args],
      { cwd: repoRoot, env },
    );
  try {
    // read-tree HEAD seeds the index so `add -A` also records deletions, not
    // just current files; write-tree then emits the exact staged-commit tree.
    await git(["read-tree", "HEAD"]);
    await git(["add", "-A"]);
    const { stdout } = await git(["write-tree"]);
    const oid = stdout.trim().toLowerCase();
    if (!GIT_OBJECT_ID_RE.test(oid)) {
      throw new Error("Git returned an invalid working-tree object ID");
    }
    return oid;
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup of the throwaway index.
    }
  }
}

export function parseRepoIdentity(githubRepo) {
  if (typeof githubRepo !== "string") return null;
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(githubRepo.trim());
  return match ? { owner: match[1], name: match[2] } : null;
}

/** The freshly resolvable configured base commit, or null when the local
 * origin ref is absent. Read-only: no fetch happens here (base synchronization
 * owns the fetch); a base that moves since verify is a later cache miss. */
export async function readImplementBaseCommitOid(repoRoot, baseBranch, runGit, commandRunner = execFile) {
  try {
    const { stdout } = await runGit(
      repoRoot,
      ["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}^{commit}`],
      commandRunner,
    );
    const oid = stdout.trim().toLowerCase();
    return GIT_OBJECT_ID_RE.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/** Run the repo-authored toolchain fingerprint command and return its single
 * lowercase SHA-256, or null when it fails or emits any other shape. The command
 * is repo-authored and must be read-only and free of credentials.
 *
 * The command runs through execFile, NOT the size-safe gate runner: the gate
 * runner keeps only a bounded output tail, which would let a command emit
 * arbitrary preceding data and finish with a valid-looking digest that the tail
 * accepts as if it were the only value. execFile captures the complete stdout and
 * rejects (via maxBuffer) a command that floods it — a fingerprint is a single
 * 65-byte line, so that ceiling is ample. The raw output is validated without
 * case folding, since the contract requires exactly one lowercase SHA-256. */
export async function resolveToolchainFingerprintDigest(repoRoot, command, commandRunner = execFile) {
  const { stdout } = await commandRunner("bash", ["-c", command], { cwd: repoRoot });
  const out = typeof stdout === "string" ? stdout.trim() : "";
  return SHA256_HEX_RE.test(out) ? out : null;
}

function attestationConfigInput(context) {
  return {
    base_branch: context?.workflow?.base_branch ?? null,
    precommit_command: context?.workflow?.precommit_command ?? null,
  };
}

/** Whether the tiered-verification attestation is active for this repo — a
 * toolchain fingerprint command is configured. When off, callers keep their
 * existing behavior unchanged and no attestation is ever formed. */
export function isVerificationAttestationActive(context) {
  return Boolean(context?.workflow?.verification?.toolchain_fingerprint_command);
}

/**
 * Compute the content-addressed attestation for the CURRENT working tree under
 * the given bindings, or null when it cannot be formed (no fingerprint, an
 * unresolvable base or toolchain digest). Shared by the producer (verify) and
 * the consumer (base synchronization) so both bind identical inputs.
 */
async function computeCurrentVerificationAttestation({
  context, repoRoot, issueNumber, branchName, baseSha, requirementUid, commandRunner,
  treeOid = null, toolchainDigest = null,
}) {
  const fingerprintCommand = context?.workflow?.verification?.toolchain_fingerprint_command ?? null;
  if (!fingerprintCommand) return null;
  if (!GIT_OBJECT_ID_RE.test(baseSha ?? "")) return null;
  const resolvedTree = treeOid ?? (await readImplementWorkingTreeOid(repoRoot, commandRunner));
  const resolvedToolchain =
    toolchainDigest ?? (await resolveToolchainFingerprintDigest(repoRoot, fingerprintCommand, commandRunner));
  if (!resolvedToolchain) return null;
  return computeVerificationAttestation({
    issueNumber,
    branchName,
    baseSha,
    treeOid: resolvedTree,
    requirementUid,
    completionCommand: context?.workflow?.completion_command ?? context?.workflow?.test_command,
    policyCommand: resolveWorkflowPolicyCommand(context),
    toolchainFingerprintCommand: fingerprintCommand,
    config: attestationConfigInput(context),
    toolchainDigest: resolvedToolchain,
  });
}

/**
 * Best-effort production of the verification attestation (issue #1497, Step 6
 * verify). `treeOid` and `toolchainDigest` are the bindings verify captured
 * BEFORE the gates and re-validated as unchanged AFTER them, so the attestation
 * describes exactly the inputs the gates evaluated — a gate that mutates the tree
 * or a toolchain input yields no attestation (both are required here). Returns
 * the attestation on success, or null when reuse cannot be authorized. Never
 * throws, so a producer fault can never fail the gate that already passed.
 */
export async function produceVerificationAttestation({
  deps, args, context, repoRoot, requirementUid, treeOid, toolchainDigest,
}) {
  try {
    if (!isVerificationAttestationActive(context)) return null;
    if (!treeOid || !toolchainDigest) return null;
    const identity = parseRepoIdentity(context?.github_repo);
    if (!identity) return null;
    const { stdout: branchOut } = await deps.runGit(repoRoot, ["branch", "--show-current"], deps.execFile);
    const baseBranch = context?.workflow?.base_branch ?? "dev";
    const baseSha = await readImplementBaseCommitOid(repoRoot, baseBranch, deps.runGit, deps.execFile);
    if (!baseSha) return null;
    const attestation = await computeCurrentVerificationAttestation({
      context,
      repoRoot,
      issueNumber: args.issueNumber,
      branchName: branchOut.trim(),
      baseSha,
      requirementUid,
      commandRunner: deps.execFile,
      treeOid,
      toolchainDigest,
    });
    if (!attestation) return null;
    // A repeated identical content id is an idempotent hit, not a second post.
    const existing = await deps.readVerificationAttestations(repoRoot, identity.owner, identity.name, args.issueNumber);
    const alreadyPosted = Boolean(existing?.ok) && existing.records.some(({ record }) => verificationAttestationMatches(record, attestation));
    if (!alreadyPosted) {
      await deps.postVerificationAttestation(repoRoot, identity.owner, identity.name, attestation);
    }
    return attestation;
  } catch {
    return null;
  }
}

/**
 * Decide whether the publish band may reuse a prior verification for the CURRENT
 * tree instead of re-running the authoritative gates (issue #1497).
 * - active:false → feature off; the caller keeps its existing behavior.
 * - active:true, reused:true → a trusted attestation for the exact current
 *   bindings exists; the caller skips full verification.
 * - active:true, reused:false → no match, or evidence could not be read; the
 *   caller MUST run full verification. `attestation` (when non-null) is the
 *   fresh record to post after that verification passes.
 * Fail-closed: with the feature ON, any fault yields active:true/reused:false so
 * the caller runs full verification rather than trusting an unproven tree.
 */
export async function resolveVerificationReuse({
  context, repoRoot, owner, name, issueNumber, branchName, baseSha, requirementUid,
  commandRunner = execFile, attestationReader, treeOid = null,
}) {
  if (!isVerificationAttestationActive(context)) return { active: false, attestation: null, reused: false };
  try {
    const attestation = await computeCurrentVerificationAttestation({
      context, repoRoot, issueNumber, branchName, baseSha, requirementUid, commandRunner, treeOid,
    });
    if (!attestation) return { active: true, attestation: null, reused: false };
    const existing = await attestationReader(repoRoot, owner, name, issueNumber);
    const reused = Boolean(existing?.ok) && existing.records.some(({ record }) => verificationAttestationMatches(record, attestation));
    return { active: true, attestation, reused };
  } catch {
    return { active: true, attestation: null, reused: false };
  }
}

/**
 * Post a fresh attestation for a just-verified tree (base synchronization's merge
 * path), best-effort and gated on the feature being active. Both `treeOid` and
 * `toolchainDigest` are the exact bindings the verification boundary proved
 * stable, so NO fingerprint command runs here — running it after the gates and
 * before push would be a tree-replacement vector (issue #1497 codex review).
 */
export async function postFreshVerificationAttestation({
  context, repoRoot, owner, name, issueNumber, branchName, baseSha, treeOid, toolchainDigest, requirementUid,
  commandRunner = execFile, attestationReader, attestationWriter,
}) {
  try {
    if (!toolchainDigest) return null;
    const attestation = await computeCurrentVerificationAttestation({
      context, repoRoot, issueNumber, branchName, baseSha, requirementUid, commandRunner, treeOid, toolchainDigest,
    });
    if (!attestation) return null;
    const existing = await attestationReader(repoRoot, owner, name, issueNumber);
    const alreadyPosted = Boolean(existing?.ok) && existing.records.some(({ record }) => verificationAttestationMatches(record, attestation));
    if (!alreadyPosted) {
      await attestationWriter(repoRoot, owner, name, attestation);
    }
    return attestation;
  } catch {
    return null;
  }
}
