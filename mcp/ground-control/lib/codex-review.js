// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { EXECUTION_OBLIGATION_CATEGORIES, EXECUTION_OBLIGATION_DISPOSITIONS, EXECUTION_OBLIGATION_EVENTS, EXECUTION_OBLIGATION_ID_RE, EXECUTION_OBLIGATION_PAUSE_CLASSES, PHASE_MARKER_RE, parseIssueCommentUrl, validateBoundedText } from "./codex-workflow.js";

export function validateExecutionObligationInput(input) {
  const errors = [];
  if (input == null || typeof input !== "object") {
    return { ok: false, errors: ["input must be an object"] };
  }
  const {
    issueNumber,
    obligationId,
    event,
    category,
    observedState,
    evidence,
    impact,
    obligation,
    pauseClass,
    decisionRequest,
    disposition,
    correctiveAction,
    verification,
    userAuthorization,
  } = input;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) errors.push("issueNumber must be a positive integer");
  if (typeof obligationId !== "string" || !EXECUTION_OBLIGATION_ID_RE.test(obligationId)) {
    errors.push("obligationId must be 1-64 uppercase ASCII letters, digits, dots, underscores, or hyphens");
  }
  if (!EXECUTION_OBLIGATION_EVENTS.includes(event)) {
    errors.push(`event must be one of: ${EXECUTION_OBLIGATION_EVENTS.join(", ")}`);
  }
  if (!EXECUTION_OBLIGATION_CATEGORIES.includes(category)) {
    errors.push(`category must be one of: ${EXECUTION_OBLIGATION_CATEGORIES.join(", ")}`);
  }
  validateBoundedText(observedState, "observedState", errors);
  validateBoundedText(impact, "impact", errors);
  validateBoundedText(obligation, "obligation", errors);
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 10) {
    errors.push("evidence must contain 1-10 bounded strings");
  } else {
    evidence.forEach((item, index) => validateBoundedText(item, `evidence[${index}]`, errors, { max: 800 }));
  }

  if (event === "escalated") {
    if (!EXECUTION_OBLIGATION_PAUSE_CLASSES.includes(pauseClass)) {
      errors.push(`pauseClass must be one of: ${EXECUTION_OBLIGATION_PAUSE_CLASSES.join(", ")}`);
    }
    validateBoundedText(decisionRequest, "decisionRequest", errors);
  } else {
    if (pauseClass != null) errors.push("pauseClass is valid only for an escalated event");
    if (decisionRequest != null) errors.push("decisionRequest is valid only for an escalated event");
  }

  if (event === "resolved") {
    if (!EXECUTION_OBLIGATION_DISPOSITIONS.includes(disposition)) {
      errors.push(`disposition must be one of: ${EXECUTION_OBLIGATION_DISPOSITIONS.join(", ")}`);
    }
    validateBoundedText(correctiveAction, "correctiveAction", errors);
    if (!Array.isArray(verification) || verification.length === 0 || verification.length > 10) {
      errors.push("verification must contain 1-10 bounded strings");
    } else {
      verification.forEach((item, index) =>
        validateBoundedText(item, `verification[${index}]`, errors, { max: 800 }));
    }
    if (disposition === "wontfix") {
      validateBoundedText(userAuthorization, "userAuthorization", errors, { max: 800 });
      if (parseIssueCommentUrl(userAuthorization) == null) {
        errors.push("userAuthorization must be a durable GitHub issue-comment URL");
      }
    }
    if (
      disposition === "not-applicable"
      && typeof correctiveAction === "string"
      && !/\b(?:factually false|does not apply|not present|no matching|cannot occur)\b/i.test(correctiveAction)
    ) {
      errors.push("not-applicable requires correctiveAction proving the condition is factually false or does not apply");
    }
  } else {
    if (disposition != null) errors.push("disposition is valid only for a resolved event");
    if (correctiveAction != null) errors.push("correctiveAction is valid only for a resolved event");
    if (verification != null) errors.push("verification is valid only for a resolved event");
    if (userAuthorization != null) errors.push("userAuthorization is valid only for a resolved event");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
export function parsePhaseMarkers(commentBodies, issueNumber) {
  const phases = new Set();
  if (!Array.isArray(commentBodies)) return phases;
  for (const body of commentBodies) {
    if (typeof body !== "string") continue;
    for (const m of body.matchAll(PHASE_MARKER_RE)) {
      const phase = m[1];
      const markerIssue = Number.parseInt(m[2], 10);
      if (markerIssue === issueNumber) phases.add(phase);
    }
  }
  return phases;
}
function capPhrase(postPushCap, prepushCap) {
  // Equal-cap phrasing collapses to "hard-cap-N"; divergent caps surface
  // both values so the protocol description stays accurate if they ever
  // diverge. The same shape is reused by the override / override-reason
  // builders so a divergence shows up consistently across tool metadata.
  return postPushCap === prepushCap
    ? `hard-cap-${postPushCap}`
    : `hard-cap (post-push ${postPushCap}, pre-push ${prepushCap})`;
}
export function buildCodexReviewToolDescription({ postPushCap, prepushCap }) {
  return (
    "Run Codex against the current branch with a production-readiness review prompt. " +
    "Codex enumerates all material findings (no triage) and, when a pull request is " +
    "available, posts each finding as an inline PR review comment. Returns the list of " +
    "posted comment ids, enriched with GraphQL review-thread ids and a short file/line/" +
    "title preview so the coding agent can drive a fix/verify loop via " +
    "gc_codex_verify_finding. For post-push reviews (uncommitted=false) the tool " +
    "auto-detects the PR number for the current branch via `gh pr view` when " +
    "pr_number is omitted; pre-push reviews (uncommitted=true) target the issue " +
    "thread and only post inline PR review comments when pr_number is supplied " +
    `explicitly. Cycle-cap enforcement (${capPhrase(postPushCap, prepushCap)}): ` +
    `post-push reviews are capped at ${postPushCap} cycles per PR (issue #794); ` +
    `pre-push reviews are capped at ${prepushCap} cycles per issue, anchored to ` +
    "the resolved GitHub issue thread (issue #796 — the branch is recorded in the " +
    "marker for audit context but is not part of the cap key, so a branch rename " +
    "on the same issue cannot reset the counter). The tool refuses any over-cap " +
    "cycle (cycle cap+1 or later) unless override_cap=true with a non-empty " +
    "override_reason quoting the user's authorization; an already-authorized " +
    "override cycle does NOT carry forward — every subsequent over-cap cycle " +
    "requires its own user authorization. The result reports `diff_mode` " +
    "('inline' when the complete diff fit one prompt, 'manifest' when it did not) " +
    "and a bounded `review_coverage` {strategy, chunks_total, chunks_completed, " +
    "files_total, files_covered, complete}. An over-cap diff is split server-side " +
    "into bounded inline slices that both reviewers read as ONE logical cycle — " +
    "the reviewer is never asked to fetch per-file diffs itself (issue #1414). " +
    "When any slice fails to produce a valid reviewer envelope the tool returns " +
    "ok=false with error='review_coverage_incomplete' BEFORE writing any findings " +
    "record, decision record, or cycle marker, so the failed attempt does not " +
    "consume a cycle and a retry is free."
  );
}
export function buildCodexReviewOverrideCapDescription({ postPushCap, prepushCap }) {
  return (
    `Override the ${capPhrase(postPushCap, prepushCap)} cycle limit (post-push and ` +
    "pre-push). Only legitimate when the user has explicitly authorized the requested " +
    "over-cap cycle in the conversation. Authorization is per-cycle: a previous " +
    "override does not extend to the next cycle. Requires override_reason."
  );
}
export function buildCodexReviewOverrideReasonDescription({ postPushCap, prepushCap }) {
  // Cap-neutral example so the description does not re-drift when either cap
  // changes. The example references the next over-cap cycle relative to the
  // current state — not "the first cycle past cap N", since the override is
  // required for *every* over-cap cycle, not just cycle cap+1.
  const example =
    postPushCap === prepushCap
      ? `'user said: yes run cycle ${postPushCap + 1} to verify'`
      : "'user said: yes run the next over-cap cycle to verify'";
  return (
    `Required when override_cap=true. Quote the user's authorization (e.g. ${example}). ` +
    "Stored in the marker for audit."
  );
}
export function buildReviewCommentPostFailedEnvelope({
  repoRoot,
  baseBranch,
  uncommitted,
  effectivePr,
  prePushOwnership,
  recordIssueNumber,
  message,
  postError,
  cycleSource,
  comments,
  postFailures,
  parseErrors,
  core,
  security,
}) {
  return {
    repo_path: repoRoot,
    base_branch: baseBranch,
    uncommitted,
    pr_number: effectivePr,
    issue_number: prePushOwnership ? prePushOwnership.issueNumber : recordIssueNumber,
    branch: prePushOwnership ? prePushOwnership.branchName : null,
    ok: false,
    error: "review_comment_post_failed",
    message,
    next_action: "fix_underlying_issue_thread_post_failure_and_retry",
    review_comment_post_error: postError,
    attempted_cycle: cycleSource ? cycleSource.cycleNumber : null,
    attempted_cap: cycleSource ? cycleSource.cap : null,
    // cycle/cap fields stay null on the response — the cycle was NOT
    // consumed because no marker was written. Retry is free.
    cycle: null,
    cap: null,
    finding_count: comments.length,
    comments,
    post_failures: postFailures,
    parse_errors: parseErrors,
    core_review_text: core.body,
    security_review_text: security.body,
    reviewers: [
      { name: "core", finding_count: core.findings.length },
      { name: "security", finding_count: security.findings.length },
    ],
  };
}
const FINDINGS_COMMENT_BODY_MAX = 65535;
const FINDINGS_COMMENT_PER_REVIEWER_MAX = 28000;
/**
 * Neutralize every reserved marker sequence in reviewer prose before it is posted.
 *
 * Reviewer output is model text written over a diff, so its content is influenced by whatever the
 * branch contains. Other tool surfaces reject a caller-supplied `<!-- gc:` outright, but a review
 * comment has to be posted verbatim to stay a faithful record, so the sequence is disarmed instead.
 *
 * The disarm covers the whole `gc:` namespace, not just `gc:codex-`. Narrowing it to the review
 * markers left every other marker forgeable: a branch containing the literal text of a
 * `gc:phase phase="ready_for_review"` or `gc:execution-obligation-authorization` marker could have
 * it quoted into the thread by the reviewer, where the readers that gate on those markers cannot
 * tell a forged one from a marker the server wrote.
 */
function disarmMarkerSequences(text) {
  if (typeof text !== "string" || text === "") return text;
  return text.replace(/<!--(\s*gc:)/g, "&lt;!--$1");
}
function truncateReviewText(text, cap) {
  if (typeof text !== "string") return "";
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n\n_(truncated — full reviewer output exceeded ${cap} chars; see run logs.)_`;
}
function buildHeaderLine({ modeLabel, cycleNumber, cap, issueNumber, prNumber, branch }) {
  return modeLabel === "pre-push"
    ? `**gc_codex_review** — cycle ${cycleNumber} of ${cap} (${modeLabel}) on issue #${issueNumber}` +
        (branch ? ` (branch \`${branch}\`)` : "")
    : `**gc_codex_review** — cycle ${cycleNumber} of ${cap} (${modeLabel}) on PR #${prNumber} (issue #${issueNumber})`;
}
function chunkText(text, chunkSize) {
  if (typeof text !== "string" || text === "") return [""];
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}
export function renderReviewerEnvelope(reviewer) {
  const env = reviewer?.envelope;
  if (!env || typeof env !== "object") {
    return typeof reviewer?.body === "string" ? reviewer.body.trim() : "";
  }
  const lines = [];
  if (typeof env.verdict === "string" && env.verdict !== "") {
    lines.push(`**Verdict:** \`${env.verdict}\``, "");
  }
  if (typeof env.architectural_read === "string" && env.architectural_read.trim() !== "") {
    lines.push(env.architectural_read.trim(), "");
  }
  const blocking = Array.isArray(env.blocking) ? env.blocking : [];
  if (blocking.length === 0) {
    lines.push("_No blocking findings._");
  } else {
    lines.push(`**Blocking findings (${blocking.length}):**`, "");
    blocking.forEach((f, i) => {
      const cls = f?.classification === "class" ? "class" : "one-off";
      let loc = "";
      if (typeof f?.path === "string" && f.path !== "") {
        loc = typeof f?.line === "number" ? ` — \`${f.path}:${f.line}\`` : ` — \`${f.path}\``;
      }
      lines.push(`${i + 1}. **[${cls}]** ${f?.title ?? "(no title)"}${loc}`);
      if (typeof f?.body === "string" && f.body.trim() !== "") {
        lines.push(`   ${f.body.trim().replace(/\n/g, "\n   ")}`);
      }
    });
  }
  return lines.join("\n").trim();
}
export function mergeReviewerArchitecturalReads(core, security) {
  const parts = [];
  const coreRead = core?.envelope?.architectural_read;
  const secRead = security?.envelope?.architectural_read;
  if (typeof coreRead === "string" && coreRead.trim() !== "") {
    parts.push(`**Core reviewer:** ${coreRead.trim()}`);
  }
  if (typeof secRead === "string" && secRead.trim() !== "") {
    parts.push(`**Security reviewer:** ${secRead.trim()}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
export function formatReviewCoverageLine(diffMode, reviewCoverage) {
  if (diffMode !== "manifest" || reviewCoverage == null) {
    return "inline — the complete diff was supplied in one prompt";
  }
  const { strategy, chunks_completed: done, chunks_total: total, files_covered: covered, files_total: files } =
    reviewCoverage;
  return (
    `manifest — the complete diff exceeded one prompt and was reviewed as ` +
    `${done}/${total} inline slice(s) (${strategy}) covering ${covered}/${files} file(s)`
  );
}
export function buildCodexReviewFindingsComments({
  cycleNumber,
  cap,
  mode,
  issueNumber,
  prNumber = null,
  branch = null,
  coreReviewText,
  securityReviewText,
  postedComments = [],
  diffMode = null,
  reviewCoverage = null,
  // Server-written first line naming the verdict this record evidences (issue #1578). It is
  // inside the header so every size budget below already accounts for it.
  stationVerdictMarker = null,
}) {
  const modeLabel = mode === "pre-push" ? "pre-push" : "post-push";
  const headerLine = [
    ...(stationVerdictMarker ? [stationVerdictMarker, ""] : []),
    buildHeaderLine({ modeLabel, cycleNumber, cap, issueNumber, prNumber, branch }),
    // The durable record states how the diff reached the reviewers, so a
    // reader can tell a fully inlined review from a sliced one without
    // re-deriving it (issue #1414).
    ...(diffMode ? [`**Diff mode:** ${formatReviewCoverageLine(diffMode, reviewCoverage)}`] : []),
  ].join("\n");

  const safeCore = disarmMarkerSequences(coreReviewText && coreReviewText.trim() !== "" ? coreReviewText : "_(empty)_");
  const safeSecurity = disarmMarkerSequences(securityReviewText && securityReviewText.trim() !== "" ? securityReviewText : "_(empty)_");

  // Try to fit everything in one body first.
  const singleBodyLines = [
    headerLine,
    "",
    "## Core review",
    "",
    safeCore,
    "",
    "## Security review",
    "",
    safeSecurity,
  ];
  if (modeLabel === "post-push" && Array.isArray(postedComments) && postedComments.length > 0) {
    singleBodyLines.push("", "## Inline comments");
    singleBodyLines.push("");
    for (const c of postedComments) {
      const title = (c?.title ?? "").trim() || "(no title)";
      const url = c?.html_url ?? "";
      singleBodyLines.push(url ? `- [${title}](${url})` : `- ${title}`);
    }
  }
  const singleBody = singleBodyLines.join("\n");
  if (singleBody.length <= FINDINGS_COMMENT_BODY_MAX) {
    return [singleBody];
  }

  // Doesn't fit. Build the primary body with truncated reviewer text
  // (each reviewer caps at FINDINGS_COMMENT_PER_REVIEWER_MAX) and a
  // pointer to the continuation comments. Then chunk the FULL reviewer
  // text into continuation bodies.
  const primaryCore = truncateReviewText(safeCore, FINDINGS_COMMENT_PER_REVIEWER_MAX);
  const primarySecurity = truncateReviewText(safeSecurity, FINDINGS_COMMENT_PER_REVIEWER_MAX);
  const primaryLines = [
    headerLine,
    "",
    "## Core review",
    "",
    primaryCore,
    "",
    "## Security review",
    "",
    primarySecurity,
  ];
  if (modeLabel === "post-push" && Array.isArray(postedComments) && postedComments.length > 0) {
    primaryLines.push("", "## Inline comments");
    primaryLines.push("");
    for (const c of postedComments) {
      const title = (c?.title ?? "").trim() || "(no title)";
      const url = c?.html_url ?? "";
      primaryLines.push(url ? `- [${title}](${url})` : `- ${title}`);
    }
  }
  primaryLines.push("", "_(Reviewer text truncated to fit GitHub's comment cap; full verbatim text in continuation comments below.)_");
  let primaryBody = primaryLines.join("\n");
  if (primaryBody.length > FINDINGS_COMMENT_BODY_MAX) {
    primaryBody = primaryBody.slice(0, FINDINGS_COMMENT_BODY_MAX - 80) +
      `\n\n_(truncated — composed primary body exceeded ${FINDINGS_COMMENT_BODY_MAX} chars.)_`;
  }
  const bodies = [primaryBody];

  // Continuation bodies preserve the full verbatim reviewer text. Each
  // continuation has a header naming the section and chunk index. Chunk
  // size leaves headroom for the header.
  const continuationChunkSize = FINDINGS_COMMENT_BODY_MAX - 256;

  function addContinuationsForSection(label, fullText) {
    if (fullText.length <= FINDINGS_COMMENT_PER_REVIEWER_MAX) return;
    const overflow = fullText; // continuation comments carry the full text
    const chunks = chunkText(overflow, continuationChunkSize);
    chunks.forEach((chunk, idx) => {
      const continuationHeader = `**gc_codex_review** — cycle ${cycleNumber} of ${cap} (${modeLabel}) — ${label} continuation ${idx + 1}/${chunks.length} (issue #${issueNumber})`;
      bodies.push(`${continuationHeader}\n\n${chunk}`);
    });
  }

  addContinuationsForSection("Core review", safeCore);
  addContinuationsForSection("Security review", safeSecurity);

  return bodies;
}
export function buildCodexReviewFindingsComment(args) {
  return buildCodexReviewFindingsComments(args)[0];
}
export function collectPostFailures(perReviewer) {
  const failures = [];
  for (const { reviewer, results } of perReviewer) {
    results.forEach((r, idx) => {
      if (r.ok === false) {
        failures.push({
          reviewer,
          finding_index: idx,
          path: r.finding?.path ?? null,
          line: r.finding?.line ?? null,
          title: r.finding?.title ?? null,
          body: r.finding?.body ?? null,
          error: r.error,
        });
      }
    });
  }
  return failures;
}
