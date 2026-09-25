// Split from gc-integrate.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Declaration bodies are unchanged.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { authorizedWorkspaceRoot } from "./workspace-binding.js";
// Re-exported so this module stays the lane's single import surface (issue #1679).
export { defaultRunCiWatcher, defaultRunSonarWatcher } from "./readiness-watchers.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  acquireIntegrationLock,
  detectSensitiveBodyContent,
  isSafeLabelName,
  normalizeIntegrationManagerConfig,
  parseGroundControlYaml,
} from "../lib.js";
import { execFileBounded, runBoundedGateCommand } from "../lib/bounded-exec.js";
export // ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ACTIONS = ["plan", "prepare", "status", "release"];export const VALID_MODES = ["prepare", "enqueue", "merge"];export const DEFAULT_MODE = "prepare";
const DEFAULT_APPROVAL_LABEL = "approved-for-integration";
const DEFAULT_ORDERING = "pr_number_asc";
const DEFAULT_MAX_QUEUE_SIZE = 20;

// Maximum pages fetched from the GitHub Pulls API (100 PRs/page × 5 = 500).
// Exceeding this is refused with error:discovery_too_large rather than
// silently truncating.
const MAX_DISCOVERY_PAGES = 5;

// Maximum summary string length surfaced in per-PR outcome records.
const MAX_SUMMARY_LENGTH = 200;

// ---------------------------------------------------------------------------
// JSON schema exported for index.js registration.
// ---------------------------------------------------------------------------

export const GC_INTEGRATION_MANAGER_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "repo_path"],
  properties: {
    action: { enum: ["plan", "prepare", "status", "release"] },
    repo_path: { type: "string", minLength: 1 },
    mode: { enum: ["prepare", "enqueue", "merge"] },
  },
};

export const GC_INTEGRATION_MANAGER_DESCRIPTION =
  "Approved PR integration manager (GC-O011). " +
  "Action-discriminated: plan (discover + ordered queue), " +
  "prepare (rebase + run gates + force-with-lease push; with mode=merge also executes the merge per-PR), " +
  "status (read lock and last-run state; read-only), " +
  "release (idempotent integration lock release). " +
  "Mode is closed enum {prepare, enqueue, merge}; " +
  "merge is enabled via the ADR-029 carve-out (2026-05-26) and requires " +
  "workflow.integration_manager.merge_strategy in .ground-control.yaml. " +
  "enqueue remains reserved.";export // ---------------------------------------------------------------------------
// Production-default implementations for injectable dependencies.
// ---------------------------------------------------------------------------

/**
 * Production execFile wrapper for fixed Git/GitHub argv. The run holds the
 * integration lock, so every call has the server-owned command deadline and
 * reaps its process tree (issue #1720). Tests replace this with a fake that
 * records argv calls.
 */
async function defaultExecFile(file, argv, options) {
  return execFileBounded(file, argv, options);
}export /**
 * Production runner for the repository's completion gate: the gate deadline,
 * process-tree reaping, and a bounded output tail (issue #1720).
 */
async function defaultRunGate(file, argv, options) {
  return runBoundedGateCommand(file, argv, options);
}export /**
 * Read the .ground-control.yaml text from the repo root.  Throws with
 * `code: "ENOENT"` when the file is absent (mirrors fs.readFileSync).
 */
function defaultReadYaml(repoRoot) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(join(repoRoot, ".ground-control.yaml"), "utf-8");
}export /**
 * Production integration lock acquirer.
 */
async function defaultAcquireIntegrationLock(repoRoot, opts) {
  return acquireIntegrationLock(repoRoot, opts);
}export /**
 * Production halt-ledger writer.  Creates the run directory and writes the
 * halt.json file.  Tests can inject a spy or no-op to inspect calls.
 */
function defaultWriteHaltLedger(runDir, ledger) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(runDir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(join(runDir, "halt.json"), JSON.stringify(ledger, null, 2), "utf-8");
}export // ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an error envelope.  Scrubs the message for sensitive content before
 * returning — all user-surfaced strings pass through this gate.
 */
function errorEnvelope(error, message, next_action, extra = {}) {
  const sensitive = detectSensitiveBodyContent(message);
  return {
    ok: false,
    error,
    message: sensitive ? "<redacted>" : message,
    next_action,
    ...extra,
  };
}export /**
 * Scrub a string for sensitive content, replacing with "<redacted>" when a
 * pattern matches.
 */
function scrub(s) {
  if (typeof s !== "string") return s;
  return detectSensitiveBodyContent(s) ? "<redacted>" : s;
}export /**
 * Truncate a summary string to MAX_SUMMARY_LENGTH chars and scrub it.
 */
function safeSummary(s) {
  if (typeof s !== "string") return "";
  const truncated = s.length > MAX_SUMMARY_LENGTH ? s.slice(0, MAX_SUMMARY_LENGTH) : s;
  return scrub(truncated);
}export /**
 * Generate a run ID: <timestamp>-<random6>.
 * `deps.now` and `deps.randomId` are injectable for deterministic tests.
 */
function makeRunId(deps) {
  const ts = deps.now ? deps.now() : Date.now();
  // Correlation label for a run directory, not a secret or a capability;
  // randomUUID is used so the generator is not a question a reader has to ask.
  const rand = deps.randomId ? deps.randomId() : randomUUID().replaceAll("-", "").slice(0, 6);
  return `${ts}-${rand}`;
}

/**
 * Classify a failure as needing a consultation_halt (true) vs. a simple
 * blocked outcome (false).  This is the v1 seam — intentionally small set.
 *
 * Consultation criteria:
 *   - PR head OID moved since discovery (force-with-lease lease mismatch).
 *   - Configured approval_label race (label differs mid-run).
 *
 * Everything else (worktree_create_failed, base_fetch_failed, rebase_conflict,
 * completion_gate_failed, ci_failed, sonar_skipped_but_configured) is NOT a
 * consultation — it is either a blocked or a queue_wide_halt.
 */
function classifyAsConsultation(failureClass) {
  return failureClass === "pr_head_moved" || failureClass === "approval_label_race";
}// Read .ground-control.yaml and resolve the integration-manager policy from it.
// Returns an error envelope on any config fault so the caller stays flat.
function resolveIntegrationConfig(repoRoot, readYaml) {
  let yamlText;
  try {
    yamlText = readYaml(repoRoot);
  } catch (e) {
    return errorEnvelope(
      "invalid_config",
      e.code === "ENOENT"
        ? ".ground-control.yaml not found at the repository root"
        : `.ground-control.yaml could not be read: ${e.message}`,
      "fix_ground_control_yaml",
    );
  }

  const parseResult = parseGroundControlYaml(yamlText);
  if (!parseResult.ok) {
    return errorEnvelope(
      "invalid_config",
      `Invalid .ground-control.yaml: ${parseResult.errors.join("; ")}`,
      "fix_ground_control_yaml",
    );
  }

  const imResult = normalizeIntegrationManagerConfig(
    parseResult.value.workflow?.integration_manager ?? null,
  );
  if (!imResult.ok) {
    return errorEnvelope(
      "invalid_config",
      `workflow.integration_manager config errors: ${imResult.errors.join("; ")}`,
      "fix_ground_control_yaml",
    );
  }

  const approvalLabel = imResult.value.approval_label ?? DEFAULT_APPROVAL_LABEL;
  if (!isSafeLabelName(approvalLabel)) {
    return errorEnvelope(
      "invalid_approval_label",
      `The resolved approval_label '${approvalLabel}' is not a safe label name`,
      "fix_ground_control_yaml",
    );
  }

  return {
    ok: true,
    cfg: parseResult.value,
    approvalLabel,
    ordering: imResult.value.ordering ?? DEFAULT_ORDERING,
    maxQueueSize: imResult.value.max_queue_size ?? DEFAULT_MAX_QUEUE_SIZE,
  };
}

// One page of open pull requests, or an error envelope. Separated so the
// pagination loop below stays a loop and nothing else.
async function fetchPullRequestPage(owner, repo, page, execFile) {
  let stdout;
  try {
    ({ stdout } = await execFile("gh", [
      "api", "-X", "GET",
      `/repos/${owner}/${repo}/pulls`,
      "--field", "state=open",
      "--field", "per_page=100",
      "--field", `page=${page}`,
    ]));
  } catch (e) {
    return errorEnvelope(
      "discovery_failed",
      `gh api call failed on page ${page}: ${e.message}`,
      "verify_remote",
    );
  }

  try {
    return { ok: true, pageData: JSON.parse(stdout) };
  } catch (e) {
    return errorEnvelope(
      "discovery_failed",
      `Could not parse GitHub API response on page ${page}: ${e.message}`,
      "contact_support",
    );
  }
}

// Every open pull request, bounded by MAX_DISCOVERY_PAGES. Exceeding the cap is
// an error rather than a silent truncation: a partial queue would be prepared
// as though it were the whole queue.
async function discoverOpenPullRequests(owner, repo, execFile) {
  const pullRequests = [];
  for (let page = 1; page <= MAX_DISCOVERY_PAGES; page++) {
    const result = await fetchPullRequestPage(owner, repo, page, execFile);
    if (!result.ok) return result;

    const { pageData } = result;
    if (Array.isArray(pageData) && pageData.length > 0) {
      pullRequests.push(...pageData);
    } else {
      return { ok: true, pullRequests };
    }
    if (pageData.length < 100) return { ok: true, pullRequests };
  }

  return errorEnvelope(
    "discovery_too_large",
    `More than ${MAX_DISCOVERY_PAGES * 100} open PRs were found; narrow the search using a more specific approval_label`,
    "narrow_approval_label",
  );
}

const QUEUE_COMPARATORS = {
  pr_number_asc: (a, b) => a.number - b.number,
  pr_number_desc: (a, b) => b.number - a.number,
  approved_at_asc: (a, b) => a.created_at.localeCompare(b.created_at),
};

// Deterministic queue order. An unrecognized ordering keeps discovery order,
// which normalizeIntegrationManagerConfig has already constrained.
function orderApprovedPullRequests(approved, ordering) {
  const sorted = [...approved];
  const comparator = QUEUE_COMPARATORS[ordering];
  if (comparator) sorted.sort(comparator);
  return sorted;
}

// One scrubbed queue entry. A cross-repository head is flagged so the prepare
// action can refuse a fork PR rather than push to another repository.
function queueEntry(pr, idx, owner, repo) {
  const headFullName = pr.head?.repo?.full_name ?? null;
  const baseFullName = pr.base?.repo?.full_name ?? null;
  const [headRepoOwner, headRepoName] = headFullName == null
    ? [owner, repo]
    : headFullName.split("/");
  return {
    ordinal: idx + 1,
    pr_number: pr.number,
    head_ref: scrub(pr.head.ref),
    head_oid: scrub(pr.head.sha),
    base_ref: scrub(pr.base.ref),
    head_repo_owner: scrub(headRepoOwner),
    head_repo_name: scrub(headRepoName),
    head_is_fork: headFullName !== null && baseFullName !== null
      && headFullName !== baseFullName,
    created_at: scrub(pr.created_at),
    updated_at: scrub(pr.updated_at),
  };
}

export // ---------------------------------------------------------------------------
// buildIntegrationQueue (extracted from runPlanAction for reuse by prepare)
// ---------------------------------------------------------------------------

/**
 * Discover and build the ordered queue of approved PRs.
 * Returns `{ok:true, queue:[...], owner, repo, policy}` or an error envelope.
 *
 * This is the shared inner logic that both runPlanAction and runPrepareAction
 * call.  Callers must have already validated mode (plan refuses non-prepare
 * modes before calling this).
 */
async function buildIntegrationQueue(args, deps) {
  const { execFile, ensureGitRepo: ensureRepo, getOwnerRepo: getOwner, readYaml } = deps;

  // Resolve and canonicalize the repo path, then bind it to the MCP launch
  // workspace. The plan and prepare actions fetch, rebase, force-with-lease
  // push, and in merge mode merge — so an unbound `repo_path` would let a caller
  // point those writes at any other checkout the server process can reach,
  // using the server's credentials. The git-repo check runs first so a
  // non-repository path still reports invalid_repo_path.
  let repoRoot;
  try {
    repoRoot = await ensureRepo(args.repo_path);
  } catch (e) {
    return errorEnvelope(
      "invalid_repo_path",
      `repo_path is not a valid Git repository: ${e.message}`,
      "verify_repo_path",
    );
  }

  const authorized = await authorizedWorkspaceRoot({ repo_path: repoRoot }, deps);
  if (!authorized.ok) return authorized;
  repoRoot = authorized.workspaceRoot;

  const configResult = resolveIntegrationConfig(repoRoot, readYaml);
  if (!configResult.ok) return configResult;
  const { cfg, approvalLabel, ordering, maxQueueSize } = configResult;

  // ── Resolve owner/repo ────────────────────────────────────────────────────
  let owner, repo;
  try {
    ({ owner, name: repo } = await getOwner(repoRoot));
  } catch (e) {
    return errorEnvelope(
      "github_remote_not_resolved",
      `Could not resolve GitHub owner/repo: ${e.message}`,
      "verify_remote",
    );
  }

  // ── Validate configured identity against the checkout (GC-P026) ────────────
  // .ground-control.yaml::github_repo is an assertion, not an alternate
  // destination: if it disagrees with the checkout's origin remote, refuse
  // before any discovery or mutation rather than act on a stale or mistyped
  // identity. Compared case-insensitively (GitHub owner/repo are case-folding).
  const configuredRepo = cfg.github_repo;
  if (configuredRepo && configuredRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    return errorEnvelope(
      "github_identity_mismatch",
      `.ground-control.yaml github_repo '${configuredRepo}' does not match the checkout's origin remote '${owner}/${repo}'`,
      "fix_ground_control_yaml",
    );
  }

  const discovery = await discoverOpenPullRequests(owner, repo, execFile);
  if (!discovery.ok) return discovery;
  const allPrs = discovery.pullRequests;

  // ── Client-side label filter ──────────────────────────────────────────────
  const approved = allPrs.filter((pr) =>
    Array.isArray(pr.labels) &&
    pr.labels.some((l) => l.name === approvalLabel),
  );

  // ── Queue cap check ───────────────────────────────────────────────────────
  if (approved.length > maxQueueSize) {
    return errorEnvelope(
      "queue_too_large",
      `${approved.length} approved PRs exceed the configured max_queue_size of ${maxQueueSize}`,
      "narrow_approval_label",
    );
  }

  const sorted = orderApprovedPullRequests(approved, ordering);

  // ── Build queue entries ───────────────────────────────────────────────────
  const queue = sorted.map((pr, idx) => queueEntry(pr, idx, owner, repo));

  return {
    ok: true,
    repoRoot,
    owner,
    repo,
    cfg,
    policy: {
      approval_label: approvalLabel,
      ordering,
      max_queue_size: maxQueueSize,
    },
    queue,
  };
}
