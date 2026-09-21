// Pre-network refusal gates for runPostFinalReport (issue #1583).
//
// Split out of lib/doc-coverage-2.js when the launch-workspace pin brought runPostFinalReport into
// new-code scope at a cognitive complexity of 95 over 229 lines (Sonar S3776/S138). Every gate keeps
// its original order, error code, message, and next_action; each returns the refusal envelope or
// null.

import { join } from "node:path";
import { readAbsoluteTextFile } from "./api-requirements.js";
import { parseGroundControlYaml } from "./ground-control-config.js";
import { detectSensitiveBodyContent } from "./grc-legacy-compat-2.js";
import { ensureGitRepo } from "./grc-legacy-compat-4.js";
import { validateFinalReportInput } from "./plan-posting.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX, rejectReservedMarkerSequence } from "./repo-vocabulary.js";
import { detectDeferralDisposition } from "./runtime-primitives.js";

function refusal(issueNumber, error, message, nextAction) {
  return {
    ok: false,
    error,
    message,
    issue_number: issueNumber,
    ...(nextAction ? { next_action: nextAction } : {}),
  };
}

// A final report claims "PR ready for user review and merge", which is false unless CI is green
// and SonarCloud did not fail. CI 'skipped' is legal in the schema for renderer fixtures only.
function refuseNonGreenGates(rest) {
  if (rest.ciStatus !== "green") {
    return refusal(
      rest.issueNumber,
      "final_report_ci_not_green",
      `ciStatus='${rest.ciStatus}' — a Step 19 final report claims PR-ready-for-merge; only ciStatus='green' is accepted by the runner`,
      "fix_ci_to_green_and_retry",
    );
  }
  if (rest.sonarStatus === "failed") {
    return refusal(
      rest.issueNumber,
      "final_report_sonar_failed",
      "sonarStatus='failed' — a final report claims PR-ready-for-merge; resolve SonarCloud findings before publishing the Step 19 record",
      "fix_sonar_and_retry",
    );
  }
  return null;
}

// /quickfix remains requirement-free. Reviews are workflow observability and
// never authorize or block a delivery (issue #1693).
function refuseQuickfixRequirements(rest) {
  const isQuickfixLane = rest.lane === "quickfix";
  if (isQuickfixLane && Array.isArray(rest.requirements) && rest.requirements.length > 0) {
    return refusal(
      rest.issueNumber,
      "final_report_quickfix_with_requirements",
        "lane='quickfix' is incompatible with requirements.length > 0; /quickfix runs are " +
        "requirement-free by precondition. If the run has requirements in scope, drop " +
        "lane='quickfix'; otherwise pass requirements: [].",
      "drop_lane_quickfix_or_drop_requirements_and_retry",
    );
  }
  return null;
}

// sonarStatus='skipped' is legitimate only when the repository has no sonarcloud block (codex
// cycle-4 F3). A missing .ground-control.yaml means no Ground Control wiring; an unreadable or
// invalid one is surfaced distinctly rather than accepted by accident.
async function refuseUnjustifiedSonarSkip(rest, repoPath) {
  if (rest.sonarStatus !== "skipped") return null;
  let cfgRepoRoot;
  try {
    cfgRepoRoot = await ensureGitRepo(repoPath);
  } catch (error) {
    return refusal(rest.issueNumber, "final_report_repo_not_git", error.message);
  }
  let yamlText;
  try {
    yamlText = readAbsoluteTextFile(join(cfgRepoRoot, ".ground-control.yaml"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      return refusal(rest.issueNumber, "final_report_config_read_failed", error.message);
    }
    return null;
  }
  const parsed = parseGroundControlYaml(yamlText);
  if (!parsed.ok) {
    return refusal(rest.issueNumber, "final_report_config_invalid", parsed.errors.join("; "));
  }
  if (parsed.value.sonarcloud != null) {
    return refusal(
      rest.issueNumber,
      "final_report_sonar_skipped_but_configured",
      "sonarStatus='skipped' but .ground-control.yaml has a sonarcloud block; SonarCloud must be run for sonar-configured repos before publishing the Step 19 record",
      "run_sonarcloud_and_pass_sonar_status_passed_or_failed",
    );
  }
  return null;
}

/** Structural and gate refusals that need no GitHub access, in the runner's original order. */
export async function refuseFinalReportInput(rest, repoPath) {
  const validation = validateFinalReportInput(rest);
  if (!validation.ok) {
    return refusal(rest.issueNumber ?? null, "final_report_input_invalid", validation.errors.join("; "));
  }
  return refuseNonGreenGates(rest)
    ?? refuseQuickfixRequirements(rest)
    ?? refuseUnjustifiedSonarSkip(rest, repoPath);
}

function objectEntries(list, keys, label) {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item, i) =>
    item && typeof item === "object" ? keys.map((k) => [`${label}[${i}].${k}`, item[k]]) : []);
}

function listEntries(list, label) {
  return Array.isArray(list) ? list.map((value, i) => [`${label}[${i}]`, value]) : [];
}

// Every caller-controlled string, in the order the runner has always scanned them.
function finalReportCallerStrings(rest) {
  const traceability = rest.traceability && typeof rest.traceability === "object" ? rest.traceability : null;
  const files = rest.files && typeof rest.files === "object" ? rest.files : {};
  return [
    ["plainEnglishOutcome", rest.plainEnglishOutcome],
    ["summary", rest.summary],
    ["planCommentUrl", rest.planCommentUrl],
    ["requirementStateOverrideReason", rest.requirementStateOverrideReason],
    ...(traceability ? [["traceability.notes", traceability.notes]] : []),
    ...objectEntries(rest.requirements, ["uid", "title", "status", "note"], "requirements"),
    ...objectEntries(rest.reviews, ["reviewer", "summary"], "reviews"),
    ...Object.keys(files).flatMap((kind) => listEntries(files[kind], `files.${kind}`)),
    ...(traceability
      ? ["added", "updated", "deleted"].flatMap((k) => listEntries(traceability[k], `traceability.${k}`))
      : []),
  ];
}

/** Reject reserved `<!-- gc:` marker syntax in any caller-controlled field (codex cycle-2 security). */
export function rejectFinalReportReservedMarkers(rest) {
  for (const [field, value] of finalReportCallerStrings(rest)) {
    const err = rejectReservedMarkerSequence(value, field);
    if (err) {
      return refusal(rest.issueNumber, "final_report_reserved_marker", err, "remove_reserved_marker_prefix_and_retry");
    }
  }
  return null;
}

/** Cheap in-memory checks on the rendered body, before any network I/O (codex cycle-2 F3). */
export function refuseFinalReportBody(body, issueNumber) {
  const nonActionError = detectDeferralDisposition(body);
  if (nonActionError) {
    return refusal(issueNumber, "final_report_unresolved_work_excuse", nonActionError, "fix_and_verify_the_real_problem_then_retry");
  }
  const sensitiveError = detectSensitiveBodyContent(body);
  if (sensitiveError) {
    return refusal(issueNumber, "final_report_body_rejected", sensitiveError, "scrub_secrets_and_retry");
  }
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return refusal(
      issueNumber,
      "final_report_body_too_large",
      `rendered body is ${bytes} bytes; GitHub's issue-comment body cap is ${GITHUB_ISSUE_COMMENT_BODY_MAX} bytes`,
      "trim_summary_or_reviews_and_retry",
    );
  }
  return null;
}
