// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { isAbsolute } from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readImplementGitOid, readRemoteImplementBranchSha } from "./codex-workflow-2.js";
import { buildImplementBaseSyncMarker, parseImplementBaseSyncMarkers } from "./codex-workflow.js";
import { detectSensitiveBodyContent } from "./grc-legacy-compat-2.js";
import { readIssueCommentsWithAuthors, resolveExecutionObligationTrust } from "./grc-legacy-compat-3.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX } from "./repo-vocabulary.js";
import { execFile } from "./runtime-primitives.js";

export async function postImplementBaseSyncRecord(
  repoRoot,
  owner,
  name,
  record,
  commandRunner = execFile,
) {
  const marker = buildImplementBaseSyncMarker(record);
  const body = [
    marker,
    "",
    "## Pre-PR base synchronization",
    "",
    `- Source: \`${record.remoteRef}\` at \`${record.fetchedBaseSha}\``,
    `- Outcome: \`${record.outcome}\``,
    `- Published feature head: \`${record.resultingFeatureSha}\``,
    `- Synchronized tree: \`${record.verifiedTreeSha}\``,
  ].join("\n");
  const sensitiveError = detectSensitiveBodyContent(body);
  if (sensitiveError) throw new Error(sensitiveError);
  if (Buffer.byteLength(body, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    throw new Error("Rendered synchronization record exceeds GitHub's issue-comment body limit");
  }
  const { stdout } = await commandRunner(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `/repos/${owner}/${name}/issues/${record.issueNumber}/comments`,
      "-f",
      `body=${body}`,
    ],
    { cwd: repoRoot },
  );
  const response = JSON.parse(stdout);
  return {
    commentUrl: typeof response?.html_url === "string" ? response.html_url : null,
    commentId: Number.isInteger(response?.id) ? response.id : null,
  };
}
export async function verifyPublishedImplementHead(
  repoRoot,
  branchName,
  expectedSha,
  commandRunner = execFile,
) {
  const localSha = await readImplementGitOid(repoRoot, "HEAD", commandRunner);
  const remoteSha = await readRemoteImplementBranchSha(repoRoot, branchName, commandRunner);
  return localSha === expectedSha && remoteSha === expectedSha;
}
export async function readTrustedImplementSyncRecord(
  repoRoot,
  owner,
  name,
  issueNumber,
  recordId,
) {
  const comments = await readIssueCommentsWithAuthors(repoRoot, owner, name, issueNumber);
  const trust = await resolveExecutionObligationTrust(repoRoot, owner, name, comments);
  const markerComments = comments
    .map((comment) => ({
      comment,
      records: parseImplementBaseSyncMarkers([comment.body], issueNumber),
    }))
    .filter(({ records }) => records.length > 0);
  if (markerComments.some(({ comment }) => !trust.isTrusted(comment))) {
    return {
      ok: false,
      error: "implement_pr_sync_record_untrusted",
      message: "A synchronization marker was authored outside the repository writer set",
    };
  }
  if (markerComments.some(({ records }) => records.some((record) => !record.valid))) {
    return {
      ok: false,
      error: "implement_pr_sync_record_malformed",
      message: "A malformed synchronization marker exists on the issue thread",
    };
  }
  const matches = markerComments
    .flatMap(({ comment, records }) => records.map((record) => ({ comment, record })))
    .filter(({ record }) => record.recordId === recordId);
  if (matches.length !== 1) {
    return {
      ok: false,
      error: matches.length === 0
        ? "implement_pr_sync_record_missing"
        : "implement_pr_sync_record_ambiguous",
      message: "Exactly one trusted synchronization record must match the requested record ID",
    };
  }
  const match = matches[0];
  return {
    ok: true,
    record: match.record,
    commentId: match.comment.id,
    commentUrl: match.comment.id == null
      ? null
      : `https://github.com/${owner}/${name}/issues/${issueNumber}#issuecomment-${match.comment.id}`,
  };
}
export async function listWorkingTreeChanges(repoPath) {
  const [tracked, untracked] = await Promise.all([
    execFile("git", ["-C", repoPath, "diff", "--name-only", "HEAD"]),
    execFile("git", ["-C", repoPath, "ls-files", "--others", "--exclude-standard"]),
  ]);

  const files = new Set();
  for (const output of [tracked.stdout, untracked.stdout]) {
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  }
  return Array.from(files).sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}
export const PACK_TYPES = ["CONTROL_PACK", "REQUIREMENTS_PACK", "CUSTOM"];
export const PACK_IMPORT_FORMATS = ["AUTO", "OSCAL_JSON", "GC_MANIFEST"];
export const CATALOG_STATUSES = ["AVAILABLE", "WITHDRAWN", "SUPERSEDED"];
export const TRUST_OUTCOMES = ["TRUSTED", "REJECTED", "UNKNOWN"];
export const INSTALL_OUTCOMES = ["INSTALLED", "UPGRADED", "REJECTED", "FAILED"];
export const TRUST_POLICY_FIELDS = [
  "publisher",
  "packId",
  "packType",
  "version",
  "sourceUrl",
  "checksum",
  "verifiedChecksum",
  "checksumVerified",
  "signerTrusted",
];
export const TRUST_POLICY_RULE_OPERATORS = ["EQUALS", "NOT_EQUALS", "CONTAINS", "IN_LIST"];
const _AUTO_FIX_RATIONALE_MAX = 240;
function _truncateForRationale(text) {
  if (typeof text !== "string" || text.length === 0) {
    return "Addressed by next cycle";
  }
  if (text.length <= _AUTO_FIX_RATIONALE_MAX) return text;
  return text.slice(0, _AUTO_FIX_RATIONALE_MAX - 1) + "…";
}
const _AUTO_FIX_SWEEP_EVIDENCE =
  "next review cycle re-reviews the full diff; structural sweep for analogues lives in the cycle loop";
function _autoFixId(f, idx) {
  return typeof f?.id === "string" && f.id.length > 0 ? f.id : `F${idx + 1}`;
}
function _autoFixTitle(f) {
  return typeof f?.title === "string" && f.title.length > 0 ? f.title : "(no title)";
}
// Synthesize a location from path:line when available — gives the agent a stable
// anchor when revisiting the finding in the next cycle. Null when no path.
function _autoFixLocation(f) {
  const path = typeof f?.path === "string" ? f.path : null;
  if (!path) return null;
  return typeof f?.line === "number" ? `${path}:${f.line}` : path;
}
function _autoFixSweepEvidence(f) {
  return typeof f?.sweep_evidence === "string" && f.sweep_evidence.length > 0
    ? f.sweep_evidence
    : _AUTO_FIX_SWEEP_EVIDENCE;
}
function _autoFixInstances(f) {
  return Array.isArray(f?.category?.instances)
    ? f.category.instances.filter((s) => typeof s === "string" && s.length > 0)
    : [];
}
function _buildAutoFixDecisionEntry(f, idx) {
  const classification = f?.classification === "class" ? "class" : "one-off";
  const entry = {
    id: _autoFixId(f, idx),
    title: _autoFixTitle(f),
    classification,
    decision: "fix",
    rationale: _truncateForRationale(typeof f?.body === "string" ? f.body : ""),
  };
  const location = _autoFixLocation(f);
  if (location) entry.location = location;
  if (classification === "one-off") {
    entry.sweep_evidence = _autoFixSweepEvidence(f);
  } else {
    entry.instances = _autoFixInstances(f);
  }
  return entry;
}
export function buildAutoFixDecisionFindings(findings) {
  const arr = Array.isArray(findings) ? findings : [];
  return arr.map((f, idx) => _buildAutoFixDecisionEntry(f, idx));
}
export function summarizeReviewFindings(findings, topCategoriesLimit = 5) {
  const arr = Array.isArray(findings) ? findings : [];
  let oneOffCount = 0;
  let classCount = 0;
  const categoryMap = new Map();
  for (const f of arr) {
    if (!f || typeof f !== "object") continue;
    const classification = f.classification === "class" ? "class" : "one-off";
    if (classification === "class") {
      classCount += 1;
      const shape = typeof f?.category?.shape === "string" ? f.category.shape : "(uncategorized)";
      const inst = Array.isArray(f?.category?.instances) ? f.category.instances.length : 0;
      const prev = categoryMap.get(shape) ?? { shape, instance_count: 0, finding_count: 0 };
      prev.instance_count += inst;
      prev.finding_count += 1;
      categoryMap.set(shape, prev);
    } else {
      oneOffCount += 1;
    }
  }
  const topCategories = Array.from(categoryMap.values())
    .sort((a, b) => {
      if (b.instance_count !== a.instance_count) return b.instance_count - a.instance_count;
      return a.shape.localeCompare(b.shape);
    })
    .slice(0, topCategoriesLimit);
  return {
    one_off_count: oneOffCount,
    class_count: classCount,
    top_categories: topCategories,
  };
}
export function _statusForReviewerAction(nextAction, hasFindings) {
  if (nextAction === "post_summary_and_escalate_to_user") return "capped";
  if (
    nextAction === "post_clean_decision_record_and_advance_to_phase_c" ||
    nextAction === "proceed_clean"
  ) {
    return "clean";
  }
  if (
    nextAction === "fix_findings_and_reinvoke" ||
    nextAction === "fix_findings_then_summarize_and_escalate"
  ) {
    return "findings";
  }
  // Any other next_action (e.g. shorten_findings_and_retry,
  // scrub_findings_and_retry, checkout_named_feature_branch) is a fatal
  // boundary error from the underlying review — surface as "post_failed"
  // so the agent stops dispatching.
  return hasFindings ? "findings" : "clean";
}
export function normalizeReviewCycleNextAction(reviewerAction, status) {
  if (status === "clean") {
    return "post_clean_decision_record_and_advance_to_phase_c";
  }
  if (status === "capped") {
    return "post_summary_and_escalate_to_user";
  }
  // For "findings" and "post_failed" the underlying vocabulary already
  // matches the wrapper's. Pass through.
  return reviewerAction;
}
export function reviewCycleFindings(reviewResult) {
  if (Array.isArray(reviewResult?.findings)) return reviewResult.findings;
  if (Array.isArray(reviewResult?.comments)) return reviewResult.comments;
  return [];
}
export const KNOWLEDGE_SOURCE_TYPES = Object.freeze([
  "commit",
  "pr",
  "review",
  "issue",
  "ci",
  "user-correction",
  "file",
]);
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const POSITIVE_INT_RE = /^[1-9]\d*$/;
const REPO_RELATIVE_PATH_RE = /^(?!\.\.(\/|$))(?!.*\/\.\.(\/|$))(?!\/)(?!.*\\)[^\s].*$/;
export function formatSourceCitation({ sourceType, sourceRef } = {}) {
  if (typeof sourceType !== "string" || sourceType.trim() === "") {
    return { ok: false, error: "source_type is required and must be a non-empty string" };
  }
  if (!KNOWLEDGE_SOURCE_TYPES.includes(sourceType)) {
    return {
      ok: false,
      error: `source_type must be one of ${KNOWLEDGE_SOURCE_TYPES.join(", ")} (got '${sourceType}')`,
    };
  }
  if (typeof sourceRef !== "string" || sourceRef.trim() === "") {
    return { ok: false, error: "source_ref is required and must be a non-empty string" };
  }
  return _normalizeSourceCitation(sourceType, sourceRef);
}

// Normalize per type. Each branch produces a single-line canonical ref
// so the resulting citation is safe to embed in a YAML scalar, a markdown
// bullet, or a git commit message subject without escaping.
function _normalizeSourceCitation(sourceType, sourceRef) {
  switch (sourceType) {
    case "commit": {
      const ref = sourceRef.trim().toLowerCase();
      if (!COMMIT_SHA_RE.test(ref)) {
        return {
          ok: false,
          error: `source_ref for 'commit' must be a 7–40 char hex SHA (got '${sourceRef}')`,
        };
      }
      return { ok: true, citation: `commit:${ref}` };
    }
    case "pr":
    case "issue": {
      const ref = sourceRef.trim().replace(/^#/, "");
      if (!POSITIVE_INT_RE.test(ref)) {
        return {
          ok: false,
          error: `source_ref for '${sourceType}' must be a positive integer (got '${sourceRef}')`,
        };
      }
      return { ok: true, citation: `${sourceType}:${ref}` };
    }
    case "review":
    case "ci": {
      // Review comment ids and CI run ids are opaque strings produced by
      // GitHub. Collapse any internal whitespace to a single space and
      // reject anything empty after trimming.
      const ref = sourceRef.trim().replace(/\s+/g, " ");
      if (ref === "") {
        return { ok: false, error: `source_ref for '${sourceType}' must be a non-empty id` };
      }
      return { ok: true, citation: `${sourceType}:${ref}` };
    }
    case "user-correction": {
      // User corrections are free-form short descriptions. Collapse
      // whitespace runs (including newlines) into single spaces so the
      // citation stays a single line safe for commit-message subjects.
      const ref = sourceRef.replace(/\s+/g, " ").trim();
      if (ref === "") {
        return { ok: false, error: "source_ref for 'user-correction' must be a non-empty description" };
      }
      return { ok: true, citation: `user-correction:${ref}` };
    }
    case "file": {
      const ref = sourceRef.trim();
      if (isAbsolute(ref)) {
        return { ok: false, error: `source_ref for 'file' must be a repo-relative path (got absolute path '${sourceRef}')` };
      }
      if (!REPO_RELATIVE_PATH_RE.test(ref)) {
        return { ok: false, error: `source_ref for 'file' must be a repo-relative path with no '..' segments (got '${sourceRef}')` };
      }
      return { ok: true, citation: `file:${ref}` };
    }
    default: {
      // Unreachable: KNOWLEDGE_SOURCE_TYPES is the only valid set and we
      // already validated membership above. Kept for defensive completeness
      // so a future addition to the list without a switch case fails fast.
      return { ok: false, error: `unsupported source_type '${sourceType}'` };
    }
  }
}
function stripSlugDashes(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}
export function buildInboxSlug(note) {
  const trimmed = (note || "").slice(0, 200).toLowerCase();
  // Dashes are trimmed by a linear character scan, not an anchored `-+$` regex,
  // which the analyzer reads as super-linear (S8786).
  const kebab = stripSlugDashes(trimmed.replace(/[^a-z0-9]+/g, "-"));
  const bounded = stripSlugDashes(kebab.slice(0, 40));
  return bounded || "note";
}
export function formatInboxTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, "").replaceAll(":", "-");
}
export function defaultSpawnIngest({ repoRoot, inboxFilePath, knowledge }) {
  const cliPath = fileURLToPath(new URL("./knowledge_ingest_cli.js", import.meta.url));
  const args = [
    cliPath,
    "--repo", repoRoot,
    "--inbox-file", inboxFilePath,
    "--knowledge-dir", knowledge.dir,
    "--knowledge-schema", knowledge.schema,
    "--knowledge-inbox", knowledge.inbox,
  ];
  const child = spawnChild(process.execPath, args, {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
