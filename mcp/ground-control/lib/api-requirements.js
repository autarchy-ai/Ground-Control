// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

export function isPathStrictlyInside(canonicalRoot, canonicalPath) {
  const rel = relative(canonicalRoot, canonicalPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
export function readAbsoluteTextFile(filePath) {
  if (!filePath || !isAbsolute(filePath)) {
    throw new Error("file_path must be an absolute path");
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- file_path is validated absolute input
  return readFileSync(filePath, "utf8");
}
export const CODEX_REVIEW_PREPUSH_HARD_CAP = 1;
export const CODEX_REVIEW_PREPUSH_MARKER_PREFIX = "<!-- gc:codex-prepush-cycle";
const CODEX_REVIEW_PREPUSH_MARKER_RE =
  /<!--\s*gc:codex-prepush-cycle\s+issue="(\d+)"\s+branch="((?:[^"\\]|\\.)*)"\s+cycle="(\d+)"[^]*?-->/g;
export function deriveIssueNumberFromBranch(branchName) {
  if (typeof branchName !== "string" || branchName === "") return null;
  const match = /^(\d+)(?:-|$)/.exec(branchName);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
/** The `{branch, cycle}` of every well-formed pre-push cycle marker for this issue in one body. */
export function parseCodexReviewPrePushCycleMarkerEntries(body, issueNumber) {
  if (typeof body !== "string") return [];
  const entries = [];
  for (const m of body.matchAll(CODEX_REVIEW_PREPUSH_MARKER_RE)) {
    if (Number.parseInt(m[1], 10) !== issueNumber) continue;
    // Validate branch attr is JSON-decodable so malformed markers don't
    // pollute counts. The cap never compares it against a specific branch; the
    // attribute is audit-only context there.
    let branch;
    try {
      branch = JSON.parse(`"${m[2]}"`);
    } catch {
      continue;
    }
    entries.push({ branch, cycle: Number.parseInt(m[3], 10) });
  }
  return entries;
}
export function parseCodexReviewPrePushCycleMarkers(commentBodies, issueNumber) {
  if (!Array.isArray(commentBodies)) return 0;
  return commentBodies.reduce(
    (count, body) => count + parseCodexReviewPrePushCycleMarkerEntries(body, issueNumber).length,
    0,
  );
}
export function evaluateCodexReviewPrePushCycleCap({
  priorCount,
  issueNumber,
  branchName,
  hardCap = CODEX_REVIEW_PREPUSH_HARD_CAP,
  overrideCap = false,
  overrideReason = null,
}) {
  if (typeof priorCount !== "number" || !Number.isFinite(priorCount) || priorCount < 0) {
    throw new Error(
      `evaluateCodexReviewPrePushCycleCap: priorCount must be a non-negative number, got ${priorCount}`,
    );
  }

  if (overrideCap === true) {
    if (typeof overrideReason !== "string" || overrideReason.trim() === "") {
      return {
        ok: false,
        error: "codex_review_prepush_override_missing_reason",
        message:
          "override_cap=true requires a non-empty override_reason quoting the user's authorization. " +
          "Audits cannot distinguish legitimate overrides from accidental ones without a reason.",
        issue_number: issueNumber,
        branch: branchName,
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
      next_action: "fix_findings_then_ask_over_cap_or_proceed",
    };
  }

  if (priorCount >= hardCap) {
    return {
      ok: false,
      error: "codex_review_prepush_cap_reached",
      message:
        `gc_codex_review pre-push hard cap reached (${hardCap} cycles) for issue #${issueNumber} ` +
        `on branch '${branchName}'. Per GC-O007 / ADR-099, summarize the completed-cycle findings, ` +
        `fixes, and verification, then ask whether to run cycle ${hardCap + 1} or proceed to Phase C. ` +
        `A clean verdict is not required to proceed. Do not silently re-invoke codex. If the user ` +
        `authorizes another cycle, retry with override_cap=true and ` +
        `override_reason="<their authorization>"; otherwise continue the workflow.`,
      issue_number: issueNumber,
      branch: branchName,
      prior_cycles: priorCount,
      cap: hardCap,
      next_action: "ask_over_cap_or_proceed",
    };
  }

  const nextCycle = priorCount + 1;
  return {
    ok: true,
    nextCycle,
    cap: hardCap,
    next_action:
      nextCycle === hardCap
        ? "fix_findings_then_ask_over_cap_or_proceed"
        : "fix_all_findings_and_restage",
  };
}
export function buildCodexReviewPrePushCycleMarker({
  issueNumber,
  branchName,
  cycleNumber,
  override = false,
  overrideReason = null,
  // The effective cap that gated this cycle. Defaults to the module constant
  // so legacy callers that don't pass it stay correct; new callers (issue #906)
  // pass the cfg-resolved cap so the marker headline reflects what the run
  // actually enforced.
  hardCap = CODEX_REVIEW_PREPUSH_HARD_CAP,
}) {
  const branchAttr = JSON.stringify(String(branchName)).slice(1, -1); // raw inner JSON-encoded form
  const overrideAttr = override === true ? ' override="true"' : "";
  const reasonAttr =
    override === true && typeof overrideReason === "string" && overrideReason.trim() !== ""
      ? ` reason=${JSON.stringify(overrideReason.trim())}`
      : "";
  const headline = override
    ? `_gc_codex_review pre-push cycle ${cycleNumber} (USER-AUTHORIZED OVERRIDE past cap ${hardCap}) complete for issue #${issueNumber} on branch '${branchName}'._`
    : `_gc_codex_review pre-push cycle ${cycleNumber} of ${hardCap} complete for issue #${issueNumber} on branch '${branchName}'._`;
  const reasonLine =
    override && typeof overrideReason === "string" && overrideReason.trim() !== ""
      ? `\nOverride reason: ${overrideReason.trim()}`
      : "";
  return [
    `${CODEX_REVIEW_PREPUSH_MARKER_PREFIX} issue="${issueNumber}" branch="${branchAttr}" cycle="${cycleNumber}"${overrideAttr}${reasonAttr} -->`,
    "",
    headline +
      ` Posted by the MCP server to enforce the pre-push hard-cap-${hardCap} contract (issues #796, #804, #906). ` +
      "Do not edit or delete — used by the next `gc_codex_review` (uncommitted) invocation to count cycles." +
      reasonLine,
  ].join("\n");
}
