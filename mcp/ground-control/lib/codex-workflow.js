// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { STATION_OBSERVATION_DISPOSITION, canReobservationClose, parseExecutionObligationV2Markers } from "./execution-obligation-v2.js";

const IMPLEMENT_BRANCH_RE = /^[a-z0-9-]+$/;
const IMPLEMENT_BRANCH_MAX_LENGTH = 50;
export const IMPLEMENT_CHECKOUT_MODES = Object.freeze(["same_checkout"]);
export const MCP_LAUNCH_CWD = process.cwd();
export function validateImplementBranchName(branchName, issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { ok: false, error: "implement_issue_number_invalid", message: "issueNumber must be a positive integer" };
  }
  if (typeof branchName !== "string" || branchName.trim() === "") {
    return { ok: false, error: "implement_branch_name_invalid", message: "branchName must be a non-empty string" };
  }
  const prefix = `${issueNumber}-`;
  if (
    !branchName.startsWith(prefix)
    || branchName.length <= prefix.length
    || branchName.length > IMPLEMENT_BRANCH_MAX_LENGTH
    || !IMPLEMENT_BRANCH_RE.test(branchName)
  ) {
    return {
      ok: false,
      error: "implement_branch_name_invalid",
      message:
        `branchName must start with '${prefix}', contain only lowercase ASCII letters, digits, and hyphens, ` +
        `include a slug, and be at most ${IMPLEMENT_BRANCH_MAX_LENGTH} characters`,
    };
  }
  return { ok: true };
}
export function isDefaultImplementHooksPath({
  repoRoot,
  hooksPath,
  gitDir,
  gitCommonDir,
}) {
  const configuredPath = resolvePath(repoRoot, hooksPath);
  return configuredPath === resolvePath(gitDir, "hooks")
    || configuredPath === resolvePath(repoRoot, gitCommonDir, "hooks");
}
export function sanitizedImplementGitEnvironment() {
  const overrides = [
    ["core.hooksPath", "/dev/null"],
    ["core.sshCommand", "/usr/bin/false"],
    ["core.askPass", "/usr/bin/false"],
    ["core.fsmonitor", "false"],
    ["credential.helper", ""],
    ["credential.interactive", "false"],
  ];
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(overrides.length),
  };
  overrides.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}
export const GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_PR_TITLE_TYPES = Object.freeze([
  "security", "added", "changed", "deprecated", "removed", "fixed",
  "feat", "fix", "chore", "docs", "refactor", "test", "ci", "build",
  "perf", "revert",
]);
export function implementNetworkGitEnvironment() {
  const overrides = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["credential.interactive", "false"],
  ];
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(overrides.length),
  };
  overrides.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}
export const REQUIREMENT_UID_GATE_ENV_VAR = "ACES_REQUIREMENT_UID";
export function validateImplementPrTitle(title, config = null) {
  if (typeof title !== "string" || title.includes("\n") || title.includes("\r")) {
    return { ok: false, message: "title must be a single-line string" };
  }
  // The optional `!` is the Conventional Commits breaking-change marker Release Please reads.
  const match = /^([a-z]+)(?:\(([^()\r\n]+)\))?!?: (.+)$/.exec(title);
  if (match == null) {
    return { ok: false, message: "title must match <type>(<optional-scope>)<optional-!>: <subject>" };
  }
  const types = Array.isArray(config?.types) ? config.types : DEFAULT_PR_TITLE_TYPES;
  if (!types.includes(match[1])) {
    return { ok: false, message: `title type must be one of: ${types.join(", ")}` };
  }
  if (config?.require_scope === true && !match[2]) {
    return { ok: false, message: "title scope is required by repository configuration" };
  }
  let subjectRe;
  try {
    subjectRe = new RegExp(config?.subject_pattern ?? "^[a-z].*$");
  } catch {
    return { ok: false, message: "configured PR title subject pattern is invalid" };
  }
  if (!subjectRe.test(match[3])) {
    return { ok: false, message: "title subject does not satisfy repository configuration" };
  }
  return { ok: true };
}
export function validateExistingSynchronizedImplementPr(
  candidate,
  {
    owner,
    name,
    baseBranch,
    branchName,
    featureSha,
    title,
    body,
  },
) {
  const headOwner = typeof candidate?.headRepositoryOwner === "string"
    ? candidate.headRepositoryOwner
    : candidate?.headRepositoryOwner?.login ?? candidate?.headRepositoryOwner?.name;
  const headName = typeof candidate?.headRepository === "string"
    ? candidate.headRepository
    : candidate?.headRepository?.name;
  const expectedUrlPrefix = `https://github.com/${owner}/${name}/pull/`.toLowerCase();
  if (
    !Number.isInteger(candidate?.number)
    || typeof candidate?.url !== "string"
    || !candidate.url.toLowerCase().startsWith(expectedUrlPrefix)
    || candidate.baseRefName !== baseBranch
    || candidate.headRefName !== branchName
    || candidate.headRefOid?.toLowerCase() !== featureSha
    || candidate.isCrossRepository === true
    || typeof headOwner !== "string"
    || headOwner.toLowerCase() !== owner.toLowerCase()
    || typeof headName !== "string"
    || headName.toLowerCase() !== name.toLowerCase()
    || candidate.title !== title
    || candidate.body !== body
  ) {
    return {
      ok: false,
      error: "implement_pr_existing_identity_mismatch",
      message: "An existing PR for the feature branch does not match the synchronized base, head, repository, title, and body",
      next_action: "inspect_the_existing_pr_without_bypassing_the_sync_gate",
    };
  }
  return { ok: true };
}
export function findNewWorkingTreeChanges(beforeFiles, afterFiles) {
  const before = new Set(beforeFiles);
  return afterFiles.filter((file) => !before.has(file));
}
export function summarizeTraceabilityLinks(traceabilityLinks = []) {
  return traceabilityLinks.map((link) => ({
    artifact_type: link.artifact_type,
    artifact_identifier: link.artifact_identifier,
    artifact_title: link.artifact_title,
    link_type: link.link_type,
  }));
}
export function readGeneratedCodexSummary(outputPath) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- outputPath is created by mkdtemp within the local temp directory
    return readFileSync(outputPath, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}
export function buildCodexArchitectureExecArgs({ repoPath, outputPath }) {
  return [
    "exec",
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "-C",
    repoPath,
    "--output-last-message",
    outputPath,
    "-",
  ];
}
export const PHASE_MARKER_PREFIX = "<!-- gc:phase";
export const PHASE_MARKER_RE = /<!--\s*gc:phase\s+phase="([a-z_]+)"\s+issue="(\d+)"[^]*?-->/g;
export const EXECUTION_OBLIGATION_SCHEMA = "gc.implement.execution-obligation/v1";
export const EXECUTION_OBLIGATION_AUTHORIZATION_SCHEMA =
  "gc.implement.execution-obligation-authorization/v1";
export const EXECUTION_OBLIGATION_EVENTS = Object.freeze(["opened", "escalated", "resolved"]);
export const EXECUTION_OBLIGATION_CATEGORIES = Object.freeze([
  "defect",
  "failing_check",
  "security",
  "workflow",
  "quality",
]);
export const EXECUTION_OBLIGATION_PAUSE_CLASSES = Object.freeze([
  "explicit_workflow_gate",
  "unresolved_ambiguity",
  "significant_architecture_decision",
  "significant_security_decision",
  "unexpected_material_scope_expansion",
  "destructive_or_external_authority",
  "hard_external_dependency",
  "enforced_cycle_cap",
]);
export const EXECUTION_OBLIGATION_DISPOSITIONS = Object.freeze(["fix", "wontfix", "not-applicable"]);
export const EXECUTION_OBLIGATION_ID_RE = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const ISSUE_COMMENT_URL_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)#issuecomment-(\d+)$/;
const EXECUTION_OBLIGATION_MARKER_RE =
  /<!--\s*gc:execution-obligation\s+schema="gc\.implement\.execution-obligation\/v1"\s+issue="(\d+)"\s+id="([A-Z0-9][A-Z0-9._-]{0,63})"\s+event="(opened|escalated|resolved)"(?:\s+disposition="(fix|wontfix|not-applicable)")?(?:\s+authorization_comment_id="(\d+)")?\s*-->/g;
const EXECUTION_OBLIGATION_AUTHORIZATION_RE =
  /<!--\s*gc:execution-obligation-authorization\s+schema="gc\.implement\.execution-obligation-authorization\/v1"\s+issue="(\d+)"\s+id="([A-Z0-9][A-Z0-9._-]{0,63})"\s+action="authorize_wontfix"\s+source_comment_id="(\d+)"\s*-->/g;
export function parseIssueCommentUrl(value) {
  if (typeof value !== "string") return null;
  const match = value.match(ISSUE_COMMENT_URL_RE);
  if (match == null) return null;
  return {
    owner: match[1],
    name: match[2],
    issueNumber: Number(match[3]),
    commentId: Number(match[4]),
  };
}
export function buildExecutionObligationMarker({
  issueNumber,
  obligationId,
  event,
  disposition = null,
  authorizationCommentId = null,
  userAuthorization = null,
}) {
  const dispositionAttribute = disposition == null ? "" : ` disposition="${disposition}"`;
  const parsedAuthorization = parseIssueCommentUrl(userAuthorization);
  const resolvedAuthorizationId = authorizationCommentId ?? parsedAuthorization?.commentId ?? null;
  const authorizationAttribute = resolvedAuthorizationId == null
    ? ""
    : ` authorization_comment_id="${resolvedAuthorizationId}"`;
  return `<!-- gc:execution-obligation schema="${EXECUTION_OBLIGATION_SCHEMA}" issue="${issueNumber}" id="${obligationId}" event="${event}"${dispositionAttribute}${authorizationAttribute} -->`;
}
export function buildExecutionObligationAuthorizationMarker({
  issueNumber,
  obligationId,
  sourceCommentId,
}) {
  return `<!-- gc:execution-obligation-authorization schema="${EXECUTION_OBLIGATION_AUTHORIZATION_SCHEMA}" issue="${issueNumber}" id="${obligationId}" action="authorize_wontfix" source_comment_id="${sourceCommentId}" -->`;
}
export function parseExecutionObligationAuthorization(body, issueNumber, obligationId) {
  if (typeof body !== "string") return null;
  for (const match of body.matchAll(EXECUTION_OBLIGATION_AUTHORIZATION_RE)) {
    if (Number(match[1]) === issueNumber && match[2] === obligationId) {
      return { sourceCommentId: Number(match[3]) };
    }
  }
  return null;
}
export function isExactWontfixAuthorizationCommand(body, obligationId) {
  return typeof body === "string"
    && body.trim() === `/ground-control authorize-wontfix ${obligationId}`;
}
export function parseExecutionObligationMarkers(commentBodies, issueNumber) {
  const events = [];
  for (const body of commentBodies || []) {
    if (typeof body !== "string") continue;
    for (const match of body.matchAll(EXECUTION_OBLIGATION_MARKER_RE)) {
      if (Number(match[1]) !== issueNumber) continue;
      events.push({
        issue_number: issueNumber,
        obligation_id: match[2],
        event: match[3],
        schema_version: 1,
        kind: null,
        station: null,
        cycle: null,
        disposition: match[4] ?? null,
        observation_record_id: null,
        authorization_comment_id: match[5] == null ? null : Number(match[5]),
      });
    }
    // v2 records (issue #1476) live in their own marker family so an older reader ignores them
    // rather than misreading a station observation as a problem obligation.
    events.push(...parseExecutionObligationV2Markers(body, issueNumber));
  }
  return events;
}
export function evaluateExecutionObligations(events) {
  const states = new Map();
  for (const event of events || []) {
    const current = states.get(event.obligation_id);
    if (event.event === "opened") {
      // Re-opening an already-open observation is the same obligation, not a second one: repeated
      // transport attempts must not strand a record nobody can resolve.
      states.set(event.obligation_id, {
        status: "open",
        disposition: null,
        schema_version: event.schema_version ?? 1,
        kind: event.kind ?? null,
        station: event.station ?? null,
        cycle: event.cycle ?? null,
      });
    } else if (event.event === "escalated" && current?.status === "open") {
      states.set(event.obligation_id, { ...current, status: "open", disposition: null });
    } else if (
      event.event === "resolved"
      && current?.status === "open"
      && isTerminalObligationResolution(current, event)
    ) {
      states.set(event.obligation_id, {
        ...current,
        status: "resolved",
        disposition: event.disposition,
      });
    }
  }
  const open = [...states.entries()]
    .filter(([, state]) => state.status === "open")
    .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
    .map(([id, state]) => ({
      obligation_id: id,
      schema_version: state.schema_version,
      kind: state.kind,
      station: state.station,
      cycle: state.cycle,
    }));
  return {
    open_obligation_ids: open.map((obligation) => obligation.obligation_id),
    // Replayed identity of each open obligation, so a caller can tell a station observation it can
    // recover (issue #1582) from a problem obligation without re-parsing the thread.
    open_obligations: open,
    clear: open.length === 0,
  };
}
/**
 * Whether a resolution event terminates the obligation it is replayed against.
 *
 * The two obligation families are isolated in both directions, because replay is keyed on the
 * obligation id and that id is deterministic and therefore guessable:
 *
 * - A `station_observation` is closable ONLY by an attested `reobserved`. Admitting the legacy
 *   `fix` / `wontfix` / `not-applicable` vocabulary here was a completion-gate bypass: a
 *   repository writer who is not the trusted MCP posting identity could copy the id, station, and
 *   cycle out of an opened marker and post `disposition="fix"`, clearing an unobserved gate with
 *   no verdict behind it (codex cycle-1 security finding).
 * - A problem obligation is closable only by that legacy vocabulary. `reobserved` attests that a
 *   gate was observed, which says nothing about whether a defect was repaired.
 */
function isTerminalObligationResolution(current, event) {
  if (current.kind === "station_observation") {
    return event.disposition === STATION_OBSERVATION_DISPOSITION
      && canReobservationClose(current, event);
  }
  return EXECUTION_OBLIGATION_DISPOSITIONS.includes(event.disposition);
}
export function validateBoundedText(value, field, errors, { required = true, max = 1200 } = {}) {
  if (value == null || value === "") {
    if (required) errors.push(`${field} must be a non-empty string`);
    return;
  }
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} must be a non-empty string`);
  } else if (Buffer.byteLength(value, "utf8") > max) {
    errors.push(`${field} must be at most ${max} bytes`);
  }
}
