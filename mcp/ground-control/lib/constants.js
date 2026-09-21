// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { emptyExamplePathsConfig } from "./repo-context.js";

// Automated post-merge finalization (issue #1688). `.ground-control.yaml` is the one
// Ground Control config a repository carries, so the grndctl version Phase E runs is
// declared here rather than baked into the workflow file. The workflow still has to exist —
// GitHub fires `pull_request: closed` only from a file in `.github/workflows/` — but it
// becomes a write-once trigger that reads this value, not a second thing to version.
export function normalizePhaseEConfig(raw) {
  if (raw == null) return { ok: true, value: { enabled: false, version: null } };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["phase_e must be a mapping"] };
  }
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!["enabled", "version"].includes(key)) errors.push(`unknown phase_e key '${key}'`);
  }
  const enabled = raw.enabled == null ? true : raw.enabled;
  if (typeof enabled !== "boolean") errors.push("phase_e.enabled must be a boolean");
  let version = null;
  if (raw.version != null) {
    if (typeof raw.version !== "string" || !/^\d+\.\d+\.\d+/.test(raw.version)) {
      errors.push("phase_e.version must be an exact grndctl version such as '2.5.1'");
    } else {
      version = raw.version;
    }
  }
  // An enabled lane with no version has nothing to run: the workflow resolves the release
  // from this field, so leaving it out would silently fall back to whatever `latest` is.
  if (enabled === true && version === null) {
    errors.push("phase_e.version is required when phase_e is enabled");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { enabled, version } };
}

// The operational pickup flag, applied when a lane takes an issue and dropped when the
// shared post-merge close concludes the issue is closed. One name rather than a literal at
// each end of the lifecycle: the two ends drifting apart is the failure this prevents, and
// it is why the label outlived its removal once already (issue #1686).
export const IMPLEMENT_IN_PROGRESS_LABEL = "in-progress";
export const STATUSES = ["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"];
export const REQUIREMENT_TYPES = ["FUNCTIONAL", "NON_FUNCTIONAL", "CONSTRAINT", "INTERFACE"];
export const PRIORITIES = ["MUST", "SHOULD", "COULD", "WONT"];
export const RELATION_TYPES = ["PARENT", "DEPENDS_ON", "CONFLICTS_WITH", "REFINES", "SUPERSEDES", "RELATED"];
export const ARTIFACT_TYPES = [
  "GITHUB_ISSUE",
  "PULL_REQUEST",
  "CODE_FILE",
  "ADR",
  "CONFIG",
  "POLICY",
  "TEST",
  "SPEC",
  "PROOF",
  "DOCUMENTATION",
  "RISK_SCENARIO",
  "CONTROL",
];
export const LINK_TYPES = ["IMPLEMENTS", "TESTS", "DOCUMENTS", "CONSTRAINS", "VERIFIES"];
export const CHANGE_CATEGORIES = ["REQUIREMENT", "RELATION", "TRACEABILITY_LINK"];
export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"];
export const METRIC_TYPES = ["COVERAGE", "ORPHAN_COUNT", "COMPLETENESS"];
export const COMPARISON_OPERATORS = ["GTE", "LTE", "EQ", "GT", "LT"];
export const ADR_STATUSES = ["PROPOSED", "ACCEPTED", "DEPRECATED", "SUPERSEDED"];
export const ASSET_TYPES = [
  "APPLICATION",
  "SERVICE",
  "SYSTEM",
  "DATABASE",
  "NETWORK",
  "HOST",
  "CONTAINER",
  "IDENTITY",
  "DATA_STORE",
  "ENDPOINT",
  "INTEGRATION",
  "WORKLOAD",
  "THIRD_PARTY",
  "BOUNDARY",
  "OTHER",
];
export const ASSET_CRITICALITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
export const ASSET_ENVIRONMENTS = [
  "PRODUCTION",
  "STAGING",
  "DEVELOPMENT",
  "TEST",
  "NON_PRODUCTION",
  "OTHER",
];
export const ASSET_SCOPES = ["IN_SCOPE", "OUT_OF_SCOPE"];
export const KNOWLEDGE_STATES = ["CONFIRMED", "PROVISIONAL", "UNKNOWN"];
export const ASSET_RELATION_TYPES = [
  "CONTAINS",
  "DEPENDS_ON",
  "COMMUNICATES_WITH",
  "TRUST_BOUNDARY",
  "SUPPORTS",
  "ACCESSES",
  "DATA_FLOW",
];
export const ASSET_LINK_TARGET_TYPES = [
  "REQUIREMENT",
  "CONTROL",
  "RISK_SCENARIO",
  "RISK_REGISTER_RECORD",
  "RISK_ASSESSMENT_RESULT",
  "TREATMENT_PLAN",
  "METHODOLOGY_PROFILE",
  "THREAT_MODEL_ENTRY",
  "FINDING",
  "EVIDENCE",
  "AUDIT",
  "ISSUE",
  "CODE",
  "CONFIGURATION",
  "EXTERNAL",
];
export const ASSET_LINK_TYPES = [
  "IMPLEMENTS",
  "MITIGATES",
  "SUBJECT_OF",
  "EVIDENCED_BY",
  "GOVERNED_BY",
  "DEPENDS_ON",
  "ASSOCIATED",
];
export const OBSERVATION_CATEGORIES = [
  "CONFIGURATION",
  "EXPOSURE",
  "IDENTITY",
  "DEPLOYMENT",
  "PATCH_STATE",
  "RELATIONSHIP",
  "OTHER",
];
export const RISK_SCENARIO_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"];
export const RISK_SCENARIO_LINK_TARGET_TYPES = [
  "THREAT_MODEL",
  "VULNERABILITY",
  "CONTROL",
  "FINDING",
  "EVIDENCE",
  "AUDIT_RECORD",
  "RISK_REGISTER_RECORD",
  "RISK_ASSESSMENT_RESULT",
  "TREATMENT_PLAN",
  "METHODOLOGY_PROFILE",
  "OBSERVATION",
  "ASSET",
  "REQUIREMENT",
  "EXTERNAL",
];
export const RISK_SCENARIO_LINK_TYPES = [
  "MITIGATED_BY",
  "EXPLOITS",
  "AFFECTS",
  "EVIDENCED_BY",
  "GOVERNED_BY",
  "ASSESSED_IN",
  "REGISTERED_IN",
  "OBSERVED_IN",
  "ASSOCIATED",
];
export const THREAT_MODEL_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"];
export const STRIDE_CATEGORIES = [
  "SPOOFING",
  "TAMPERING",
  "REPUDIATION",
  "INFORMATION_DISCLOSURE",
  "DENIAL_OF_SERVICE",
  "ELEVATION_OF_PRIVILEGE",
];
export const THREAT_MODEL_LINK_TARGET_TYPES = [
  "ASSET",
  "REQUIREMENT",
  "CONTROL",
  "RISK_SCENARIO",
  "OBSERVATION",
  "RISK_ASSESSMENT_RESULT",
  "VERIFICATION_RESULT",
  "FINDING",
  "ARCHITECTURE_MODEL",
  "CODE",
  "ISSUE",
  "EVIDENCE",
  "EXTERNAL",
];
export const THREAT_MODEL_LINK_TYPES = [
  "AFFECTS",
  "EXPLOITS",
  "MITIGATED_BY",
  "ASSESSED_IN",
  "OBSERVED_IN",
  "DOCUMENTED_IN",
  "ASSOCIATED",
];
export function normalizeExamplePathsConfig(raw) {
  if (raw == null) {
    return { ok: true, value: emptyExamplePathsConfig() };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["example_paths must be a mapping, not a list or scalar"] };
  }
  const allowed = ["source", "test"];
  const value = emptyExamplePathsConfig();
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      errors.push(`example_paths has unknown key '${key}'`);
      continue;
    }
    const v = raw[key];
    if (v == null) continue;
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`example_paths.${key} must be a non-empty string when set`);
      continue;
    }
    value[key] = v;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}
function emptyRequirementsConfig() {
  return { uid_examples: [] };
}
export function normalizeRequirementsConfig(raw) {
  if (raw == null) {
    return { ok: true, value: emptyRequirementsConfig() };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["requirements must be a mapping, not a list or scalar"] };
  }
  const allowed = ["uid_examples"];
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      errors.push(`requirements has unknown key '${key}'`);
    }
  }
  const value = emptyRequirementsConfig();
  const uidExamples = raw.uid_examples;
  if (uidExamples != null) {
    if (!Array.isArray(uidExamples)) {
      errors.push("requirements.uid_examples must be a list of strings");
    } else {
      for (const entry of uidExamples) {
        if (typeof entry !== "string" || entry.trim() === "") {
          errors.push("requirements.uid_examples entries must be non-empty strings");
          break;
        }
      }
      if (!errors.length) value.uid_examples = [...uidExamples];
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}
function emptyCrossCuttingConcernsConfig() {
  return { description: null };
}
export function normalizeCrossCuttingConcernsConfig(raw) {
  if (raw == null) {
    return { ok: true, value: emptyCrossCuttingConcernsConfig() };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["cross_cutting_concerns must be a mapping, not a list or scalar"] };
  }
  const allowed = ["description"];
  const value = emptyCrossCuttingConcernsConfig();
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      errors.push(`cross_cutting_concerns has unknown key '${key}'`);
      continue;
    }
    const v = raw[key];
    if (v == null) continue;
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`cross_cutting_concerns.${key} must be a non-empty string when set`);
      continue;
    }
    value[key] = v;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}
export function normalizeKnowledgeConfig(raw) {
  if (raw == null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["knowledge must be a mapping, not a list or scalar"] };
  }
  const allowed = ["dir", "schema", "inbox"];
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      errors.push(`knowledge has unknown key '${key}'`);
    }
  }
  if (typeof raw.dir !== "string" || raw.dir.trim() === "") {
    errors.push("knowledge.dir is required and must be a non-empty string");
  }
  for (const optional of ["schema", "inbox"]) {
    const v = raw[optional];
    if (v == null) continue;
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`knowledge.${optional} must be a non-empty string when set`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      dir: raw.dir,
      schema: raw.schema ?? null,
      inbox: raw.inbox ?? null,
    },
  };
}
