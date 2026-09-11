// Startup environment provisioning for the MCP server (issue #1562).
//
// `<launch directory>/.env` is the only source of Ground Control's own
// configuration and credentials. There is no machine-level file, no user-level
// file, and no fallback to whatever the launcher passed down.
//
// The launch directory is a deliberate control, not an incidental default. It
// is what lets separate checkouts draw on resources belonging to different
// projects or organizations, and what makes it possible to deploy Ground
// Control into a single-repo sandbox. #1560's per-host `~/.config/ground-control/env`
// assumed there is a machine level — an assumption about deployment topology
// this server has no business making — and, ranked behind the inherited
// environment, it silently substituted a global credential into a repository
// that deliberately has none.
//
// Two rules make `.env` authoritative rather than a fallback:
//
//   1. Inherited values for every name in GROUND_CONTROL_ENV_VARS are removed
//      before anything is installed, so no owned value can arrive by
//      inheritance.
//   2. Only inventoried names are installed from the file, so an unrelated
//      `.env` entry cannot replace PATH, HOME, or another OS runtime value.
//
// What is deliberately NOT done is clearing the environment. `node`, `git`,
// `gh`, `codex`, and `claude` still need PATH, HOME, locale, and temporary
// directory settings to execute at all; the rule governs Ground Control's own
// variables, not the process's ability to run.
//
// The file is read once, at startup, so provisioning or rotating a value takes
// effect on the next server start — which is what the operator-facing error
// messages say.
//
// This module is a leaf on purpose: `node:fs` and `node:path` only. The entry
// point evaluates it before it dynamically imports the server runtime, so an
// environment-derived default anywhere in that graph sees the loaded values.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every environment name Ground Control reads or deliberately forwards.
 *
 * This is the provenance boundary — where a value may come from — not a second
 * validation schema. Consumers keep owning their own values: parseCodexTimeoutMs
 * owns the timeout bounds, the review-size consumers own their numeric meanings,
 * and reviewEngineEnv owns Claude auth-mode selection.
 *
 * `server-env.inventory-parity.test.js` holds this list, the `process.env` reads
 * in the tree, and `.env.example` in agreement, so the template cannot drift
 * from what the code actually reads.
 */
export const GROUND_CONTROL_ENV_VARS = Object.freeze([
  // Read by the server itself.
  "GC_CODEX_REVIEW_MAX_DIFF_BYTES",
  "GC_CODEX_REVIEW_PARALLEL",
  "GC_CODEX_TIMEOUT_MS",
  "GC_KNOWLEDGE_INGEST_ANTHROPIC_API_KEY",
  "GH_VERIFY_FINDING_AUTHORS",
  "SONAR_TOKEN",
  // Forwarded to the `codex` child by codexEngineEnv. HOME and PATH are also on
  // that allowlist but are process state, not Ground Control configuration.
  "CODEX_HOME",
  "OPENAI_API_KEY",
  // Forwarded to the `claude` review engine by reviewEngineEnv: the auth-mode
  // selectors and the companion values each mode needs.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
]);

const OWNED = new Set(GROUND_CONTROL_ENV_VARS);

/** Absolute path of the one configuration file, given the launch directory. */
export function launchEnvFilePath(cwd = process.cwd()) {
  return join(cwd, ".env");
}

/**
 * Parse one `KEY=VALUE` line, stripping a single matching quote pair.
 *
 * Returns [key, value] or null for blank, comment, and malformed lines. This is
 * the single dotenv grammar in the tree; do not add a second parser or
 * shell-evaluation semantics.
 */
export function parseEnvFileLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  const quoted = value.length >= 2
    && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"));
  if (quoted) value = value.slice(1, -1);
  return [key, value];
}

/**
 * Bind `env` in place to the launch directory's `.env`.
 *
 * Owned names are cleared first, so a missing, empty, malformed, or unreadable
 * file can never reactivate an inherited value.
 */
export function loadServerEnv(env = process.env, { cwd = process.cwd() } = {}) {
  for (const name of GROUND_CONTROL_ENV_VARS) delete env[name];

  let body;
  try {
    body = readFileSync(launchEnvFilePath(cwd), "utf8");
  } catch {
    // Absent or unreadable. The file is not required: the server starts and
    // every registered tool that needs no variable works without it.
    return env;
  }

  for (const line of body.split(/\r?\n/)) {
    const parsed = parseEnvFileLine(line);
    if (parsed && OWNED.has(parsed[0])) env[parsed[0]] = parsed[1];
  }
  return env;
}
