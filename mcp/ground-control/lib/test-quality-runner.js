// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { TEST_QUALITY_REVIEW_DEFAULT_MODEL } from "./ci-watcher.js";
import { detectSensitiveBodyContent } from "./grc-legacy-compat-2.js";
import { readIssueCommentBodies } from "./grc-legacy-compat-3.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX } from "./repo-vocabulary.js";
import { execFile } from "./runtime-primitives.js";
import { postStationReobservation } from "./station-observation-records.js";

export const TEST_QUALITY_REVIEW_HARD_CAP = 1;
export class ReviewerCapConfigError extends Error {
  constructor(blockName, configErrors) {
    super(
      `resolveReviewerPrePushCap: .ground-control.yaml failed validation while reading ` +
        `workflow.${blockName}.pre_push_cap — refusing to silently fall back to the module ` +
        `default. Validation errors: ${(configErrors || []).join("; ")}`,
    );
    this.name = "ReviewerCapConfigError";
    this.blockName = blockName;
    this.configErrors = configErrors;
  }
}
export const TEST_QUALITY_REVIEW_MARKER_PREFIX =
  "<!-- gc:test-quality-review-cycle";
const TEST_QUALITY_REVIEW_MARKER_RE =
  /<!--\s*gc:test-quality-review-cycle\s+issue="(\d+)"\s+branch="((?:[^"\\]|\\.)*)"\s+cycle="(\d+)"[^]*?-->/g;
const TEST_QUALITY_FINDINGS_MARKER_RE =
  /^<!-- gc:test-quality-review-findings issue="(\d+)" branch="((?:[^"\\]|\\.)*)" cycle="(\d+)" -->/;
/** The `{branch, cycle}` of every well-formed cycle marker for this issue in one body. */
export function parseTestQualityReviewCycleMarkerEntries(body, issueNumber) {
  if (typeof body !== "string") return [];
  const entries = [];
  for (const m of body.matchAll(TEST_QUALITY_REVIEW_MARKER_RE)) {
    if (Number.parseInt(m[1], 10) !== issueNumber) continue;
    try {
      entries.push({ branch: JSON.parse(`"${m[2]}"`), cycle: Number.parseInt(m[3], 10) });
    } catch {
      // A malformed branch attribute is not a marker this server wrote.
    }
  }
  return entries;
}
export function parseTestQualityReviewCycleMarkers(commentBodies, issueNumber) {
  if (!Array.isArray(commentBodies)) return 0;
  return commentBodies.reduce(
    (count, body) => count + parseTestQualityReviewCycleMarkerEntries(body, issueNumber).length,
    0,
  );
}
/** The `{issueNumber, cycle, branch}` a findings record opens with, or null. Anchored to the start. */
export function parseTestQualityReviewFindingsMarker(body) {
  const match = typeof body === "string" ? body.match(TEST_QUALITY_FINDINGS_MARKER_RE) : null;
  if (match == null) return null;
  try {
    return { issueNumber: Number(match[1]), branch: JSON.parse(`"${match[2]}"`), cycle: Number(match[3]) };
  } catch {
    return null;
  }
}
export function evaluateTestQualityReviewCycleCap({
  priorCount,
  issueNumber,
  branchName,
  hardCap = TEST_QUALITY_REVIEW_HARD_CAP,
  overrideCap = false,
  overrideReason = null,
}) {
  if (
    typeof priorCount !== "number" ||
    !Number.isFinite(priorCount) ||
    priorCount < 0
  ) {
    throw new Error(
      `evaluateTestQualityReviewCycleCap: priorCount must be a non-negative number, got ${priorCount}`,
    );
  }

  if (overrideCap === true) {
    if (typeof overrideReason !== "string" || overrideReason.trim() === "") {
      return {
        ok: false,
        error: "test_quality_review_override_missing_reason",
        message:
          "override_cap=true requires a non-empty override_reason quoting the user's authorization. " +
          "Audits cannot distinguish legitimate overrides from accidents without a reason.",
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
      next_action: "fix_findings_then_summarize_and_escalate",
    };
  }

  if (priorCount >= hardCap) {
    return {
      ok: false,
      error: "test_quality_review_cap_reached",
      message:
        `gc_test_quality_review hard cap reached (${hardCap} cycles) for issue #${issueNumber} ` +
        `on branch '${branchName}'. Per ADR-029 / #884 follow-up, after cycle ${hardCap} you must ` +
        `(a) post a summary of remaining findings + fix history to the issue thread, then (b) ` +
        `escalate to the user and ask whether to run cycle ${hardCap + 1} or ship as-is. Do not ` +
        `address findings by silently re-invoking the reviewer. If the user authorizes another ` +
        `cycle, retry with override_cap=true and override_reason="<their authorization>".`,
      issue_number: issueNumber,
      branch: branchName,
      prior_cycles: priorCount,
      cap: hardCap,
      next_action: "post_summary_and_escalate_to_user",
    };
  }

  const nextCycle = priorCount + 1;
  return {
    ok: true,
    nextCycle,
    cap: hardCap,
    next_action:
      nextCycle === hardCap
        ? "fix_findings_then_summarize_and_escalate"
        : "fix_findings_and_reinvoke",
  };
}
export function buildTestQualityReviewCycleMarker({
  issueNumber,
  branchName,
  cycleNumber,
  override = false,
  overrideReason = null,
  // Effective cap that gated this cycle. Defaults to the module constant for
  // legacy callers; runTestQualityReview passes the cfg-resolved cap so the
  // marker headline reflects what the run actually enforced (issue #906).
  hardCap = TEST_QUALITY_REVIEW_HARD_CAP,
}) {
  const branchAttr = JSON.stringify(String(branchName)).slice(1, -1);
  const overrideAttr = override === true ? ' override="true"' : "";
  const reasonAttr =
    override === true &&
    typeof overrideReason === "string" &&
    overrideReason.trim() !== ""
      ? ` reason=${JSON.stringify(overrideReason.trim())}`
      : "";
  const headline = override
    ? `_gc_test_quality_review cycle ${cycleNumber} (USER-AUTHORIZED OVERRIDE past cap ${hardCap}) complete for issue #${issueNumber} on branch '${branchName}'._`
    : `_gc_test_quality_review cycle ${cycleNumber} of ${hardCap} complete for issue #${issueNumber} on branch '${branchName}'._`;
  const reasonLine =
    override &&
    typeof overrideReason === "string" &&
    overrideReason.trim() !== ""
      ? `\nOverride reason: ${overrideReason.trim()}`
      : "";
  return [
    `${TEST_QUALITY_REVIEW_MARKER_PREFIX} issue="${issueNumber}" branch="${branchAttr}" cycle="${cycleNumber}"${overrideAttr}${reasonAttr} -->`,
    "",
    headline +
      ` Posted by the MCP server to enforce the gc_test_quality_review hard-cap-${hardCap} contract (issue #884 follow-up, default lowered in #906). ` +
      "Do not edit or delete — used by the next `gc_test_quality_review` invocation to count cycles." +
      reasonLine,
  ].join("\n");
}
export async function findChangedTestFiles({ repoRoot, baseBranch, includeUncommitted = false }) {
  if (typeof repoRoot !== "string" || repoRoot.trim() === "") {
    throw new Error("findChangedTestFiles: repoRoot must be a non-empty string");
  }
  if (typeof baseBranch !== "string" || baseBranch.trim() === "") {
    throw new Error("findChangedTestFiles: baseBranch must be a non-empty string");
  }
  let stdout = "";
  // Try origin/<base>...HEAD first; fall back to local <base>...HEAD; fetch
  // and retry as a last resort. Track resolved success vs empty-stdout-from-
  // empty-diff explicitly: a legitimately empty diff (HEAD == base, common
  // pre-push at #906's Step 6.6 before the first commit) must not trigger a
  // `git fetch` against an `origin` remote that may not exist.
  let baseResolved = false;
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    try {
      const result = await execFile("git", ["-C", repoRoot, "diff", "--name-only", `${ref}...HEAD`]);
      stdout = result.stdout;
      baseResolved = true;
      break;
    } catch {
      // try next
    }
  }
  if (!baseResolved) {
    try {
      await execFile("git", ["-C", repoRoot, "fetch", "origin", baseBranch]);
      const result = await execFile("git", [
        "-C",
        repoRoot,
        "diff",
        "--name-only",
        `origin/${baseBranch}...HEAD`,
      ]);
      stdout = result.stdout;
      baseResolved = true;
    } catch (err) {
      // In pre-push contexts (`includeUncommitted: true`) the staged + unstaged
      // + untracked diff carries the call, so an unresolvable base ref is
      // non-fatal. In post-push contexts the base ref is the only source, so
      // preserve the legacy hard-fail.
      if (!includeUncommitted) {
        throw new Error(
          `findChangedTestFiles: unable to resolve base ref '${baseBranch}': ${err.message}`,
        );
      }
    }
  }

  // Pre-push placement (issue #906): merge in the agent's staged + unstaged
  // + untracked test edits. `git diff --cached` covers staged; `git diff`
  // covers unstaged tracked edits; `git ls-files --others --exclude-standard`
  // covers brand-new untracked test files. Each list is allowed to fail
  // independently (e.g. brand-new repo with no HEAD) without taking down
  // the review.
  let uncommittedStdout = "";
  if (includeUncommitted) {
    for (const extraArgs of [["diff", "--name-only", "--cached"], ["diff", "--name-only"], ["ls-files", "--others", "--exclude-standard"]]) {
      try {
        const result = await execFile("git", ["-C", repoRoot, ...extraArgs]);
        uncommittedStdout += "\n" + result.stdout;
      } catch {
        // Best-effort: skip this list, continue with the others.
      }
    }
  }

  const combined = stdout + (uncommittedStdout ? "\n" + uncommittedStdout : "");
  return Array.from(
    new Set(
      combined
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        // Recognized test-file shapes:
        //   - `test_foo` / `foo_test.` / `FooTest.` — legacy Skill predicate.
        //   - `test/` (singular) and `tests/` (plural) directories — covers
        //     Maven-style `src/test/...`, `test/parser/...`, etc. (`test/`
        //     added per #906 codex cycle-3 F3).
        //   - `.test.<ext>` — JS / TS test convention (`foo.test.js`,
        //     `bar.test.ts`, `baz.test.tsx`). Added per #906 codex F3.
        //   - `.spec.<ext>` — alternate JS / TS test convention. Added per
        //     #906 codex F3.
        // The SKILL.md documents the broader test-glob contract; the predicate
        // here is the only place that contract is actually enforced. `test/`
        // is matched as either a leading segment or anywhere after a `/` so a
        // file like `src/test/parser/foo.py` qualifies while a file like
        // `latest_results.json` does not.
        .filter((path) => /(?:^|\/)tests?\/|test_|_test\.|Test\.|\.test\.|\.spec\./i.test(path))
        // Skill markdown is not a code file — exclude so the skill .md itself
        // never appears as a "test file" needing test-quality review.
        .filter((path) => !path.endsWith(".md")),
    ),
  );
}
export function buildTestQualityReviewFindingsComment({
  cycleNumber,
  cap,
  issueNumber,
  branch,
  findings,
  model = TEST_QUALITY_REVIEW_DEFAULT_MODEL,
}) {
  const lines = [];
  lines.push(
    `<!-- gc:test-quality-review-findings issue="${issueNumber}" branch="${JSON.stringify(String(branch)).slice(1, -1)}" cycle="${cycleNumber}" -->`,
  );
  lines.push("");
  lines.push(`## gc_test_quality_review cycle ${cycleNumber} of ${cap} — issue #${issueNumber}`);
  lines.push("");
  lines.push(`**Reviewer:** test-quality (${model} via gc_test_quality_review)  `);
  lines.push(`**Branch:** \`${branch}\`  `);
  lines.push(`**Cycle:** ${cycleNumber} / ${cap}  `);
  lines.push(`**Findings:** ${findings.length}${findings.length === 0 ? " (clean run)" : ""}`);
  if (findings.length > 0) {
    lines.push("");
    findings.forEach((f, i) => {
      lines.push(`### Finding ${i + 1} — [${f.severity}] \`${f.location}\``);
      lines.push("");
      lines.push(`**Problem:** ${f.problem}`);
      if (f.why_it_matters && f.why_it_matters.trim() !== "") {
        lines.push(`**Why it matters:** ${f.why_it_matters}`);
      }
      lines.push(`**Fix:** ${f.fix}`);
      if (i < findings.length - 1) lines.push("");
    });
  }
  return lines.join("\n");
}
export async function postFindingsRecordAndCycleMarker({
  repoRoot,
  owner,
  name,
  issueNumber,
  branchName,
  cycleNumber,
  override,
  overrideReason,
  recordBody,
  findingCount = 0,
  findings = [],
  // Effective cap (resolved by the caller from cfg + module default). Defaults
  // to the module constant for callers that don't pass it; issue #906 added
  // the cfg-resolved path through runTestQualityReview.
  hardCap = TEST_QUALITY_REVIEW_HARD_CAP,
  // Set when an earlier attempt at this logical cycle rendered no verdict and left a
  // station-observation obligation open (issue #1476). The resolution is written between the
  // findings record and the cycle marker so the cap is never consumed while the obligation is
  // still open — that combination is exactly the state that used to require a human to post an
  // authorization string for a defect nobody ever observed.
  stationObservation = null,
}) {
  // Body-size guard. GitHub's REST issue-comment endpoint rejects bodies
  // over 65535 chars; refuse at the boundary so the cycle isn't
  // half-spent if a verbose Claude run overruns. Same cap as
  // gc_post_decision_record / gc_post_final_report.
  if (recordBody.length > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return {
      ok: false,
      envelope: {
        ok: false,
        error: "test_quality_review_record_too_large",
        message:
          `rendered findings record is ${recordBody.length} bytes; GitHub issue-comment cap is ` +
          `${GITHUB_ISSUE_COMMENT_BODY_MAX}. Reduce verbose finding fields or split.`,
        issue_number: issueNumber,
        branch: branchName,
        next_action: "shorten_findings_and_retry",
        finding_count: findingCount,
        findings,
      },
    };
  }
  const sensitiveError = detectSensitiveBodyContent(recordBody);
  if (sensitiveError) {
    return {
      ok: false,
      envelope: {
        ok: false,
        error: "test_quality_review_record_rejected",
        message: `rendered findings record matched the sensitive-content guardrail; refusing to post. ${sensitiveError}`,
        issue_number: issueNumber,
        branch: branchName,
        next_action: "scrub_findings_and_retry",
        finding_count: findingCount,
        findings,
      },
    };
  }
  let recordUrl;
  try {
    recordUrl = await postIssueCommentAndReturnUrl({
      repoRoot,
      owner,
      name,
      issueNumber,
      body: recordBody,
    });
  } catch (err) {
    return {
      ok: false,
      envelope: {
        ok: false,
        error: "test_quality_review_record_post_failed",
        message: `findings record POST failed: ${err.message}`,
        issue_number: issueNumber,
        branch: branchName,
        next_action: "fix_github_posting_and_retry",
        finding_count: findingCount,
        findings,
      },
    };
  }

  // Re-observation resolution, bound to the record just posted, BEFORE the cap marker. If this
  // post fails the cycle stays unconsumed, so a retry is free — the inverse order would spend the
  // cap and leave the observation obligation open, which is the deadlock this issue removes.
  if (stationObservation != null) {
    const resolution = await postStationReobservation({
      repoRoot, owner, name, issueNumber, recordUrl, stationObservation,
    });
    if (!resolution.ok) {
      return {
        ok: false,
        envelope: {
          ok: false,
          error: "station_observation_resolution_post_failed",
          message:
            `the findings record posted at ${recordUrl} but the station-observation resolution ` +
            `for '${stationObservation.obligationId}' did not: ${resolution.message}. No cycle ` +
            `marker was written, so the cap is untouched and re-running is safe.`,
          issue_number: issueNumber,
          branch: branchName,
          findings_comment_url: recordUrl,
          next_action: "fix_github_posting_and_retry",
          finding_count: findingCount,
          findings,
        },
      };
    }
  }

  // Marker write — failure here is harder to recover from cleanly: the
  // record is durable on the thread but the cap counter never observed
  // this cycle. Return a structured envelope naming the orphaned record
  // so the caller can either back out (delete the record) or write a
  // fix-up marker by hand.
  const markerBody = buildTestQualityReviewCycleMarker({
    issueNumber,
    branchName,
    cycleNumber,
    override,
    overrideReason,
    hardCap,
  });
  try {
    await postIssueCommentAndReturnUrl({
      repoRoot,
      owner,
      name,
      issueNumber,
      body: markerBody,
    });
  } catch (err) {
    return {
      ok: false,
      envelope: {
        ok: false,
        error: "test_quality_review_marker_post_failed",
        message:
          `cycle marker POST failed AFTER the findings record was posted: ${err.message}. ` +
          `The record is durable at ${recordUrl}; the cycle counter did NOT observe this run. ` +
          `Either re-POST the marker manually OR delete the record and retry; do not silently retry ` +
          `the whole tool call (the record would duplicate).`,
        issue_number: issueNumber,
        branch: branchName,
        findings_comment_url: recordUrl,
        next_action: "manual_marker_repost_or_record_delete",
        finding_count: findingCount,
        findings,
      },
    };
  }
  return { ok: true, recordUrl };
}
export async function readPriorTestQualityReviewCycleCount(repoRoot, owner, name, issueNumber) {
  const bodies = await readIssueCommentBodies(repoRoot, owner, name, issueNumber);
  return parseTestQualityReviewCycleMarkers(bodies, issueNumber);
}
async function postIssueCommentAndReturnUrl({ repoRoot, owner, name, issueNumber, body }) {
  const { stdout } = await execFile(
    "gh",
    [
      "api",
      `/repos/${owner}/${name}/issues/${issueNumber}/comments`,
      "-f",
      `body=${body}`,
      "--jq",
      ".html_url",
    ],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}
export const AUDIT_TYPES = ["INTERNAL", "EXTERNAL", "REGULATORY", "SPECIAL"];
export const AUDIT_STATUSES = ["PLANNED", "IN_PROGRESS", "DRAFT_REPORT", "FINAL_REPORT", "CLOSED"];
export const AUDIT_PHASE_KINDS = ["PLANNING", "FIELDWORK", "REPORTING", "FOLLOWUP"];
export const AUDIT_LINK_TARGET_TYPES = [
  "FRAMEWORK", "ASSET", "CONTROL", "RISK_SCENARIO", "RISK_REGISTER_RECORD",
  "EVIDENCE", "FINDING", "EXTERNAL",
];
export const AUDIT_LINK_TYPES = ["SCOPES", "ASSESSES", "EVIDENCED_BY", "FOLLOWS_UP_ON", "ASSOCIATED"];
