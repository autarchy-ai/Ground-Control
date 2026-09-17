// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const ARCH_VOCABULARY_TOP_KEYS = new Set(["patterns", "canonical_helpers", "boundary_contract", "binding_adrs", "anti_recommendations"]);
const ARCH_PATTERN_KEYS = new Set(["name", "applies_to", "example_path"]);
const ARCH_HELPER_KEYS = new Set(["name", "path", "purpose"]);
const ARCH_BOUNDARY_KEYS = new Set(["description"]);
const ARCH_BINDING_ADR_KEYS = new Set(["id", "one_liner"]);
const ARCH_BINDING_ADR_ID_RE = /^ADR-\d{3}$/;
function emptyArchitectureVocabularyConfig() {
  return {
    patterns: [],
    canonical_helpers: [],
    boundary_contract: null,
    binding_adrs: [],
    anti_recommendations: [],
  };
}
function validateVocabularyPatterns(rawPatterns, value, errors) {
  if (!Array.isArray(rawPatterns)) {
    errors.push("architecture.vocabulary.patterns must be a list when set");
    return;
  }
  rawPatterns.forEach((entry, i) => {
    const prefix = `architecture.vocabulary.patterns[${i}]`;
    const before = errors.length;
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${prefix} must be a mapping`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ARCH_PATTERN_KEYS.has(key)) {
        errors.push(`${prefix} has unknown key '${key}'`);
      }
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      errors.push(`${prefix}.name must be a non-empty string`);
    }
    if (typeof entry.applies_to !== "string" || entry.applies_to.trim() === "") {
      errors.push(`${prefix}.applies_to must be a non-empty string`);
    }
    if (entry.example_path != null && (typeof entry.example_path !== "string" || entry.example_path.trim() === "")) {
      errors.push(`${prefix}.example_path must be a non-empty string when set`);
    }
    if (errors.length === before) {
      value.patterns.push({
        name: entry.name,
        applies_to: entry.applies_to,
        example_path: entry.example_path ?? null,
      });
    }
  });
}

function validateVocabularyCanonicalHelpers(rawHelpers, value, errors) {
  if (!Array.isArray(rawHelpers)) {
    errors.push("architecture.vocabulary.canonical_helpers must be a list when set");
    return;
  }
  rawHelpers.forEach((entry, i) => {
    const prefix = `architecture.vocabulary.canonical_helpers[${i}]`;
    const before = errors.length;
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${prefix} must be a mapping`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ARCH_HELPER_KEYS.has(key)) {
        errors.push(`${prefix} has unknown key '${key}'`);
      }
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      errors.push(`${prefix}.name must be a non-empty string`);
    }
    if (typeof entry.purpose !== "string" || entry.purpose.trim() === "") {
      errors.push(`${prefix}.purpose must be a non-empty string`);
    }
    if (entry.path != null && (typeof entry.path !== "string" || entry.path.trim() === "")) {
      errors.push(`${prefix}.path must be a non-empty string when set`);
    }
    if (errors.length === before) {
      value.canonical_helpers.push({
        name: entry.name,
        purpose: entry.purpose,
        path: entry.path ?? null,
      });
    }
  });
}

function validateVocabularyBoundaryContract(rawBoundary, value, errors) {
  if (typeof rawBoundary !== "object" || Array.isArray(rawBoundary)) {
    errors.push("architecture.vocabulary.boundary_contract must be a mapping when set");
    return;
  }
  for (const key of Object.keys(rawBoundary)) {
    if (!ARCH_BOUNDARY_KEYS.has(key)) {
      errors.push(`architecture.vocabulary.boundary_contract has unknown key '${key}'`);
    }
  }
  if (typeof rawBoundary.description !== "string" || rawBoundary.description.trim() === "") {
    errors.push("architecture.vocabulary.boundary_contract.description must be a non-empty string");
  } else {
    value.boundary_contract = { description: rawBoundary.description };
  }
}

function validateVocabularyBindingAdrs(rawAdrs, value, errors) {
  if (!Array.isArray(rawAdrs)) {
    errors.push("architecture.vocabulary.binding_adrs must be a list when set");
    return;
  }
  rawAdrs.forEach((entry, i) => {
    const prefix = `architecture.vocabulary.binding_adrs[${i}]`;
    const before = errors.length;
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${prefix} must be a mapping`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!ARCH_BINDING_ADR_KEYS.has(key)) {
        errors.push(`${prefix} has unknown key '${key}'`);
      }
    }
    if (typeof entry.id !== "string" || !ARCH_BINDING_ADR_ID_RE.test(entry.id)) {
      errors.push(`${prefix}.id must match ${ARCH_BINDING_ADR_ID_RE.source}`);
    }
    if (typeof entry.one_liner !== "string" || entry.one_liner.trim() === "") {
      errors.push(`${prefix}.one_liner must be a non-empty string`);
    }
    if (errors.length === before) {
      value.binding_adrs.push({ id: entry.id, one_liner: entry.one_liner });
    }
  });
}

function validateVocabularyAntiRecommendations(rawAnti, value, errors) {
  if (!Array.isArray(rawAnti)) {
    errors.push("architecture.vocabulary.anti_recommendations must be a list when set");
    return;
  }
  const before = errors.length;
  rawAnti.forEach((entry, i) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      errors.push(`architecture.vocabulary.anti_recommendations[${i}] must be a non-empty string`);
    }
  });
  if (errors.length === before) {
    value.anti_recommendations = [...rawAnti];
  }
}

function normalizeArchitectureVocabularyConfig(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["architecture.vocabulary must be a mapping, not a list or scalar"] };
  }
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!ARCH_VOCABULARY_TOP_KEYS.has(key)) {
      errors.push(`architecture.vocabulary has unknown key '${key}'`);
    }
  }
  const value = emptyArchitectureVocabularyConfig();
  if (raw.patterns != null) validateVocabularyPatterns(raw.patterns, value, errors);
  if (raw.canonical_helpers != null) validateVocabularyCanonicalHelpers(raw.canonical_helpers, value, errors);
  if (raw.boundary_contract != null) validateVocabularyBoundaryContract(raw.boundary_contract, value, errors);
  if (raw.binding_adrs != null) validateVocabularyBindingAdrs(raw.binding_adrs, value, errors);
  if (raw.anti_recommendations != null) validateVocabularyAntiRecommendations(raw.anti_recommendations, value, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}
export function normalizeArchitectureConfig(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["architecture must be a mapping, not a list or scalar"] };
  }
  const allowed = new Set(["vocabulary"]);
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(`architecture has unknown key '${key}'`);
    }
  }
  const vocabResult = normalizeArchitectureVocabularyConfig(raw.vocabulary);
  if (!vocabResult.ok) errors.push(...vocabResult.errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { vocabulary: vocabResult.value } };
}
export const DECISION_RECORD_REVIEWERS = Object.freeze(["codex", "refactor", "test-quality", "sonarcloud"]);
export const DECISION_RECORD_DECISIONS = Object.freeze(["fix", "wontfix", "not-applicable"]);
export const DECISION_RECORD_CLASSIFICATIONS = Object.freeze(["one-off", "class"]);
const DECISION_RECORD_MARKER_PREFIX = "<!-- gc:decision-record";
export const GITHUB_ISSUE_COMMENT_BODY_MAX = 65535;
// GitHub caps a PR body at the same 65,535 bytes as an issue comment. The
// renderer enforces this at its own boundary (issue #1199) so a rendered body
// can never succeed only to be rejected by gc_create_synchronized_implement_pr.
export const PR_BODY_MAX = 65535;
export const PR_BODY_SUMMARY_MAX = 1200;
// Caller-supplied run-specific test evidence (`test_notes`) is bounded well
// below the body cap: it is evidence prose, not a second configuration surface.
export const PR_BODY_TEST_NOTES_MAX = 4000;
export const FINAL_REPORT_SUMMARY_MAX = 800;
export const FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX = 600;
export const FINAL_REPORT_REVIEW_SUMMARY_MAX = 240;
const RESERVED_MARKER_PREFIX_RE = /<!--\s*gc:/i;
export function rejectReservedMarkerSequence(text, fieldName) {
  if (typeof text !== "string" || text === "") return null;
  if (RESERVED_MARKER_PREFIX_RE.test(text)) {
    return `${fieldName}: caller-controlled text carries a reserved marker prefix (<!-- gc:...); reserved by the workflow surface, refused`;
  }
  return null;
}
export function buildDecisionRecordMarker({ reviewer, cycle, issueNumber }) {
  return `<!-- gc:decision-record reviewer="${reviewer}" cycle="${cycle}" issue="${issueNumber}" -->`;
}
export const SONAR_BASE_URL = "https://sonarcloud.io";
const SONAR_SEVERITY_RANK = {
  BLOCKER: 5,
  CRITICAL: 4,
  MAJOR: 3,
  MINOR: 2,
  INFO: 1,
};
const SONAR_HOTSPOT_PROBABILITY_RANK = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};
export function summarizeSonarIssues(issues, maxTop = 10) {
  const arr = Array.isArray(issues) ? issues : [];
  const bySeverity = {};
  const byType = {};
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const sev = typeof it.severity === "string" ? it.severity : "UNKNOWN";
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    const ty = typeof it.type === "string" ? it.type : "UNKNOWN";
    byType[ty] = (byType[ty] ?? 0) + 1;
  }
  // Sort by severity rank desc; stable-ish tie-break by component+line so
  // identical inputs produce identical top_issues across runs.
  const sorted = arr
    .filter((it) => it && typeof it === "object")
    .map((it) => ({
      raw: it,
      rank: SONAR_SEVERITY_RANK[it.severity] ?? 0,
    }))
    .sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      const ac = `${a.raw.component ?? ""}:${a.raw.line ?? ""}`;
      const bc = `${b.raw.component ?? ""}:${b.raw.line ?? ""}`;
      return ac.localeCompare(bc);
    });
  const topIssues = sorted.slice(0, maxTop).map(({ raw }) => ({
    key: typeof raw.key === "string" ? raw.key : "",
    severity: typeof raw.severity === "string" ? raw.severity : "",
    type: typeof raw.type === "string" ? raw.type : "",
    message: typeof raw.message === "string" ? raw.message : "",
    component: typeof raw.component === "string" ? raw.component : "",
    line: typeof raw.line === "number" ? raw.line : null,
  }));
  return {
    open_count: arr.length,
    by_severity: bySeverity,
    by_type: byType,
    top_issues: topIssues,
  };
}
export function summarizeSonarHotspots(hotspots, maxTop = 10) {
  const arr = Array.isArray(hotspots) ? hotspots : [];
  const sorted = arr
    .filter((h) => h && typeof h === "object")
    .map((h) => ({
      raw: h,
      rank: SONAR_HOTSPOT_PROBABILITY_RANK[h.vulnerabilityProbability] ?? 0,
    }))
    .sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      const ac = `${a.raw.component ?? ""}:${a.raw.line ?? ""}`;
      const bc = `${b.raw.component ?? ""}:${b.raw.line ?? ""}`;
      return ac.localeCompare(bc);
    });
  const topHotspots = sorted.slice(0, maxTop).map(({ raw }) => ({
    key: typeof raw.key === "string" ? raw.key : "",
    vulnerability_probability:
      typeof raw.vulnerabilityProbability === "string" ? raw.vulnerabilityProbability : "",
    message: typeof raw.message === "string" ? raw.message : "",
    component: typeof raw.component === "string" ? raw.component : "",
    line: typeof raw.line === "number" ? raw.line : null,
  }));
  return {
    open_count: arr.length,
    top_hotspots: topHotspots,
  };
}
export function _sonarAuthHeader(token) {
  // SonarCloud REST: HTTP Basic with token as username, empty password.
  const b64 = Buffer.from(`${token}:`, "utf8").toString("base64");
  return `Basic ${b64}`;
}
export function shouldRetrySonarStatus(status) {
  if (typeof status !== "number") return false;
  if (status === 429) return true;
  return status >= 500 && status < 600;
}
export const SONAR_RETRY_DELAYS_MS = [1000, 2000, 4000]; // 3 retries; total worst-case ~7s
export const SONAR_EXPORT_RETENTION = 50;
export function _pruneSonarExports(absSonarDir, retention) {
  // Best-effort prune. Failure to read the directory or stat individual
  // files is non-fatal — the export itself is operational, not workflow
  // state, so a broken prune just leaves more files than intended.
  try {
    const entries = readdirSync(absSonarDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const abs = join(absSonarDir, name);
        try {
          return { name, abs, mtimeMs: statSync(abs).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((e) => e !== null);
    if (entries.length <= retention) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toDelete = entries.slice(0, entries.length - retention);
    for (const entry of toDelete) {
      try {
        rmSync(entry.abs, { force: true });
      } catch {
        // Best-effort. If a delete fails (permissions, concurrent run),
        // skip and let the next pass clean up.
      }
    }
  } catch {
    // Directory doesn't exist yet or unreadable. The mkdirSync below
    // handles creation; nothing to prune.
  }
}
export const TELEMETRY_TIERS = Object.freeze(["low", "medium", "high"]);
export const TELEMETRY_OUTCOMES = Object.freeze(["ok", "error", "skipped"]);
export const ROUTING_TIERS = TELEMETRY_TIERS;
export const ROUTING_PROVIDERS = Object.freeze(["claude"]);
export const ROUTING_STAGE_NAME_RE = /^[a-z][a-z0-9_-]*$/;
export const CLAUDE_MODEL_BY_TIER = Object.freeze({
  low: "claude-haiku-4-5",
  medium: "claude-sonnet-5",
  high: "claude-opus-4-8",
});
export const DEFAULT_IMPLEMENT_ROUTING_STAGES = Object.freeze({
  issue_branch_resolution: { tier: "low" },
  read_issue_context: { tier: "low" },
  architecture_preflight: { tier: "low" },
  codebase_assessment: { tier: "medium" },
  planning: { tier: "high" },
  implementation: { tier: "medium" },
  clause_mapping: { tier: "medium" },
  precommit: { tier: "low" },
  review_cycle_1_consume: { tier: "high" },
  review_fix_application: { tier: "medium" },
  git_publish: { tier: "low" },
  base_sync: { tier: "low" },
  pr_body: { tier: "low" },
  ci_monitor: { tier: "low" },
  sonarcloud: { tier: "low" },
  test_quality_review: { tier: "medium" },
  transition_reconcile: { tier: "medium" },
  final_report: { tier: "low" },
  close_issue_after_merge: { tier: "low" },
});
