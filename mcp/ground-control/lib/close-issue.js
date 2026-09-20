// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { TO_CAMEL } from "./field-mapping.js";
import { extractGhErrorMessage } from "./grc-legacy-compat-2.js";
import { fetchPullRequest, listIssueCrossReferencedPullNumbers } from "./github-rest.js";
import { readIssueCommentBodies, readIssueCommentsWithAuthors, resolveExecutionObligationTrust, validateSourceDevStartGate } from "./grc-legacy-compat-3.js";
import { findTrustedFinalReportMarker } from "./final-report-marker.js";
import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { devStartGateConfigFailure, devStartGateFailure, readDevStartPlanFields, readSourceBearingDecision, validateNonSourceDevStartGate } from "./grc-legacy-compat.js";
import { buildCodexReviewCycleMarker, normalizeDevStartGateConfig, parseCodexReviewCycleMarkers } from "./repo-context-2.js";
import { execFile } from "./runtime-primitives.js";

const TO_SNAKE = Object.fromEntries(Object.entries(TO_CAMEL).map(([k, v]) => [v, k]));
export const OPAQUE_VALUE_KEYS = new Set([
  "metadata",
  "schemaBody",
  "schema_body",
  // GC-T014: NIST SP 800-30 Rev. 1 methodology-defined value bags. inputFactors
  // / computedOutputs / uncertaintyMetadata persist NIST profile-defined keys
  // (threat_event_relevance, legacy threat_source_relevance,
  // likelihood_initiation, likelihood_adverse_impact, likelihood_overall,
  // impact_level, ...) that must reach the caller verbatim.
  // inputSchema / outputSchema carry the methodology JSON Schema bodies whose
  // properties keys are likewise methodology-defined (see preflight note
  // architecture/notes/nist-sp800-30-risk-assessment-preflight.md).
  "inputFactors",
  "input_factors",
  "computedOutputs",
  "computed_outputs",
  "uncertaintyMetadata",
  "uncertainty_metadata",
  "inputSchema",
  "input_schema",
  "outputSchema",
  "output_schema",
  "treatmentStrategyVocabulary",
  "treatment_strategy_vocabulary",
  // #1106 — ControlRequest/UpdateControlRequest: methodologyFactors and
  // effectiveness are Map<String,Object> bags whose inner keys are
  // methodology-defined and must not be camel-cased.
  "methodologyFactors",
  "methodology_factors",
  "effectiveness",
  // #1106 — RiskRegisterRecordRequest.decisionMetadata is Map<String,Object>.
  "decisionMetadata",
  "decision_metadata",
  // GC-I017 — RiskControlMapping.methodologyInfluence is a Map<String,Object>
  // whose inner keys are methodology-defined (FAIR-CAM domain, effect dimensions,
  // and any profile-defined influence factors). These must not be camel/snake-rewritten.
  "methodologyInfluence",
  "methodology_influence",
  // NOTE: VerificationResultRequest.evidence is also a Map<String,Object>, but
  // "evidence" is also used as a structured array field in analysis responses
  // (toSnakeCase path). OPAQUE_VALUE_KEYS is consulted by both directions, so
  // adding "evidence" here would block toSnakeCase from recursing into response
  // evidence arrays. Instead, createVerificationResult/updateVerificationResult
  // build the camelCase body explicitly (rawBody) to preserve evidence inner keys.
]);
function copyShallow(value) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice();
  return { ...value };
}
export function toCamelCase(obj) {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(toCamelCase);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const renamed = TO_CAMEL[k] || k;
    out[renamed] = OPAQUE_VALUE_KEYS.has(k) || OPAQUE_VALUE_KEYS.has(renamed) ? copyShallow(v) : toCamelCase(v);
  }
  return out;
}
export function toSnakeCase(obj) {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(toSnakeCase);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const renamed = TO_SNAKE[k] || k;
    // Symmetric to toCamelCase: free-form user-defined maps (metadata,
    // schemaBody) must reach the caller verbatim. Without this guard,
    // response normalization would rewrite an inner key like `assetType`
    // (a project-defined metadata field) into `asset_type`, mutating the
    // persisted contract round-trip. See codex over-cap finding 5 on #722.
    out[renamed] = OPAQUE_VALUE_KEYS.has(k) || OPAQUE_VALUE_KEYS.has(renamed) ? copyShallow(v) : toSnakeCase(v);
  }
  return out;
}
export function validateDevStartPlanGate(planBody, gateConfig) {
  const normalized = normalizeDevStartGateConfig(gateConfig);
  if (!normalized.ok) return devStartGateConfigFailure(normalized.errors);
  const config = normalized.value;
  if (config.enabled !== true) return { ok: true, checked: false, source_bearing: null };

  const planFields = readDevStartPlanFields(planBody, config);
  if (!planFields.ok) return planFields;

  const sourceDecision = readSourceBearingDecision(planFields.fields);
  if (!sourceDecision.ok) {
    return devStartGateFailure({
      planSection: config.plan_section,
      missing: sourceDecision.missing,
      invalid: sourceDecision.invalid,
    });
  }
  if (!sourceDecision.sourceBearing) return validateNonSourceDevStartGate(planFields.fields, config);
  return validateSourceDevStartGate(planFields.fields, config);
}
export async function readPriorCodexReviewCycleCount(repoRoot, owner, name, prNumber) {
  const bodies = await readIssueCommentBodies(repoRoot, owner, name, prNumber);
  return parseCodexReviewCycleMarkers(bodies, prNumber);
}
export async function postCodexReviewCycleMarker(repoRoot, owner, name, prNumber, cycleNumber, extras = {}) {
  const body = buildCodexReviewCycleMarker({
    prNumber,
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
async function findPrForIssue(repoRoot, owner, name, issueNumber) {
  // Linked PRs come from the issue's REST timeline (cross-referenced events), then each PR's own
  // REST record for state, merged_at, base ref, and merge commit. REST only: the GraphQL timeline
  // query failed closed whenever the shared token's GraphQL budget ran out, blocking every Phase E
  // even though REST could answer it (issue #1584).
  let numbers;
  try {
    numbers = await listIssueCrossReferencedPullNumbers(repoRoot, owner, name, issueNumber);
  } catch (error) {
    throw new Error(`GitHub REST issue timeline lookup failed: ${extractGhErrorMessage(error)}`);
  }
  const prs = [];
  for (const number of numbers) {
    try {
      const pr = await fetchPullRequest(repoRoot, owner, name, number);
      if (pr) prs.push(pr);
    } catch (error) {
      throw new Error(`GitHub REST pull request #${number} lookup failed: ${extractGhErrorMessage(error)}`);
    }
  }
  return prs;
}
export async function resolvePrForClose({ repoRoot, owner, name, issueNumber, prNumber }) {
  if (prNumber == null) {
    let prs;
    try {
      prs = await findPrForIssue(repoRoot, owner, name, issueNumber);
    } catch (error) {
      return {
        earlyReturn: {
          ok: false,
          error: "close_pr_lookup_failed",
          message: error.message,
          issue_number: issueNumber,
        },
      };
    }
    const merged = prs.find((p) => p.state === "MERGED" && p.mergedAt);
    if (merged) return { pr: merged };
    if (prs.length === 0) {
      return {
        earlyReturn: {
          ok: false,
          error: "close_no_linked_pr",
          message: `gc_close_issue_after_merge could not find any PR linked to issue #${issueNumber}; expected a merged PR with the issue cross-referenced.`,
          issue_number: issueNumber,
          next_action: "open_or_link_a_pr_first",
        },
      };
    }
    return { pr: prs[0] };
  }

  // Codex review cycle 1 (issue #1058): a caller-supplied pr_number must
  // be verified as linked to the issue before being used as the close
  // gate. Trusting the caller's pr_number for the issue→PR relationship
  // would defeat the gate's purpose: a stale cached PR number or a
  // malicious caller could pass any merged PR from this repo paired with
  // an unrelated open issue and cause the wrong issue to close. Resolve
  // the issue's actual linked PRs from the timeline and require the
  // supplied PR number to appear in that set; only then proceed to
  // fetch the PR's merged_at / state for the merge-status gate.
  let linkedPrs;
  try {
    linkedPrs = await findPrForIssue(repoRoot, owner, name, issueNumber);
  } catch (error) {
    return {
      earlyReturn: {
        ok: false,
        error: "close_pr_lookup_failed",
        message: error.message,
        issue_number: issueNumber,
        pr_number: prNumber,
      },
    };
  }
  const matched = linkedPrs.find((p) => p.number === prNumber);
  if (!matched) {
    return {
      earlyReturn: {
        ok: false,
        error: "close_pr_not_linked_to_issue",
        message:
          `gc_close_issue_after_merge refuses to close issue #${issueNumber} via PR #${prNumber}: ` +
          `that PR is not in the issue's linked-PR set ${JSON.stringify(linkedPrs.map((p) => p.number))}. ` +
          `Supplied pr_number must reference a PR that the issue's GitHub timeline already links to; ` +
          `pass no pr_number to let the tool resolve the linked PR from the issue timeline instead.`,
        issue_number: issueNumber,
        pr_number: prNumber,
        linked_pr_numbers: linkedPrs.map((p) => p.number),
        next_action: "omit_pr_number_or_pass_a_linked_pr",
      },
    };
  }
  return { pr: matched };
}
// A trusted `gc:final-report` marker is the proof that post-merge requirement-state
// validation succeeded (runAssertCompletion posts the report only after validation). The
// close path requires it before closing an OPEN issue so the canonical close can never run
// ahead of validation (issue #1541). Marker parsing and the trust decision live in
// lib/final-report-marker.js, shared with publication so the two can never disagree about
// what counts as a recorded validation (issue #1671).
async function hasTrustedFinalReportMarker(repoRoot, owner, name, issueNumber, prNumber) {
  const marker = await findTrustedFinalReportMarker({ repoRoot, owner, name, issueNumber, prNumber });
  return marker.found;
}

// The merged-requirement-state escape hatch. Authority is a TRUSTED issue-thread
// comment authored by a repo-write human that names THIS PR — never a caller-supplied
// DTO field, because a request boolean is a claim, not authorization (issue #1541
// security review). Binding to the PR stops an authorization for one PR from unlocking
// a later PR on the same issue, and the comment itself is the durable record of the
// bypass (ADR-029). A human authorizes by commenting `gc-authorize-merge-state-override
// pr=<n> <reason>` on the issue. Returns { authorized, reason }.
const MERGE_STATE_OVERRIDE_RE = /(?:^|\s)gc-authorize-merge-state-override\s+pr=(\d+)\b/i;
export async function readTrustedMergeStateOverride(repoRoot, owner, name, issueNumber, prNumber) {
  const comments = await readIssueCommentsWithAuthors(repoRoot, owner, name, issueNumber);
  const candidates = comments.filter((c) => {
    if (typeof c.body !== "string") return false;
    const match = MERGE_STATE_OVERRIDE_RE.exec(c.body);
    return match != null && Number(match[1]) === prNumber;
  });
  if (candidates.length === 0) return { authorized: false, reason: null };
  const trust = await resolveExecutionObligationTrust(repoRoot, owner, name, comments);
  const authorizing = candidates.find((c) => trust.isTrusted(c));
  if (!authorizing) return { authorized: false, reason: null };
  return { authorized: true, reason: authorizing.body.trim().slice(0, 300) };
}
export async function runCloseIssueAfterMerge(
  { repoPath, issueNumber, prNumber = null },
  { workspaceAuthorizationResolver = undefined } = {},
) {
  if (issueNumber == null || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("gc_close_issue_after_merge requires a positive integer issue_number");
  }
  if (prNumber != null && (!Number.isInteger(prNumber) || prNumber <= 0)) {
    throw new Error("gc_close_issue_after_merge pr_number must be a positive integer when supplied");
  }

  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    return issueRepositoryNotAuthorized("close", repository, { issue_number: issueNumber });
  }
  const { repoRoot, owner, name } = repository;

  const resolved = await resolvePrForClose({ repoRoot, owner, name, issueNumber, prNumber });
  if (resolved.earlyReturn) return resolved.earlyReturn;
  const pr = resolved.pr;

  if (!pr?.mergedAt || pr.state !== "MERGED") {
    return {
      ok: false,
      error: "close_pr_not_merged",
      message:
        `gc_close_issue_after_merge refuses to close issue #${issueNumber}: ` +
        `linked PR #${pr?.number ?? "?"} state=${pr?.state ?? "unknown"}, merged_at=${pr?.mergedAt ?? "null"}. ` +
        `The post-merge close gate requires merged_at non-null AND state='MERGED'.`,
      issue_number: issueNumber,
      pr_state: pr?.state ?? null,
      pr_merged_at: pr?.mergedAt ?? null,
      next_action: "wait_for_user_to_merge_the_pr",
    };
  }

  return closeIssueIdempotently({ repoRoot, owner, name, issueNumber, pr });
}
async function closeIssueIdempotently({ repoRoot, owner, name, issueNumber, pr }) {
  // Check current issue state to support idempotent re-runs.
  let issueState;
  try {
    const { stdout } = await execFile(
      "gh",
      ["api", `/repos/${owner}/${name}/issues/${issueNumber}`],
      { cwd: repoRoot },
    );
    const parsed = JSON.parse(stdout);
    issueState = typeof parsed.state === "string" ? parsed.state : null;
  } catch (error) {
    return {
      ok: false,
      error: "close_issue_lookup_failed",
      message: `gc_close_issue_after_merge could not fetch issue #${issueNumber}: ${extractGhErrorMessage(error)}`,
      issue_number: issueNumber,
    };
  }

  if (issueState === "closed") {
    return {
      ok: true,
      already_closed: true,
      issue_number: issueNumber,
      pr_number: pr.number,
      pr_merged_at: pr.mergedAt,
      next_action: "no_op",
    };
  }

  // The issue is still open. On the requirement-backed path the PR body uses a
  // non-closing `Refs #n` so GitHub cannot auto-close ahead of validation. Require a
  // trusted final-report marker for THIS PR (proof of merged requirement-state
  // validation), OR a trusted issue-thread override authorizing this PR, before closing
  // (issue #1541). A requirement-free run's `Closes #n` closes the issue only when the
  // PR merged into the default branch; merged into the integration branch, the issue
  // is still open here and needs the lane's final-report marker like any other (#1601).
  let closeAuthorized;
  try {
    closeAuthorized = await hasTrustedFinalReportMarker(repoRoot, owner, name, issueNumber, pr.number);
    if (!closeAuthorized) {
      const override = await readTrustedMergeStateOverride(repoRoot, owner, name, issueNumber, pr.number);
      closeAuthorized = override.authorized;
    }
  } catch (error) {
    return {
      ok: false,
      error: "close_final_report_lookup_failed",
      message: `gc_close_issue_after_merge could not read the issue's final-report / authorization markers for issue #${issueNumber}: ${extractGhErrorMessage(error)}`,
      issue_number: issueNumber,
      pr_number: pr.number,
    };
  }
  if (!closeAuthorized) {
    return {
      ok: false,
      error: "close_requirement_state_unverified",
      message:
        `gc_close_issue_after_merge refuses to close issue #${issueNumber}: no trusted gc:final-report marker for PR #${pr.number} is present, ` +
        `so merged requirement-state validation has not been recorded. Post the validated final report ` +
        `(gc_assert_completion phase=post_merge) first, or have a repo-write user comment ` +
        `\`gc-authorize-merge-state-override pr=${pr.number} <reason>\` on the issue.`,
      issue_number: issueNumber,
      pr_number: pr.number,
      next_action: "post_the_validated_final_report_first_or_post_a_trusted_override_authorization",
    };
  }

  try {
    await execFile(
      "gh",
      [
        "api", "--method", "PATCH",
        `/repos/${owner}/${name}/issues/${issueNumber}`,
        "-f", "state=closed",
        "-f", "state_reason=completed",
      ],
      { cwd: repoRoot },
    );
  } catch (error) {
    return {
      ok: false,
      error: "close_issue_patch_failed",
      message: `gc_close_issue_after_merge could not close issue #${issueNumber}: ${extractGhErrorMessage(error)}`,
      issue_number: issueNumber,
      pr_number: pr.number,
    };
  }

  return {
    ok: true,
    already_closed: false,
    issue_number: issueNumber,
    pr_number: pr.number,
    pr_merged_at: pr.mergedAt,
    pr_url: pr.url,
  };
}
