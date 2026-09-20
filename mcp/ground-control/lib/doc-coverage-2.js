// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { buildFinalReportMarker, renderCiStatus, renderDocumentationSection, renderSonarStatus } from "./doc-coverage.js";
import { buildFinalizerRunMarker } from "./final-report-marker.js";
import { extractGhErrorMessage } from "./grc-legacy-compat-2.js";
import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { refuseFinalReportBody, refuseFinalReportInput, rejectFinalReportReservedMarkers } from "./final-report-input-gates.js";
import { FINAL_REPORT_FILE_KINDS, buildQuickfixCloseComment, validateFinalReportInput } from "./plan-posting.js";
import { execFile } from "./runtime-primitives.js";

// Each section returns a `string[]` so buildFinalReport assembles the body by
// spreading them into one array (kept under the S138 length cap and the S7778
// no-repeated-push rule without changing a byte of the rendered output).
function _finalReportHeader({ isPreMerge, issueNumber, prNumber, planCommentUrl, plainEnglishOutcome, summary, automationRunId }) {
  return [
    isPreMerge
      ? `<!-- gc:phase phase="ready_for_review" issue="${issueNumber}" -->`
      : buildFinalReportMarker({ issueNumber, prNumber }),
    ...(isPreMerge ? [] : buildFinalizerRunMarker({ prNumber, runId: automationRunId })),
    "",
    isPreMerge ? `## Ready for review — issue #${issueNumber}` : `## Final report — issue #${issueNumber} complete`,
    "",
    `**PR:** #${prNumber}  `,
    ...(planCommentUrl ? [`**Plan:** ${planCommentUrl}`] : []),
    "",
    "### Outcome",
    "",
    plainEnglishOutcome.trim(),
    ...(summary ? ["", summary.trim()] : []),
  ];
}

// Pre-merge readiness names PR-head state as PROPOSED; only the merge revision is
// authoritative. Post-merge renders the OBSERVED merged values and cites the revision
// they were verified at (issue #1541).
function _finalReportRequirementsSection({ requirements, isPreMerge, mergeRevision, requirementStateOverrideReason }) {
  if (requirements.length === 0) return [];
  let authorityNote = [];
  if (isPreMerge) authorityNote = ["_Proposed state in this PR — authoritative only after merge._", ""];
  else if (typeof mergeRevision === "string" && mergeRevision !== "") authorityNote = [`_Verified at merge revision \`${mergeRevision.slice(0, 12)}\`._`, ""];
  const bullets = requirements.map((r) => {
    const note = r.note ? ` — ${r.note}` : "";
    const proposed = isPreMerge ? " (proposed)" : "";
    return `- \`${r.uid}\` (${r.title}) — ${r.status}${proposed}${note}`;
  });
  const overrideNote =
    !isPreMerge && typeof requirementStateOverrideReason === "string" && requirementStateOverrideReason.trim() !== ""
      ? ["", `- ⚠️ Merged requirement-state validation OVERRIDDEN: ${requirementStateOverrideReason.trim()}`]
      : [];
  return ["", `### In-scope requirements`, "", ...authorityNote, ...bullets, ...overrideNote];
}

function _finalReportFilesSection(files) {
  const fileLines = [];
  for (const kind of FINAL_REPORT_FILE_KINDS) {
    const list = Array.isArray(files[kind]) ? files[kind] : [];
    if (list.length === 0) continue;
    fileLines.push(`**${kind[0].toUpperCase() + kind.slice(1)}:**`, "", ...list.map((p) => `- \`${p}\``), "");
  }
  if (fileLines.length === 0) fileLines.push("- (none)", "");
  return ["", `### Files changed`, "", ...fileLines];
}

function _finalReportReviewsSection(reviews) {
  if (reviews.length === 0) return [];
  return [`### Reviews`, "", ...reviews.map((r) => `- **${r.reviewer}:** ${r.summary}`), ""];
}

function _finalReportTraceabilitySection({ isPreMerge, traceability }) {
  if (isPreMerge) {
    const count = (key) => (Array.isArray(traceability[key]) ? traceability[key].length : 0);
    return [
      `### Traceability reconciliation`, "",
      "_Proposed in this PR — verified against the merged tree in Phase E._", "",
      `- IMPLEMENTS / TESTS / DOCUMENTS added: ${count("added")}`,
      `- Links updated: ${count("updated")}`,
      `- Stale links removed: ${count("deleted")}`,
    ];
  }
  const count = (key) => (Array.isArray(traceability[key]) ? traceability[key].length : 0);
  const notes =
    typeof traceability.notes === "string" && traceability.notes.trim() !== "" ? ["", traceability.notes.trim()] : [];
  return [
    `### Traceability reconciliation`, "",
    `- IMPLEMENTS / TESTS / DOCUMENTS added: ${count("added")}`,
    `- Links updated: ${count("updated")}`,
    `- Stale links removed: ${count("deleted")}`,
    ...notes,
  ];
}

function _finalReportStatusSection({ isPreMerge, ciStatus, sonarStatus, documentation_outcome }) {
  return [
    "", `### Status`, "",
    `- CI: ${renderCiStatus(ciStatus)}`,
    `- SonarCloud: ${renderSonarStatus(sonarStatus)}`,
    isPreMerge
      ? `- PR ready for user review and merge. Phase E validates the merged requirement state, posts the final report, and closes the issue automatically once this PR merges.`
      : `- PR ready for user review and merge.`,
    ...(documentation_outcome == null ? [] : ["", ...renderDocumentationSection(documentation_outcome)]),
  ];
}

export function buildFinalReport(input) {
  const validation = validateFinalReportInput(input);
  if (!validation.ok) {
    throw new Error(`buildFinalReport input invalid: ${validation.errors.join("; ")}`);
  }
  const { issueNumber, prNumber, requirements, files = {}, reviews, traceability = {}, ciStatus, sonarStatus, planCommentUrl, summary, lane, plainEnglishOutcome, phase = "post_merge", mergeRevision = null, requirementStateOverrideReason = null, automationRunId = null } = input;
  // Slim quickfix renderer (issue #906 codex cycle-3 F2). When lane='quickfix'
  // the close comment is structurally smaller: no "In-scope requirements",
  // no "Traceability reconciliation", no "Reviews" section when empty.
  // The /implement final-report sections become empty noise on a /quickfix
  // run; the slim renderer matches the SKILL.md Step Q19 contract.
  if (lane === "quickfix") {
    return buildQuickfixCloseComment({
      issueNumber, prNumber, files, reviews, ciStatus, sonarStatus, planCommentUrl, summary, automationRunId,
    });
  }
  // Phase D (pre_merge) renders a "ready for review" record carrying a
  // `ready_for_review` phase marker; the requirement-status transition and
  // traceability reconciliation have run pre-publish in the delivery PR
  // (issue #1541). Phase E (post_merge, default) renders the reconciled final
  // report carrying the `gc:final-report` marker.
  const isPreMerge = phase === "pre_merge";
  return [
    ..._finalReportHeader({ isPreMerge, issueNumber, prNumber, planCommentUrl, plainEnglishOutcome, summary, automationRunId }),
    ..._finalReportRequirementsSection({ requirements, isPreMerge, mergeRevision, requirementStateOverrideReason }),
    ..._finalReportFilesSection(files),
    ..._finalReportReviewsSection(reviews),
    ..._finalReportTraceabilitySection({ isPreMerge, traceability }),
    ..._finalReportStatusSection({ isPreMerge, ciStatus, sonarStatus, documentation_outcome: input.documentation_outcome }),
  ].join("\n");
}
export async function runPostFinalReport(input, { workspaceAuthorizationResolver = undefined } = {}) {
  const { repoPath } = input;
  const rest = { ...input };
  delete rest.repoPath;
  const inputRefusal = await refuseFinalReportInput(rest, repoPath);
  if (inputRefusal) return inputRefusal;
  const markerRefusal = rejectFinalReportReservedMarkers(rest);
  if (markerRefusal) return markerRefusal;
  const body = buildFinalReport(rest);
  const bodyRefusal = refuseFinalReportBody(body, rest.issueNumber);
  if (bodyRefusal) return bodyRefusal;
  // The report is posted only to the launch-workspace-authorized repository, never a checkout a
  // caller named (issues #1578, #1583).
  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    return issueRepositoryNotAuthorized("final_report", repository, { issue_number: rest.issueNumber });
  }
  const { repoRoot, owner, name } = repository;
  // The traceability-reconciliation prerequisite (former issue #1058) is retired
  // with the backend (issue #1500): reconciliation is no longer a workflow phase,
  // so there is no `traceability_reconciled` marker to require. The report's real
  // gates — CI green, Sonar pass-or-legit-skipped, mandatory Codex review, and the
  // sensitive/defer/reserved-marker scrubs above — remain the bar for a "PR ready"
  // record. The agent records requirement status and traceability directly in the
  // requirement files, reviewed in the PR.
  let apiResponse = null;
  try {
    const { stdout } = await execFile(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `/repos/${owner}/${name}/issues/${rest.issueNumber}/comments`,
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
      error: "final_report_post_failed",
      message: extractGhErrorMessage(error),
      issue_number: rest.issueNumber,
      next_action: "retry_after_resolving_gh_failure",
    };
  }
  return {
    repo_path: repoRoot,
    issue_number: rest.issueNumber,
    pr_number: rest.prNumber,
    ok: true,
    comment_url: apiResponse && typeof apiResponse.html_url === "string" ? apiResponse.html_url : null,
    comment_id: apiResponse && Number.isInteger(apiResponse.id) ? apiResponse.id : null,
  };
}
