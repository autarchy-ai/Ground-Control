// Launch-workspace authorization for tests that drive tools pinned to the MCP launch workspace.
//
// Production resolves the authorization once from the directory the MCP server launched in. A test
// that runs a pinned tool against its own temporary repository supplies the equivalent identity for
// that repository, so the real authorization check still runs against a matching workspace.

import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function workspaceAuthorizationFor(repoDir) {
  return async () => {
    const git = (...args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
    const gitDir = realpathSync(git("rev-parse", "--absolute-git-dir"));
    const origin = git("remote", "get-url", "origin");
    const [, owner, name] = origin.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return {
      workspaceRoot: realpathSync(repoDir),
      gitDir,
      gitCommonDir: realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir")),
      origin,
      owner,
      name,
    };
  };
}
