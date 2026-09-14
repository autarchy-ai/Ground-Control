// Launch-workspace-pinned repository identity for issue-thread records and reads (#1578, #1583).
//
// A caller's repo_path is a claim, not an identity. Every tool that posts a durable issue-thread
// or pull-request record, closes or creates an issue, or reads a thread with the MCP host's GitHub
// credentials resolves its repository through the MCP launch-workspace authorization. Otherwise any
// checkout on the host with a GitHub origin could be named, and the server would spend the host's
// credentials on that repository — including writing the cycle markers and decision records other
// gates consume.

import {
  authorizeImplementRepoRoot,
  ensureGitRepo,
  resolveMcpLaunchWorkspaceAuthorization,
} from "./grc-legacy-compat-4.js";

export async function resolveAuthorizedIssueRepository(
  repoPath,
  workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
) {
  let repoRoot;
  try {
    repoRoot = await ensureGitRepo(repoPath);
  } catch (error) {
    return { ok: false, error: "implement_repo_not_git", message: error.message };
  }
  const authorization = await authorizeImplementRepoRoot(repoRoot, workspaceAuthorizationResolver);
  if (!authorization.ok) return authorization;
  return { ok: true, repoRoot, owner: authorization.owner, name: authorization.name };
}

/**
 * The structured refusal a pinned tool returns before any GitHub read or write.
 *
 * @param {string} errorPrefix tool-stable error namespace, e.g. `decision_record`
 * @param {{error: string, message: string}} repository the failed resolution
 * @param {object} [fields] tool-specific envelope fields (issue_number, pr_number, ...)
 */
export function issueRepositoryNotAuthorized(errorPrefix, repository, fields = {}) {
  return {
    ok: false,
    error: `${errorPrefix}_repo_not_authorized`,
    message:
      `${repository.message} (${repository.error}). `
      + "This tool acts on GitHub with the MCP host's credentials, so it acts only on the "
      + "workspace this server was launched in.",
    ...fields,
    next_action: "run_from_the_mcp_launch_workspace_and_retry",
  };
}
