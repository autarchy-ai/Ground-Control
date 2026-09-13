// Split from gc-implement-contract.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { runPrepareImplementBranch, validateImplementBranchName } from "./lib.js";

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gc-implement-contract-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "initial"]);
  execFileSync("git", ["-C", repo, "branch", "-M", "dev"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/example/repo.git"]);
  return repo;
}

function authorizationForRepo(repo) {
  // A freshly `git init`'d repo is a main worktree, so --absolute-git-dir and
  // --git-common-dir resolve to the same `.git` (issue #1502).
  const gitDir = realpathSync(
    execFileSync("git", ["-C", repo, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim(),
  );
  return {
    workspaceRoot: realpathSync(repo),
    gitDir,
    gitCommonDir: gitDir,
    origin: execFileSync(
      "git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" },
    ).trim(),
    owner: "example",
    name: "repo",
  };
}

const execFileAsync = promisify(execFileCallback);

// Branch preparation runs git only (issue #1584): no `gh issue develop`, so no GitHub GraphQL. The
// runner logs every git invocation, answers `fetch` from a local stand-in for origin (the base branch
// at HEAD, optionally an existing remote issue branch), and runs every other git command for real.
function offlineGitRunner(repo, logPath, { remoteBranches = [] } = {}) {
  return async (command, args, options) => {
    appendFileSync(logPath, `${command} ${JSON.stringify(args)}\n`);
    if (command !== "git") throw new Error(`unexpected command: ${command}`);
    const op = args.slice(args.indexOf("-C") + 2);
    if (op[0] === "fetch") {
      const [, destination] = op[op.length - 1].replace(/^\+/, "").split(":");
      const branch = destination.replace("refs/remotes/origin/", "");
      if (branch !== "dev" && !remoteBranches.includes(branch)) {
        throw Object.assign(new Error(`couldn't find remote ref refs/heads/${branch}`), { code: 128 });
      }
      execFileSync("git", ["-C", repo, "update-ref", destination, "HEAD"]);
      return { stdout: "", stderr: "" };
    }
    return execFileAsync(command, args, options);
  };
}

async function withPath(bin, fn) {
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = old;
  }
}

describe("same-checkout /implement branch operation", () => {
  it("creates the issue branch in the invocation checkout without a worktree command", async () => {
    const repo = initRepo();
    const bin = mkdtempSync(join(tmpdir(), "gc-implement-bin-"));
    const log = join(bin, "gh.log");
    writeFileSync(log, "");
    try {
      const result = await withPath(bin, () =>
        runPrepareImplementBranch({
          repoPath: repo,
          invocationRoot: repo,
          issueNumber: 1416,
          branchName: "1416-implement-principles",
          baseBranch: "dev",
          checkoutMode: "same_checkout",
        }, {
          workspaceAuthorizationResolver: async () => authorizationForRepo(repo),
          commandRunner: offlineGitRunner(repo, log),
        }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.repo_path, realpathSync(repo));
      assert.equal(result.branch, "1416-implement-principles");
      assert.equal(result.origin, undefined);
      assert.equal(
        execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
        realpathSync(repo),
      );
      assert.doesNotMatch(readFileSync(log, "utf8"), /worktree/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("authorizes when only the per-worktree Git dir diverges (issue #1502)", async () => {
    const repo = initRepo();
    const bin = mkdtempSync(join(tmpdir(), "gc-implement-bin-"));
    const log = join(bin, "gh.log");
    writeFileSync(log, "");
    try {
      // A concurrent /implement in a sibling linked worktree (or an MCP relaunch) can
      // shift the captured per-worktree --absolute-git-dir while the shared repository
      // store, origin, and owner/name are unchanged. The guard pins the common dir, so
      // this no longer fails with implement_repo_identity_changed.
      const authorization = {
        ...authorizationForRepo(repo),
        gitDir: join(repo, ".git", "worktrees", "stale-pointer"),
      };
      const result = await withPath(bin, () =>
        runPrepareImplementBranch({
          repoPath: repo,
          invocationRoot: repo,
          issueNumber: 1502,
          branchName: "1502-worktree-identity-guard",
          baseBranch: "dev",
          checkoutMode: "same_checkout",
        }, { workspaceAuthorizationResolver: async () => authorization, commandRunner: offlineGitRunner(repo, log) }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.branch, "1502-worktree-identity-guard");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("fails closed when the invocation root is not the supplied checkout", async () => {
    const repo = initRepo();
    const other = mkdtempSync(join(tmpdir(), "gc-other-checkout-"));
    try {
      const result = await runPrepareImplementBranch({
        repoPath: repo,
        invocationRoot: other,
        issueNumber: 1416,
        branchName: "1416-implement-principles",
        baseBranch: "dev",
        checkoutMode: "same_checkout",
      }, { workspaceAuthorizationResolver: async () => authorizationForRepo(repo) });
      assert.equal(result.ok, false);
      assert.equal(result.error, "implement_invocation_root_mismatch");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("never executes a caller-controlled post-checkout hook", async () => {
    const repo = initRepo();
    const bin = mkdtempSync(join(tmpdir(), "gc-implement-bin-"));
    const log = join(bin, "gh.log");
    const hookResult = join(bin, "hook-ran");
    writeFileSync(log, "");
    const hooks = join(repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "post-checkout"),
      `#!/bin/sh\nprintf ran > ${JSON.stringify(hookResult)}\n`,
      { mode: 0o755 },
    );
    try {
      const authorization = authorizationForRepo(repo);
      const result = await withPath(bin, () =>
        runPrepareImplementBranch({
          repoPath: repo,
          invocationRoot: repo,
          issueNumber: 1416,
          branchName: "1416-implement-principles",
          checkoutMode: "same_checkout",
        }, { workspaceAuthorizationResolver: async () => authorization, commandRunner: offlineGitRunner(repo, log) }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.match(readFileSync(log, "utf8"), /"switch"/);
      assert.throws(() => readFileSync(hookResult));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("rejects a mutable origin retarget before branch mutation", async () => {
    const repo = initRepo();
    try {
      const authorization = authorizationForRepo(repo);
      execFileSync("git", [
        "-C", repo, "remote", "set-url", "origin", "https://github.com/example/other.git",
      ]);
      const result = await runPrepareImplementBranch({
        repoPath: repo,
        invocationRoot: repo,
        issueNumber: 1416,
        branchName: "1416-implement-principles",
      }, { workspaceAuthorizationResolver: async () => authorization });
      assert.equal(result.ok, false);
      assert.equal(result.error, "implement_repo_identity_changed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects branch mutation outside the MCP launch workspace", async () => {
    const repo = initRepo();
    try {
      const result = await runPrepareImplementBranch({
        repoPath: repo,
        invocationRoot: repo,
        issueNumber: 1416,
        branchName: "1416-implement-principles",
        checkoutMode: "same_checkout",
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, "implement_repo_not_authorized");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("prepares the branch from the fetched integration branch without invoking gh (issue #1584)", async () => {
    const repo = initRepo();
    const bin = mkdtempSync(join(tmpdir(), "gc-implement-bin-"));
    const log = join(bin, "git.log");
    writeFileSync(log, "");
    // A gh on PATH that fails the test if branch preparation reaches GitHub at all.
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'gh must not run' >&2\nexit 3\n", { mode: 0o755 });
    try {
      execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "origin tip"]);
      const originTip = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const result = await withPath(bin, () =>
        runPrepareImplementBranch({
          repoPath: repo, invocationRoot: repo, issueNumber: 1584, branchName: "1584-rest-first", baseBranch: "dev",
        }, { workspaceAuthorizationResolver: async () => authorizationForRepo(repo), commandRunner: offlineGitRunner(repo, log) }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.branch, "1584-rest-first");
      assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), originTip);
      assert.doesNotMatch(readFileSync(log, "utf8"), /^gh /m);
      assert.match(readFileSync(log, "utf8"), /\+refs\/heads\/dev:refs\/remotes\/origin\/dev/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("tracks the issue branch from origin when it already exists there", async () => {
    const repo = initRepo();
    const log = join(mkdtempSync(join(tmpdir(), "gc-implement-log-")), "git.log");
    writeFileSync(log, "");
    try {
      const result = await runPrepareImplementBranch({
        repoPath: repo, invocationRoot: repo, issueNumber: 1584, branchName: "1584-rest-first", baseBranch: "dev",
      }, {
        workspaceAuthorizationResolver: async () => authorizationForRepo(repo),
        commandRunner: offlineGitRunner(repo, log, { remoteBranches: ["1584-rest-first"] }),
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const upstream = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "@{upstream}"], { encoding: "utf8" }).trim();
      assert.equal(upstream, "origin/1584-rest-first");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("enforces the existing issue branch shape", () => {
    assert.deepEqual(validateImplementBranchName("1416-fix-branch", 1416), { ok: true });
    assert.equal(validateImplementBranchName("feature/1416-fix", 1416).ok, false);
    assert.equal(validateImplementBranchName(`1416-${"x".repeat(50)}`, 1416).ok, false);
  });
});
