// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { join } from "node:path";
import { readAbsoluteTextFile } from "./api-requirements.js";
import { parseGroundControlYaml } from "./ground-control-config.js";
import { buildFinalReportMarker, renderCiStatus, renderDocumentationSection, renderSonarStatus } from "./doc-coverage.js";
import { detectSensitiveBodyContent, extractGhErrorMessage } from "./grc-legacy-compat-2.js";
import { ensureGitRepo } from "./grc-legacy-compat-4.js";
import { resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { checkMandatoryCodexReview, readFinalReportStationEvidence, refuseWaivedStationReviewClaims, renderWaivedStationsSection } from "./final-report-station-waivers.js";
import { buildQuickfixCloseComment, validateFinalReportInput } from "./plan-posting.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX, rejectReservedMarkerSequence } from "./repo-vocabulary.js";
import { detectDeferralDisposition, execFile } from "./runtime-primitives.js";
import { FINAL_REPORT_FILE_KINDS } from "./test-quality-prompt.js";

// Each section returns a `string[]` so buildFinalReport assembles the body by
// spreading them into one array (kept under the S138 length cap and the S7778
// no-repeated-push rule without changing a byte of the rendered output).
function _finalReportHeader({ isPreMerge, issueNumber, prNumber, planCommentUrl, plainEnglishOutcome, summary }) {
  return [
    isPreMerge
      ? `<!-- gc:phase phase="ready_for_review" issue="${issueNumber}" -->`
      : buildFinalReportMarker({ issueNumber, prNumber }),
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
    return [`### Traceability reconciliation`, "", `- Pending — requirement status transition and IMPLEMENTS/TESTS reconciliation run in Phase E once the PR merges.`];
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
      ? `- PR ready for user review and merge. Ground Control reconciliation (requirement status + traceability) runs on merge (Phase E).`
      : `- PR ready for user review and merge.`,
    ...(documentation_outcome == null ? [] : ["", ...renderDocumentationSection(documentation_outcome)]),
  ];
}

export function buildFinalReport(input) {
  const validation = validateFinalReportInput(input);
  if (!validation.ok) {
    throw new Error(`buildFinalReport input invalid: ${validation.errors.join("; ")}`);
  }
  const { issueNumber, prNumber, requirements, files = {}, reviews, traceability = {}, ciStatus, sonarStatus, planCommentUrl, summary, lane, plainEnglishOutcome, phase = "post_merge", mergeRevision = null, requirementStateOverrideReason = null, stationEvidence = null } = input;
  // Slim quickfix renderer (issue #906 codex cycle-3 F2). When lane='quickfix'
  // the close comment is structurally smaller: no "In-scope requirements",
  // no "Traceability reconciliation", no "Reviews" section when empty.
  // The /implement final-report sections become empty noise on a /quickfix
  // run; the slim renderer matches the SKILL.md Step Q19 contract.
  if (lane === "quickfix") {
    return buildQuickfixCloseComment({
      issueNumber, prNumber, files, reviews, ciStatus, sonarStatus, planCommentUrl, summary,
      waivedStationLines: renderWaivedStationsSection(stationEvidence),
    });
  }
  // Phase D (pre_merge) renders a "ready for review" record carrying a
  // `ready_for_review` phase marker; the requirement-status transition and
  // traceability reconciliation have run pre-publish in the delivery PR
  // (issue #1541). Phase E (post_merge, default) renders the reconciled final
  // report carrying the `gc:final-report` marker.
  const isPreMerge = phase === "pre_merge";
  return [
    ..._finalReportHeader({ isPreMerge, issueNumber, prNumber, planCommentUrl, plainEnglishOutcome, summary }),
    ..._finalReportRequirementsSection({ requirements, isPreMerge, mergeRevision, requirementStateOverrideReason }),
    ..._finalReportFilesSection(files),
    ..._finalReportReviewsSection(reviews),
    ...renderWaivedStationsSection(stationEvidence),
    ..._finalReportTraceabilitySection({ isPreMerge, traceability }),
    ..._finalReportStatusSection({ isPreMerge, ciStatus, sonarStatus, documentation_outcome: input.documentation_outcome }),
  ].join("\n");
}
export async function runPostFinalReport(input, { workspaceAuthorizationResolver = undefined } = {}) {
  const { repoPath } = input;
  const rest = { ...input };
  delete rest.repoPath;
  // Station evidence is read from the trusted ledger below, never accepted from a caller.
  delete rest.stationEvidence;
  const validation = validateFinalReportInput(rest);
  if (!validation.ok) {
    return {
      ok: false,
      error: "final_report_input_invalid",
      message: validation.errors.join("; "),
      issue_number: rest.issueNumber ?? null,
    };
  }
  // A Step 19 final report says "PR ready for user review and merge." That
  // claim is FALSE when CI is anything other than green or SonarCloud failed.
  // Refuse to publish a durable ready-for-merge marker against non-green
  // gates. Sonar 'skipped' remains legitimate (the repo has no sonarcloud
  // config — cfg.sonarcloud null path); CI 'skipped' is NOT legitimate for a
  // real PR — Step 10 makes CI mandatory. The schema permits 'skipped' for
  // test fixtures and pure renderer tests, but the runner refuses it.
  if (rest.ciStatus !== "green") {
    return {
      ok: false,
      error: "final_report_ci_not_green",
      message: `ciStatus='${rest.ciStatus}' — a Step 19 final report claims PR-ready-for-merge; only ciStatus='green' is accepted by the runner`,
      issue_number: rest.issueNumber,
      next_action: "fix_ci_to_green_and_retry",
    };
  }
  if (rest.sonarStatus === "failed") {
    return {
      ok: false,
      error: "final_report_sonar_failed",
      message: "sonarStatus='failed' — a final report claims PR-ready-for-merge; resolve SonarCloud findings before publishing the Step 19 record",
      issue_number: rest.issueNumber,
      next_action: "fix_sonar_and_retry",
    };
  }
  // Step 19 is supposed to preserve review evidence for the run. An empty
  // reviews[] (or one without a codex entry) would render an incomplete
  // record while still posting a `gc:final-report` marker. The pre-push
  // Codex review is mandatory for every /implement run; the runner refuses
  // a final report without at least one codex review entry. (codex cycle-3
  // F4 widened by cycle-4 F3.)
  //
  // The `lane: "quickfix"` carve-out (issue #906) intentionally relaxes
  // these two checks: /quickfix runs with AI-assisted reviews off by
  // default and the Q19 close comment is structurally smaller than a
  // /implement Step 19 final report. The relaxation is bounded — every
  // other gate (CI green, Sonar pass-or-legit-skipped, sensitive-content
  // scrub, no-defer scrub, reserved-marker scrub) still applies — so the
  // server-side filters that make this tool the only driver-neutral
  // close-comment surface remain in force.
  const isQuickfixLane = rest.lane === "quickfix";
  // The `lane: "quickfix"` carve-out is bounded by the lane's own
  // requirement-free invariant: a /quickfix run cannot have requirements in
  // scope (per the SKILL.md hard precondition). Reject the combination
  // server-side so a caller cannot bypass the review-evidence gate by
  // setting `lane: "quickfix"` on an `/implement`-shape payload (codex
  // cycle-3 F1 + security F1). The tool cannot verify the issue body's
  // `## Requirements` section without an extra GitHub round-trip, but
  // rejecting the inconsistent payload shape covers the realistic case.
  if (isQuickfixLane && Array.isArray(rest.requirements) && rest.requirements.length > 0) {
    return {
      ok: false,
      error: "final_report_quickfix_with_requirements",
      message:
        "lane='quickfix' is incompatible with requirements.length > 0; /quickfix runs are " +
        "requirement-free by precondition. If the run actually has requirements in scope, drop " +
        "lane='quickfix' and provide the mandatory codex review entry; if it does not, pass " +
        "requirements: [].",
      issue_number: rest.issueNumber,
      next_action: "drop_lane_quickfix_or_drop_requirements_and_retry",
    };
  }
  if (!isQuickfixLane) {
    // A verified, unsuperseded codex-station waiver is the only substitute (issue #1578).
    const reviewsRefusal = await checkMandatoryCodexReview({
      reviews: rest.reviews, repoPath, issueNumber: rest.issueNumber, workspaceAuthorizationResolver,
    });
    if (reviewsRefusal) return reviewsRefusal;
  }
  // If the caller claims sonarStatus='skipped', validate that the repo
  // actually has no sonarcloud config (codex cycle-4 F3). Otherwise a caller
  // could publish a "PR ready" record for a sonar-configured repo without
  // having run SonarCloud. Load .ground-control.yaml and check `sonarcloud`.
  // If yaml is missing or invalid, surface that distinctly rather than
  // accepting 'skipped' by accident.
  if (rest.sonarStatus === "skipped") {
    let cfgRepoRoot;
    try {
      cfgRepoRoot = await ensureGitRepo(repoPath);
    } catch (error) {
      return { ok: false, error: "final_report_repo_not_git", message: error.message, issue_number: rest.issueNumber };
    }
    let yamlText;
    try {
      yamlText = readAbsoluteTextFile(join(cfgRepoRoot, ".ground-control.yaml"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        return { ok: false, error: "final_report_config_read_failed", message: error.message, issue_number: rest.issueNumber };
      }
      // No config file → 'skipped' is legitimate (no Ground Control wiring)
      yamlText = null;
    }
    if (yamlText != null) {
      const parsed = parseGroundControlYaml(yamlText);
      if (!parsed.ok) {
        return { ok: false, error: "final_report_config_invalid", message: parsed.errors.join("; "), issue_number: rest.issueNumber };
      }
      if (parsed.value.sonarcloud != null) {
        return {
          ok: false,
          error: "final_report_sonar_skipped_but_configured",
          message: "sonarStatus='skipped' but .ground-control.yaml has a sonarcloud block; SonarCloud must be run for sonar-configured repos before publishing the Step 19 record",
          issue_number: rest.issueNumber,
          next_action: "run_sonarcloud_and_pass_sonar_status_passed_or_failed",
        };
      }
    }
  }
  // Reject caller-controlled fields carrying reserved `<!-- gc:` marker
  // syntax (codex cycle-2 security finding; same shape as runPostDecisionRecord).
  const callerStringFields = [
    ["plainEnglishOutcome", rest.plainEnglishOutcome],
    ["summary", rest.summary],
    ["planCommentUrl", rest.planCommentUrl],
    ["requirementStateOverrideReason", rest.requirementStateOverrideReason],
  ];
  if (rest.traceability && typeof rest.traceability === "object") {
    callerStringFields.push(["traceability.notes", rest.traceability.notes]);
  }
  for (const [k, v] of callerStringFields) {
    const err = rejectReservedMarkerSequence(v, k);
    if (err) {
      return {
        ok: false,
        error: "final_report_reserved_marker",
        message: err,
        issue_number: rest.issueNumber,
        next_action: "remove_reserved_marker_prefix_and_retry",
      };
    }
  }
  if (Array.isArray(rest.requirements)) {
    for (let i = 0; i < rest.requirements.length; i++) {
      const r = rest.requirements[i];
      if (!r || typeof r !== "object") continue;
      for (const [k, v] of [["uid", r.uid], ["title", r.title], ["status", r.status], ["note", r.note]]) {
        const err = rejectReservedMarkerSequence(v, `requirements[${i}].${k}`);
        if (err) return { ok: false, error: "final_report_reserved_marker", message: err, issue_number: rest.issueNumber, next_action: "remove_reserved_marker_prefix_and_retry" };
      }
    }
  }
  if (Array.isArray(rest.reviews)) {
    for (let i = 0; i < rest.reviews.length; i++) {
      const r = rest.reviews[i];
      if (!r || typeof r !== "object") continue;
      for (const [k, v] of [["reviewer", r.reviewer], ["summary", r.summary]]) {
        const err = rejectReservedMarkerSequence(v, `reviews[${i}].${k}`);
        if (err) return { ok: false, error: "final_report_reserved_marker", message: err, issue_number: rest.issueNumber, next_action: "remove_reserved_marker_prefix_and_retry" };
      }
    }
  }
  if (rest.files && typeof rest.files === "object") {
    for (const kind of Object.keys(rest.files)) {
      const arr = Array.isArray(rest.files[kind]) ? rest.files[kind] : [];
      for (let i = 0; i < arr.length; i++) {
        const err = rejectReservedMarkerSequence(arr[i], `files.${kind}[${i}]`);
        if (err) return { ok: false, error: "final_report_reserved_marker", message: err, issue_number: rest.issueNumber, next_action: "remove_reserved_marker_prefix_and_retry" };
      }
    }
  }
  if (rest.traceability && typeof rest.traceability === "object") {
    for (const k of ["added", "updated", "deleted"]) {
      const arr = Array.isArray(rest.traceability[k]) ? rest.traceability[k] : [];
      for (let i = 0; i < arr.length; i++) {
        const err = rejectReservedMarkerSequence(arr[i], `traceability.${k}[${i}]`);
        if (err) return { ok: false, error: "final_report_reserved_marker", message: err, issue_number: rest.issueNumber, next_action: "remove_reserved_marker_prefix_and_retry" };
      }
    }
  }
  // Cheap in-memory checks BEFORE any network I/O — same rationale as in
  // runPostDecisionRecord (codex cycle-2 F3).
  const body = buildFinalReport(rest);
  const nonActionError = detectDeferralDisposition(body);
  if (nonActionError) {
    return {
      ok: false,
      error: "final_report_unresolved_work_excuse",
      message: nonActionError,
      issue_number: rest.issueNumber,
      next_action: "fix_and_verify_the_real_problem_then_retry",
    };
  }
  const sensitiveError = detectSensitiveBodyContent(body);
  if (sensitiveError) {
    return {
      ok: false,
      error: "final_report_body_rejected",
      message: sensitiveError,
      issue_number: rest.issueNumber,
      next_action: "scrub_secrets_and_retry",
    };
  }
  if (Buffer.byteLength(body, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return {
      ok: false,
      error: "final_report_body_too_large",
      message: `rendered body is ${Buffer.byteLength(body, "utf8")} bytes; GitHub's issue-comment body cap is ${GITHUB_ISSUE_COMMENT_BODY_MAX} bytes`,
      issue_number: rest.issueNumber,
      next_action: "trim_summary_or_reviews_and_retry",
    };
  }
  // The report is posted to, and its waiver evidence read from, the launch-workspace-authorized
  // repository only — never a checkout a caller named (issue #1578).
  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    return {
      ok: false,
      error: "final_report_repo_not_authorized",
      message: repository.message,
      issue_number: rest.issueNumber,
      next_action: "run_from_the_mcp_launch_workspace_and_retry",
    };
  }
  const { repoRoot, owner, name } = repository;
  // Waived stations are reported from the verified ledger, and a review entry for one is refused:
  // a waiver authorizes continuing without a verdict, never claiming one (issue #1578).
  const stationRead = await readFinalReportStationEvidence({ repository, issueNumber: rest.issueNumber });
  if (!stationRead.ok) {
    return {
      ok: false,
      error: "final_report_obligation_state_failed",
      message: `the execution-obligation ledger could not be verified: ${stationRead.message}`,
      issue_number: rest.issueNumber,
      next_action: "repair_execution_obligation_record_and_retry",
    };
  }
  const claimRefusal = refuseWaivedStationReviewClaims({
    reviews: rest.reviews, evidence: stationRead.evidence, issueNumber: rest.issueNumber,
  });
  if (claimRefusal) return claimRefusal;
  const postedBody = buildFinalReport({ ...rest, stationEvidence: stationRead.evidence });
  if (Buffer.byteLength(postedBody, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return {
      ok: false,
      error: "final_report_body_too_large",
      message: `rendered body is ${Buffer.byteLength(postedBody, "utf8")} bytes; GitHub's issue-comment body cap is ${GITHUB_ISSUE_COMMENT_BODY_MAX} bytes`,
      issue_number: rest.issueNumber,
      next_action: "trim_summary_or_reviews_and_retry",
    };
  }
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
        `body=${postedBody}`,
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
