// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { isAbsolute, relative, resolve as resolvePath } from "node:path";
export * from "./repo-context-3.js";

export const SUPPORTED_GROUND_CONTROL_SCHEMA_VERSIONS = [1];
export function resolveRepoRelativePath(repoRoot, rawPath, fieldName) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { ok: false, error: `${fieldName} must be a non-empty string when set` };
  }
  if (isAbsolute(rawPath)) {
    return {
      ok: false,
      error: `${fieldName} must be a repo-relative path (got absolute path '${rawPath}')`,
    };
  }
  const abs = resolvePath(repoRoot, rawPath);
  const rel = relative(repoRoot, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return {
      ok: false,
      error: `${fieldName} must stay inside the repository root (got '${rawPath}')`,
    };
  }
  return { ok: true, rel, abs };
}
export const DEFAULT_POLICY_COMMAND = "make policy";
export function resolveWorkflowPolicyCommand(context) {
  const configured = context?.workflow?.policy_command;
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  return DEFAULT_POLICY_COMMAND;
}
export const DEFAULT_PRECOMMIT_COMMAND = "pre-commit run --hook-stage pre-commit";
export function resolveWorkflowPrecommitCommand(context) {
  const configured = context?.workflow?.precommit_command;
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  return DEFAULT_PRECOMMIT_COMMAND;
}
export function emptyWorkflowConfig() {
  return {
    test_command: null,
    completion_command: null,
    lint_command: null,
    format_command: null,
    policy_command: DEFAULT_POLICY_COMMAND,
    precommit_command: DEFAULT_PRECOMMIT_COMMAND,
    base_branch: null,
    // Per-reviewer pre-push cap defaults. `null` means "use the MCP tool
    // default" (issue #906 lowered the tool default from 3 to 1; repos that
    // want the old behavior set `pre_push_cap: 3` explicitly).
    codex_review: { pre_push_cap: null, non_verdict_retry_limit: null },
    test_quality_review: { pre_push_cap: null, non_verdict_retry_limit: null },
    // PR title validation config (issue #896). `null` means "use the canonical
    // defaults declared in step-09-pr-body.md".
    pr_title: null,
    // Integration manager config (issue #989). All fields null means "use the
    // tool-layer defaults at call time".
    integration_manager: { approval_label: null, ordering: null, max_queue_size: null, merge_strategy: null },
    // Dev-start plan gate. Disabled by default so existing repositories keep
    // their current /implement flow until they opt in through repo config.
    dev_start_gate: emptyDevStartGateConfig(),
    // Review-cap auto-disposition (gc_review_cap_disposition). Disabled by
    // default so existing repos keep the human-only override_cap path until
    // they opt in. `mode: shadow` records a disposition without authorizing an
    // over-cap cycle; `authoritative` lets a recorded one_more_cycle grant
    // unblock an auto_grant cycle. `max_auto_overrides` caps how many over-cap
    // cycles the auto path can ever grant per (issue, reviewer).
    review_disposition: { enabled: false, mode: "shadow", max_auto_overrides: 1, judge: { enabled: false, model: null } },

  };
}
export const DEV_START_GATE_REQUIRED_FOR = Object.freeze(["source-bearing"]);
export const DEFAULT_DEV_START_GATE_PLAN_SECTION = "Dev-Start Gate";
export const DEFAULT_DEV_START_GATE_REQUIRED_FIELDS = Object.freeze([
  "Requirement wave or gate",
  "Boundary owner",
  "Contract or seam",
  "Tenant/principal/authz/audit/evidence/provenance context",
  "Connectivity/offline behavior",
  "Security relevance decision",
  "Framework/control-family impact",
  "Verification risk score",
  "Verification plan",
  "Supply chain/provenance impact",
  "Sovereignty/FOCI impact",
  "Quality-gate readiness",
  "Dev-start gate satisfied",
]);
export const DEV_START_GATE_SECURITY_DECISIONS = Object.freeze([
  "security-relevant",
  "not security-relevant",
  "no security baseline",
]);
export function emptyDevStartGateConfig() {
  return {
    enabled: false,
    required_for: "source-bearing",
    plan_section: DEFAULT_DEV_START_GATE_PLAN_SECTION,
    blocker_uids: [],
    required_fields: [...DEFAULT_DEV_START_GATE_REQUIRED_FIELDS],
  };
}
function normalizePrTitleTypes(raw, value, errors) {
  if (raw.types == null) {
    value.types = null;
    return;
  }
  if (!Array.isArray(raw.types)) {
    errors.push("workflow.pr_title.types must be a list of strings");
    return;
  }
  for (const t of raw.types) {
    if (typeof t !== "string" || t.trim() === "") {
      errors.push("workflow.pr_title.types entries must be non-empty strings");
      break;
    }
  }
  if (!errors.some((e) => e.includes("types"))) {
    value.types = [...raw.types];
  }
}
function normalizePrTitleSubjectPattern(raw, value, errors) {
  if (raw.subject_pattern == null) {
    value.subject_pattern = null;
    return;
  }
  if (typeof raw.subject_pattern !== "string" || raw.subject_pattern.trim() === "") {
    errors.push("workflow.pr_title.subject_pattern must be a non-empty string when set");
    return;
  }
  value.subject_pattern = raw.subject_pattern;
}
function normalizePrTitleRequireScope(raw, value, errors) {
  if (raw.require_scope == null) {
    value.require_scope = null;
    return;
  }
  if (typeof raw.require_scope !== "boolean") {
    errors.push("workflow.pr_title.require_scope must be a boolean when set");
    return;
  }
  value.require_scope = raw.require_scope;
}
export function normalizePrTitleConfig(raw) {
  if (raw == null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["workflow.pr_title must be a mapping when set"] };
  }
  const allowed = new Set(["types", "subject_pattern", "require_scope"]);
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(`workflow.pr_title has unknown key '${key}'`);
    }
  }
  const value = {};
  normalizePrTitleTypes(raw, value, errors);
  normalizePrTitleSubjectPattern(raw, value, errors);
  normalizePrTitleRequireScope(raw, value, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}
const REVIEWER_PRE_PUSH_CAP_MIN = 1;
const REVIEWER_PRE_PUSH_CAP_MAX = 10;
// Additional attempts after the first when a station renders no verdict (issue #1476). Zero is
// meaningful — it opts out of automatic re-attempts — which is why the lower bound is 0 and not 1
// as it is for pre_push_cap. The upper bound is deliberately small: a station that cannot be
// observed in three total attempts is a hard external dependency, not something to keep hammering.
const REVIEWER_NON_VERDICT_RETRY_MIN = 0;
const REVIEWER_NON_VERDICT_RETRY_MAX = 2;
export function normalizeReviewerConfig(rawBlock, blockName) {
  if (rawBlock == null) {
    return { ok: true, value: { pre_push_cap: null, non_verdict_retry_limit: null } };
  }
  if (typeof rawBlock !== "object" || Array.isArray(rawBlock)) {
    return { ok: false, errors: [`${blockName} must be a mapping when set`] };
  }
  const allowed = new Set(["pre_push_cap", "non_verdict_retry_limit"]);
  const errors = [];
  for (const key of Object.keys(rawBlock)) {
    if (!allowed.has(key)) {
      errors.push(`${blockName} has unknown key '${key}'`);
    }
  }
  const pre_push_cap = normalizeBoundedReviewerInteger(
    rawBlock.pre_push_cap,
    `${blockName}.pre_push_cap`,
    REVIEWER_PRE_PUSH_CAP_MIN,
    REVIEWER_PRE_PUSH_CAP_MAX,
    errors,
  );
  const non_verdict_retry_limit = normalizeBoundedReviewerInteger(
    rawBlock.non_verdict_retry_limit,
    `${blockName}.non_verdict_retry_limit`,
    REVIEWER_NON_VERDICT_RETRY_MIN,
    REVIEWER_NON_VERDICT_RETRY_MAX,
    errors,
  );
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { pre_push_cap, non_verdict_retry_limit } };
}
/** Null means "unset — use the tool-layer default"; an out-of-range value is an error, not a clamp. */
function normalizeBoundedReviewerInteger(value, label, min, max, errors) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push(`${label} must be an integer`);
    return null;
  }
  if (value < min || value > max) {
    errors.push(`${label} must be between ${min} and ${max} inclusive`);
    return null;
  }
  return value;
}
export const INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MIN = 1;
export const INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MAX = 100;
export const INTEGRATION_MANAGER_ORDERINGS = ["pr_number_asc", "pr_number_desc", "approved_at_asc"];
export const INTEGRATION_MANAGER_MERGE_STRATEGIES = ["merge", "squash", "rebase"];
export function isSafeLabelName(s) {
  if (typeof s !== "string" || s.length === 0) return false;
  if (s.length > 50) return false;
  if (s.length === 1) {
    // Single character: must be a non-space printable ASCII character.
    return /^[\x21-\x7E]$/.test(s);
  }
  // Length ≥ 2: first and last chars must be non-space printable ASCII;
  // interior chars may include spaces (\x20) but no control chars or non-ASCII.
  return /^[\x21-\x7E][\x20-\x7E]*[\x21-\x7E]$/.test(s);
}
function normalizeIntegrationApprovalLabel(raw, errors) {
  if (raw.approval_label == null) return null;
  if (typeof raw.approval_label !== "string" || !isSafeLabelName(raw.approval_label)) {
    errors.push(
      "workflow.integration_manager.approval_label must be a 1–50 character printable ASCII string without leading or trailing whitespace",
    );
    return null;
  }
  return raw.approval_label;
}
function normalizeIntegrationOrdering(raw, errors) {
  if (raw.ordering == null) return null;
  if (INTEGRATION_MANAGER_ORDERINGS.includes(raw.ordering)) return raw.ordering;
  errors.push(
    `workflow.integration_manager.ordering must be one of: ${INTEGRATION_MANAGER_ORDERINGS.join(", ")}`,
  );
  return null;
}
function normalizeIntegrationMaxQueueSize(raw, errors) {
  if (raw.max_queue_size == null) return null;
  const v = raw.max_queue_size;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    errors.push("workflow.integration_manager.max_queue_size must be an integer");
    return null;
  }
  if (v < INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MIN || v > INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MAX) {
    errors.push(
      `workflow.integration_manager.max_queue_size must be between ${INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MIN} and ${INTEGRATION_MANAGER_MAX_QUEUE_SIZE_MAX} inclusive`,
    );
    return null;
  }
  return v;
}
function normalizeIntegrationMergeStrategy(raw, errors) {
  if (raw.merge_strategy == null) return null;
  if (INTEGRATION_MANAGER_MERGE_STRATEGIES.includes(raw.merge_strategy)) return raw.merge_strategy;
  errors.push(
    `workflow.integration_manager.merge_strategy must be one of: ${INTEGRATION_MANAGER_MERGE_STRATEGIES.join(", ")}`,
  );
  return null;
}
export function normalizeIntegrationManagerConfig(raw) {
  if (raw == null) {
    return { ok: true, value: { approval_label: null, ordering: null, max_queue_size: null, merge_strategy: null } };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: ["workflow.integration_manager must be a mapping when set"],
    };
  }
  const allowed = new Set(["approval_label", "ordering", "max_queue_size", "merge_strategy"]);
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(`workflow.integration_manager has unknown key '${key}'`);
    }
  }
  const approval_label = normalizeIntegrationApprovalLabel(raw, errors);
  const ordering = normalizeIntegrationOrdering(raw, errors);
  const max_queue_size = normalizeIntegrationMaxQueueSize(raw, errors);
  const merge_strategy = normalizeIntegrationMergeStrategy(raw, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { approval_label, ordering, max_queue_size, merge_strategy } };
}
export function isSafeGitRefName(s) {
  if (typeof s !== "string" || s === "") return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(s)) return false;
  if (s.startsWith("-")) return false;
  if (s.startsWith("/") || s.endsWith("/")) return false;
  if (s.startsWith(".") || s.endsWith(".")) return false;
  if (s.endsWith(".lock")) return false;
  if (s.includes("..")) return false;
  if (s.includes("//")) return false;
  const components = s.split("/");
  if (components.some((part) => (
    part === ""
    || part.startsWith(".")
    || part.endsWith(".")
    || part.endsWith(".lock")
  ))) return false;
  return true;
}
// The optional sonarcloud fields: same validation, same trimming, one loop.
// `analysis_check` names the CI check or workflow that publishes this repo's
// Sonar analysis, so the watcher can tell "no analysis is coming" from "it has
// not landed yet" (issue #1559). Absent, any Sonar-named check matches. It
// selects an existing producer; it never asserts that a scan may be skipped.
const SONARCLOUD_OPTIONAL_KEYS = ["quality_gate", "analysis_check"];
const SONARCLOUD_ALLOWED_KEYS = new Set(["project_key", "organization", ...SONARCLOUD_OPTIONAL_KEYS]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function normalizeSonarcloudConfig(raw) {
  if (raw == null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["sonarcloud must be a mapping, not a list or scalar"] };
  }
  const errors = Object.keys(raw)
    .filter((key) => !SONARCLOUD_ALLOWED_KEYS.has(key))
    .map((key) => `sonarcloud has unknown key '${key}'`);

  for (const key of ["project_key", "organization"]) {
    if (!nonEmptyString(raw[key])) {
      errors.push(`sonarcloud.${key} must be a non-empty string when sonarcloud is set`);
    }
  }
  for (const key of SONARCLOUD_OPTIONAL_KEYS) {
    if (raw[key] != null && !nonEmptyString(raw[key])) {
      errors.push(`sonarcloud.${key} must be a non-empty string when set`);
    }
  }
  if (errors.length) return { ok: false, errors };

  const value = { project_key: raw.project_key, organization: raw.organization };
  for (const key of SONARCLOUD_OPTIONAL_KEYS) {
    if (raw[key] != null) value[key] = raw[key].trim();
  }
  return { ok: true, value };
}
export function normalizeRulesConfig(raw) {
  if (raw == null) {
    return { ok: true, value: { plan_rules_path: null } };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["rules must be a mapping"] };
  }
  const allowed = new Set(["plan_rules"]);
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(`rules has unknown key '${key}'`);
    }
  }
  if (errors.length) return { ok: false, errors };

  const planRules = raw.plan_rules;
  if (planRules == null) {
    return { ok: true, value: { plan_rules_path: null } };
  }
  if (typeof planRules !== "string" || planRules.trim() === "") {
    return { ok: false, errors: ["rules.plan_rules must be a non-empty string when set"] };
  }
  return { ok: true, value: { plan_rules_path: planRules } };
}
function emptyDocsConfig() {
  return {
    adr_dir: null,
    architecture_overview: null,
    coding_standards: null,
    workflow_reference: null,
    knowledge_base: null,
  };
}
export function normalizeDocsConfig(raw) {
  if (raw == null) {
    return { ok: true, value: emptyDocsConfig() };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["docs must be a mapping, not a list or scalar"] };
  }
  const allowed = new Set(["adr_dir", "architecture_overview", "coding_standards", "workflow_reference", "knowledge_base"]);
  const value = emptyDocsConfig();
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(`docs has unknown key '${key}'`);
      continue;
    }
    const v = raw[key];
    if (v == null) continue;
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`docs.${key} must be a non-empty string when set`);
      continue;
    }
    value[key] = v;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}
export function emptyExamplePathsConfig() {
  return { source: null, test: null };
}
