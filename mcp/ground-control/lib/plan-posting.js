// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { validateDevStartPlanGate } from "./close-issue.js";
import { parseGroundControlYaml } from "./ground-control-config.js";
import { buildFinalReportMarker, renderCiStatus, renderSonarStatus, validateDocumentationOutcome } from "./doc-coverage.js";
import { buildFinalizerRunMarker } from "./final-report-marker.js";
import { detectSensitiveBodyContent } from "./grc-legacy-compat-2.js";
import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { postPhaseMarker } from "./grc-legacy-compat-3.js";
import { readCompletedPhases } from "./grc-legacy-compat-4.js";
import { evaluatePhasePrerequisite } from "./grc-legacy-compat.js";
import { getRepoGroundControlContext } from "./repo-vocabulary-2.js";
import { FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX, FINAL_REPORT_REVIEW_SUMMARY_MAX, FINAL_REPORT_SUMMARY_MAX, GITHUB_ISSUE_COMMENT_BODY_MAX } from "./repo-vocabulary.js";
import { EXACT_REQUIREMENT_UID_RE, REQUIREMENT_UID_CONTRACT_DESCRIPTION, execFile } from "./runtime-primitives.js";

export const FINAL_REPORT_FILE_KINDS = Object.freeze(["added", "modified", "renamed", "deleted"]);
export const FINAL_REPORT_CI_STATUSES = Object.freeze(["green", "red", "skipped"]);
export const FINAL_REPORT_SONAR_STATUSES = Object.freeze(["passed", "failed", "skipped"]);

export async function runPostImplementationPlan({
  repoPath,
  issueNumber,
  planBody,
  override = false,
  overrideReason = null,
}, { workspaceAuthorizationResolver = undefined } = {}) {
  if (issueNumber == null || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("gc_post_implementation_plan requires a positive integer issue_number");
  }
  if (typeof planBody !== "string" || planBody.trim() === "") {
    throw new Error("gc_post_implementation_plan requires a non-empty plan_body");
  }

  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    return issueRepositoryNotAuthorized("plan", repository, { issue_number: issueNumber });
  }
  const { repoRoot, owner, name } = repository;

  // Prerequisite check: preflight must have run for this issue. Override is
  // available for the same reason as the codex-review cap override — the user
  // can explicitly authorize skipping the gate (for tiny bug fixes where
  // preflight is overkill, for example). Override requires a non-empty reason.
  if (override === true) {
    if (typeof overrideReason !== "string" || overrideReason.trim() === "") {
      return {
        ok: false,
        error: "phase_override_missing_reason",
        message:
          "override=true requires a non-empty override_reason quoting the user's authorization to skip preflight. " +
          "Audits cannot distinguish legitimate overrides from accidents without a reason.",
        issue_number: issueNumber,
      };
    }
  } else {
    const completed = await readCompletedPhases(repoRoot, owner, name, issueNumber);
    const decision = evaluatePhasePrerequisite({
      completed,
      nextPhase: "plan",
      requires: ["preflight"],
      issueNumber,
    });
    if (!decision.ok) {
      return {
        repo_path: repoRoot,
        issue_number: issueNumber,
        ok: false,
        error: decision.error,
        message: decision.message,
        missing: decision.missing,
        completed: decision.completed,
        next_action: "run_gc_codex_architecture_preflight_first",
      };
    }
  }

  const cfg = await getRepoGroundControlContext(repoRoot);
  if (cfg.status !== "ok") {
    return {
      repo_path: repoRoot,
      issue_number: issueNumber,
      ok: false,
      error: "ground_control_config_invalid",
      message: "Cannot validate the implementation plan because .ground-control.yaml is missing or invalid.",
      errors: cfg.errors || [],
      next_action: "fix_ground_control_yaml_and_retry",
    };
  }
  const devStartGate = validateDevStartPlanGate(planBody, cfg.workflow?.dev_start_gate);
  if (!devStartGate.ok) {
    return {
      repo_path: repoRoot,
      issue_number: issueNumber,
      ok: false,
      ...devStartGate,
      next_action: "add_valid_dev_start_gate_to_plan_and_retry",
    };
  }

  const combinedBody = planBody;

  const sensitiveError = detectSensitiveBodyContent(combinedBody);
  if (sensitiveError) {
    return {
      repo_path: repoRoot,
      issue_number: issueNumber,
      ok: false,
      error: "plan_body_rejected",
      message: sensitiveError,
      next_action: "scrub_secrets_from_plan_and_retry",
    };
  }
  if (Buffer.byteLength(combinedBody, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return {
      repo_path: repoRoot,
      issue_number: issueNumber,
      ok: false,
      error: "plan_body_too_large",
      message: `rendered plan body is ${Buffer.byteLength(combinedBody, "utf8")} bytes; GitHub's issue-comment body cap is ${GITHUB_ISSUE_COMMENT_BODY_MAX} bytes`,
      next_action: "reduce_plan_size_and_retry",
    };
  }

  // Post the plan + the `plan` phase marker as a single combined comment so
  // the marker and the human-visible plan are the same thread artifact.
  const apiResponse = await postPhaseMarker(repoRoot, owner, name, issueNumber, "plan", { commentBody: combinedBody });

  return {
    repo_path: repoRoot,
    issue_number: issueNumber,
    ok: true,
    phase_marker: { phase: "plan", issue_number: issueNumber },
    override: override === true ? true : false,
    override_reason: override === true ? overrideReason.trim() : null,
    comment_url: apiResponse && typeof apiResponse.html_url === "string" ? apiResponse.html_url : null,
    comment_id: apiResponse && Number.isInteger(apiResponse.id) ? apiResponse.id : null,
  };
}
export async function readVocabularyForReview(repoRoot, baseBranch) {
  // 1. Is .ground-control.yaml modified in the diff (working tree or HEAD)?
  let yamlChanged = false;
  try {
    const candidates = [`origin/${baseBranch}...HEAD`, `${baseBranch}...HEAD`];
    for (const range of candidates) {
      try {
        const { stdout } = await execFile(
          "git",
          ["-C", repoRoot, "diff", "--name-only", range],
          { maxBuffer: 1 * 1024 * 1024 },
        );
        if (stdout.split("\n").some((p) => p.trim() === ".ground-control.yaml")) {
          yamlChanged = true;
        }
        break;
      } catch {
        continue;
      }
    }
    // Working-tree changes (uncommitted) — same predicate.
    try {
      const { stdout } = await execFile(
        "git",
        ["-C", repoRoot, "diff", "HEAD", "--name-only"],
        { maxBuffer: 1 * 1024 * 1024 },
      );
      if (stdout.split("\n").some((p) => p.trim() === ".ground-control.yaml")) {
        yamlChanged = true;
      }
    } catch {
      // best-effort
    }
    try {
      const { stdout } = await execFile(
        "git",
        ["-C", repoRoot, "diff", "--cached", "--name-only"],
        { maxBuffer: 1 * 1024 * 1024 },
      );
      if (stdout.split("\n").some((p) => p.trim() === ".ground-control.yaml")) {
        yamlChanged = true;
      }
    } catch {
      // best-effort
    }
  } catch {
    // best-effort; on any unexpected git failure, treat as changed (safer).
    yamlChanged = true;
  }

  if (!yamlChanged) {
    // No PR-side edits to the policy file; the working tree is trustworthy.
    try {
      const cfg = await getRepoGroundControlContext(repoRoot);
      if (cfg.status === "ok" && cfg.architecture && cfg.architecture.vocabulary) {
        return cfg.architecture.vocabulary;
      }
    } catch {
      // best-effort
    }
    return null;
  }

  // PR touches the policy file. Load from a trusted base ref instead, so the
  // PR cannot rewrite its own review rules.
  const candidates = [`origin/${baseBranch}`, baseBranch];
  for (const ref of candidates) {
    try {
      const { stdout } = await execFile(
        "git",
        ["-C", repoRoot, "show", `${ref}:.ground-control.yaml`],
        { maxBuffer: 1 * 1024 * 1024 },
      );
      const parseResult = parseGroundControlYaml(stdout);
      if (parseResult.ok && parseResult.value.architecture && parseResult.value.architecture.vocabulary) {
        return parseResult.value.architecture.vocabulary;
      }
      // The base ref either has no architecture block or the block is
      // malformed at the base — either way, run with workflow defaults
      // rather than fall through to the untrusted working tree.
      return null;
    } catch {
      continue;
    }
  }
  // Could not read the base ref at all (no remote, no permissions). Fall
  // back to null vocabulary (workflow defaults) rather than the working
  // tree — the trusted-ref defense fails closed.
  return null;
}
export const EVIDENCE_TYPES = [
  "OBSERVATION_SUMMARY",
  "CONTROL_TEST_SUMMARY",
  "ASSURANCE_CONCLUSION",
  "VERIFICATION_SUMMARY",
  "ATTESTATION",
  "MIXED",
];
export const EVIDENCE_SOURCE_KINDS = [
  "OBSERVATION",
  "CONTROL_TEST",
  "CONTROL_EFFECTIVENESS_ASSESSMENT",
  "VERIFICATION_RESULT",
  "RISK_ASSESSMENT_RESULT",
  "FINDING",
  "ATTESTATION",
  "EXTERNAL",
];
export function validateFinalReportInput(input) {
  const errors = [];
  if (input == null || typeof input !== "object") {
    return { ok: false, errors: ["input must be an object"] };
  }
  const { issueNumber, prNumber, requirements, files, reviews, traceability, ciStatus, sonarStatus, planCommentUrl, summary, lane, plainEnglishOutcome } = input;
  if (lane != null && lane !== "implement" && lane !== "quickfix") {
    errors.push("lane must be 'implement' or 'quickfix' when set");
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    errors.push("issueNumber must be a positive integer");
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    errors.push("prNumber must be a positive integer");
  }
  if (!Array.isArray(requirements)) {
    errors.push("requirements must be an array (may be empty)");
  } else {
    requirements.forEach((r, i) => {
      if (r == null || typeof r !== "object") {
        errors.push(`requirements[${i}] must be an object`);
        return;
      }
      // Anchored bounded-identifier check for a structured field; identity is
      // resolved by the project-scoped backend lookup (issue #1425).
      if (typeof r.uid !== "string" || !EXACT_REQUIREMENT_UID_RE.test(r.uid)) {
        errors.push(`requirements[${i}].uid must be ${REQUIREMENT_UID_CONTRACT_DESCRIPTION}`);
      }
      if (typeof r.title !== "string" || r.title.trim() === "") errors.push(`requirements[${i}].title must be a non-empty string`);
      if (typeof r.status !== "string" || r.status.trim() === "") errors.push(`requirements[${i}].status must be a non-empty string`);
      if (r.note != null && typeof r.note !== "string") errors.push(`requirements[${i}].note must be a string when set`);
    });
  }
  if (files != null && typeof files === "object" && !Array.isArray(files)) {
    for (const kind of Object.keys(files)) {
      if (!FINAL_REPORT_FILE_KINDS.includes(kind)) {
        errors.push(`files has unknown key '${kind}' (allowed: ${FINAL_REPORT_FILE_KINDS.join(", ")})`);
        continue;
      }
      if (!Array.isArray(files[kind])) {
        errors.push(`files.${kind} must be an array`);
        continue;
      }
      files[kind].forEach((p, i) => {
        if (typeof p !== "string" || p.trim() === "") {
          errors.push(`files.${kind}[${i}] must be a non-empty string`);
        }
      });
    }
  } else if (files != null) {
    errors.push("files must be a mapping of {added|modified|renamed|deleted: [paths]}");
  }
  if (!Array.isArray(reviews)) {
    errors.push("reviews must be an array (may be empty)");
  } else {
    reviews.forEach((r, i) => {
      if (r == null || typeof r !== "object") {
        errors.push(`reviews[${i}] must be an object`);
        return;
      }
      if (typeof r.reviewer !== "string" || r.reviewer.trim() === "") errors.push(`reviews[${i}].reviewer must be a non-empty string`);
      if (typeof r.summary !== "string" || r.summary.trim() === "") {
        errors.push(`reviews[${i}].summary must be a non-empty string`);
      } else if (Buffer.byteLength(r.summary, "utf8") > FINAL_REPORT_REVIEW_SUMMARY_MAX) {
        errors.push(
          `reviews[${i}].summary exceeds the final-report review-summary cap of ${FINAL_REPORT_REVIEW_SUMMARY_MAX} bytes (got ${Buffer.byteLength(r.summary, "utf8")}). A review summary is one tight line — restated context and hedging are the usual offenders.`,
        );
      }
    });
  }
  if (traceability != null) {
    if (typeof traceability !== "object" || Array.isArray(traceability)) {
      errors.push("traceability must be a mapping with optional keys 'added', 'updated', 'deleted'");
    } else {
      for (const k of Object.keys(traceability)) {
        if (!["added", "updated", "deleted", "notes"].includes(k)) {
          errors.push(`traceability has unknown key '${k}' (allowed: added, updated, deleted, notes)`);
        }
      }
    }
  }
  if (!FINAL_REPORT_CI_STATUSES.includes(ciStatus)) {
    errors.push(`ciStatus must be one of: ${FINAL_REPORT_CI_STATUSES.join(", ")}`);
  }
  if (!FINAL_REPORT_SONAR_STATUSES.includes(sonarStatus)) {
    errors.push(`sonarStatus must be one of: ${FINAL_REPORT_SONAR_STATUSES.join(", ")}`);
  }
  if (planCommentUrl != null && typeof planCommentUrl !== "string") {
    errors.push("planCommentUrl must be a string when set");
  }
  if (summary != null && typeof summary !== "string") {
    errors.push("summary must be a string when set");
  } else if (typeof summary === "string" && Buffer.byteLength(summary, "utf8") > FINAL_REPORT_SUMMARY_MAX) {
    errors.push(
      `summary exceeds the final-report summary cap of ${FINAL_REPORT_SUMMARY_MAX} bytes (got ${Buffer.byteLength(summary, "utf8")}). A final-report summary is one tight paragraph — restated context and hedging are the usual offenders.`,
    );
  }
  const requiresPlainEnglishOutcome = lane !== "quickfix";
  if (plainEnglishOutcome == null) {
    if (requiresPlainEnglishOutcome) {
      errors.push("plainEnglishOutcome is required for /implement final reports");
    }
  } else if (typeof plainEnglishOutcome !== "string" || plainEnglishOutcome.trim() === "") {
    errors.push("plainEnglishOutcome must be a non-empty string when set");
  } else if (Buffer.byteLength(plainEnglishOutcome, "utf8") > FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX) {
    errors.push(
      `plainEnglishOutcome exceeds the final-report plain-English outcome cap of ${FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX} bytes (got ${Buffer.byteLength(plainEnglishOutcome, "utf8")}). Keep it to 1-3 plain-language sentences.`,
    );
  }
  // Optional documentation_outcome field (issue #896, ADR-054).
  if (input.documentation_outcome != null) {
    const docResult = validateDocumentationOutcome(input.documentation_outcome);
    if (!docResult.ok) {
      for (const e of docResult.errors) errors.push(`documentation_outcome: ${e}`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true };
}
export function buildQuickfixCloseComment({ issueNumber, prNumber, files, reviews, ciStatus, sonarStatus, planCommentUrl, summary, automationRunId = null }) {
  const lines = [];
  lines.push(buildFinalReportMarker({ issueNumber, prNumber }));
  lines.push(...buildFinalizerRunMarker({ prNumber, runId: automationRunId }));
  lines.push("");
  lines.push(`## Quickfix close — issue #${issueNumber} complete`);
  lines.push("");
  lines.push(`**PR:** #${prNumber}  `);
  if (planCommentUrl) lines.push(`**Plan:** ${planCommentUrl}`);
  if (summary) {
    lines.push("");
    lines.push(summary.trim());
  }
  lines.push("");
  lines.push(`### Files changed`);
  lines.push("");
  let anyFiles = false;
  for (const kind of FINAL_REPORT_FILE_KINDS) {
    const list = Array.isArray(files[kind]) ? files[kind] : [];
    if (list.length === 0) continue;
    anyFiles = true;
    lines.push(`**${kind[0].toUpperCase() + kind.slice(1)}:**`);
    lines.push("");
    for (const p of list) lines.push(`- \`${p}\``);
    lines.push("");
  }
  if (!anyFiles) {
    lines.push("- (none)");
    lines.push("");
  }
  if (reviews.length > 0) {
    lines.push(`### Reviews`);
    lines.push("");
    for (const r of reviews) lines.push(`- **${r.reviewer}:** ${r.summary}`);
    lines.push("");
  }
  lines.push(`### Status`);
  lines.push("");
  lines.push(`- CI: ${renderCiStatus(ciStatus)}`);
  lines.push(`- SonarCloud: ${renderSonarStatus(sonarStatus)}`);
  lines.push(`- PR ready for user review and merge.`);
  return lines.join("\n");
}
