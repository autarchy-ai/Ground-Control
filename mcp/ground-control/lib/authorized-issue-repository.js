// Launch-workspace-pinned repository identity for issue-thread ledger reads and records (#1578).
//
// A caller's repo_path is a claim, not an identity. Everything that reads the execution-obligation
// ledger to decide what completion may clear — or posts the record that says so — resolves the
// repository through the MCP launch-workspace authorization, so waiver evidence and completion
// records are always bound to the checkout this server was launched for.

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
