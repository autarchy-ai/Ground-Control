// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { detectSensitiveBodyContent, extractGhErrorMessage } from "./grc-legacy-compat-2.js";
import { getOwnerRepo } from "./grc-legacy-compat-3.js";
import { ensureGitRepo } from "./grc-legacy-compat-4.js";
import { REVIEW_NOTES_MAX, REVIEW_VERDICTS } from "./grc-legacy-compat-5.js";
import { checkVerdictBlockingConsistency } from "./grc-legacy-compat.js";
import { DECISION_RECORD_CLASSIFICATIONS, DECISION_RECORD_DECISIONS, DECISION_RECORD_REVIEWERS, GITHUB_ISSUE_COMMENT_BODY_MAX, buildDecisionRecordMarker, rejectReservedMarkerSequence } from "./repo-vocabulary.js";
import { execFile } from "./runtime-primitives.js";

function validateDecisionHeader({ issueNumber, cycle, reviewer, verdict, architectural_read }) {
  const errors = [];
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    errors.push("issueNumber must be a positive integer");
  }
  if (!Number.isInteger(cycle) || cycle <= 0) {
    errors.push("cycle must be a positive integer");
  }
  if (typeof reviewer !== "string" || !DECISION_RECORD_REVIEWERS.includes(reviewer)) {
    errors.push(`reviewer must be one of: ${DECISION_RECORD_REVIEWERS.join(", ")}`);
  }
  // verdict + architectural_read are optional for back-compat — when omitted,
  // the record renders the legacy findings-only shape (#931). When present
  // (the new path), the shape is validated.
  if (verdict !== undefined && !REVIEW_VERDICTS.includes(verdict)) {
    errors.push(`verdict must be one of: ${REVIEW_VERDICTS.join(", ")} when set`);
  }
  if (architectural_read !== undefined && (typeof architectural_read !== "string" || architectural_read.trim() === "")) {
    errors.push("architectural_read must be a non-empty string when set");
  }
  return errors;
}
function validateDecisionNotes(notes) {
  if (notes === undefined || notes === null) return [];
  if (!Array.isArray(notes)) return ["notes must be an array when set"];
  const errors = [];
  if (notes.length > REVIEW_NOTES_MAX) {
    errors.push(`notes must contain at most ${REVIEW_NOTES_MAX} entries`);
  }
  notes.forEach((n, i) => {
    if (n == null || typeof n !== "object" || Array.isArray(n)) {
      errors.push(`notes[${i}] must be an object {text}`);
      return;
    }
    if (typeof n.text !== "string" || n.text.trim() === "") {
      errors.push(`notes[${i}].text must be a non-empty string`);
    }
  });
  return errors;
}
function validateDecisionVerdictConsistency({ verdict, findings }) {
  // Verdict / blocking consistency (#931 codex cycle-1 F1). When the caller
  // supplies the verdict envelope fields, enforce the same invariants the
  // review-tail parsers enforce — a decision record cannot legitimately
  // persist `verdict: ship` alongside non-empty findings, or `don't-ship`
  // without a structural blocker. Skip when verdict is omitted (back-compat
  // for legacy findings-only callers).
  if (typeof verdict !== "string" || !REVIEW_VERDICTS.includes(verdict) || !Array.isArray(findings)) {
    return [];
  }
  // Decision-record findings don't carry the `structural_blocker` boolean
  // (that's a parse-time annotation on the review-tail envelope); a class
  // classification is the only structural-blocker signal at this layer.
  // This is deliberate: by the time a decision record is being posted, the
  // structural_blocker annotation has either been honored (the reviewer
  // emitted verdict: don't-ship and the agent recorded the fix decision)
  // or discarded; only the classification carries forward.
  return checkVerdictBlockingConsistency({
    verdict,
    blocking: findings,
    blockingHasStructural: (f) => f?.classification === "class",
  });
}
function validateFindingDecision(f, i) {
  const errors = [];
  if (!DECISION_RECORD_DECISIONS.includes(f.decision)) {
    // Reject `defer` explicitly — ADR-029 zero-deferral. The rejection is
    // defense in depth on top of the PreToolUse block-defer hook.
    if (f.decision === "defer") {
      errors.push(`findings[${i}].decision='defer' is invalid; ADR-029 forbids deferral. Use 'fix', 'wontfix' (with user authorization), or 'not-applicable' (with rationale).`);
    } else {
      errors.push(`findings[${i}].decision must be one of: ${DECISION_RECORD_DECISIONS.join(", ")}`);
    }
  }
  if (typeof f.rationale !== "string" || f.rationale.trim() === "") {
    errors.push(`findings[${i}].rationale must be a non-empty string`);
  }
  // `wontfix` requires explicit user authorization per ADR-029 — the agent
  // cannot self-authorize closing a finding as wontfix. Require a non-empty
  // user_authorization field that quotes the user's approval (a URL to the
  // issue-thread comment authorizing it, or a verbatim quote with an
  // issue/comment id). Validated at the tool boundary so the durable record
  // cannot carry a `wontfix` without evidence of authorization.
  if (f.decision === "wontfix" && (typeof f.user_authorization !== "string" || f.user_authorization.trim() === "")) {
    errors.push(`findings[${i}].decision='wontfix' requires a non-empty user_authorization field (URL to the issue-thread comment OR a verbatim quote with the comment id)`);
  }
  return errors;
}
function validateFindingClassInstances(f, i) {
  if (f.classification !== "class") return [];
  if (!Array.isArray(f.instances) || f.instances.length < 2) {
    return [`findings[${i}].classification='class' requires instances[] of length >= 2`];
  }
  const errors = [];
  f.instances.forEach((inst, j) => {
    if (typeof inst !== "string" || inst.trim() === "") {
      errors.push(`findings[${i}].instances[${j}] must be a non-empty string`);
    }
  });
  return errors;
}
function validateDecisionFinding(f, i) {
  if (f == null || typeof f !== "object") {
    return [`findings[${i}] must be an object`];
  }
  const errors = [];
  if (typeof f.id !== "string" || f.id.trim() === "") {
    errors.push(`findings[${i}].id must be a non-empty string`);
  }
  if (typeof f.title !== "string" || f.title.trim() === "") {
    errors.push(`findings[${i}].title must be a non-empty string`);
  }
  if (!DECISION_RECORD_CLASSIFICATIONS.includes(f.classification)) {
    errors.push(`findings[${i}].classification must be one of: ${DECISION_RECORD_CLASSIFICATIONS.join(", ")}`);
  }
  errors.push(...validateFindingDecision(f, i), ...validateFindingClassInstances(f, i));
  if (f.location != null && typeof f.location !== "string") {
    errors.push(`findings[${i}].location must be a string when set`);
  }
  if (f.comment_url != null && typeof f.comment_url !== "string") {
    errors.push(`findings[${i}].comment_url must be a string when set`);
  }
  return errors;
}
export function validateDecisionRecordInput(input) {
  if (input == null || typeof input !== "object") {
    return { ok: false, errors: ["input must be an object"] };
  }
  const { issueNumber, cycle, reviewer, findings, verdict, architectural_read, notes } = input;
  const errors = [
    ...validateDecisionHeader({ issueNumber, cycle, reviewer, verdict, architectural_read }),
    ...validateDecisionNotes(notes),
    ...validateDecisionVerdictConsistency({ verdict, findings }),
  ];
  if (Array.isArray(findings)) {
    findings.forEach((f, i) => errors.push(...validateDecisionFinding(f, i)));
  } else {
    errors.push("findings must be an array (may be empty)");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true };
}
export function buildDecisionRecord({ issueNumber, cycle, reviewer, findings, verdict, architectural_read, notes }) {
  const validation = validateDecisionRecordInput({ issueNumber, cycle, reviewer, findings, verdict, architectural_read, notes });
  if (!validation.ok) {
    throw new Error(`buildDecisionRecord input invalid: ${validation.errors.join("; ")}`);
  }
  const lines = [];
  lines.push(
    buildDecisionRecordMarker({ reviewer, cycle, issueNumber }),
    "",
    `## Review decision record — ${reviewer} cycle ${cycle} (issue #${issueNumber})`,
    "",
    `**Reviewer:** ${reviewer}  `,
    `**Cycle:** ${cycle}  `,
  );
  // Verdict + architectural_read header (#931). When the caller passes these,
  // the record makes verdict a first-class field — `verdict: ship` with zero
  // findings is the principal-engineer "ship it" signal we want to render
  // prominently.
  if (typeof verdict === "string") {
    lines.push(`**Verdict:** \`${verdict}\`  `);
  }
  if (typeof architectural_read === "string" && architectural_read.trim() !== "") {
    lines.push(
      "",
      "**Architectural read:**",
      "",
      `> ${architectural_read.trim().replaceAll("\n", "\n> ")}`,
      "",
    );
  }
  if (findings.length === 0) {
    lines.push(`**Blocking findings:** 0 (clean run)`);
    // Render notes when present even on a clean run — they carry no decision
    // and don't block merge, but they're useful context.
    if (Array.isArray(notes) && notes.length > 0) {
      lines.push("", "**Notes (non-blocking, no decisions):**", "");
      for (const n of notes) lines.push(`- ${n.text}`);
    }
    return lines.join("\n");
  }
  lines.push(`**Blocking findings:** ${findings.length}`, "");
  findings.forEach((f, i) => {
    const idx = i + 1;
    const heading = f.classification === "class"
      ? `### Finding ${idx} — \`class\` (${f.instances.length} instances)`
      : `### Finding ${idx} — \`one-off\``;
    lines.push(heading, "", `- **ID:** \`${f.id}\``, `- **Title:** ${f.title}`);
    if (f.location) lines.push(`- **Location:** \`${f.location}\``);
    lines.push(`- **Decision:** ${f.decision}`);
    if (f.decision === "wontfix" && f.user_authorization) {
      lines.push(`- **User authorization:** ${f.user_authorization}`);
    }
    lines.push(`- **Rationale:** ${f.rationale}`);
    if (f.comment_url) lines.push(`- **Comment:** ${f.comment_url}`);
    if (f.classification === "class") {
      lines.push(`- **Instances:**`);
      for (const inst of f.instances) {
        lines.push(`  - \`${inst}\``);
      }
    }
    if (i < findings.length - 1) lines.push("");
  });
  // Notes section (#931). Rendered AFTER blocking so the principal-engineer
  // hierarchy is preserved: read → blocking → notes. The notes carry no
  // decisions and explicitly do NOT block merge — they're informational.
  if (Array.isArray(notes) && notes.length > 0) {
    lines.push("", "**Notes (non-blocking, no decisions):**", "");
    for (const n of notes) lines.push(`- ${n.text}`);
  }
  return lines.join("\n");
}
function reservedMarkerEnvelope(message, issueNumber) {
  return {
    ok: false,
    error: "decision_record_reserved_marker",
    message,
    issue_number: issueNumber,
    next_action: "remove_reserved_marker_prefix_and_retry",
  };
}
function rejectReservedMarkersInFinding(f, i, issueNumber) {
  if (!f || typeof f !== "object") return null;
  for (const [k, v] of [
    ["id", f.id], ["title", f.title], ["location", f.location],
    ["rationale", f.rationale], ["comment_url", f.comment_url],
    ["user_authorization", f.user_authorization],
  ]) {
    const err = rejectReservedMarkerSequence(v, `findings[${i}].${k}`);
    if (err) return reservedMarkerEnvelope(err, issueNumber);
  }
  if (Array.isArray(f.instances)) {
    for (let j = 0; j < f.instances.length; j++) {
      const err = rejectReservedMarkerSequence(f.instances[j], `findings[${i}].instances[${j}]`);
      if (err) return reservedMarkerEnvelope(err, issueNumber);
    }
  }
  return null;
}
function rejectReservedMarkersInNotes(notes, issueNumber) {
  if (!Array.isArray(notes)) return null;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (!n || typeof n !== "object") continue;
    const noteErr = rejectReservedMarkerSequence(n.text, `notes[${i}].text`);
    if (noteErr) return reservedMarkerEnvelope(noteErr, issueNumber);
  }
  return null;
}
function rejectReservedMarkersInDecisionInput({ findings, architectural_read, notes, issueNumber }) {
  // Reject caller-controlled fields carrying reserved `<!-- gc:` marker
  // syntax — they could otherwise forge a phase/decision/final-report marker
  // and bypass downstream prerequisite checks (codex cycle-2 security finding).
  if (Array.isArray(findings)) {
    for (let i = 0; i < findings.length; i++) {
      const err = rejectReservedMarkersInFinding(findings[i], i, issueNumber);
      if (err) return err;
    }
  }
  // Architectural read passes through the same caller-controlled reserved
  // marker guard. Notes were shape-validated in validateDecisionRecordInput.
  if (typeof architectural_read === "string") {
    const archErr = rejectReservedMarkerSequence(architectural_read, "architectural_read");
    if (archErr) return reservedMarkerEnvelope(archErr, issueNumber);
  }
  return rejectReservedMarkersInNotes(notes, issueNumber);
}
export async function runPostDecisionRecord({ repoPath, issueNumber, cycle, reviewer, findings, verdict, architectural_read, notes }) {
  const validation = validateDecisionRecordInput({ issueNumber, cycle, reviewer, findings, verdict, architectural_read, notes });
  if (!validation.ok) {
    return {
      ok: false,
      error: "decision_record_input_invalid",
      message: validation.errors.join("; "),
      issue_number: issueNumber ?? null,
    };
  }
  const markerError = rejectReservedMarkersInDecisionInput({ findings, architectural_read, notes, issueNumber });
  if (markerError) return markerError;
  // Build the body and run all cheap in-memory checks (sensitive content,
  // body-size cap) BEFORE any network I/O, so a body that would be rejected
  // never costs a `gh repo view` round trip. The reserved-marker reject
  // above is also cheap and runs first.
  const body = buildDecisionRecord({ issueNumber, cycle, reviewer, findings, verdict, architectural_read, notes });
  const sensitiveError = detectSensitiveBodyContent(body);
  if (sensitiveError) {
    return {
      ok: false,
      error: "decision_record_body_rejected",
      message: sensitiveError,
      issue_number: issueNumber,
      next_action: "scrub_secrets_from_findings_and_retry",
    };
  }
  // GitHub's REST issue-comment endpoint rejects bodies over 65,535 chars.
  // Refuse at the boundary with a structured envelope so the run does not
  // produce a half-failed durable record.
  if (Buffer.byteLength(body, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return {
      ok: false,
      error: "decision_record_body_too_large",
      message: `rendered body is ${Buffer.byteLength(body, "utf8")} bytes; GitHub's issue-comment body cap is ${GITHUB_ISSUE_COMMENT_BODY_MAX} bytes`,
      issue_number: issueNumber,
      next_action: "reduce_findings_or_split_across_cycles_and_retry",
    };
  }
  const repoRoot = await ensureGitRepo(repoPath);
  const { owner, name } = await getOwnerRepo(repoRoot);
  let apiResponse = null;
  try {
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
      apiResponse = JSON.parse(stdout);
    } catch {
      apiResponse = null;
    }
  } catch (error) {
    return {
      ok: false,
      error: "decision_record_post_failed",
      message: extractGhErrorMessage(error),
      issue_number: issueNumber,
      next_action: "retry_after_resolving_gh_failure",
    };
  }
  return {
    repo_path: repoRoot,
    issue_number: issueNumber,
    ok: true,
    cycle,
    reviewer,
    finding_count: findings.length,
    comment_url: apiResponse && typeof apiResponse.html_url === "string" ? apiResponse.html_url : null,
    comment_id: apiResponse && Number.isInteger(apiResponse.id) ? apiResponse.id : null,
  };
}
// acquireKnowledgeLock / acquireIntegrationLock and the shared filesystem-lock
// mechanics moved to lib/filesystem-lease.js when the mechanical publish base-sync
// became the third real caller (issue #1495). The barrel re-exports them, so
// existing import sites are unchanged.
