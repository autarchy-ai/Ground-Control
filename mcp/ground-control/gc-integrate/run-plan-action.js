// Split from gc-integrate.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Declaration bodies are unchanged.

import { join } from "node:path";
import { realpathSync } from "node:fs";
import { assertRealpathInRepo } from "../lib.js";
import { DEFAULT_MODE, buildIntegrationQueue, safeSummary } from "./exec-file-async.js";

// A trailing ": <url>" suffix when a watcher supplied one. Keeps the failure
// summaries free of nested template literals (S4624).
function detailsSuffix(detailsUrl) {
  return detailsUrl ? `: ${detailsUrl}` : "";
}

export // ---------------------------------------------------------------------------
// runPlanAction
// ---------------------------------------------------------------------------

/**
 * Implements the `plan` action.
 *
 * @param {object} args - Validated MCP tool args (action, repo_path, mode).
 * @param {object} deps - Injected dependencies.
 * @returns {Promise<object>} Plan envelope or error envelope.
 */
async function runPlanAction(args, deps) {
  // ── Clause d: mode refusal short-circuit ─────────────────────────────────
  if (args.mode === "enqueue" || args.mode === "merge") {
    return {
      ok: false,
      error: "mode_disabled",
      message:
        `${args.mode} mode is reserved; the integration manager only executes prepare mode under the current ADR set`,
      next_action: "file_adr_amendment",
      mode: args.mode,
    };
  }

  const effectiveMode = args.mode ?? DEFAULT_MODE;

  const queueResult = await buildIntegrationQueue(args, deps);
  if (!queueResult.ok) {
    return queueResult;
  }

  const { owner, repo, policy, queue } = queueResult;

  return {
    ok: true,
    action: "plan",
    mode: effectiveMode,
    owner,
    repo,
    policy,
    plan: queue,
  };
}// Refusals that need no git or gh side effect: a worktree path that would
// escape the repository, and a fork PR (the prepare-only lane is same-repo
// only, GC-O011 first slice). Returns a blocked record, or null to proceed.
function preparePreflight(pr, repoRoot, worktreePath) {
  let repoRootReal;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repoRoot validated by ensureGitRepo
    repoRootReal = realpathSync(repoRoot);
  } catch {
    repoRootReal = repoRoot; // best-effort fallback
  }

  // assertRealpathInRepo walks up existing ancestors, so a worktree path that
  // does not exist yet is still checked for containment.
  const containCheck = assertRealpathInRepo(repoRootReal, worktreePath, "integration-worktree path");
  if (!containCheck.ok) {
    return {
      pr_number: pr.pr_number,
      outcome: "blocked",
      failure_class: "worktree_path_invalid",
      summary: safeSummary(`Worktree path rejected: ${containCheck.error}`),
      next_action: "contact_support",
    };
  }

  if (pr.head_is_fork) {
    return {
      pr_number: pr.pr_number,
      outcome: "blocked",
      failure_class: "fork_pr_unsupported",
      summary: safeSummary(
        `PR from fork ${pr.head_repo_owner}/${pr.head_repo_name} is not supported in the prepare-only lane (GC-O011 first slice)`,
      ),
      next_action: "merge_manually_or_open_followup",
    };
  }

  return null;
}

// The repository's configured completion gate, run inside the worktree.
// Returns a blocked record on a non-zero exit, or null when it passes or when
// the repository configures no gate.
async function runCompletionGate(pr, cfg, worktreePath, execFile) {
  const completionCommand = cfg?.workflow?.completion_command;
  if (!completionCommand) return null;
  try {
    // The command string is repo-authored config, not user input.
    // execFile("bash", ["-c", ...]) is the deliberately-excepted form
    // documented in the dispatch spec: argv is exactly [bash, -c, <cmd>].
    await execFile("bash", ["-c", completionCommand], { cwd: worktreePath });
    return null;
  } catch (e) {
    return {
      pr_number: pr.pr_number,
      outcome: "blocked",
      failure_class: "completion_gate_failed",
      summary: safeSummary(`Completion gate exited non-zero: ${e.message ?? String(e)}`),
      next_action: "fix_completion_gate",
    };
  }
}

// git reports a lease rejection in several wordings; match them in one place.
function isLeaseMismatch(errText, message) {
  return /stale info|force with lease|rejected.*lease|lease.*rejected|rejected.*\[remote rejected\]/i.test(errText)
    || (message ?? "").includes("lease");
}

// Push the rebased head under a lease bound to the head OID seen at discovery.
// A lease rejection means the PR head moved under us, which is a maintainer
// decision rather than a retry. Returns a failure record, or null on success.
async function pushRebasedHead(pr, tmpRef, worktreePath, execFile) {
  try {
    await execFile("git", [
      "-C", worktreePath,
      "push",
      `--force-with-lease=${pr.head_ref}:${pr.head_oid}`,
      "origin",
      `${tmpRef}:${pr.head_ref}`,
    ]);
  } catch (e) {
    const errText = (e.stderr ?? e.stdout ?? e.message ?? "").toString();
    if (isLeaseMismatch(errText, e.message)) {
      return {
        pr_number: pr.pr_number,
        outcome: "consultation_halt",
        failure_class: "pr_head_moved",
        halt_reason: "pr_head_moved",
        summary: safeSummary(`PR #${pr.pr_number} head moved since discovery; force-with-lease rejected`),
        candidate_resolutions: [
          "Re-run plan to discover the new head OID",
          "Verify the PR was not force-pushed concurrently",
          "Check for automated commits (e.g., bot activity) on this branch",
        ],
        next_action: "consult_maintainer",
      };
    }
    return {
      pr_number: pr.pr_number,
      outcome: "blocked",
      failure_class: "push_failed",
      summary: safeSummary(`git push --force-with-lease failed: ${errText.slice(0, 150)}`),
      next_action: "check_remote_access",
    };
  }
  return null;
}

// The commit this lane is about to publish, for the readiness watchers to bind
// to. Best-effort on purpose: the watchers bind to the branch tip on their own
// when this is null, which is the same guarantee against a stale run. Naming
// the commit only closes the narrower window where someone else's push lands
// between ours and the watcher's read.
async function rebasedHeadSha(tmpRef, worktreePath, execFile) {
  try {
    const { stdout } = await execFile("git", ["-C", worktreePath, "rev-parse", tmpRef]);
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

// CI conclusions that block a PR, with the record each one produces.
const CI_BLOCKERS = {
  queued_too_long: {
    failure_class: "ci_queued_too_long",
    summary: "CI run has been queued longer than the configured timeout",
    next_action: "check_ci_queue",
  },
  timed_out: {
    failure_class: "ci_timed_out",
    summary: "CI run did not complete within the configured total timeout",
    next_action: "check_ci_run",
  },
};

// A Sonar skip on a Sonar-configured repo, classified by what the watcher
// observed. A terminal producer is a scope question, not a configuration one:
// routing it to `check_sonar_configuration` sent the operator at
// .ground-control.yaml for a scan the repository's own CI declined to run
// (issue #1559). The block stands either way.
function sonarSkipBlockedRecord(pr, sonarResult) {
  const notProduced = sonarResult.reason === "sonar_watch_analysis_not_produced";
  let summary;
  if (notProduced) {
    summary = "SonarCloud published no analysis for this pull request: its producer check is already terminal";
  } else {
    summary = "Sonar analysis was skipped but sonarcloud is configured in .ground-control.yaml";
    if (sonarResult.reason) summary += ` (watcher reported ${sonarResult.reason})`;
  }
  return {
    pr_number: pr.pr_number,
    outcome: "blocked",
    failure_class: notProduced ? "sonar_analysis_not_produced" : "sonar_skipped_but_configured",
    summary: safeSummary(summary),
    next_action: notProduced ? "diagnose_sonar_scan_scope" : "check_sonar_configuration",
    ...(sonarResult.scope_evidence ? { sonar_scope_evidence: sonarResult.scope_evidence } : {}),
  };
}

// The CI and Sonar readiness gates. Hook contract for both:
// (pr, ctx, deps) => Promise<{conclusion, details_url?}>. Returns a blocked
// record for the first gate that refuses, or null when the PR is ready.
async function runReadinessWatchers(pr, ctx, deps, cfg) {
  const ciResult = await deps.runCiWatcher(pr, ctx, deps);
  if (ciResult.conclusion === "failure") {
    return {
      pr_number: pr.pr_number,
      outcome: "blocked",
      failure_class: "ci_failed",
      summary: safeSummary(`CI check failed${detailsSuffix(ciResult.details_url)}`),
      next_action: "fix_ci",
    };
  }
  const ciBlocker = CI_BLOCKERS[ciResult.conclusion];
  if (ciBlocker) {
    return {
      pr_number: pr.pr_number,
      outcome: "blocked",
      failure_class: ciBlocker.failure_class,
      summary: safeSummary(ciBlocker.summary),
      next_action: ciBlocker.next_action,
    };
  }

  const sonarResult = await deps.runSonarWatcher(pr, ctx, deps);
  // A skipped analysis is only a problem when the repo configures SonarCloud;
  // otherwise there is nothing for the watcher to have observed.
  if (sonarResult.conclusion === "skipped" && cfg?.sonarcloud != null) {
    return sonarSkipBlockedRecord(pr, sonarResult);
  }
  if (sonarResult.conclusion === "failure") {
    return {
      pr_number: pr.pr_number,
      outcome: "blocked",
      failure_class: "sonar_gate_red",
      summary: safeSummary(`Sonar quality gate is red${detailsSuffix(sonarResult.details_url)}`),
      next_action: "fix_sonar_issues",
    };
  }

  return null;
}

// Fetch the PR head into a temporary ref and check it out in an isolated
// worktree. `git fetch pull/<n>/head` rather than `gh pr checkout`, which would
// pollute the current worktree. Returns a blocked record, or null on success —
// the caller marks the worktree created so cleanup runs.
async function fetchHeadIntoWorktree(pr, tmpRef, repoRoot, worktreePath, execFile) {
  try {
    await execFile("git", [
      "-C", repoRoot,
      "fetch", "origin",
      `pull/${pr.pr_number}/head:${tmpRef}`,
    ]);
  } catch (e) {
    return {
      pr_number: pr.pr_number,
      outcome: "blocked",
      failure_class: "worktree_create_failed",
      summary: safeSummary(`Failed to fetch PR head: ${e.message ?? String(e)}`),
      next_action: "check_remote_access",
    };
  }

  try {
    await execFile("git", ["-C", repoRoot, "worktree", "add", worktreePath, tmpRef]);
    return null;
  } catch (e) {
    return {
      pr_number: pr.pr_number,
      outcome: "blocked",
      failure_class: "worktree_create_failed",
      summary: safeSummary(`git worktree add failed: ${e.message ?? String(e)}`),
      next_action: "check_remote_access",
    };
  }
}

// The rebase conflict record, with the conflicted-file count pulled out of the
// git output for the summary.
function rebaseConflictRecord(pr, errText) {
  const conflictLines = errText.split("\n").filter((l) => l.startsWith("CONFLICT")).length;
  const count = conflictLines > 0 ? conflictLines : "unknown";
  return {
    pr_number: pr.pr_number,
    outcome: "blocked",
    failure_class: "rebase_conflict",
    summary: safeSummary(`Rebase produced conflicts on ${count} file(s): ${errText.slice(0, 100)}`),
    next_action: "resolve_conflicts",
  };
}

// Fetch the base branch and rebase the PR head onto its tip. A base-fetch
// failure halts the whole queue (every later PR would rebase onto the same
// missing base); a conflict blocks only this PR. Returns a record, or null.
async function rebaseOntoBase(pr, tmpRef, worktreePath, execFile) {
  try {
    await execFile("git", ["-C", worktreePath, "fetch", "origin", pr.base_ref]);
  } catch (e) {
    return {
      pr_number: pr.pr_number,
      outcome: "queue_wide_halt",
      failure_class: "base_fetch_failed",
      summary: safeSummary(`Base branch fetch failed (${pr.base_ref}): ${e.message ?? String(e)}`),
      next_action: "check_base_branch",
    };
  }

  let mergeBase;
  try {
    const mbResult = await execFile("git", [
      "-C", worktreePath,
      "merge-base", tmpRef, `origin/${pr.base_ref}`,
    ]);
    mergeBase = mbResult.stdout.trim();
  } catch {
    // No shared merge-base is reachable (a shallow clone, or a head with no
    // common ancestor). Rebasing from the base tip is the correct fallback, so
    // the failure carries no information the caller can act on.
    mergeBase = `origin/${pr.base_ref}`;
  }

  try {
    await execFile("git", [
      "-C", worktreePath,
      "rebase", "--onto", `origin/${pr.base_ref}`, mergeBase, tmpRef,
    ]);
    return null;
  } catch (e) {
    try {
      await execFile("git", ["-C", worktreePath, "rebase", "--abort"]);
    } catch {
      // Best-effort abort to leave the worktree clean; ignore secondary failures.
    }
    return rebaseConflictRecord(pr, (e.stderr ?? e.stdout ?? e.message ?? "").toString());
  }
}

export // ---------------------------------------------------------------------------
// preparePullRequestBranch — per-PR worktree isolation, rebase, gates, push
// ---------------------------------------------------------------------------

/**
 * Per-PR preparation: isolated worktree, fetch, rebase, completion gate,
 * force-with-lease push, CI/Sonar watcher hooks, worktree cleanup.
 *
 * @param {object} pr   - Queue entry ({pr_number, head_ref, head_oid, base_ref}).
 * @param {object} ctx  - Run context ({repoRoot, runId, cfg, owner, repo}).
 * @param {object} deps - Injected dependencies.
 * @returns {Promise<object>} Per-PR outcome record.
 */
async function preparePullRequestBranch(pr, ctx, deps) {
  const { execFile } = deps;
  const { repoRoot, runId, cfg } = ctx;

  const tmpRef = `integ-tmp-${pr.pr_number}`;
  const worktreePath = join(repoRoot, ".gc", "integration-worktrees", runId, String(pr.pr_number));

  const refusal = preparePreflight(pr, repoRoot, worktreePath);
  if (refusal) return refusal;

  let worktreeCreated = false;

  try {
    const fetchFailure = await fetchHeadIntoWorktree(pr, tmpRef, repoRoot, worktreePath, execFile);
    if (fetchFailure) return fetchFailure;
    worktreeCreated = true;

    const rebaseFailure = await rebaseOntoBase(pr, tmpRef, worktreePath, execFile);
    if (rebaseFailure) return rebaseFailure;

    const gateFailure = await runCompletionGate(pr, cfg, worktreePath, execFile);
    if (gateFailure) return gateFailure;

    // Push BEFORE the CI/Sonar watchers so they observe the rebased commit.
    const pushedHeadSha = await rebasedHeadSha(tmpRef, worktreePath, execFile);
    const pushFailure = await pushRebasedHead(pr, tmpRef, worktreePath, execFile);
    if (pushFailure) return pushFailure;

    // Watchers run after the push AND bound to the commit it published: a push
    // and its workflow runs are seconds to minutes apart, so "after" alone
    // still lets the pre-rebase run answer for the rebase (issue #1365).
    const watcherFailure = await runReadinessWatchers(
      { ...pr, pushed_head_sha: pushedHeadSha }, ctx, deps, cfg);
    if (watcherFailure) return watcherFailure;


    return {
      pr_number: pr.pr_number,
      outcome: "ready",
      summary: safeSummary(`PR #${pr.pr_number} rebased and pushed successfully`),
    };
  } finally {
    // ── Cleanup: remove worktree and delete tmp ref ───────────────────────
    // Failures here are logged (not surfaced) and do not change the outcome.
    if (worktreeCreated) {
      try {
        await execFile("git", [
          "-C", repoRoot,
          "worktree", "remove", "--force", worktreePath,
        ]);
      } catch {
        // Best-effort cleanup.
      }
    }
    // Delete the temporary local ref regardless of worktree cleanup outcome.
    try {
      await execFile("git", [
        "-C", repoRoot,
        "update-ref", "-d", `refs/heads/${tmpRef}`,
      ]);
    } catch {
      // Best-effort cleanup.
    }
  }
}
