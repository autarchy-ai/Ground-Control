// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRequirementByUid } from "./requirement-files.js";
import { codexEngineEnv } from "./codex-engine-env.js";
import { evaluateCodexVerifyCycleCap, postCodexVerifyCycleMarker, readPriorCodexVerifyCycleCount } from "./codex-verify-cap.js";
import { buildCodexArchitecturePreflightPrompt, getIssueContext } from "./codex-workflow-3.js";
import { formatWorkingTreeMutation } from "./command-failure-diagnostics.js";
import { buildCodexArchitectureExecArgs, findNewWorkingTreeChanges, readGeneratedCodexSummary } from "./codex-workflow.js";
import { getOwnerRepo, postPhaseMarker } from "./grc-legacy-compat-3.js";
import { enrichCommentsWithThreadIds, ensureGitRepo, fetchReviewCommentById } from "./grc-legacy-compat-4.js";
import { buildCodexVerifyPrompt, getRuntimeAllowedAuthors, parseCodexVerifyTail, postReviewCommentReply, resolveReviewThread } from "./issue-thread.js";
import { listWorkingTreeChanges } from "./knowledge-capture.js";
import { getRepoGroundControlContext } from "./repo-vocabulary-2.js";
import { getDefaultCodexTimeoutMs, execFileWithInput, formatCommandFailure } from "./runtime-primitives.js";
import { fetchPullRequest } from "./github-rest.js";

// Enough paths to identify what a failed run touched without turning the
// failure message into a directory listing; the full count travels alongside.
const PREFLIGHT_FAILURE_FILE_MAX = 20;

// Issue-first runs treat the GitHub issue as the authoritative contract. When no
// requirement anchors the run, a loadable issue body is mandatory: if the issue
// body could not be loaded (wrong repo, missing scope, gh CLI not authenticated,
// etc.) there is nothing for codex to reason about and no way for the caller to
// catch silent drift, so fail fast with a specific error that names the issue
// number and the underlying reason.
//
// Empty bodies are acceptable — GitHub returns `"body": ""` for valid title-only
// issues (common for bugs and refactors), and the title plus the diff still gives
// codex a usable context. Only fail when the body field is missing entirely
// (lookup failure) or when getIssueContext attached a `warning` field indicating
// the gh CLI call did not succeed.
function assertPreflightIssueContext(requirement, issueContext, issueNumber) {
  if (requirement != null) return;
  const lookupFailed =
    !issueContext
    || issueContext.warning !== undefined
    || !("body" in issueContext);
  if (!lookupFailed) return;
  const detail = issueContext?.warning
    ?? (issueContext == null
      ? "getIssueContext returned null"
      : "issue context has no body field");
  throw new Error(
    `gc_codex_architecture_preflight: issue-only run requires a loadable GitHub issue but failed to fetch issue #${issueNumber}: ${detail}`,
  );
}

// Best-effort read of the repo's architecture.vocabulary (issue #931) so the
// preflight can emit a "Design Vocabulary That Applies" section the pre-push
// reviewers consume. A missing or invalid block yields null and never blocks
// preflight.
async function resolvePreflightVocabulary(repoRoot) {
  try {
    const cfg = await getRepoGroundControlContext(repoRoot);
    if (cfg.status === "ok" && cfg.architecture?.vocabulary) {
      return cfg.architecture.vocabulary;
    }
  } catch {
    // best-effort
  }
  return null;
}

// Record the `preflight` phase marker on the issue thread so downstream tools
// (gc_post_implementation_plan etc.) can detect that preflight ran before they
// let the workflow advance. Marker post is best-effort — a failed post does not
// invalidate the preflight; the worst case is the next gating tool sees no marker
// and refuses, prompting the agent to re-run preflight (the correct fallback).
async function postPreflightPhaseMarker(repoRoot, issueNumber) {
  if (issueNumber == null) return null;
  try {
    const { owner, name } = await getOwnerRepo(repoRoot);
    await postPhaseMarker(repoRoot, owner, name, issueNumber, "preflight");
    return { phase: "preflight", issue_number: issueNumber };
  } catch (markerError) {
    // eslint-disable-next-line no-console
    console.error(
      `[gc_codex_architecture_preflight] phase marker post failed for issue #${issueNumber}: ${markerError.message}`,
    );
    return null;
  }
}

// A preflight killed at the wall cap has usually already written to the
// checkout: it runs codex under `--sandbox workspace-write`. The failure must
// name those paths, otherwise the mechanical result says only "failed" while
// the tree carries partial output the next attempt silently builds on
// (issue #1568). Best-effort — a git failure here must not mask the real
// failure being reported.
async function describeFailedPreflightMutation(repoRoot, preexistingChangedFiles) {
  try {
    const changed = findNewWorkingTreeChanges(
      preexistingChangedFiles,
      await listWorkingTreeChanges(repoRoot),
    );
    return {
      changed_files: changed.slice(0, PREFLIGHT_FAILURE_FILE_MAX),
      changed_file_count: changed.length,
      preexisting_changed_file_count: preexistingChangedFiles.length,
    };
  } catch (scanError) {
    return { working_tree_scan_error: scanError.message };
  }
}

export async function runCodexArchitecturePreflight({
  requirementUid,
  project,
  repoPath,
  issueNumber,
  repo,
  signal = undefined,
}) {
  // The /implement workflow supports two entry points: UID-first (a formal
  // Ground Control requirement) and issue-first (a requirement-free issue
  // for a bug, refactor, or maintenance run). Preflight must support both,
  // so at least one of the two anchors is required — an invocation with
  // neither has no subject to reason about.
  if (!requirementUid && issueNumber == null) {
    throw new Error(
      "gc_codex_architecture_preflight requires at least one of requirement_uid or issue_number",
    );
  }

  const repoRoot = await ensureGitRepo(repoPath);

  let requirement = null;
  let traceabilityLinks = [];
  if (requirementUid) {
    // Requirements are repo-local files now (ADR-093, issue #1500). A UID-first run names a
    // formal requirement, so a missing file is a hard error — the same fail-fast the former
    // REST 404 gave — not a silent skip that would let preflight reason about nothing.
    requirement = await readRequirementByUid(repoRoot, requirementUid);
    if (!requirement) {
      throw new Error(
        `requirement ${requirementUid} not found at docs/requirements/${requirementUid}/requirement.md`,
      );
    }
    traceabilityLinks = requirement.traceabilityLinks ?? [];
  }

  // `getIssueContext` is bound to `repoRoot` so `gh` resolves the target
  // repository from the checkout's git config even when `GH_REPO` is unset
  // and no explicit `repo` was supplied. This prevents the MCP server's own
  // working directory from leaking into the lookup.
  const issueContext = await getIssueContext(issueNumber, repo, { cwd: repoRoot });

  // Issue-first runs treat the GitHub issue as the authoritative contract; a
  // requirement-free run demands a loadable issue body before codex can reason.
  assertPreflightIssueContext(requirement, issueContext, issueNumber);

  const preexistingChangedFiles = await listWorkingTreeChanges(repoRoot);

  // Pass the repo's architecture.vocabulary (issue #931) so the preflight can
  // emit a "Design Vocabulary That Applies" section the pre-push reviewers
  // consume. Best-effort: a missing or invalid block does not block preflight.
  const preflightVocabulary = await resolvePreflightVocabulary(repoRoot);

  const tempDir = mkdtempSync(join(tmpdir(), "gc-codex-preflight-"));
  const outputPath = join(tempDir, "codex-last-message.txt");
  const prompt = buildCodexArchitecturePreflightPrompt({
    requirement,
    traceabilityLinks,
    issueContext,
    vocabulary: preflightVocabulary,
  });

  try {
    await execFileWithInput(
      "codex",
      buildCodexArchitectureExecArgs({ repoPath: repoRoot, outputPath }),
      {
        input: prompt,
        cwd: repoRoot,
        maxBuffer: 10 * 1024 * 1024,
        env: codexEngineEnv(),
        timeoutMs: getDefaultCodexTimeoutMs(),
        signal,
      },
    );

    const summary = readGeneratedCodexSummary(outputPath);
    const changedFiles = findNewWorkingTreeChanges(preexistingChangedFiles, await listWorkingTreeChanges(repoRoot));

    // Record the `preflight` phase marker on the issue thread so downstream
    // tools (gc_post_implementation_plan etc.) can detect that preflight ran
    // before they let the workflow advance.
    const phaseMarker = await postPreflightPhaseMarker(repoRoot, issueNumber);

    return {
      requirement_uid: requirementUid ?? null,
      issue_number: issueNumber ?? null,
      repo_path: repoRoot,
      preexisting_changed_files: preexistingChangedFiles,
      changed_files: changedFiles,
      summary,
      phase_marker: phaseMarker,
    };
  } catch (error) {
    const mutation = await describeFailedPreflightMutation(repoRoot, preexistingChangedFiles);
    const failure = new Error(
      `Codex architecture preflight failed: ${formatCommandFailure("codex", error)}`
      + ` | ${formatWorkingTreeMutation(mutation)}`,
    );
    // Structured twin of the message suffix, for callers that dispatch on the
    // result rather than read it. The async registry bounds and scrubs this
    // before it reaches a poll envelope.
    failure.diagnostics = {
      stage: "architecture_preflight",
      issue_number: issueNumber ?? null,
      requirement_uid: requirementUid ?? null,
      timed_out: error?.code === "ETIMEDOUT",
      ...mutation,
    };
    throw failure;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Fetch the review comment and confirm its author is trusted. Accept the
// allowlisted set or the PR author — in a local dev workflow gc_codex_review
// posts via the user's gh auth, so comments are authored by the user, not a bot.
async function fetchAuthorizedReviewComment({ repoRoot, owner, name, prNumber, commentId }) {
  const comment = await fetchReviewCommentById(repoRoot, owner, name, commentId);
  const author = comment?.user?.login;
  const allowed = getRuntimeAllowedAuthors();
  let prAuthorLogin = null;
  try {
    // REST pull-request read; `gh pr view` spent the shared GraphQL budget (issue #1584).
    prAuthorLogin = (await fetchPullRequest(repoRoot, owner, name, prNumber))?.author?.login || null;
  } catch {
    prAuthorLogin = null;
  }
  if (!author || (!allowed.has(author) && author !== prAuthorLogin)) {
    throw new Error(
      `Refusing to verify comment ${commentId}: author "${author}" is not in the allowlist and is not the PR author. ` +
        `Set GH_VERIFY_FINDING_AUTHORS to a comma-separated list of additional trusted logins if needed.`,
    );
  }
  return comment;
}

// Build the verify prompt, run codex read-only against the finding, and return
// its parsed tail verdict.
async function runCodexVerify({ repoRoot, comment, filePath, fileContents, line }) {
  const prompt = buildCodexVerifyPrompt({
    findingBody: String(comment.body || ""),
    filePath,
    fileContents,
    line,
  });

  let stdout;
  try {
    ({ stdout } = await execFileWithInput(
      "codex",
      ["exec", "--sandbox", "read-only", "-C", repoRoot, "-"],
      {
        input: prompt,
        cwd: repoRoot,
        maxBuffer: 10 * 1024 * 1024,
        env: codexEngineEnv(),
        timeoutMs: getDefaultCodexTimeoutMs(),
      },
    ));
  } catch (error) {
    throw new Error(`Codex verify failed: ${formatCommandFailure("codex", error)}`);
  }

  return parseCodexVerifyTail(stdout);
}

// Record the verify cycle marker after a successful run (whether the finding
// came back RESOLVED or UNRESOLVED — both are completed cycles). Marker-post
// failures are non-fatal, same policy as the cycle marker.
async function recordCodexVerifyCycleMarker({ repoRoot, owner, name, prNumber, commentId, verifyDecision }) {
  try {
    await postCodexVerifyCycleMarker(
      repoRoot,
      owner,
      name,
      prNumber,
      commentId,
      verifyDecision.nextCycle,
      { override: verifyDecision.override === true, overrideReason: verifyDecision.override_reason ?? null },
    );
  } catch (markerError) {
    // eslint-disable-next-line no-console
    console.error(
      `[gc_codex_verify_finding] cycle marker post failed for PR #${prNumber} comment #${commentId}: ${markerError.message}`,
    );
  }
}

// Resolved → mark the review thread resolved; unresolved → post the codex reply
// as a threaded reply on the original comment. Returns the terminal verify
// envelope for either outcome.
async function finalizeCodexVerifyResult({ repoRoot, owner, name, prNumber, commentId, threadId, parsed, verifyDecision }) {
  const capFields = {
    cycle: verifyDecision.nextCycle,
    cap: verifyDecision.cap,
    next_action: verifyDecision.next_action ?? null,
    override: verifyDecision.override === true,
    override_reason: verifyDecision.override_reason ?? null,
  };

  if (parsed.status === "resolved") {
    if (!threadId) {
      throw new Error(
        `Codex reported RESOLVED but no review thread was found for comment ${commentId}. Cannot mark the thread resolved.`,
      );
    }
    const resolved = await resolveReviewThread(repoRoot, threadId);
    return {
      repo_path: repoRoot,
      pr_number: prNumber,
      comment_id: commentId,
      thread_id: threadId,
      status: "resolved",
      thread_resolved: resolved,
      ...capFields,
    };
  }

  // Unresolved — post the reply as a threaded reply on the original comment.
  const replyComment = await postReviewCommentReply(
    repoRoot,
    owner,
    name,
    prNumber,
    commentId,
    parsed.reply,
  );
  return {
    repo_path: repoRoot,
    pr_number: prNumber,
    comment_id: commentId,
    thread_id: threadId,
    status: "unresolved",
    reply_comment_id: replyComment.id,
    reply_body: parsed.reply,
    reply_html_url: replyComment.html_url || null,
    ...capFields,
  };
}

export async function runCodexVerifyFinding({
  repoPath,
  prNumber,
  commentId,
  overrideCap = false,
  overrideReason = null,
}) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("pr_number must be a positive integer");
  }
  if (!Number.isInteger(commentId) || commentId <= 0) {
    throw new Error("comment_id must be a positive integer");
  }

  const repoRoot = await ensureGitRepo(repoPath);
  const { owner, name } = await getOwnerRepo(repoRoot);

  // Per-finding hard-cap-2 enforcement. Same template as the cycle cap but
  // keyed per (PR, comment_id). Refuses cycle 3+ unless overrideCap=true with
  // a non-empty reason.
  const priorVerifyCount = await readPriorCodexVerifyCycleCount(repoRoot, owner, name, prNumber, commentId);
  const verifyDecision = evaluateCodexVerifyCycleCap({
    priorCount: priorVerifyCount,
    prNumber,
    commentId,
    overrideCap,
    overrideReason,
  });
  if (!verifyDecision.ok) {
    return {
      repo_path: repoRoot,
      pr_number: prNumber,
      comment_id: commentId,
      ok: false,
      error: verifyDecision.error,
      message: verifyDecision.message,
      prior_cycles: verifyDecision.prior_cycles,
      cap: verifyDecision.cap,
      next_action: verifyDecision.next_action ?? null,
    };
  }

  const comment = await fetchAuthorizedReviewComment({ repoRoot, owner, name, prNumber, commentId });

  // Path and line the finding is anchored to. Prefer the current-diff line
  // when present, fall back to the original commit position.
  const filePath = comment.path;
  const line = comment.line ?? comment.original_line ?? null;
  if (!filePath) {
    throw new Error(`Comment ${commentId} has no \`path\` field — not an inline review comment`);
  }

  let fileContents;
  try {
    fileContents = readFileSync(join(repoRoot, filePath), "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${filePath} from the working tree: ${error.message}`);
  }

  // Resolve the REST comment id → GraphQL thread id before running codex,
  // because we'll need it for either the resolve or reply action.
  const threadMap = await enrichCommentsWithThreadIds({
    repoRoot,
    owner,
    name,
    prNumber,
    commentIds: [commentId],
  });
  const threadId = threadMap.get(commentId) || null;

  const parsed = await runCodexVerify({ repoRoot, comment, filePath, fileContents, line });

  await recordCodexVerifyCycleMarker({ repoRoot, owner, name, prNumber, commentId, verifyDecision });

  return finalizeCodexVerifyResult({
    repoRoot,
    owner,
    name,
    prNumber,
    commentId,
    threadId,
    parsed,
    verifyDecision,
  });
}
