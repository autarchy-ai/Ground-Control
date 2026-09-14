// Commit signing through the /implement Git boundary (issue #1580). Signing is a
// property of real Git objects, so these drive live temporary repositories with
// an isolated global config (GIT_CONFIG_GLOBAL) and a throwaway SSH signing key.

import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IMPLEMENT_COMMIT_SIGNING_FAILED,
  assertSafeImplementCheckoutConfiguration,
  runImplementCommit,
  runImplementGit,
  runImplementGitCommand,
  runSynchronizeImplementBranch,
} from "./lib.js";
import { runPublish } from "./implement/publish.js";

const execFile = promisify(execFileCb);
const ISSUE = 1580;
const BRANCH = "1580-sign-publish-commits";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gc-signing-1580-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
function scratchPath(name) {
  sequence += 1;
  return join(scratch, `${sequence}-${name}`);
}

const signingKey = scratchPath("signing-key");
await execFile("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "gc-test", "-f", signingKey]);

// Run `body` with GIT_CONFIG_GLOBAL pointing at a file holding `globalConfig`,
// the host-level configuration the boundary must follow.
async function withHostGitConfig(globalConfig, body) {
  const configPath = scratchPath("gitconfig");
  writeFileSync(configPath, globalConfig);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
}

const IDENTITY = "[user]\n\tname = Test\n\temail = t@example.test\n";
const SIGNING_REQUIRED = (key) => `${IDENTITY}[commit]\n\tgpgSign = true\n[gpg]\n\tformat = ssh\n[user]\n\tsigningKey = ${key}\n`;

async function initRepo() {
  const dir = scratchPath("repo");
  const origin = scratchPath("origin.git");
  const git = (...args) => execFile("git", ["-C", dir, ...args]);
  await execFile("git", ["init", "-q", "--bare", origin]);
  await execFile("git", ["init", "-q", "-b", "dev", dir]);
  await git("remote", "add", "origin", origin);
  await git("config", "user.name", "Test");
  await git("config", "user.email", "t@example.test");
  writeFileSync(join(dir, "base.txt"), "base\n");
  await git("add", "-A");
  await git("commit", "-q", "--no-gpg-sign", "-m", "base");
  await git("checkout", "-q", "-b", BRANCH);
  return { dir, origin, git };
}

async function headCommitObject(git) {
  const { stdout } = await git("cat-file", "commit", "HEAD");
  return stdout;
}

function publishDeps() {
  return {
    authorizeRepo: async (path) => ({ ok: true, repoRoot: path }),
    getContext: async () => ({ status: "ok", workflow: { base_branch: "dev" } }),
    authorizeRequirementUid: async () => ({ ok: true, requirementUid: null }),
    runGit: runImplementGitCommand,
    commit: runImplementCommit,
    execFile,
    preCommit: async () => ({ stdout: "" }),
    synchronize: async () => ({ ok: true, status: "complete" }),
    resolvePublishGitDir: async (repoRoot) => join(repoRoot, ".git"),
    acquirePublishLock: async () => async () => {},
    reconcileInterruptedPublish: async () => ({ proceed: true }),
    writePublishJournal: () => {},
    removePublishJournal: () => {},
  };
}

async function publishChange(dir) {
  writeFileSync(join(dir, "change.txt"), "change\n");
  return runPublish({
    action: "publish",
    repoPath: dir,
    issueNumber: ISSUE,
    branchName: BRANCH,
    commitMessage: "Sign publish commits",
  }, publishDeps());
}

describe("implement commits follow the host signing configuration (#1580)", () => {
  it("signs the publish commit when the host requires signing", async () => {
    const { dir, git } = await initRepo();
    await withHostGitConfig(SIGNING_REQUIRED(signingKey), async () => {
      const result = await publishChange(dir);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.match(await headCommitObject(git), /^gpgsig -----BEGIN SSH SIGNATURE-----/m);
    });
  });

  it("signs the base-sync merge commit when the host requires signing", async () => {
    const { dir, git } = await initRepo();
    await withHostGitConfig(SIGNING_REQUIRED(signingKey), async () => {
      await git("checkout", "-q", "dev");
      writeFileSync(join(dir, "dev.txt"), "dev\n");
      await git("add", "-A");
      await git("commit", "-q", "-m", "dev advance");
      await git("checkout", "-q", BRANCH);
      await runImplementGit(dir, ["merge", "--no-ff", "--no-commit", "dev"], execFile);
      const committed = await runImplementCommit(dir, ["-m", `Merge origin/dev into ${BRANCH}`], execFile);
      assert.deepEqual(committed, { ok: true });
      const commit = await headCommitObject(git);
      assert.equal(commit.match(/^parent /gm).length, 2);
      assert.match(commit, /^gpgsig -----BEGIN SSH SIGNATURE-----/m);
    });
  });

  it("still commits unsigned when the host does not configure signing", async () => {
    const { dir, git } = await initRepo();
    await withHostGitConfig(IDENTITY, async () => {
      const result = await publishChange(dir);
      assert.equal(result.ok, true, JSON.stringify(result));
      const commit = await headCommitObject(git);
      assert.match(commit, /\nSign publish commits\n/);
      assert.doesNotMatch(commit, /^gpgsig /m);
    });
  });

  it("returns a named error and creates no commit when a required signature fails", async () => {
    const { dir, origin, git } = await initRepo();
    const { stdout: before } = await git("rev-parse", "HEAD");
    await withHostGitConfig(SIGNING_REQUIRED(scratchPath("missing-key")), async () => {
      const result = await publishChange(dir);
      assert.equal(result.ok, false);
      assert.equal(result.error, IMPLEMENT_COMMIT_SIGNING_FAILED);
      assert.equal(result.failed_stage, "commit");
    });
    const { stdout: afterHead } = await git("rev-parse", "HEAD");
    assert.equal(afterHead, before, "no commit may be created");
    const { stdout: remoteHeads } = await execFile("git", ["-C", origin, "for-each-ref", "refs/heads"]);
    assert.equal(remoteHeads, "", "nothing may be pushed");
  });

  it("maps a failed base-sync merge signature to the named error without pushing", async () => {
    const pre = "1".repeat(40);
    const base = "2".repeat(40);
    const calls = [];
    const runner = async (command, args) => {
      calls.push([command, args]);
      if (command === "bash" || command === "make") return { stdout: "" };
      const op = args.slice(args.indexOf("-C") + 2);
      if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
      if (op[0] === "status") return { stdout: "M  file.txt\n" };
      if (op[0] === "rev-parse") return { stdout: `${op.at(-1).startsWith("MERGE_HEAD") ? base : pre}\n` };
      if (op[0] === "ls-files") return { stdout: "" };
      if (op[0] === "write-tree") return { stdout: `${"5".repeat(40)}\n` };
      if (op[0] === "config") return { stdout: "true\n" };
      if (op[0] === "commit") {
        const error = new Error("git commit failed");
        error.stderr = "error: Couldn't load public key\n\nfatal: failed to write commit object\n";
        throw error;
      }
      throw new Error(`unexpected git operation: ${op.join(" ")}`);
    };
    const repoRoot = realpathSync(new URL("../..", import.meta.url).pathname);
    const { stdout: originUrl } = await execFile("git", ["-C", repoRoot, "remote", "get-url", "origin"]);
    const result = await runSynchronizeImplementBranch({
      repoPath: repoRoot, issueNumber: ISSUE, branchName: BRANCH,
      action: "complete", recordId: "4".repeat(32), preSyncSha: pre, fetchedBaseSha: base, outcome: "merged_clean",
    }, {
      commandRunner: runner,
      workspaceAuthorizationResolver: async () => {
        const [gitDir, gitCommonDir] = await Promise.all([
          execFile("git", ["-C", repoRoot, "rev-parse", "--absolute-git-dir"]),
          execFile("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
        ]);
        return {
          workspaceRoot: repoRoot, gitDir: realpathSync(gitDir.stdout.trim()),
          gitCommonDir: realpathSync(gitCommonDir.stdout.trim()), origin: originUrl.trim(),
          owner: "autarchy-ai", name: "ground-control",
        };
      },
      contextResolver: async () => ({ status: "ok", workflow: { base_branch: "dev", completion_command: "make check", policy_command: "make policy" } }),
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error, IMPLEMENT_COMMIT_SIGNING_FAILED);
    assert.equal(calls.some(([, args]) => args.includes("push")), false);
  });

  it("rethrows a commit failure that is not a signing failure", async () => {
    const runner = async (_command, args) => {
      if (args.includes("config")) return { stdout: "false\n" };
      const error = new Error("git commit failed");
      error.stderr = "fatal: failed to write commit object\n";
      throw error;
    };
    await assert.rejects(runImplementCommit("/repo", ["-m", "x"], runner), /git commit failed/);
  });
});

describe("checkout-selected signing programs are refused (#1580)", () => {
  const SIGNING_PROGRAM_KEYS = [
    "gpg.program",
    "gpg.ssh.program",
    "gpg.openpgp.program",
    "gpg.x509.program",
    "gpg.ssh.defaultKeyCommand",
  ];

  for (const key of SIGNING_PROGRAM_KEYS) {
    it(`refuses a checkout whose local config sets ${key}`, async () => {
      const { dir, git } = await initRepo();
      await git("config", "--local", key, "/tmp/untrusted-signer");
      await assert.rejects(assertSafeImplementCheckoutConfiguration(dir), (error) =>
        error.message.toLowerCase().endsWith(`not permitted: ${key.toLowerCase()}`));
    });
  }

  it("refuses a signing program set in the worktree-scoped config", async () => {
    const { dir, git } = await initRepo();
    await git("config", "extensions.worktreeConfig", "true");
    await git("config", "--worktree", "gpg.ssh.program", "/tmp/untrusted-signer");
    await assert.rejects(assertSafeImplementCheckoutConfiguration(dir), /gpg\.ssh\.program/);
  });

  it("refuses a non-default hooks path set in the worktree-scoped config", async () => {
    const { dir, git } = await initRepo();
    await git("config", "extensions.worktreeConfig", "true");
    await git("config", "--worktree", "core.hooksPath", "/tmp/untrusted-hooks");
    await assert.rejects(assertSafeImplementCheckoutConfiguration(dir), /core\.hookspath/);
  });

  it("accepts local signing preferences and the default hooks path in either scope", async () => {
    const { dir, git } = await initRepo();
    await git("config", "--local", "commit.gpgSign", "true");
    await git("config", "--local", "gpg.format", "ssh");
    await git("config", "--local", "user.signingKey", signingKey);
    await git("config", "--local", "core.hooksPath", join(dir, ".git", "hooks"));
    await git("config", "extensions.worktreeConfig", "true");
    await git("config", "--worktree", "core.hooksPath", join(dir, ".git", "hooks"));
    await assertSafeImplementCheckoutConfiguration(dir);
  });
});
