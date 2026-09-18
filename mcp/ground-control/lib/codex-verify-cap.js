// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { CODEX_REVIEW_PREPUSH_HARD_CAP, buildCodexReviewPrePushCycleMarker, parseCodexReviewPrePushCycleMarkers } from "./api-requirements.js";
import { classifyChangedSurface } from "./doc-coverage.js";
import { getPullRequestClosingIssues, readIssueCommentBodies } from "./grc-legacy-compat-3.js";
import { enrichCommentsWithThreadIds } from "./grc-legacy-compat-4.js";
import { REVIEW_AUTO_DISPOSITION_JUDGE_SCHEMA, buildDispositionJudgePrompt, parseDispositionJudgeOutput, parseNumstatManifest, summarizeFindingsForDisposition } from "./review-cap-disposition.js";
import { execFile, execFileWithInput, reviewEngineEnv } from "./runtime-primitives.js";

const REVIEW_DISPOSITION_JUDGE_DEFAULT_MODEL = "claude-sonnet-5";
const REVIEW_DISPOSITION_JUDGE_TIMEOUT_MS = 1_800_000;

export const CODEX_VERIFY_HARD_CAP = 2;
export const CODEX_VERIFY_CYCLE_MARKER_PREFIX = "<!-- gc:codex-verify-cycle";
const CODEX_VERIFY_CYCLE_MARKER_RE =
  /<!--\s*gc:codex-verify-cycle\s+pr="(\d+)"\s+comment="(\d+)"\s+cycle="(\d+)"[^]*?-->/g;
export function parseCodexVerifyCycleMarkers(commentBodies, prNumber, commentId) {
  if (!Array.isArray(commentBodies)) return 0;
  let count = 0;
  for (const body of commentBodies) {
    if (typeof body !== "string") continue;
    for (const m of body.matchAll(CODEX_VERIFY_CYCLE_MARKER_RE)) {
      const markerPr = Number.parseInt(m[1], 10);
      const markerComment = Number.parseInt(m[2], 10);
      if (markerPr === prNumber && markerComment === commentId) count += 1;
    }
  }
  return count;
}
export function evaluateCodexVerifyCycleCap({
  priorCount,
  prNumber,
  commentId,
  hardCap = CODEX_VERIFY_HARD_CAP,
  overrideCap = false,
  overrideReason = null,
}) {
  if (typeof priorCount !== "number" || !Number.isFinite(priorCount) || priorCount < 0) {
    throw new Error(`evaluateCodexVerifyCycleCap: priorCount must be a non-negative number, got ${priorCount}`);
  }

  if (overrideCap === true) {
    if (typeof overrideReason !== "string" || overrideReason.trim() === "") {
      return {
        ok: false,
        error: "codex_verify_override_missing_reason",
        message:
          "override_cap=true requires a non-empty override_reason quoting the user's authorization. " +
          "Audits cannot distinguish legitimate overrides from accidents without a reason.",
        pr_number: prNumber,
        comment_id: commentId,
        prior_cycles: priorCount,
        cap: hardCap,
      };
    }
    return {
      ok: true,
      nextCycle: priorCount + 1,
      cap: hardCap,
      override: true,
      override_reason: overrideReason.trim(),
      next_action: "fix_finding_then_escalate_if_still_unresolved",
    };
  }

  if (priorCount >= hardCap) {
    return {
      ok: false,
      error: "codex_verify_cap_reached",
      message:
        `gc_codex_verify_finding hard cap reached (${hardCap} cycles) for comment #${commentId} ` +
        `on PR #${prNumber}. After cycle ${hardCap}, escalate to the user with the comment + verify ` +
        `history; do not silently re-invoke. If the user authorizes another verify call, retry with ` +
        `override_cap=true and override_reason="<user authorization>".`,
      pr_number: prNumber,
      comment_id: commentId,
      prior_cycles: priorCount,
      cap: hardCap,
      next_action: "escalate_finding_to_user",
    };
  }

  return {
    ok: true,
    nextCycle: priorCount + 1,
    cap: hardCap,
    next_action: priorCount + 1 === hardCap ? "fix_finding_then_escalate_if_still_unresolved" : "fix_finding_and_retry",
  };
}
export function buildCodexVerifyCycleMarker({ prNumber, commentId, cycleNumber, override = false, overrideReason = null }) {
  const overrideAttr = override === true ? ' override="true"' : "";
  const reasonAttr =
    override === true && typeof overrideReason === "string" && overrideReason.trim() !== ""
      ? ` reason=${JSON.stringify(overrideReason.trim())}`
      : "";
  const headline = override
    ? `_gc_codex_verify_finding cycle ${cycleNumber} (USER-AUTHORIZED OVERRIDE past cap ${CODEX_VERIFY_HARD_CAP}) complete for PR #${prNumber} comment #${commentId}._`
    : `_gc_codex_verify_finding cycle ${cycleNumber} of ${CODEX_VERIFY_HARD_CAP} complete for PR #${prNumber} comment #${commentId}._`;
  const reasonLine =
    override && typeof overrideReason === "string" && overrideReason.trim() !== ""
      ? `\nOverride reason: ${overrideReason.trim()}`
      : "";
  return [
    `${CODEX_VERIFY_CYCLE_MARKER_PREFIX} pr="${prNumber}" comment="${commentId}" cycle="${cycleNumber}"${overrideAttr}${reasonAttr} -->`,
    "",
    headline +
      " Posted by the MCP server to enforce the per-finding hard-cap-2 contract (issue #794). " +
      "Do not edit or delete — used by the next `gc_codex_verify_finding` invocation to count cycles." +
      reasonLine,
  ].join("\n");
}
export async function readPriorCodexVerifyCycleCount(repoRoot, owner, name, prNumber, commentId) {
  const bodies = await readIssueCommentBodies(repoRoot, owner, name, prNumber);
  return parseCodexVerifyCycleMarkers(bodies, prNumber, commentId);
}
export async function postCodexVerifyCycleMarker(repoRoot, owner, name, prNumber, commentId, cycleNumber, extras = {}) {
  const body = buildCodexVerifyCycleMarker({
    prNumber,
    commentId,
    cycleNumber,
    override: extras.override === true,
    overrideReason: extras.overrideReason ?? null,
  });
  await execFile(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `/repos/${owner}/${name}/issues/${prNumber}/comments`,
      "-f",
      `body=${body}`,
    ],
    { cwd: repoRoot },
  );
}
export async function readPriorCodexReviewPrePushCycleCount(repoRoot, owner, name, issueNumber) {
  const bodies = await readIssueCommentBodies(repoRoot, owner, name, issueNumber);
  return parseCodexReviewPrePushCycleMarkers(bodies, issueNumber);
}
export async function postCodexReviewPrePushCycleMarker(
  repoRoot,
  owner,
  name,
  issueNumber,
  branchName,
  cycleNumber,
  extras = {},
) {
  const body = buildCodexReviewPrePushCycleMarker({
    issueNumber,
    branchName,
    cycleNumber,
    override: extras.override === true,
    overrideReason: extras.overrideReason ?? null,
    hardCap: extras.hardCap ?? CODEX_REVIEW_PREPUSH_HARD_CAP,
  });
  await execFile(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `/repos/${owner}/${name}/issues/${issueNumber}/comments`,
      "-f",
      `body=${body}`,
    ],
    { cwd: repoRoot },
  );
}
export async function resolveFindingsRecordIssueNumber({
  repoRoot,
  uncommitted,
  effectivePr,
  prePushOwnership,
}) {
  if (uncommitted) {
    return prePushOwnership ? prePushOwnership.issueNumber : null;
  }
  if (effectivePr == null) return null;
  const closingIssues = await getPullRequestClosingIssues(repoRoot, effectivePr);
  if (closingIssues.length === 0) return null;
  return closingIssues[0];
}
export async function postCodexReviewFindingsComment({ repoRoot, owner, name, issueNumber, body }) {
  const { stdout } = await execFile(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `/repos/${owner}/${name}/issues/${issueNumber}/comments`,
      "-f",
      `body=${body}`,
    ],
    { cwd: repoRoot },
  );
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
export async function buildReviewerCommentsList({
  repoRoot,
  owner,
  name,
  prNumber,
  postResults,
  findings,
  reviewer,
}) {
  if (postResults.length === 0) {
    // No POST attempted (no PR, or zero findings). The placeholder carries
    // the full finding so the agent can act on it — `body` is the
    // authoritative finding detail per the new prompt (closes a gap flagged
    // in #793 review cycle 4 / post-push cycle 2). `classification`/`category`
    // (#830) ride along so the agent's review-response loop can take the
    // class-finding path (design at the category level, fix all instances at
    // once) instead of whack-a-mole'ing the named site.
    return findings.map((finding) => ({
      comment_id: null,
      thread_id: null,
      reviewer,
      path: finding.path,
      line: finding.line,
      title: `[${reviewer}] ${finding.title}`.slice(0, 200),
      body: finding.body,
      classification: finding.classification,
      ...(finding.category ? { category: finding.category } : {}),
      html_url: null,
    }));
  }

  // Resolve thread ids in one round-trip for the successful posts only.
  const successful = postResults.filter(
    (r) => r.ok && Number.isInteger(r.comment_id) && r.comment_id > 0,
  );
  if (successful.length === 0) return [];
  const threadMap = await enrichCommentsWithThreadIds({
    repoRoot,
    owner,
    name,
    prNumber,
    commentIds: successful.map((r) => r.comment_id),
  });
  return successful.map((result) => {
    const { finding } = result;
    return {
      comment_id: result.comment_id,
      thread_id: threadMap.get(result.comment_id) ?? null,
      reviewer,
      path: finding.path,
      line: finding.line,
      title: `[${reviewer}] ${finding.title}`.slice(0, 200),
      classification: finding.classification,
      ...(finding.category ? { category: finding.category } : {}),
      html_url: result.html_url,
    };
  });
}
export function collectDispositionSignals({
  reviewer,
  findingsSummary,
  diffManifest,
  changedPaths,
  priorAutoOverrides,
  repoRoot,
  diffMode,
}) {
  const diff = parseNumstatManifest(diffManifest);
  let surfaces = [];
  if (Array.isArray(changedPaths) && changedPaths.length > 0) {
    const { classifications } = classifyChangedSurface(changedPaths, repoRoot);
    surfaces = [...new Set(classifications.map((c) => c.surface_class))];
  }
  return {
    reviewer: reviewer ?? null,
    prior_auto_overrides: Number.isInteger(priorAutoOverrides) ? priorAutoOverrides : 0,
    diff,
    surfaces,
    // Derived server-side by the caller from the same selector the reviewer
    // used — never a caller assertion. Absent collapses to "unknown" rather
    // than "inline" so missing coverage is never scored as full coverage
    // (issue #1414).
    diff_mode: typeof diffMode === "string" ? diffMode : "unknown",
    findings: summarizeFindingsForDisposition(findingsSummary),
  };
}
export async function runDispositionJudge({ repoRoot, signalsSnapshot, config, reviewer, issueNumber, cycle, cap, signal }) {
  const model =
    config?.judge && typeof config.judge.model === "string" && config.judge.model.trim() !== ""
      ? config.judge.model
      : REVIEW_DISPOSITION_JUDGE_DEFAULT_MODEL;
  const prompt = buildDispositionJudgePrompt({ signalsSnapshot, reviewer, issueNumber, cycle, cap });
  const args = [
    "--print",
    "--model",
    model,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(REVIEW_AUTO_DISPOSITION_JUDGE_SCHEMA),
    "--add-dir",
    repoRoot,
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "Read Glob Grep",
  ];
  const childEnv = reviewEngineEnv();
  const { stdout } = await execFileWithInput("claude", args, {
    input: prompt,
    cwd: repoRoot,
    env: childEnv,
    maxBuffer: 10 * 1024 * 1024,
    timeoutMs: REVIEW_DISPOSITION_JUDGE_TIMEOUT_MS,
    signal,
  });
  return parseDispositionJudgeOutput(stdout);
}
export function effectiveReviewerCap(workflow, reviewer) {
  if (reviewer !== "codex") return null;
  const block = workflow?.codex_review;
  const configured = block && Number.isInteger(block.pre_push_cap) ? block.pre_push_cap : null;
  return configured ?? CODEX_REVIEW_PREPUSH_HARD_CAP;
}
