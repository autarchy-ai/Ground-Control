// Can a SonarCloud analysis still appear for this pull request? (issue #1559).
//
// The watcher's poll loop waits for a 404 to become a quality gate. That is the
// right wait while a scan is running and a guaranteed 30-minute burn once the
// repository's own CI has declared the scan terminal: the component never
// appears, the job is not cancellable, and the cap is spent on a state that
// cannot change. GitHub's check-run rollup answers the prior question in one
// call, before the propagation wait and before a Sonar credential is needed.
//
// What this module does NOT do: prove *why* a scan was skipped. A terminal
// skipped check says no analysis is coming; it does not carry the consuming
// repository's ownership decision, so it cannot authorize a scope waiver at the
// readiness gate. Issue #1533 owns that clearance and consumes this evidence.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCommitCheckRollup, ghRestJson } from "./github-rest.js";
import { ciStationResult } from "./ci-conclusion.js";
import { parseGroundControlYaml } from "./ground-control-config.js";

/**
 * Read the repo's SonarCloud declaration, distinguishing "absent" from "invalid".
 *
 * `_readSonarCloudConfigFromRepo` collapses a missing file, unparseable YAML, an
 * invalid declaration, and a valid config with no `sonarcloud` block into one
 * `null`, and the watcher turns `null` into `skipped: true`, which
 * `sonarGatePassed` accepts unconditionally. A malformed `.ground-control.yaml`
 * therefore cleared the SonarCloud gate silently. A gate that could not be read
 * is not a gate that passed, so an invalid declaration fails closed here.
 *
 * @returns {{state: "absent"|"unconfigured"|"configured"|"invalid", config?: object, errors?: string[]}}
 */
export function readSonarCloudConfigStrict(repoRoot) {
  let yamlText;
  try {
    yamlText = readFileSync(join(repoRoot, ".ground-control.yaml"), "utf8");
  } catch (error) {
    // Only a genuinely missing file proves the repo never opted into the gate.
    // A permission, I/O, or wrong-type failure means the declaration could not
    // be read — and the caller turns "absent" into a skip that
    // `sonarGatePassed` accepts, so swallowing those would keep the fail-open
    // this function exists to close.
    if (error?.code === "ENOENT") return { state: "absent" };
    return {
      state: "unreadable",
      errors: [`.ground-control.yaml could not be read (${error?.code ?? "unknown error"})`],
    };
  }
  const parsed = parseGroundControlYaml(yamlText);
  if (!parsed.ok) return { state: "invalid", errors: parsed.errors };
  if (parsed.value.sonarcloud == null) return { state: "unconfigured" };
  return { state: "configured", config: parsed.value.sonarcloud };
}

/** Default producer selector: any check or workflow whose name mentions Sonar. */
export const SONAR_PRODUCER_DEFAULT_PATTERN = /sonar/i;

/** Nested evidence travels inside job results and issue records, so it is bounded at origin. */
export const SONAR_SCOPE_EVIDENCE_CHECK_MAX = 20;
const EVIDENCE_NAME_MAX = 120;

// StatusContext has no status/conclusion pair — one `state` carries both. Map it
// onto the CheckRun axis so a single classifier reads both shapes.
const STATUS_CONTEXT_STATES = {
  success: { status: "completed", conclusion: "success" },
  failure: { status: "completed", conclusion: "failure" },
  error: { status: "completed", conclusion: "failure" },
  pending: { status: "pending", conclusion: null },
  expected: { status: "pending", conclusion: null },
};

function lower(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : null;
}

function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Normalize one `statusCheckRollup` entry (see `fetchCommitCheckRollup`).
 *
 * Display names keep their original casing because they are shown to an
 * operator; status and conclusion are lowercased because they are compared.
 *
 * @returns {{name: string, workflow_name: string|null, status: string, conclusion: string|null, completed_at: string|null}|null}
 */
export function normalizeCheckRollupEntry(raw) {
  if (raw == null || typeof raw !== "object") return null;
  const name = text(raw.name) ?? text(raw.context);
  if (name === null) return null;

  if (text(raw.context) !== null && text(raw.name) === null) {
    const mapped = STATUS_CONTEXT_STATES[lower(raw.state) ?? ""] ?? { status: "pending", conclusion: null };
    return {
      name,
      workflow_name: null,
      status: mapped.status,
      conclusion: mapped.conclusion,
      completed_at: null,
    };
  }
  return {
    name,
    workflow_name: text(raw.workflowName),
    status: lower(raw.status) ?? "pending",
    conclusion: lower(raw.conclusion),
    completed_at: text(raw.completedAt),
  };
}

/**
 * Pick the checks that are the repository's Sonar analysis producer.
 *
 * `selector` is `sonarcloud.analysis_check` when the repo names its producer:
 * a case-insensitive *exact* match on the check or workflow name, so naming one
 * producer cannot silently widen to a sibling. Absent, the default pattern
 * matches any Sonar-named check.
 */
export function selectSonarProducerChecks(checks, selector) {
  const wanted = text(selector);
  const matches = wanted === null
    ? (value) => value !== null && SONAR_PRODUCER_DEFAULT_PATTERN.test(value)
    : (value) => value !== null && value.toLowerCase() === wanted.toLowerCase();
  return (Array.isArray(checks) ? checks : [])
    .filter((check) => check != null && (matches(check.name) || matches(check.workflow_name)));
}

/**
 * Classify whether an analysis can still arrive for the pull request.
 *
 * `unknown` is the safe default: no producer was observed, so there is no
 * evidence either way and the caller must keep its existing behavior.
 *
 * Only `skipped` proves non-publication. A producer that *failed* proves
 * nothing of the kind — the `SonarCloud Code Analysis` check reports the hosted
 * quality-gate result, so a red one means an analysis exists and was rejected.
 * Terminating on it would suppress the real issue and hotspot read and report an
 * evaluated failure as an unevaluable gate. `unavailable` is recorded as
 * evidence; it is not grounds to stop asking SonarCloud.
 *
 * @returns {{analysis: "pending"|"expected"|"unavailable"|"skipped"|"unknown", reason: string|null}}
 */
export function classifySonarProducer(checks) {
  const observed = Array.isArray(checks) ? checks.filter((check) => check != null) : [];
  if (observed.length === 0) return { analysis: "unknown", reason: null };
  if (observed.some((check) => check.status !== "completed")) {
    return { analysis: "pending", reason: "producer_running" };
  }
  if (observed.some((check) => check.conclusion === "success")) {
    return { analysis: "expected", reason: "producer_succeeded" };
  }
  // The station axis already owns the {skipped, neutral} grouping and the
  // "inspected nothing" bucket (lib/ci-conclusion.js); reusing it keeps one
  // vocabulary across both remote gates.
  const stations = observed.map((check) => ciStationResult(check.conclusion));
  if (stations.every((station) => station === "skipped_station")) {
    return { analysis: "skipped", reason: "producer_skipped" };
  }
  return { analysis: "unavailable", reason: "producer_terminal_without_analysis" };
}

/**
 * Build the normalized, bounded evidence record for a terminal producer.
 *
 * Bounded here rather than at the consumer: the mechanical `failure()` helper
 * scrubs its message, not a nested `extra` object, and async job results retain
 * nested payloads verbatim.
 */
export function buildSonarScopeEvidence({ repoSlug, prNumber, headSha, projectKey, selector, checks, reason }) {
  const all = Array.isArray(checks) ? checks : [];
  const kept = all.slice(0, SONAR_SCOPE_EVIDENCE_CHECK_MAX);
  const evidence = {
    source: "github_check_runs",
    repo: repoSlug ?? null,
    pr_number: prNumber ?? null,
    head_sha: headSha ?? null,
    project_key: projectKey ?? null,
    selector: text(selector) ?? "default:/sonar/i",
    reason: reason ?? null,
    checks: kept.map((check) => ({
      name: check.name.slice(0, EVIDENCE_NAME_MAX),
      workflow_name: check.workflow_name === null ? null : check.workflow_name.slice(0, EVIDENCE_NAME_MAX),
      status: check.status,
      conclusion: check.conclusion,
      completed_at: check.completed_at,
    })),
  };
  if (all.length > kept.length) evidence.checks_truncated = true;
  return evidence;
}

/**
 * Read the pull request's head revision and check-run rollup.
 *
 * The repository is pinned in every REST path, so a rogue `GH_REPO` on the MCP
 * host cannot retarget the read. Returns `null` on any failure: the
 * pre-check is an optimization over the existing wait, never a new hard
 * dependency of the watch.
 */
export async function fetchSonarProducerEvidence({ repoRoot, repoSlug, prNumber, execFile }) {
  // REST only (issue #1584): `gh pr view --json statusCheckRollup` spent the shared GraphQL budget.
  // The head sha comes from the pull request and the rollup from that commit, with each Actions
  // check run's workflow name, so the selector still sees the names it matched against before.
  try {
    const pr = await ghRestJson(repoRoot, `/repos/${repoSlug}/pulls/${prNumber}`, { execFile });
    const headSha = text(pr?.head?.sha);
    if (headSha === null) return null;
    const rollup = await fetchCommitCheckRollup(repoRoot, repoSlug, headSha, { execFile, withWorkflowNames: true });
    return {
      headSha,
      entries: rollup.map(normalizeCheckRollupEntry).filter((entry) => entry !== null),
    };
  } catch {
    return null;
  }
}
