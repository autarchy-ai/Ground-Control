// Launch-workspace authorization for tests that drive tools pinned to the MCP launch workspace.
//
// Production resolves the authorization once from the directory the MCP server launched in. A test
// that runs a pinned tool against its own temporary repository supplies the equivalent identity for
// that repository, captured by the same function production uses, so the real authorization check
// still runs against a matching workspace.

import { captureImplementWorkspaceAuthorization } from "./lib/grc-legacy-compat-4.js";

export function workspaceAuthorizationFor(repoDir) {
  return () => captureImplementWorkspaceAuthorization(repoDir);
}
