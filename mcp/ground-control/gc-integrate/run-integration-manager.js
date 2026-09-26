// Split from gc-integrate.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Declaration bodies are unchanged.

import { detectSensitiveBodyContent, ensureGitRepo, getOwnerRepo } from "../lib.js";
import { DEFAULT_MODE, VALID_ACTIONS, VALID_MODES, defaultAcquireIntegrationLock, defaultExecFile, defaultReadYaml, defaultRunGate, defaultRunCiWatcher, defaultRunSonarWatcher, defaultWriteHaltLedger, errorEnvelope } from "./exec-file-async.js";
import { runPlanAction } from "./run-plan-action.js";
import { defaultReadFile, defaultReaddir, defaultRmFile, defaultStatFile, runPrepareAction, runReleaseAction, runStatusAction } from "./run-prepare-action.js";

// ---------------------------------------------------------------------------
// runIntegrationManager — top-level dispatcher
// ---------------------------------------------------------------------------

/**
 * Top-level dispatcher for gc_integration_manager.
 *
 * @param {object} args - MCP tool input (action, repo_path, mode?).
 * @param {object} [deps] - Injectable dependencies for testing.
 * @returns {Promise<object>} Result envelope.
 */
export async function runIntegrationManager(args = {}, deps = {}) {
  // Fill in production defaults for any uninjected deps.
  const resolvedDeps = {
    execFile: deps.execFile ?? defaultExecFile,
    runGate: deps.runGate ?? defaultRunGate,
    ensureGitRepo: deps.ensureGitRepo ?? ensureGitRepo,
    getOwnerRepo: deps.getOwnerRepo ?? getOwnerRepo,
    readYaml: deps.readYaml ?? defaultReadYaml,
    acquireIntegrationLock: deps.acquireIntegrationLock ?? defaultAcquireIntegrationLock,
    writeHaltLedger: deps.writeHaltLedger ?? defaultWriteHaltLedger,
    // CI/Sonar watcher hooks — real adapters wired to lib.js watchers.
    runCiWatcher: deps.runCiWatcher ?? defaultRunCiWatcher,
    runSonarWatcher: deps.runSonarWatcher ?? defaultRunSonarWatcher,
    // Status/release injectable deps.
    // The workspace-root resolver stays undefined unless injected; the status
    // and release actions fall back to the real MCP launch workspace.
    resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
    statFile: deps.statFile ?? defaultStatFile,
    readdir: deps.readdir ?? defaultReaddir,
    readFile: deps.readFile ?? defaultReadFile,
    rmFile: deps.rmFile ?? defaultRmFile,
    // Run-ID generation — injectable for deterministic tests.
    now: deps.now,
    randomId: deps.randomId,
  };

  try {
    // ── Validate action ──────────────────────────────────────────────────────
    const { action } = args;
    if (!action || !VALID_ACTIONS.includes(action)) {
      return errorEnvelope(
        "unknown_action",
        `action must be one of: ${VALID_ACTIONS.join(", ")}; got ${JSON.stringify(action)}`,
        "use_supported_action",
      );
    }

    // ── Validate repo_path ───────────────────────────────────────────────────
    if (!args.repo_path || typeof args.repo_path !== "string" || args.repo_path.trim() === "") {
      return errorEnvelope(
        "invalid_repo_path",
        "repo_path is required and must be a non-empty string",
        "verify_repo_path",
      );
    }

    // ── Validate mode ────────────────────────────────────────────────────────
    if (args.mode !== undefined && !VALID_MODES.includes(args.mode)) {
      return errorEnvelope(
        "unknown_mode",
        `mode must be one of: ${VALID_MODES.join(", ")}; got ${JSON.stringify(args.mode)}`,
        "use_supported_mode",
      );
    }

    // Normalise args: apply default mode.
    const normalizedArgs = {
      ...args,
      mode: args.mode ?? DEFAULT_MODE,
    };

    // ── Dispatch on action ───────────────────────────────────────────────────
    switch (action) {
      case "plan":
        return await runPlanAction(normalizedArgs, resolvedDeps);

      case "prepare":
        return await runPrepareAction(normalizedArgs, resolvedDeps);

      case "status":
        return await runStatusAction(normalizedArgs, resolvedDeps);

      case "release":
        return await runReleaseAction(normalizedArgs, resolvedDeps);

      default:
        // Unreachable due to VALID_ACTIONS guard above, but kept for safety.
        return errorEnvelope(
          "unknown_action",
          `Unknown action: ${action}`,
          "use_supported_action",
        );
    }
  } catch (e) {
    // Never throw across the MCP boundary.
    const raw = e?.message ?? String(e);
    const sensitive = detectSensitiveBodyContent(raw);
    return errorEnvelope(
      "unexpected_error",
      sensitive ? "<redacted>" : `Unexpected error: ${raw}`,
      "contact_support",
    );
  }
}
