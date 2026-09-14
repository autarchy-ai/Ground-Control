// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parsePhaseMarkers } from "./codex-review.js";
import { MCP_LAUNCH_CWD, evaluateExecutionObligations, isDefaultImplementHooksPath, parseExecutionObligationMarkers } from "./codex-workflow.js";
import { ENRICH_THREAD_PAGE_CAP } from "./grc-legacy-compat-2.js";
import { getAuthenticatedGitHubLogin, getOwnerRepo, hasVerifiedStructuredWontfixAuthorization, readIssueCommentsWithAuthors, resolveExecutionObligationTrust } from "./grc-legacy-compat-3.js";
import { STATION_OBSERVATION_DISPOSITION, hasVerifiedStationReobservation } from "./execution-obligation-v2.js";
import { listPullRequestsForHead } from "./github-rest.js";
import { execFile, formatCommandFailure } from "./runtime-primitives.js";
export * from "./grc-legacy-compat-7.js";

// `git rev-parse --show-toplevel` recurs across the repo-root resolvers below.
const GIT_SHOW_TOPLEVEL = "--show-toplevel";

export async function ensureGitRepo(repoPath) {
  if (!repoPath || !isAbsolute(repoPath)) {
    throw new Error("repo_path must be an absolute path to a Git repository");
  }

  try {
    const { stdout } = await execFile("git", ["-C", repoPath, "rev-parse", GIT_SHOW_TOPLEVEL]);
    return stdout.trim();
  } catch (error) {
    throw new Error(`repo_path is not a valid Git repository: ${formatCommandFailure("git", error)}`);
  }
}
export async function captureImplementWorkspaceAuthorization(cwd) {
  const { stdout } = await execFile("git", ["-C", cwd, "rev-parse", GIT_SHOW_TOPLEVEL]);
  const workspaceRoot = realpathSync(stdout.trim());
  const identity = await readGitIdentity(workspaceRoot);
  const { owner, name } = await getOwnerRepo(workspaceRoot, { allowGhFallback: false });
  return Object.freeze({
    workspaceRoot,
    gitDir: identity.gitDir,
    gitCommonDir: identity.gitCommonDir,
    origin: identity.origin,
    owner: owner.toLowerCase(),
    name: name.toLowerCase(),
  });
}
const MCP_LAUNCH_WORKSPACE_AUTHORIZATION = captureImplementWorkspaceAuthorization(
  MCP_LAUNCH_CWD,
).catch(() => null);
export async function resolveMcpLaunchWorkspaceAuthorization() {
  return MCP_LAUNCH_WORKSPACE_AUTHORIZATION;
}
export async function authorizeImplementRepoRoot(repoRoot, workspaceAuthorizationResolver) {
  let authorization;
  try {
    authorization = await workspaceAuthorizationResolver();
  } catch {
    authorization = null;
  }
  if (
    authorization == null
    || typeof authorization !== "object"
    || typeof authorization.workspaceRoot !== "string"
    || typeof authorization.gitCommonDir !== "string"
    || typeof authorization.origin !== "string"
    || typeof authorization.owner !== "string"
    || typeof authorization.name !== "string"
  ) {
    return {
      ok: false,
      error: "implement_workspace_root_unavailable",
      message: "The MCP launch workspace and repository identity could not be captured",
    };
  }
  const workspaceRoot = realpathSync(authorization.workspaceRoot);
  if (realpathSync(repoRoot) !== workspaceRoot) {
    return {
      ok: false,
      error: "implement_repo_not_authorized",
      message: "The requested repository is outside the MCP launch workspace authorized for this run",
    };
  }
  let current;
  let currentOwnerRepo;
  try {
    current = await readGitIdentity(repoRoot);
    currentOwnerRepo = await getOwnerRepo(repoRoot, { allowGhFallback: false });
  } catch {
    return {
      ok: false,
      error: "implement_repo_identity_unverifiable",
      message: "The requested repository identity could not be verified",
    };
  }
  // Pin the shared repository store (--git-common-dir), not the per-worktree Git
  // directory (--absolute-git-dir). The workspaceRoot check above already binds the run
  // to one checkout; pinning the per-worktree pointer on top of it was fragile, because a
  // concurrent /implement in a sibling linked worktree (git worktree repair/prune) or an
  // MCP relaunch could shift that pointer's realpath while the repository is unchanged,
  // firing implement_repo_identity_changed mid-run with no recovery (issue #1502). The
  // origin/owner/name checks stay strict, so an origin retarget to a different repo is
  // still rejected.
  if (
    current.gitCommonDir !== realpathSync(authorization.gitCommonDir)
    || current.origin !== authorization.origin
    || currentOwnerRepo.owner.toLowerCase() !== authorization.owner.toLowerCase()
    || currentOwnerRepo.name.toLowerCase() !== authorization.name.toLowerCase()
  ) {
    return {
      ok: false,
      error: "implement_repo_identity_changed",
      message:
        "The checkout origin or Git repository differs from the identity captured at MCP launch. "
        + "If you are in a linked worktree or the Ground Control MCP server was relaunched, "
        + "restart the server from this worktree so it re-captures the workspace identity.",
    };
  }
  return {
    ok: true,
    workspaceRoot,
    gitDir: current.gitDir,
    gitCommonDir: current.gitCommonDir,
    origin: authorization.origin,
    owner: authorization.owner,
    name: authorization.name,
  };
}
export async function readGitIdentity(repoRoot) {
  const [top, gitDir, gitCommonDir, origin] = await Promise.all([
    execFile("git", ["-C", repoRoot, "rev-parse", GIT_SHOW_TOPLEVEL]),
    execFile("git", ["-C", repoRoot, "rev-parse", "--absolute-git-dir"]),
    execFile("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"]),
    execFile("git", ["-C", repoRoot, "remote", "get-url", "origin"]),
  ]);
  // --git-common-dir returns the shared repository store: for a linked worktree it is
  // the main checkout's `.git` (stable across every worktree of the repo), while
  // --absolute-git-dir is the per-worktree `<common>/worktrees/<name>` pointer. Git may
  // return it relative to repoRoot (typically bare `.git` in the main worktree), so
  // resolve against repoRoot before realpath. See issue #1502.
  const rawCommonDir = gitCommonDir.stdout.trim();
  return {
    topLevel: realpathSync(top.stdout.trim()),
    gitDir: realpathSync(gitDir.stdout.trim()),
    gitCommonDir: realpathSync(
      isAbsolute(rawCommonDir) ? rawCommonDir : join(repoRoot, rawCommonDir),
    ),
    origin: origin.stdout.trim(),
  };
}
// Dangerous, caller-controlled executable Git config keys. Split from one large
// alternation into per-key anchored patterns (S5843): the outer `^(?:A|B|…)$/i`
// matches a whole key iff it fully matches one branch, so testing each branch
// as its own `^(?:…)$/i` and OR-ing the results matches EXACTLY the same set.
const DANGEROUS_GIT_CONFIG_KEY_RES = [
  /^core\.(?:hookspath|sshcommand|askpass|fsmonitor)$/i,
  /^credential(?:\.|$)$/i,
  /^filter\..*\.(?:clean|smudge|process|required)$/i,
  /^diff\..*\.command$/i,
  /^merge\..*\.driver$/i,
  /^include(?:if\..*)?\.path$/i,
  /^url\..*\.(?:insteadof|pushinsteadof)$/i,
  /^remote\..*\.(?:proxy|uploadpack|receivepack)$/i,
];

function isDangerousGitConfigKey(key) {
  return DANGEROUS_GIT_CONFIG_KEY_RES.some((re) => re.test(key));
}

export async function assertSafeImplementCheckoutConfiguration(repoRoot) {
  const { stdout } = await execFile(
    "git",
    ["-C", repoRoot, "config", "--local", "--name-only", "--get-regexp", ".*"],
  ).catch((error) => {
    if (error.code === 1) return { stdout: "" };
    throw error;
  });
  let configuredDangerousKeys = stdout
    .split(/\r?\n/)
    .map((key) => key.trim())
    .filter((key) => key !== "" && isDangerousGitConfigKey(key));
  if (configuredDangerousKeys.some((key) => key.toLowerCase() === "core.hookspath")) {
    const [{ stdout: hooksPath }, { stdout: gitDir }, { stdout: gitCommonDir }] = await Promise.all([
      execFile("git", ["-C", repoRoot, "config", "--local", "--path", "--get", "core.hooksPath"]),
      execFile("git", ["-C", repoRoot, "rev-parse", "--absolute-git-dir"]),
      execFile("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"]),
    ]);
    if (isDefaultImplementHooksPath({
      repoRoot,
      hooksPath: hooksPath.trim(),
      gitDir: gitDir.trim(),
      gitCommonDir: gitCommonDir.trim(),
    })) {
      configuredDangerousKeys = configuredDangerousKeys.filter(
        (key) => key.toLowerCase() !== "core.hookspath",
      );
    }
  }
  if (configuredDangerousKeys.length > 0) {
    throw new Error(
      `caller-controlled executable Git configuration is not permitted: ${configuredDangerousKeys.join(", ")}`,
    );
  }
}
// `preread` lets a caller that must bind further decisions to the same thread snapshot (issue #1582)
// evaluate the ledger over the comments it already holds instead of a second, possibly newer, read.
export async function readTrustedExecutionObligationState(repoRoot, owner, name, issueNumber, preread = null) {
  const comments = preread ?? await readIssueCommentsWithAuthors(repoRoot, owner, name, issueNumber);
  const markerComments = comments
    .map((comment) => ({
      comment,
      events: parseExecutionObligationMarkers([comment.body], issueNumber),
    }))
    .filter(({ events }) => events.length > 0);
  if (markerComments.length === 0) {
    return { ok: true, ...evaluateExecutionObligations([]) };
  }
  const trust = await resolveExecutionObligationTrust(
    repoRoot,
    owner,
    name,
    comments,
  );
  const untrustedMarker = markerComments.find(({ comment }) => !trust.isTrusted(comment));
  if (untrustedMarker != null) {
    return {
      ok: false,
      error: "execution_obligation_provenance_unverifiable",
      message:
        "An execution-obligation marker was authored outside the repository's authorized signer set",
    };
  }
  const trustedEvents = await filterAttestedReobservations(repoRoot, markerComments, comments);
  for (const event of trustedEvents) {
    if (event.event !== "resolved" || event.disposition !== "wontfix") continue;
    const authorization = comments.find(
      (comment) => comment.id === event.authorization_comment_id,
    );
    if (
      authorization == null
      || !hasVerifiedStructuredWontfixAuthorization(
        authorization,
        comments,
        trust,
        issueNumber,
        event.obligation_id,
      )
    ) {
      return {
        ok: false,
        error: "execution_obligation_authorization_unverifiable",
        message:
          `The wontfix resolution for '${event.obligation_id}' lacks a verified structured authorization record`,
      };
    }
  }
  return {
    ok: true,
    ...evaluateExecutionObligations(trustedEvents),
  };
}
/**
 * Drop `reobserved` resolutions that are not attested by the trusted MCP posting identity.
 *
 * Dropped rather than raised as an error: an unattested marker leaves its obligation open, which
 * keeps completion blocked and the problem visible. Failing the whole read instead would let
 * anyone who can comment on the issue wedge the run by pasting a marker-shaped record.
 *
 * The trusted login is resolved only when such a resolution is actually present, so the common
 * path keeps its current number of GitHub calls.
 */
async function filterAttestedReobservations(repoRoot, markerComments, comments) {
  const events = markerComments.flatMap(({ events: parsed }) => parsed);
  const hasReobservation = events.some(
    (event) => event.event === "resolved"
      && event.disposition === STATION_OBSERVATION_DISPOSITION,
  );
  if (!hasReobservation) return events;
  const trustedLogin = await getAuthenticatedGitHubLogin(repoRoot);
  const attested = [];
  for (const { comment, events: parsed } of markerComments) {
    for (const event of parsed) {
      const isReobservation = event.event === "resolved"
        && event.disposition === STATION_OBSERVATION_DISPOSITION;
      if (
        isReobservation
        && !hasVerifiedStationReobservation(event, comment, comments, trustedLogin)
      ) {
        continue;
      }
      attested.push(event);
    }
  }
  return attested;
}
/**
 * Phases whose completion markers were authored by someone with repository permission.
 *
 * Every caller uses the result as a prerequisite gate — the plan post, the review cap, and the
 * completion record all refuse to proceed until the phases they require appear here. The markers
 * were previously read from comment bodies alone, with no regard for who wrote them, so anyone able
 * to comment on the issue could paste a `gc:phase` marker and satisfy a prerequisite that no phase
 * had actually met. Execution-obligation markers on the same thread already resolve their author's
 * effective repository permission before they are believed; phase markers now use the same trust
 * model, since they gate the same workflow.
 *
 * Fails closed. A marker whose author cannot be established, or a trust lookup that cannot be
 * completed, yields no phase rather than an assumed one: an unmet prerequisite blocks, and blocking
 * on an unverifiable marker is the safe direction.
 */
export async function readCompletedPhases(repoRoot, owner, name, issueNumber) {
  let comments;
  try {
    comments = await readIssueCommentsWithAuthors(repoRoot, owner, name, issueNumber);
  } catch {
    return new Set();
  }
  const markerComments = comments.filter(
    (comment) => parsePhaseMarkers([comment.body], issueNumber).size > 0,
  );
  if (markerComments.length === 0) {
    return new Set();
  }
  let trust;
  try {
    trust = await resolveExecutionObligationTrust(repoRoot, owner, name, comments);
  } catch {
    return new Set();
  }
  const trustedBodies = markerComments.filter((comment) => trust.isTrusted(comment)).map((c) => c.body);
  return parsePhaseMarkers(trustedBodies, issueNumber);
}
export async function getCurrentBranchName(repoRoot) {
  try {
    const { stdout } = await execFile("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
    });
    const branch = String(stdout).trim();
    if (!branch || branch === "HEAD") return null;
    return branch;
  } catch {
    return null;
  }
}
export async function autoDetectPrNumber(repoRoot) {
  // Pin --repo to the git-remote-derived slug so a rogue GH_REPO on the
  // MCP host can't redirect this lookup at a different repo. --repo is
  // placed at the end of argv (gh accepts flags in any order) so the
  // hermetic-shim test fixtures' strict argv-prefix matches still work.
  // The current branch's open PR, over REST: `gh pr view` spent the shared GraphQL budget
  // (issue #1584). Ambiguity (no PR, or several) resolves to null, as before.
  try {
    const { owner, name } = await getOwnerRepo(repoRoot);
    const branch = await getCurrentBranchName(repoRoot);
    if (branch == null) return null;
    const prs = await listPullRequestsForHead(repoRoot, owner, name, branch);
    return prs.length === 1 ? prs[0].number : null;
  } catch {
    return null;
  }
}
export async function fetchReviewCommentById(repoRoot, owner, name, commentId) {
  const { stdout } = await execFile(
    "gh",
    ["api", `/repos/${owner}/${name}/pulls/comments/${commentId}`],
    { cwd: repoRoot },
  );
  return JSON.parse(stdout);
}
// Fold one page of GraphQL review threads into `result`, recording the thread
// id for every wanted comment database id not already mapped. Extracted to keep
// enrichCommentsWithThreadIds under the cognitive-complexity budget (S3776).
function _absorbReviewThreadPage(threads, wanted, result) {
  for (const node of threads.nodes || []) {
    for (const c of node.comments?.nodes || []) {
      if (wanted.has(c.databaseId) && !result.has(c.databaseId)) {
        result.set(c.databaseId, node.id);
      }
    }
  }
}

// GraphQL by necessity (issue #1586): REST review comments carry no review-thread
// node id, and `resolveReviewThread` accepts only that id, so there is no REST
// path from a comment to the thread gc_codex_verify_finding resolves.
export async function enrichCommentsWithThreadIds({ repoRoot, owner, name, prNumber, commentIds }) {
  if (!commentIds || commentIds.length === 0) {
    return new Map();
  }
  const wanted = new Set(commentIds);
  const result = new Map();
  let cursor = null;
  let pages = 0;

  while (result.size < wanted.size) {
    if (pages >= ENRICH_THREAD_PAGE_CAP) {
      // Don't throw — the caller is happy to receive partial mapping (missing
      // entries become null thread_ids in the returned comment list). Just
      // stop paging so we cannot loop forever.
      break;
    }
    pages += 1;
    const query = `
      query($owner:String!, $name:String!, $pr:Int!, $cursor:String) {
        repository(owner:$owner, name:$name) {
          pullRequest(number:$pr) {
            reviewThreads(first:100, after:$cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                comments(first:10) { nodes { databaseId } }
              }
            }
          }
        }
      }
    `;
    const args = [
      "api", "graphql",
      "-f", `query=${query}`,
      "-F", `owner=${owner}`,
      "-F", `name=${name}`,
      "-F", `pr=${prNumber}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const { stdout } = await execFile("gh", args, { cwd: repoRoot });
    const data = JSON.parse(stdout);
    const threads = data?.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) break;
    _absorbReviewThreadPage(threads, wanted, result);
    if (!threads.pageInfo?.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
  }

  return result;
}
