// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { collectPrBodyErrors, renderPrBodyLines } from "./pr-body-render.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { detectSensitiveBodyContent } from "./grc-legacy-compat-2.js";
import { PR_BODY_MAX } from "./repo-vocabulary.js";
import { checkPrBodyShape } from "./runtime-primitives.js";

const TRACEABILITY_TESTABLE_SURFACE_PREFIXES = [
  "backend/src/main/",
  "frontend/src/",
  "mcp/",
  "tools/policy/",
];
export function hasTestableSurfaceTarget(linksOfTypeImplements) {
  if (!Array.isArray(linksOfTypeImplements) || linksOfTypeImplements.length === 0) return false;
  for (const link of linksOfTypeImplements) {
    if (!link || typeof link !== "object") continue;
    const id = typeof link.artifact_identifier === "string" ? link.artifact_identifier : "";
    if (!id) continue;
    for (const prefix of TRACEABILITY_TESTABLE_SURFACE_PREFIXES) {
      if (id.startsWith(prefix)) return true;
    }
  }
  return false;
}
export function validatePrBodyInput(input) {
  if (input == null || typeof input !== "object") {
    return { ok: false, errors: ["input must be an object"] };
  }
  const errors = collectPrBodyErrors(input);
  return errors.length ? { ok: false, errors } : { ok: true };
}
export function buildPrBody(input) {
  const validation = validatePrBodyInput(input);
  if (!validation.ok) {
    throw new Error(`buildPrBody input invalid: ${validation.errors.join("; ")}`);
  }
  return renderPrBodyLines(input).join("\n");
}
export async function runRenderPrBody(input) {
  const validation = validatePrBodyInput(input);
  if (!validation.ok) {
    return {
      ok: false,
      error: "pr_body_input_invalid",
      message: validation.errors.join("; "),
      issue_number: input?.issueNumber ?? null,
    };
  }
  if (typeof input.repoPath === "string" && input.repoPath.trim() !== "") {
    const expectedMode = existsSync(path.join(input.repoPath, "release-please-config.json"))
      ? "release-please"
      : "fragments";
    const actualMode = input.changelogMode ?? "fragments";
    if (actualMode !== expectedMode) {
      return {
        ok: false,
        error: "pr_body_changelog_mode_mismatch",
        message: `changelogMode must be '${expectedMode}' for the target repository`,
        issue_number: input.issueNumber,
        next_action: "use_repository_changelog_mode_and_retry",
      };
    }
  }
  // NB: JS-side deferral detection is intentionally NOT applied here (codex
  // cycle-4 F1). The previous Tier-1 regex was a partial subset of the
  // canonical classifier in `tools/policy/checks.py::run_no_deferral_disposition_check`
  // (which itself loads cases from `tools/policy/deferral_cases.json`).
  // A partial JS detector gives false confidence: a caller-supplied string
  // could pass the JS check and then fail `make policy`/CI. Authoritative
  // enforcement lives in two places that DO catch the rendered body:
  //   (a) the `block-defer-language.py` PreToolUse hook, which fires on
  //       `gh pr {create,edit,comment}` invocations carrying deferral text
  //       in body or title;
  //   (b) `bin/policy` (`tools/policy/checks.py::check_pr_body` →
  //       `run_no_deferral_disposition_check`) at completion-gate / CI time.
  // The downstream MCP record posters (runPostDecisionRecord,
  // runPostFinalReport) keep a Tier-1 check because they call `gh api` rather
  // than `gh pr create`, and the PreToolUse hook only fires on the latter.
  const body = buildPrBody(input);
  // Enforce the GitHub PR-body cap at the renderer boundary (issue #1199) so a
  // render success can never produce an artifact gc_create_synchronized_implement_pr
  // must reject at its own 65,535-byte limit.
  if (Buffer.byteLength(body, "utf8") > PR_BODY_MAX) {
    return {
      ok: false,
      error: "pr_body_too_large",
      message: `rendered PR body is ${Buffer.byteLength(body, "utf8")} bytes; GitHub's PR-body cap is ${PR_BODY_MAX} bytes. Trim summary, changes, or test_notes.`,
      issue_number: input.issueNumber,
      next_action: "trim_inputs_and_retry",
    };
  }
  const sensitiveError = detectSensitiveBodyContent(body);
  if (sensitiveError) {
    return {
      ok: false,
      error: "pr_body_rejected",
      message: sensitiveError,
      issue_number: input.issueNumber,
      next_action: "scrub_secrets_from_inputs_and_retry",
    };
  }
  // Final structural check — mirrors the Python check_pr_body predicates so the
  // tool's contract holds at the boundary, not in agent prose. If the
  // renderer drifts from the policy or a caller-provided field smuggles
  // deferral language past the per-field check, this catches it before the
  // body is handed back for `gh pr create --body`. The Python policy at
  // `bin/policy` remains the canonical check at CI time; this is defense in
  // depth.
  const shape = checkPrBodyShape(body);
  if (!shape.ok) {
    return {
      ok: false,
      error: "pr_body_policy_violation",
      message: shape.errors.join("; "),
      issue_number: input.issueNumber,
      next_action: "fix_inputs_or_renderer_and_retry",
    };
  }
  return {
    ok: true,
    issue_number: input.issueNumber,
    change_class: input.changeClass,
    body,
    byte_length: Buffer.byteLength(body, "utf8"),
  };
}
