// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { realpathSync } from "node:fs";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { isPathStrictlyInside } from "./api-requirements.js";
import { DEV_START_GATE_REQUIRED_FOR, emptyDevStartGateConfig, emptyWorkflowConfig, isSafeGitRefName, normalizeIntegrationManagerConfig, normalizePrTitleConfig, normalizeReviewDispositionConfig, normalizeReviewerConfig } from "./repo-context.js";
import { CLAUDE_MODEL_BY_TIER, ROUTING_PROVIDERS, ROUTING_STAGE_NAME_RE, ROUTING_TIERS } from "./repo-vocabulary.js";
import { EXACT_REQUIREMENT_UID_RE, REQUIREMENT_UID_CONTRACT_DESCRIPTION } from "./runtime-primitives.js";

export function assertRealpathInRepo(repoRootReal, targetAbs, fieldName) {
  let cursor = targetAbs;
  let canonical = null;
  for (;;) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- cursor originates from an already-validated repo-relative path
      canonical = realpathSync(cursor);
      break;
    } catch (error) {
      // ENOENT means the path itself (or the ancestor we're currently at)
      // does not exist yet — walk up one level and keep looking.
      // ENOTDIR means we descended *through* a regular file, e.g.
      // `docs/knowledge/SCHEMA.md/capture`. The offending component is still
      // somewhere above `cursor`; walk up the same way so the helper always
      // returns a structured validation error instead of letting the
      // exception escape and hard-fail the whole tool call.
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) {
        return {
          ok: false,
          error: `${fieldName} could not be canonicalized — no valid ancestor of '${targetAbs}' (${error.code})`,
        };
      }
      cursor = parent;
    }
  }

  // If we walked up the tree, append the unresolved tail back so the
  // "resolved" path reflects what the caller will actually use. The tail
  // cannot re-introduce symlink escapes because it does not yet exist.
  const tail = relative(cursor, targetAbs);
  const effective = tail === "" ? canonical : resolvePath(canonical, tail);
  if (!isPathStrictlyInside(repoRootReal, effective)) {
    return {
      ok: false,
      error: `${fieldName} resolves outside the repository root via a symlink (canonical path '${effective}')`,
    };
  }
  return { ok: true, canonical: effective };
}
function validateStringList(raw, fieldName, { uid = false } = {}) {
  const errors = [];
  if (!Array.isArray(raw)) {
    return { ok: false, errors: [`${fieldName} must be a list when set`] };
  }
  const seen = new Set();
  const value = [];
  raw.forEach((entry, i) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      errors.push(`${fieldName}[${i}] must be a non-empty string`);
      return;
    }
    const trimmed = entry.trim();
    if (trimmed.includes("\n") || trimmed.includes("\r")) {
      errors.push(`${fieldName}[${i}] must be a single-line string`);
      return;
    }
    if (uid && !EXACT_REQUIREMENT_UID_RE.test(trimmed)) {
      errors.push(`${fieldName}[${i}] must be ${REQUIREMENT_UID_CONTRACT_DESCRIPTION}`);
      return;
    }
    if (seen.has(trimmed)) {
      errors.push(`${fieldName}[${i}] duplicates '${trimmed}'`);
      return;
    }
    seen.add(trimmed);
    value.push(trimmed);
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}
function normalizeDevStartGateEnabled(raw, value, errors) {
  if (raw.enabled == null) return;
  if (typeof raw.enabled !== "boolean") {
    errors.push("workflow.dev_start_gate.enabled must be a boolean when set");
    return;
  }
  value.enabled = raw.enabled;
}
function normalizeDevStartGateRequiredFor(raw, value, errors) {
  if (raw.required_for == null) return;
  if (DEV_START_GATE_REQUIRED_FOR.includes(raw.required_for)) {
    value.required_for = raw.required_for;
    return;
  }
  errors.push(`workflow.dev_start_gate.required_for must be one of: ${DEV_START_GATE_REQUIRED_FOR.join(", ")}`);
}
function normalizeDevStartGatePlanSection(raw, value, errors) {
  if (raw.plan_section == null) return;
  if (typeof raw.plan_section !== "string" || raw.plan_section.trim() === "") {
    errors.push("workflow.dev_start_gate.plan_section must be a non-empty string when set");
    return;
  }
  if (raw.plan_section.includes("\n") || raw.plan_section.includes("\r")) {
    errors.push("workflow.dev_start_gate.plan_section must be a single-line string");
    return;
  }
  value.plan_section = raw.plan_section.trim();
}
function normalizeDevStartGateBlockerUids(raw, value, errors) {
  if (raw.blocker_uids == null) return;
  const r = validateStringList(raw.blocker_uids, "workflow.dev_start_gate.blocker_uids", { uid: true });
  if (r.ok) value.blocker_uids = r.value;
  else errors.push(...r.errors);
}
function normalizeDevStartGateRequiredFields(raw, value, errors) {
  if (raw.required_fields == null) return;
  const r = validateStringList(raw.required_fields, "workflow.dev_start_gate.required_fields");
  if (!r.ok) errors.push(...r.errors);
  else if (r.value.length === 0) errors.push("workflow.dev_start_gate.required_fields must not be empty when set");
  else value.required_fields = r.value;
}
export function normalizeDevStartGateConfig(raw) {
  const value = emptyDevStartGateConfig();
  if (raw == null) {
    return { ok: true, value };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["workflow.dev_start_gate must be a mapping when set"] };
  }
  const allowed = new Set(["enabled", "required_for", "plan_section", "blocker_uids", "required_fields"]);
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) errors.push(`workflow.dev_start_gate has unknown key '${key}'`);
  }
  normalizeDevStartGateEnabled(raw, value, errors);
  normalizeDevStartGateRequiredFor(raw, value, errors);
  normalizeDevStartGatePlanSection(raw, value, errors);
  normalizeDevStartGateBlockerUids(raw, value, errors);
  normalizeDevStartGateRequiredFields(raw, value, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}
function applyWorkflowScalarKeys(raw, value, allowed, allowedNested, errors) {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(`workflow has unknown key '${key}'`);
      continue;
    }
    if (allowedNested.has(key)) continue; // handled by applyWorkflowNestedKeys
    const v = raw[key];
    if (v == null) continue;
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`workflow.${key} must be a non-empty string when set`);
      continue;
    }
    if (key === "base_branch" && !isSafeGitRefName(v)) {
      errors.push(
        `workflow.base_branch '${v}' is not a safe Git ref name; allowed characters are [A-Za-z0-9._/-] and the value must satisfy git check-ref-format`,
      );
      continue;
    }
    value[key] = v;
  }
}
function applyWorkflowNestedKeys(raw, value, errors) {
  const nested = [
    ["codex_review", () => normalizeReviewerConfig(raw.codex_review, "workflow.codex_review")],
    ["test_quality_review", () => normalizeReviewerConfig(raw.test_quality_review, "workflow.test_quality_review")],
    ["pr_title", () => normalizePrTitleConfig(raw.pr_title)],
    ["integration_manager", () => normalizeIntegrationManagerConfig(raw.integration_manager)],
    ["dev_start_gate", () => normalizeDevStartGateConfig(raw.dev_start_gate)],
    ["review_disposition", () => normalizeReviewDispositionConfig(raw.review_disposition)],
  ];
  for (const [key, run] of nested) {
    const result = run();
    if (result.ok) value[key] = result.value;
    else errors.push(...result.errors);
  }
}
export function normalizeWorkflowConfig(raw) {
  if (raw == null || typeof raw !== "object") {
    return { ok: true, value: emptyWorkflowConfig() };
  }
  if (Array.isArray(raw)) {
    return { ok: false, errors: ["workflow must be a mapping, not a list"] };
  }
  // Scalar string-typed keys handled inline; nested-mapping keys delegated to
  // their own normalizers below.
  const allowedScalar = ["test_command", "completion_command", "lint_command", "format_command", "policy_command", "precommit_command", "base_branch"];
  const allowedNested = new Set(["codex_review", "test_quality_review", "pr_title", "integration_manager", "dev_start_gate", "review_disposition"]);
  const allowed = new Set([...allowedScalar, ...allowedNested]);
  const value = emptyWorkflowConfig();
  const errors = [];
  applyWorkflowScalarKeys(raw, value, allowed, allowedNested, errors);
  applyWorkflowNestedKeys(raw, value, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}
function normalizeRoutingEnabled(raw, errors) {
  if (raw.enabled == null) return false;
  if (typeof raw.enabled !== "boolean") {
    errors.push("routing.enabled must be a boolean when set");
    return false;
  }
  return raw.enabled;
}
function normalizeRoutingDefaultProvider(raw, errors) {
  if (raw.default_provider == null) return "claude";
  if (ROUTING_PROVIDERS.includes(raw.default_provider)) return raw.default_provider;
  errors.push(`routing.default_provider must be one of: ${ROUTING_PROVIDERS.join(", ")}`);
  return "claude";
}
function normalizeRoutingStages(raw, defaultProvider, errors) {
  const stages = {};
  if (raw.stages == null) return stages;
  if (typeof raw.stages !== "object" || Array.isArray(raw.stages)) {
    errors.push("routing.stages must be a mapping from stage name to route config");
    return stages;
  }
  for (const [stage, route] of Object.entries(raw.stages)) {
    const normalized = normalizeRoutingStageConfig(stage, route, { defaultProvider });
    if (normalized.ok) stages[stage] = normalized.value;
    else errors.push(...normalized.errors);
  }
  return stages;
}
export function normalizeRoutingConfig(raw) {
  if (raw == null) {
    return { ok: true, value: { enabled: false, default_provider: "claude", stages: {} } };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["routing must be a mapping, not a list or scalar"] };
  }
  const allowed = new Set(["enabled", "default_provider", "stages"]);
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(`routing has unknown key '${key}'`);
    }
  }
  const enabled = normalizeRoutingEnabled(raw, errors);
  const defaultProvider = normalizeRoutingDefaultProvider(raw, errors);
  const stages = normalizeRoutingStages(raw, defaultProvider, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { enabled, default_provider: defaultProvider, stages } };
}
function normalizeRoutingStageConfig(stage, raw, { defaultProvider }) {
  const prefix = `routing.stages.${stage}`;
  const errors = [];
  if (!ROUTING_STAGE_NAME_RE.test(stage)) {
    errors.push(`${prefix} key must match ${ROUTING_STAGE_NAME_RE}`);
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [...errors, `${prefix} must be a mapping`] };
  }
  const allowed = new Set(["tier", "provider", "model"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(`${prefix} has unknown key '${key}'`);
    }
  }
  const tier = raw.tier;
  if (!ROUTING_TIERS.includes(tier)) {
    errors.push(`${prefix}.tier must be one of: ${ROUTING_TIERS.join(", ")}`);
  }
  const provider = raw.provider ?? defaultProvider;
  if (!ROUTING_PROVIDERS.includes(provider)) {
    errors.push(`${prefix}.provider must be one of: ${ROUTING_PROVIDERS.join(", ")}`);
  }
  const model = raw.model ?? CLAUDE_MODEL_BY_TIER[tier];
  if (provider === "claude" && typeof model === "string" && !/^claude-(haiku|sonnet|opus)-\d+(-\d+)?$/.test(model)) {
    errors.push(`${prefix}.model must be a canonical Claude model id like claude-sonnet-5`);
  } else if (typeof model !== "string" || model.trim() === "") {
    errors.push(`${prefix}.model must be a non-empty string`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { tier, provider, model } };
}
export const CODEX_REVIEW_HARD_CAP = 3;
export const CODEX_REVIEW_CYCLE_MARKER_PREFIX = "<!-- gc:codex-review-cycle";
const CODEX_REVIEW_CYCLE_MARKER_RE =
  /<!--\s*gc:codex-review-cycle\s+cycle="(\d+)"\s+pr="(\d+)"[^]*?-->/;
export function parseCodexReviewCycleMarkers(commentBodies, prNumber) {
  if (!Array.isArray(commentBodies)) return 0;
  let count = 0;
  for (const body of commentBodies) {
    if (typeof body !== "string") continue;
    const match = CODEX_REVIEW_CYCLE_MARKER_RE.exec(body);
    if (!match) continue;
    const markerPr = Number.parseInt(match[2], 10);
    if (markerPr === prNumber) count += 1;
  }
  return count;
}
export function evaluateCodexReviewCycleCap({
  priorCount,
  prNumber,
  hardCap = CODEX_REVIEW_HARD_CAP,
  overrideCap = false,
  overrideReason = null,
}) {
  if (typeof priorCount !== "number" || !Number.isFinite(priorCount) || priorCount < 0) {
    throw new Error(`evaluateCodexReviewCycleCap: priorCount must be a non-negative number, got ${priorCount}`);
  }

  if (overrideCap === true) {
    if (typeof overrideReason !== "string" || overrideReason.trim() === "") {
      return {
        ok: false,
        error: "codex_review_override_missing_reason",
        message:
          "override_cap=true requires a non-empty override_reason quoting the user's authorization. " +
          "Audits cannot distinguish legitimate overrides from accidental ones without a reason.",
        pr_number: prNumber,
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
      error: "codex_review_cap_reached",
      message:
        `gc_codex_review hard cap reached (${hardCap} cycles) for PR #${prNumber}. ` +
        `Per GC-O007 / ADR-029, after cycle ${hardCap} you must (a) post a summary of findings + fixes ` +
        `to the issue thread, then (b) escalate to the user and ask whether to run cycle ${hardCap + 1} ` +
        `or ship as-is. Do not address findings by silently re-invoking codex. If the user authorizes ` +
        `another cycle, retry with override_cap=true and override_reason="<their authorization>".`,
      pr_number: prNumber,
      prior_cycles: priorCount,
      cap: hardCap,
      next_action: "post_summary_and_escalate_to_user",
    };
  }

  // Cycle 1 returns next_action that nudges toward "fix findings"; cycle 2
  // returns the stronger nudge that includes the summarize-and-escalate
  // discipline (the gap that #794 was specifically filed to close).
  const nextCycle = priorCount + 1;
  return {
    ok: true,
    nextCycle,
    cap: hardCap,
    next_action:
      nextCycle === hardCap
        ? "fix_all_findings_then_summarize_and_escalate"
        : "fix_all_findings_and_push",
  };
}
export function buildCodexReviewCycleMarker({ prNumber, cycleNumber, override = false, overrideReason = null }) {
  const overrideAttr = override === true ? ' override="true"' : "";
  const reasonAttr =
    override === true && typeof overrideReason === "string" && overrideReason.trim() !== ""
      ? ` reason=${JSON.stringify(overrideReason.trim())}`
      : "";
  const headline = override
    ? `_gc_codex_review cycle ${cycleNumber} (USER-AUTHORIZED OVERRIDE past cap ${CODEX_REVIEW_HARD_CAP}) complete for PR #${prNumber}._`
    : `_gc_codex_review cycle ${cycleNumber} of ${CODEX_REVIEW_HARD_CAP} complete for PR #${prNumber}._`;
  const reasonLine =
    override && typeof overrideReason === "string" && overrideReason.trim() !== ""
      ? `\nOverride reason: ${overrideReason.trim()}`
      : "";
  return [
    `${CODEX_REVIEW_CYCLE_MARKER_PREFIX} cycle="${cycleNumber}" pr="${prNumber}"${overrideAttr}${reasonAttr} -->`,
    "",
    headline +
      ` Posted by the MCP server to enforce the hard-cap-${CODEX_REVIEW_HARD_CAP} contract (issues #794, #804). ` +
      "Do not edit or delete — used by the next `gc_codex_review` invocation to count cycles." +
      reasonLine,
  ].join("\n");
}
