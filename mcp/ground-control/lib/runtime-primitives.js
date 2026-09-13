// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { CLAUDE_MODEL_BY_TIER, DEFAULT_IMPLEMENT_ROUTING_STAGES, ROUTING_STAGE_NAME_RE, ROUTING_TIERS } from "./repo-vocabulary.js";
import { boundedOutputTail, describeChildProcessState, formatOutputTail } from "./command-failure-diagnostics.js";

// execFileWithInput and the GC_CODEX_TIMEOUT_MS parsing/bounds live in
// model-subprocess.js (issue #1518, split out to stay under the 500-LOC file
// gate). Re-exported here so this remains the single import path every
// existing caller already uses.
export {
  CODEX_TIMEOUT_MS_DEFAULT,
  CODEX_TIMEOUT_MS_MAX,
  CODEX_TIMEOUT_MS_MIN,
  getDefaultCodexTimeoutMs,
  execFileWithInput,
  parseCodexTimeoutMs,
} from "./model-subprocess.js";

const execFileUnguarded = promisify(execFileCb);

// Ground Control authorization commands (`/ground-control waive-station`, `authorize-wontfix`,
// `authorize-scope-removal`) are authority only because a human with write access typed them. The
// server posts under a write-permitted identity that is often that same account, so replay cannot
// tell the two apart by author (issue #1578). The guarantee lives here instead, on the boundary
// every server-side GitHub write passes through: a `gh` call that would publish a body carrying a
// command line is refused before it spawns, whatever tool assembled the body.
const GROUND_CONTROL_COMMAND_LINE_RE = /^\s*\/ground-control\s/m;
const GH_BODY_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);
const GH_BODY_FLAGS = new Set(["-b", "--body"]);

// `-F`/`--field` interpolate `@path` as a file's contents; `-f`/`--raw-field` publish it literally.
const GH_INTERPOLATING_FIELD_FLAGS = new Set(["-F", "--field"]);

/** The body a gh argv token publishes, as `{ body, interpolated }`, or null when it publishes none. */
function publishedBodyAt(args, index) {
  const arg = String(args[index]);
  const next = String(args[index + 1] ?? "");
  if (GH_BODY_FIELD_FLAGS.has(arg)) {
    return next.startsWith("body=")
      ? { body: next.slice("body=".length), interpolated: GH_INTERPOLATING_FIELD_FLAGS.has(arg) }
      : null;
  }
  if (GH_BODY_FLAGS.has(arg)) return { body: next, interpolated: false };
  const field = arg.match(/^(--field|--raw-field)=body=([^]*)$/);
  if (field) return { body: field[2], interpolated: GH_INTERPOLATING_FIELD_FLAGS.has(field[1]) };
  const body = arg.match(/^--body=([^]*)$/);
  return body ? { body: body[1], interpolated: false } : null;
}

/** Refusal message when a gh argv would publish a Ground Control authorization command, else null. */
export function findGroundControlCommandInGhArgv(args) {
  for (let index = 0; index < (args?.length ?? 0); index += 1) {
    const published = publishedBodyAt(args, index);
    if (published == null) continue;
    // An interpolated `body=@path` publishes a file this check cannot see; the server never needs it.
    const fileSourced = published.interpolated && published.body.startsWith("@");
    if (fileSourced || GROUND_CONTROL_COMMAND_LINE_RE.test(published.body)) {
      return "refusing to publish a Ground Control authorization command under the MCP identity: " +
        "only a human with write access may post a '/ground-control' command";
    }
  }
  return null;
}

export function execFile(file, args, options) {
  if (file === "gh") {
    const refusal = findGroundControlCommandInGhArgv(args);
    if (refusal) {
      return Promise.reject(Object.assign(new Error(refusal), { code: "GC_AUTHORIZATION_COMMAND_REFUSED" }));
    }
  }
  return execFileUnguarded(file, args, options);
}
export const GROUND_CONTROL_PROJECT_RE = /^[a-z0-9][a-z0-9-]*$/;
// Shared with the .ground-control.yaml parser and the repo-identity resolver. It lives beside its
// sibling rather than privately in whichever module happened to need it first: a second copy is how
// two validators of the same value drift into disagreeing about what is well-formed.
export const GITHUB_REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export function formatCommandFailure(command, error) {
  const details = [];
  if (error.code === "ENOENT") {
    details.push(`${command} is not installed or not available on PATH`);
  } else {
    if (error.message) details.push(error.message);
    const state = describeChildProcessState(error);
    if (state) details.push(state);
  }

  // Both streams, each tail-anchored (issue #1568). Reporting only stderr when
  // it is non-empty let a single unrelated warning line hide the entire stdout
  // trace, and an untruncated stream let a downstream head-anchored cap keep
  // nothing but the engine's startup banner — between them, a killed 20-minute
  // worker returned no evidence of what it was actually doing.
  for (const [label, raw] of [["stderr", error.stderr], ["stdout", error.stdout]]) {
    const line = formatOutputTail(label, boundedOutputTail(raw));
    if (line) details.push(line);
  }

  return details.join(" | ");
}
export function buildGroundControlContextSnippet(project = "your-project-id") {
  return [
    "## Ground Control Context",
    "",
    "This repo's Ground Control project id, workflow commands, SonarCloud",
    "settings, and plan rules live in `.ground-control.yaml` at repo root.",
    "Agents read it via the `gc_get_repo_ground_control_context` MCP tool.",
  ].join("\n");
}
function suggestedYamlWorkflowSection(project) {
  return [
    "schema_version: 1",
    `project: ${project}`,
    "",
    "# Optional fields:",
    "# github_repo: owner/repo",
    "# short_code: GC  # Optional: short project code for tmux session renaming (1-8 uppercase alphanumeric)",
    "# workflow:",
    "#   test_command: <how to run tests>",
    "#   completion_command: <how to run the full CI gate>",
    "#   lint_command: <how to run the linter>",
    "#   format_command: <how to run the formatter>",
    "#   # Repo-native policy/governance gate. Defaults to `make policy`; set it",
    "#   # when your gate is named differently. It is never skipped.",
    "#   policy_command: make policy",
    "#   # Pre-publish hook boundary. Defaults to `pre-commit run --all-files`;",
    "#   # set it for lefthook, husky, or a bespoke script.",
    "#   precommit_command: pre-commit run --all-files",
    "#   # Per-reviewer pre-push caps (issue #906). Omit to use MCP-tool defaults.",
    "#   codex_review:",
    "#     pre_push_cap: 1",
    "#   test_quality_review:",
    "#     pre_push_cap: 1",
    "#   # PR title validation (issue #896). Omit to use /implement skill defaults.",
    "#   pr_title:",
    "#     types: [security, added, changed, deprecated, removed, fixed,",
    "#             feat, fix, chore, docs, refactor, test, ci, build, perf, revert]",
    "#     subject_pattern: \"^[a-z].*$\"",
    "#     require_scope: false",
    "#   # Optional dev-start plan gate. Disabled unless a repo opts in.",
    "#   dev_start_gate:",
    "#     enabled: false",
    "#     required_for: source-bearing",
    "#     plan_section: Dev-Start Gate",
    "#     blocker_uids: []",
    "#     required_fields:",
    "#       - Requirement wave or gate",
    "#       - Boundary owner",
    "#       - Contract or seam",
    "#   # Optional review-cap auto-disposition (gc_review_cap_disposition).",
    "#   # Disabled unless a repo opts in; with enabled:false every existing",
    "#   # review-cap behavior is unchanged.",
    "#   review_disposition:",
    "#     enabled: false",
    "#     mode: shadow            # shadow | authoritative",
    "#     max_auto_overrides: 1",
    "#     judge:",
    "#       enabled: false",
    "#       model: null",
    "#   # Optional tiered publish verification (issue #1497). When a toolchain",
    "#   # fingerprint command is set, verify posts a content-addressed",
    "#   # attestation that the publish band reuses instead of re-verifying an",
    "#   # unchanged tree; any tree/base/config/toolchain change re-runs the full",
    "#   # gate. Absent (default) = no reuse, every gate runs in full (fail-closed).",
    "#   verification:",
    "#     toolchain_fingerprint_command: <command emitting one lowercase sha256>",
  ];
}
function suggestedYamlPackagingSection() {
  return [
    "# sonarcloud:",
    "#   project_key: <sonar-project-key>",
    "#   organization: <sonar-org>",
    "#   quality_gate: <sonar-quality-gate-name>  # optional; SonarCloud association is server-side",
    "# rules:",
    "#   plan_rules: .gc/plan-rules.md",
    "# knowledge:",
    "#   dir: docs/knowledge",
    "#   # optional overrides (default to <dir>/SCHEMA.md and <dir>/inbox):",
    "#   # schema: docs/knowledge/SCHEMA.md",
    "#   # inbox: docs/knowledge/inbox",
    "",
    "# Workflow-packaging fields (ADR-027). The canonical /implement skill",
    "# renders prose against these via {cfg.X|default Y} placeholders.",
    "# docs:",
    "#   adr_dir: architecture/adrs/",
    "#   architecture_overview: docs/architecture/ARCHITECTURE.md",
    "#   coding_standards: docs/CODING_STANDARDS.md",
    "#   workflow_reference: docs/DEVELOPMENT_WORKFLOW.md",
    "#   knowledge_base: docs/knowledge/",
    "# example_paths:",
    "#   source: backend/src/main/java/com/keplerops/groundcontrol/",
    "#   test:   backend/src/test/java/com/keplerops/groundcontrol/",
    "# requirements:",
    "#   uid_examples: [\"GC-X001\", \"OBS-042\"]",
    "# cross_cutting_concerns:",
    "#   description: |",
    "#     Logger: <project's logging library>",
    "#     Validation: <project's validation approach>",
    "#     Errors: <error envelope / handler>",
    "#     Tests: <fixture / test-slice patterns>",
    "# routing:",
    "#   enabled: false",
    "#   # Optional stage/purpose overrides. Omitted stages use the",
    "#   # built-in /implement defaults when routing is enabled.",
    "#   # stages:",
    "#   #   implementation:",
    "#   #     tier: medium",
    "#   #     model: claude-sonnet-5",
    "",
  ];
}
function suggestedYamlArchitectureSection() {
  return [
    "# Repo design vocabulary (issue #931). Optional. Codex preflight and the",
    "# pre-push reviewers anchor their architectural_read on this vocabulary",
    "# when present, so 'use the canonical helper' findings name a real helper.",
    "# architecture:",
    "#   vocabulary:",
    "#     patterns:",
    "#       - name: Repository",
    "#         applies_to: data access",
    "#         example_path: backend/src/main/java/.../FooRepository.java",
    "#     canonical_helpers:",
    "#       - name: ErrorResponse",
    "#         path: backend/src/main/java/.../shared/web/ErrorResponse.java",
    "#         purpose: standard error envelope routed via GlobalExceptionHandler",
    "#     boundary_contract:",
    "#       description: api/ → domain/ ← infrastructure/ (ArchUnit-enforced)",
    "#     binding_adrs:",
    "#       - id: ADR-027",
    "#         one_liner: .ground-control.yaml is the agent-neutral context contract",
    "#     anti_recommendations:",
    "#       - Do not introduce new abstractions below 3 call-sites",
    "",
  ];
}
export function buildSuggestedGroundControlYaml(project = "your-project-id") {
  return [
    ...suggestedYamlWorkflowSection(project),
    ...suggestedYamlPackagingSection(),
    ...suggestedYamlArchitectureSection(),
  ].join("\n");
}
// The auth modes the review engine (`claude`) accepts. Every one is inventoried
// in lib/server-env.js, so each arrives from the launch directory's `.env` and
// nowhere else (issue #1562).
export const REVIEW_ENGINE_AUTH_VARS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
]);

export const REVIEW_ENGINE_AUTH_MISSING = "review_engine_auth_missing";

/**
 * Refuse before spawning `claude` when no auth mode is declared.
 *
 * The engine used to load a user-level `review-env` file in this case, and
 * without one it fell through to whatever default profile the host happened to
 * have — frequently an expired one, which surfaced as an engine failure rather
 * than as the provisioning fault it is. Naming the alternatives and the file to
 * fix is the whole recovery path. The message carries names only, never a
 * value.
 */
export function assertReviewEngineAuth(env = process.env) {
  if (REVIEW_ENGINE_AUTH_VARS.some((name) => env[name])) return;
  const error = new Error(
    "No review-engine auth is declared. Set one of "
      + `${REVIEW_ENGINE_AUTH_VARS.join(", ")} in the launch directory's .env, `
      + "then restart the MCP server; the file is read at startup.",
  );
  error.code = REVIEW_ENGINE_AUTH_MISSING;
  throw error;
}

/**
 * Build the environment for the review engine (`claude`), which runs as a
 * separate process from the agent.
 *
 * OS execution state passes through — the child still needs PATH and HOME — but
 * every Claude configuration value it reads has already been bound to the
 * launch directory's `.env` at startup. The one remaining rule is the conflict
 * strip: ANTHROPIC_API_KEY is removed only when another auth path survives, so
 * the key can serve as the sole auth when it is all that is declared.
 */
export function reviewEngineEnv(baseEnv = process.env) {
  assertReviewEngineAuth(baseEnv);
  const env = { ...baseEnv };
  if (env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CONFIG_DIR) {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}
export function resolveWorkflowRouteFromConfig({ routing, stage, tier = null }) {
  if (typeof stage !== "string" || stage.trim() === "") {
    return { ok: false, error: "routing_stage_invalid", message: "stage must be a non-empty string" };
  }
  const normalizedStage = stage.trim();
  if (!ROUTING_STAGE_NAME_RE.test(normalizedStage)) {
    return {
      ok: false,
      error: "routing_stage_invalid",
      message: `stage must match ${ROUTING_STAGE_NAME_RE}`,
      stage: normalizedStage,
    };
  }
  if (routing?.enabled !== true) {
    return {
      ok: true,
      enabled: false,
      stage: normalizedStage,
      outcome: "disabled",
      message: "routing.enabled is false (or absent) in .ground-control.yaml",
    };
  }
  const configured = routing.stages?.[normalizedStage];
  const defaultStage = DEFAULT_IMPLEMENT_ROUTING_STAGES[normalizedStage];
  const resolvedTier = configured?.tier ?? tier ?? defaultStage?.tier ?? null;
  if (!ROUTING_TIERS.includes(resolvedTier)) {
    return {
      ok: false,
      error: "routing_stage_unconfigured",
      message: `No route is configured for stage '${normalizedStage}' and no valid tier was supplied`,
      stage: normalizedStage,
    };
  }
  const provider = configured?.provider ?? routing.default_provider ?? "claude";
  const model = configured?.model ?? CLAUDE_MODEL_BY_TIER[resolvedTier];
  let source = "tier";
  if (configured) source = "config";
  else if (defaultStage) source = "default";
  return {
    ok: true,
    enabled: true,
    stage: normalizedStage,
    tier: resolvedTier,
    provider,
    model,
    source,
  };
}
export const PR_BODY_CHANGE_CLASSES = Object.freeze(["doc-only", "source", "source+migration"]);
export const PR_REQUIREMENT_RE = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[A-Z0-9]*\d\b/;
export const REQUIREMENT_UID_MAX_LENGTH = 50;
export const EXACT_REQUIREMENT_UID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
export function isRequirementUidToken(token) {
  if (typeof token !== "string" || !EXACT_REQUIREMENT_UID_RE.test(token)) return false;
  const match = PR_REQUIREMENT_RE.exec(token);
  return match?.[0] === token;
}
export function findRequirementUidTokens(text) {
  if (typeof text !== "string" || text === "") return [];
  // Derived from PR_REQUIREMENT_RE so the shape has exactly one definition; the
  // `g` flag is needed for matchAll and the source is a module-local literal.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const scan = new RegExp(PR_REQUIREMENT_RE.source, "g");
  const found = [];
  for (const match of text.matchAll(scan)) {
    const token = match[0];
    if (isRequirementUidToken(token) && !found.includes(token)) found.push(token);
  }
  return found;
}
export const REQUIREMENT_UID_CONTRACT_DESCRIPTION =
  `a single requirement UID: 1-${REQUIREMENT_UID_MAX_LENGTH} characters, starting with a letter or digit, `
  + "containing only letters, digits, '.', '_', or '-'";
// Sonar S5843 caps a single regex literal's complexity at 20. The three richest
// deferral patterns exceed that, so each is composed at module load from simple
// sub-pattern literals via `new RegExp`. Every composed `source` is byte-identical
// to the literal it replaces (the fragments concatenate to the original pattern),
// so the matched language is unchanged — only per-literal complexity drops.
const DEFERRAL_FIXED_IN_FOLLOWUP_HEAD = /\b(?:will be |is |are |gets? |get )?(?:fixed|handled|landed?|done) (?:in|as) /;
const DEFERRAL_FIXED_IN_FOLLOWUP_TAIL = /(?:a |the )?(?:follow[- ]?up|subsequent) (?:PR|issue|pull request)\b/;
const DEFERRAL_REFUSAL_ACTION_HEAD = /\b(?:not|won'?t|will\s+not|cannot|can'?t|skip(?:ping)?)\s+(?:be\s+)?/;
const DEFERRAL_REFUSAL_ACTION_TAIL = /(?:fix|fixing|address|addressing|repair|repairing|resolve|resolving|handle|handling)\b/;
const DEFERRAL_BECAUSE_GAP = /[^.\n]{0,80}\b(?:because|since|as)\b[^.\n]{0,60}\b/;
const DEFERRAL_SCOPE_SO_GAP = /[^.\n]{0,80}(?:\b(?:so|therefore|means)\b|[;:])[^.\n]{0,60}\b/;
const DEFERRAL_REFUSAL_TRAILING = /(?:not|won'?t|will\s+not|skip(?:ping)?|left\s+unresolved|leave\s+unresolved)\b/;
const DEFERRAL_SCOPE_BRANCHES = [
  /pre-existing/,
  /unrelated/,
  /outside\s+(?:this\s+)?(?:PR'?s?\s+)?scope/,
  /out\s+of\s+scope/,
];
function deferralScopeGroupSource(ownedByBranch) {
  return `(?:${[...DEFERRAL_SCOPE_BRANCHES, ownedByBranch].map((r) => r.source).join("|")})${/\b/.source}`;
}
// eslint-disable-next-line security/detect-non-literal-regexp -- composed from module-local literal fragments; source is byte-identical to the original pattern
const DEFERRAL_FIXED_IN_FOLLOWUP_RE = new RegExp(
  DEFERRAL_FIXED_IN_FOLLOWUP_HEAD.source + DEFERRAL_FIXED_IN_FOLLOWUP_TAIL.source,
  "i",
);
// eslint-disable-next-line security/detect-non-literal-regexp -- composed from module-local literal fragments; source is byte-identical to the original pattern
const DEFERRAL_REFUSAL_BECAUSE_SCOPE_RE = new RegExp(
  DEFERRAL_REFUSAL_ACTION_HEAD.source
    + DEFERRAL_REFUSAL_ACTION_TAIL.source
    + DEFERRAL_BECAUSE_GAP.source
    + deferralScopeGroupSource(/owned\s+by/),
  "i",
);
// eslint-disable-next-line security/detect-non-literal-regexp -- composed from module-local literal fragments; source is byte-identical to the original pattern
const DEFERRAL_SCOPE_THEN_REFUSAL_RE = new RegExp(
  /\b/.source
    + deferralScopeGroupSource(/owned\s+by[^,.;\n]{0,40}/)
    + DEFERRAL_SCOPE_SO_GAP.source
    + DEFERRAL_REFUSAL_TRAILING.source,
  "i",
);
const DEFERRAL_TIER1_PATTERNS = Object.freeze([
  /\bdeferred to (?:a |the )?(?:follow[- ]?up|subsequent|later|next)\b/i,
  /\bdefer(?:red)? (?:to |until )?(?:a |the )?(?:follow[- ]?up|subsequent|later iteration)\b/i,
  /\b(?:will be |is |are )?addressed in (?:a |the )?follow[- ]?up\b/i,
  DEFERRAL_FIXED_IN_FOLLOWUP_RE,
  /\bTBD later\b/i,
  /\bto be (?:done|filed|landed?) (?:later|separately)\b/i,
  DEFERRAL_REFUSAL_BECAUSE_SCOPE_RE,
  DEFERRAL_SCOPE_THEN_REFUSAL_RE,
]);
export function detectDeferralDisposition(text) {
  if (typeof text !== "string" || text === "") return null;
  for (const re of DEFERRAL_TIER1_PATTERNS) {
    const m = re.exec(text);
    if (m) return `deferral-disposition phrase '${m[0]}' detected (ADR-029 forbids deferral)`;
  }
  return null;
}

// The PR-body policy surface (Ground Control Checks lines, required headers,
// checkPrBodyShape) lives in pr-body-policy.js (issue #1551, split out to stay
// under the 500-LOC file gate). Re-exported here so this remains the single
// import path every existing caller already uses.
export {
  PR_BODY_LANES,
  PR_BODY_POLICY_CHECK_LINE,
  PR_BODY_PRE_PUSH_REVIEW_STATES,
  PR_BODY_REVIEWS_OPTIONAL_LANE,
  PR_BODY_REVIEW_CHECK_LINES,
  PR_BODY_REVIEW_CHECK_LINE_COMPLETED,
  PR_BODY_REVIEW_CHECK_LINE_NOT_RUN,
  PR_BODY_REVIEW_CHECK_LINE_WAIVED,
  checkPrBodyShape,
  extractRequirementUidTokensFromSection,
  prBodyGcCheckLines,
} from "./pr-body-policy.js";
