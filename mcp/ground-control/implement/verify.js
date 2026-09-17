// Extracted from gc-implement-mechanical.js (issue #1355).
//
// The module had reached 1,231 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md). gc-implement-mechanical.js remains the tool entry point.

import { dominantGate, implementGateEnvironment, isVerificationAttestationActive, parseRepoIdentity, produceVerificationAttestation, readImplementBaseCommitOid, readImplementWorkingTreeOid, resolveVerificationReuse, resolveWorkflowPolicyCommand, runImplementCompletionPolicyGates, runVerifiedGateBoundary } from "../lib.js";
import { commandFailure, failure, readStatus } from "./gate-helpers.js";

// Resolve and validate everything verify needs before running gates: repository
// context, an authorized mutation checkout, a configured completion command, and
// the authorized requirement UID. Returns `{ failure }` on the first invalid input
// so the caller surfaces it unchanged.
async function resolveVerifyInputs(args, deps, action) {
  const context = await deps.getContext(args.repoPath);
  if (context?.status !== "ok") {
    return {
      failure: failure(
        action,
        "implement_mechanical_context_invalid",
        context?.errors?.join("; ") ?? "Ground Control repository context is unavailable",
        "repair_ground_control_context_and_retry",
      ),
    };
  }
  const authorization = await deps.authorizeRepo(args.repoPath);
  if (!authorization.ok) {
    return {
      failure: failure(
        action,
        authorization.error,
        authorization.message,
        "repair_authorized_checkout_and_retry",
      ),
    };
  }
  const command =
    context.workflow?.completion_command ?? context.workflow?.test_command;
  if (typeof command !== "string" || command.trim() === "") {
    return {
      failure: failure(
        action,
        "implement_mechanical_completion_command_missing",
        "No completion or test command is configured",
        "configure_a_completion_command_and_retry",
      ),
    };
  }
  // The repository's gates may need the requirement under test, which they
  // normally read from the branch name. A run that targets a requirement whose
  // branch carries no UID supplies it here instead (issue #1434). Building the
  // environment before the first gate keeps an invalid value from surfacing as
  // a misleading gate failure.
  const authorized = await deps.authorizeRequirementUid({
    repoPath: args.repoPath,
    issueNumber: args.issueNumber,
    requestedRequirementUid: args.requestedRequirementUid,
  });
  if (!authorized.ok) {
    return { failure: failure(action, authorized.error, authorized.message, authorized.next_action) };
  }
  return { context, repoRoot: authorization.repoRoot, command, authorized };
}

// Run the completion/policy gates through the attestation boundary (feature ON) or
// the shared runner (feature OFF). Returns the bound tree/toolchain identity and
// timings, or `{ ok: false, failure }` mapping the gate error to a refusal.
async function executeVerificationGates(
  { deps, action, repoRoot, context, childEnv, attestationActive, reuseKey },
) {
  let timings;
  let boundTreeOid = null;
  let boundToolchainDigest = null;
  try {
    if (attestationActive) {
      ({ treeOid: boundTreeOid, toolchainDigest: boundToolchainDigest, timings } = await runVerifiedGateBoundary({
        repoRoot,
        context,
        gateEnv: childEnv,
        commandRunner: deps.execFile,
        reportProgress: typeof deps.reportProgress === "function" ? deps.reportProgress : null,
        readTreeOid: () => readImplementWorkingTreeOid(repoRoot, deps.execFile),
        readStatus: () => readStatus(repoRoot, deps.runGit, deps.execFile),
        reuseKey,
      }));
    } else {
      ({ timings } = await runImplementCompletionPolicyGates({
        repoRoot,
        context,
        gateEnv: childEnv,
        commandRunner: deps.execFile,
        reportProgress: typeof deps.reportProgress === "function" ? deps.reportProgress : null,
      }));
    }
  } catch (error) {
    if (error.code === "implement_mechanical_gate_tree_changed") {
      return { ok: false, failure: failure(action, error.code, error.message ?? "A verification boundary changed the checkout", "inspect_and_commit_or_revert_gate_generated_changes") };
    }
    return { ok: false, failure: commandFailure(action, `${error.gatePhase ?? "completion"}_gate`, error) };
  }
  return { ok: true, timings, boundTreeOid, boundToolchainDigest };
}

async function resolveVerifyReuse({ deps, args, context, repoRoot, requirementUid }) {
  if (!isVerificationAttestationActive(context)) {
    return { active: false, reused: false, attestation: null, reason: "verification_reuse_disabled" };
  }
  try {
    const identity = parseRepoIdentity(context?.github_repo);
    if (!identity) return { active: true, reused: false, attestation: null, reason: "repository_identity_unavailable" };
    const { stdout } = await deps.runGit(repoRoot, ["branch", "--show-current"], deps.execFile);
    const baseBranch = context?.workflow?.base_branch ?? "dev";
    const baseSha = await readImplementBaseCommitOid(repoRoot, baseBranch, deps.runGit, deps.execFile);
    if (!baseSha) return { active: true, reused: false, attestation: null, reason: "base_commit_unavailable" };
    const reuse = await resolveVerificationReuse({
      context, repoRoot, owner: identity.owner, name: identity.name,
      issueNumber: args.issueNumber, branchName: stdout.trim(), baseSha, requirementUid,
      commandRunner: deps.execFile, attestationReader: deps.readVerificationAttestations,
    });
    return {
      ...reuse,
      phaseKey: reuse.attestation ? `${identity.owner}/${identity.name}:${reuse.attestation.id}` : null,
      reason: reuse.reused ? "trusted_attestation_match" : "trusted_attestation_miss",
    };
  } catch {
    return { active: true, reused: false, attestation: null, phaseKey: null, reason: "attestation_lookup_failed" };
  }
}

// The feature-OFF porcelain guard: the completion/policy gates must not mutate the
// checkout. Returns a bounded failure when the working tree changed, else null.
async function assertNoTreeChange(action, repoRoot, deps, before) {
  const after = await readStatus(repoRoot, deps.runGit, deps.execFile);
  if (after !== before) {
    return failure(
      action,
      "implement_mechanical_gate_tree_changed",
      "The completion or policy gate changed the checkout",
      "inspect_and_commit_or_revert_gate_generated_changes",
    );
  }
  return null;
}
export async function runVerify(args, deps) {
  const action = "verify";
  const inputs = await resolveVerifyInputs(args, deps, action);
  if (inputs.failure) return inputs.failure;
  const { context, repoRoot, command, authorized } = inputs;
  const gateEnv = implementGateEnvironment(authorized.requirementUid);
  const childEnv = gateEnv;
  const policyCommand = resolveWorkflowPolicyCommand(context);
  const attestationActive = isVerificationAttestationActive(context);
  const reuse = await resolveVerifyReuse({
    deps, args, context, repoRoot, requirementUid: authorized.requirementUid,
  });
  if (reuse.reused) {
    const timings = [
      { phase: "completion", duration_ms: 0, outcome: "reused" },
      { phase: "policy", duration_ms: 0, outcome: "reused" },
    ];
    return {
      ok: true,
      action,
      phase: "verification_complete",
      completion_command: command,
      policy_command: policyCommand,
      policy: "passed",
      timings,
      dominant_gate: null,
      attestation_id: reuse.attestation.id,
      verification_decision: "reused",
      verification_reason: reuse.reason,
      broad_gates_executed: 0,
      next_action: "run_required_agent_reviews_or_publish",
    };
  }
  // Feature ON: run through the ONE shared invariant-preserving boundary — the
  // same base synchronization uses (issue #1497) — which binds the working-tree
  // content oid + toolchain digest and re-validates them after the fingerprint
  // and after each gate, so the attestation can only describe the exact candidate
  // every gate observed. Feature OFF: keep the cheap porcelain no-mutation guard,
  // so a repo that never reuses pays nothing for the content-oid machinery.
  const before = attestationActive ? null : await readStatus(repoRoot, deps.runGit, deps.execFile);
  const gateOutcome = await executeVerificationGates({
    deps, action, repoRoot, context, childEnv, attestationActive,
    reuseKey: reuse.phaseKey ?? null,
  });
  if (!gateOutcome.ok) return gateOutcome.failure;
  const { timings, boundTreeOid, boundToolchainDigest } = gateOutcome;

  if (!attestationActive) {
    const treeChangeFailure = await assertNoTreeChange(action, repoRoot, deps, before);
    if (treeChangeFailure) return treeChangeFailure;
  }
  // Bind the boundary-proven tree + toolchain in a content-addressed attestation
  // so the publish band can reuse this authoritative verification instead of
  // re-running it on an unchanged tree (issue #1497). Best-effort: a producer
  // fault leaves no attestation, which is fail-closed — the consumer re-verifies.
  const attestation = await produceVerificationAttestation({
    deps,
    args,
    context,
    repoRoot,
    requirementUid: authorized.requirementUid,
    treeOid: boundTreeOid,
    toolchainDigest: boundToolchainDigest,
  });

  // The backend quality-gate rollup is retired (issue #1500): CI (GitHub) and Sonar
  // (direct-to-Sonar) are the real quality signals and run in the monitor band. The
  // verify band's job is the local gates above — completion command, policy, Vale,
  // and the no-tree-change guard — not a backend aggregation that no longer exists.
  const broadGatesExecuted = timings.filter(({ outcome }) => outcome !== "reused").length;
  return {
    ok: true,
    action,
    phase: "verification_complete",
    completion_command: command,
    policy_command: policyCommand,
    policy: "passed",
    timings,
    dominant_gate: dominantGate(timings),
    ...(attestation ? { attestation_id: attestation.id } : {}),
    verification_decision: broadGatesExecuted === 0 ? "reused" : "executed",
    verification_reason: broadGatesExecuted === 0 ? "phase_attestation_reuse" : reuse.reason,
    broad_gates_executed: broadGatesExecuted,
    next_action: "run_required_agent_reviews_or_publish",
  };
}

export function validateCommitMessage(message) {
  if (typeof message !== "string" || message.trim() === "") {
    return "commit_message is required";
  }
  if (/[\r\n]/.test(message)) return "commit_message must be a single line";
  if (/\b(?:codex|claude|chatgpt|openai|anthropic)\b|co-authored-by|generated with/i.test(message)) {
    return "commit_message must not contain assistant or vendor attribution";
  }
  return null;
}
// Sensitive staged paths, as one anchored alternation over three classes: a
// `.secret` directory (optional trailing `s`), a `credential`/`credentials`
// entry, or a private-key or certificate file by extension. The trailing `$`
// sits inside the key-file alternative, so its precedence is explicit (S5850),
// and factoring the shared path-boundary prefix keeps the whole pattern under
// the regex-complexity limit (S5843). Matching is unchanged.
export const SENSITIVE_STAGED_PATH_RE =
  /(?:^|\/)(?:\.secrets?(?:\/|$)|credentials?(?:[./]|$)|[^/]+\.(?:pem|key|p12|pfx)$)/i;
export function isSensitivePublishPath(path) {
  const basename = path.split("/").at(-1);
  const sensitiveEnv =
    /^\.env(?:\.|$)/i.test(basename)
    && !/^\.env\.(?:example|sample|template)$/i.test(basename);
  return sensitiveEnv || SENSITIVE_STAGED_PATH_RE.test(path);
}
export function splitNullPaths(stdout) {
  return stdout.split("\0").filter(Boolean);
}
export async function readPublishPaths(repoRoot, runGit, commandRunner) {
  const [tracked, staged, untracked] = await Promise.all([
    runGit(repoRoot, ["diff", "--name-only", "-z"], commandRunner),
    runGit(repoRoot, ["diff", "--cached", "--name-only", "-z"], commandRunner),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], commandRunner),
  ]);
  return [...new Set([
    ...splitNullPaths(tracked.stdout),
    ...splitNullPaths(staged.stdout),
    ...splitNullPaths(untracked.stdout),
  ])];
}
