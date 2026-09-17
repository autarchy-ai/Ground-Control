// PR-body policy surface, extracted from runtime-primitives.js (issue #1551).
//
// runtime-primitives.js crossed the repo's 500-LOC file gate
// (docs/CODING_STANDARDS.md, Sonar S104) when the review attestation grew a
// second accurate form. These members are one coherent unit — the Markdown
// shape `tools/policy/authz_matrix.py::check_pr_body` enforces, mirrored on the
// JS side so `gc_render_pr_body` refuses a body the CI gate would reject. The
// requirement-UID recognizers they build on stay in runtime-primitives.js;
// the dependency runs one way, and runtime-primitives.js re-exports this module
// so every existing import path is unchanged.

import { EXACT_REQUIREMENT_UID_RE, REQUIREMENT_UID_CONTRACT_DESCRIPTION } from "./runtime-primitives.js";

export const PR_BODY_POLICY_CHECK_LINE = "- [x] Repository policy checks required in CI before merge";
// Repo-neutral Ground Control Checks (issue #1199): the section attests only
// gates the /implement workflow actually enforces for every repository, named
// semantically. The previous lines named `gc_evaluate_quality_gates` /
// `gc_run_sweep`, tools removed with the #1500 backend teardown.
//
// The review attestation has two accurate forms (issue #1551). /implement runs
// both pre-push reviewers (Steps 6.5/6.6) before gc_render_pr_body, so
// "completed" is accurate there. /quickfix leaves both reviewers off unless the
// user passes --review, so the same line on a default quickfix run would claim a
// verification the run never performed. A body must always carry one of these —
// the attestation is never optional, only accurate. Keep both byte-identical to
// tools/policy/authz_matrix.py::check_pr_body's accepted set — the
// renderer-vs-policy compose fixture is the parity contract.
export const PR_BODY_REVIEW_CHECK_LINE_COMPLETED =
  "- [x] Pre-push code review and test-quality review completed; all findings fixed or dispositioned";
export const PR_BODY_REVIEW_CHECK_LINE_NOT_RUN =
  "- [x] Pre-push code review and test-quality review not run for this lane; CI and repository policy gates enforced";
export const PR_BODY_REVIEW_CHECK_LINES = Object.freeze([
  PR_BODY_REVIEW_CHECK_LINE_COMPLETED,
  PR_BODY_REVIEW_CHECK_LINE_NOT_RUN,
]);
export const PR_BODY_PRE_PUSH_REVIEW_STATES = Object.freeze(["completed", "not_run"]);
// Only the lane whose contract makes the pre-push reviewers optional may render
// the "not run" attestation; /implement mandates both, so it can never claim it.
export const PR_BODY_REVIEWS_OPTIONAL_LANE = "quickfix";
export const PR_BODY_LANES = Object.freeze(["implement", PR_BODY_REVIEWS_OPTIONAL_LANE]);
export function prBodyGcCheckLines(prePushReviews) {
  return [
    PR_BODY_POLICY_CHECK_LINE,
    prePushReviews === "not_run" ? PR_BODY_REVIEW_CHECK_LINE_NOT_RUN : PR_BODY_REVIEW_CHECK_LINE_COMPLETED,
  ];
}
const PR_BODY_REQUIRED_HEADERS = Object.freeze([
  "## Requirement UIDs",
  "## ADR Impact",
  "## Ground Control Checks",
  "## Traceability",
]);
// Strip a leading run and a trailing run of backticks (a markdown inline-code
// wrapper like `GC-X001`). A linear scan rather than /^`+|`+$/g, which the regex
// engine matches with super-linear backtracking (Sonar S8786); interior
// backticks are left untouched, exactly as the anchored global replace did.
function stripEdgeBackticks(s) {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === "`") start += 1;
  while (end > start && s[end - 1] === "`") end -= 1;
  return s.slice(start, end);
}
function extractRequirementUidsSection(body) {
  const start = body.indexOf("## Requirement UIDs");
  if (start === -1) return "";
  const after = body.slice(start + "## Requirement UIDs".length);
  const nextHeader = after.search(/\n## /);
  return nextHeader === -1 ? after : after.slice(0, nextHeader);
}
export function extractRequirementUidTokensFromSection(body) {
  if (typeof body !== "string") return [];
  const tokens = [];
  for (const line of extractRequirementUidsSection(body).split(/\r?\n/)) {
    const bullet = line.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (!bullet) continue;
    if (/^\(none\b/i.test(bullet[1])) continue;
    // The WHOLE bullet must be a single token in the corpus. Scanning a bullet
    // for any corpus-shaped word would count ordinary prose — `- (no real UID
    // here)` contains `no`, a syntactically valid identifier — because the
    // corpus cannot distinguish a UID from a word without a lookup. Requiring
    // the bullet to be exactly one token keeps the gate decidable while still
    // accepting every UID the structured path accepts.
    const candidate = stripEdgeBackticks(bullet[1]).trim();
    if (!EXACT_REQUIREMENT_UID_RE.test(candidate)) continue;
    if (!tokens.includes(candidate)) tokens.push(candidate);
  }
  return tokens;
}
export function checkPrBodyShape(body) {
  const errors = [];
  if (typeof body !== "string" || body === "") {
    return { ok: false, errors: ["body must be a non-empty string"] };
  }
  for (const h of PR_BODY_REQUIRED_HEADERS) {
    if (!body.includes(h)) errors.push(`missing required header: ${h}`);
  }
  // Section-scoped UID check — see extractRequirementUidsSection for rationale.
  // The section is machine-rendered one UID per bullet, so it is parsed
  // structurally and each token is held to the identity corpus. That keeps the
  // gate's accepted set exactly equal to what gc_render_pr_body accepts, so a
  // UID that reconciles and reports can always be rendered (issue #1425).
  const uidSection = extractRequirementUidsSection(body);
  const sectionHasUid = extractRequirementUidTokensFromSection(body).length > 0;
  const sectionHasNoneMarker = /-\s*\(none\b/i.test(uidSection);
  if (!sectionHasUid && !sectionHasNoneMarker) {
    errors.push(
      "## Requirement UIDs section must contain at least one Ground Control UID " +
      "(" + REQUIREMENT_UID_CONTRACT_DESCRIPTION + ") OR the explicit '- (none — ...)' " +
      "marker for requirement-free runs. ADR references in other sections do NOT " +
      "satisfy the requirement-UID gate — that is concept confusion between ADR " +
      "impact and requirement traceability.",
    );
  }
  if (!body.includes("ADR-") && !body.includes("No ADR required")) {
    errors.push("ADR Impact must reference an ADR ('ADR-...') or contain 'No ADR required'");
  }
  if (!body.includes(PR_BODY_POLICY_CHECK_LINE)) {
    errors.push(`missing Ground Control Checks line: ${PR_BODY_POLICY_CHECK_LINE}`);
  }
  if (!PR_BODY_REVIEW_CHECK_LINES.some((line) => body.includes(line))) {
    errors.push(
      "missing Ground Control Checks pre-push review attestation; expected one of: "
      + PR_BODY_REVIEW_CHECK_LINES.join(" | "),
    );
  }
  if (!body.includes("- IMPLEMENTS:")) errors.push("missing '- IMPLEMENTS:' marker under Traceability");
  if (!body.includes("- TESTS:")) errors.push("missing '- TESTS:' marker under Traceability");
  // NB: deferral-language enforcement is intentionally NOT done here (codex
  // cycle-4 F1). Authoritative enforcement: `block-defer-language.py`
  // PreToolUse hook on `gh pr create` AND `bin/policy` /
  // `check_pr_body::run_no_deferral_disposition_check` at CI time. The JS
  // classifier was a partial subset of the Python `deferral_cases.json`
  // matcher and gave false confidence ("ok:true" from a body that would
  // later fail policy). The structural check (headers / markers / GC checks
  // / UID section) is what this function owns; deferral is owned downstream.
  if (errors.length) return { ok: false, errors };
  return { ok: true };
}
