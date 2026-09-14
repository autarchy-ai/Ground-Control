// Split from gc-implement-base-sync.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { execFile as execFileCb } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveWorkflowRouteFromConfig,
  runCreateSynchronizedImplementPr,
  validateImplementPrTitle,
} from "./lib.js";

const execFile = promisify(execFileCb);

const REPO_ROOT = realpathSync(new URL("../..", import.meta.url).pathname);

const ISSUE = 1421;

const BRANCH = "1421-merge-dev-before-pr";

const PRE = "1".repeat(40);

const BASE = "2".repeat(40);

const RESULT = "3".repeat(40);

const RECORD = "4".repeat(32);

const TREE = "5".repeat(40);

function renderedPrBody() {
  return [
    "## Summary", "", "summary", "",
    "## Requirement UIDs", "", "- `GC-O007`", "",
    "## Related Issues", "", "Refs #1421", "",
    "## ADR Impact", "", "- ADR-021", "",
    "## Changes", "", "- change", "",
    "## Test Plan", "", "- tests", "",
    "## Ground Control Checks", "",
    "- [x] Configured repository policy command passes",
    "- [x] Pre-push code review and test-quality review completed; all findings fixed or dispositioned",
    "", "## Traceability", "", "- IMPLEMENTS: GC-O007", "- TESTS: test", "",
    "## Checklist", "", "- [x] done",
  ].join("\n");
}

async function workspaceAuthorization() {
  const [gitDir, gitCommonDir, origin] = await Promise.all([
    execFile("git", ["-C", REPO_ROOT, "rev-parse", "--absolute-git-dir"]),
    execFile("git", ["-C", REPO_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    execFile("git", ["-C", REPO_ROOT, "remote", "get-url", "origin"]),
  ]);
  return {
    workspaceRoot: REPO_ROOT,
    gitDir: realpathSync(gitDir.stdout.trim()),
    gitCommonDir: realpathSync(gitCommonDir.stdout.trim()),
    origin: origin.stdout.trim(),
    owner: "autarchy-ai",
    name: "ground-control",
  };
}

function context(baseBranch = "dev", workflowOverrides = {}) {
  return {
    status: "ok",
    workflow: {
      base_branch: baseBranch,
      completion_command: "make check",
      policy_command: "make policy",
      pr_title: null,
      ...workflowOverrides,
    },
  };
}

// The issue Requirements section is the server-side binding for a requested
// requirement identity (issue #1434).
function requirementsThreadReader(body = "## Requirements\n- DSL-437\n") {
  return async () => ({ ok: true, body });
}

// PR lookup and creation go through GitHub REST (issue #1584): `gh api --method <M> <path> ...`.
function ghRestCall(args) {
  return { method: args[args.indexOf("--method") + 1], path: args.find((arg) => arg.startsWith("/repos/")) ?? "" };
}

function restPr({ number, baseRef = "dev", body = renderedPrBody() }) {
  const repo = { name: "Ground-Control", full_name: "autarchy-ai/Ground-Control", owner: { login: "autarchy-ai" } };
  return {
    number,
    html_url: `https://github.com/autarchy-ai/Ground-Control/pull/${number}`,
    state: "open",
    merged_at: null,
    title: "feat: require synchronized implement PRs",
    body,
    base: { ref: baseRef, repo },
    head: { ref: BRANCH, sha: RESULT, repo },
  };
}

function gitOperation(args) {
  const marker = args.indexOf("-C");
  return args.slice(marker + 2);
}

describe("synchronized PR gate", () => {
  it("treats routing metadata as advisory and exposes no execution-control field", () => {
    const result = resolveWorkflowRouteFromConfig({
      routing: {
        enabled: true,
        default_provider: "claude",
        stages: {
          implementation: {
            tier: "medium",
            provider: "claude",
            model: "claude-sonnet-5",
          },
        },
      },
      stage: "implementation",
    });
    assert.equal(result.ok, true);
    assert.equal(result.model, "claude-sonnet-5");
    assert.equal("agent" in result, false);
    assert.equal("fallback" in result, false);
  });

  it("validates the configured Conventional Commit title shape", () => {
    assert.equal(validateImplementPrTitle("feat: merge dev before PR").ok, true);
    assert.equal(validateImplementPrTitle("feat: Merge dev before PR").ok, false);
    assert.equal(validateImplementPrTitle("fix/refactor: merge dev").ok, false);
  });

  it("accepts the Conventional Commits breaking-change marker under the configured rules (#1593)", () => {
    const config = { types: ["feat", "fix"], subject_pattern: "^[a-z].*$", require_scope: false };
    assert.equal(validateImplementPrTitle("feat!: adopt raes 4.1.0", config).ok, true);
    assert.equal(validateImplementPrTitle("feat(api)!: drop legacy route", config).ok, true);
    assert.equal(validateImplementPrTitle("feat!!: adopt raes 4.1.0", config).ok, false);
    assert.equal(validateImplementPrTitle("feat!(api): drop legacy route", config).ok, false);
    assert.equal(validateImplementPrTitle("docs!: rewrite guide", config).ok, false);
    assert.equal(validateImplementPrTitle("feat!: Adopt raes 4.1.0", config).ok, false);
    assert.equal(validateImplementPrTitle("feat!: adopt raes 4.1.0", { ...config, require_scope: true }).ok, false);
  });

  it("refuses PR creation on an invalid repository context (#1429)", async () => {
    const calls = [];
    const result = await runCreateSynchronizedImplementPr({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      recordId: RECORD,
      title: "feat: require synchronized implement PRs",
      body: renderedPrBody(),
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      commandRunner: async (command, args) => {
        calls.push([command, args]);
        return { stdout: "" };
      },
      contextResolver: async () => ({
        status: "invalid",
        errors: ["workflow.policy_command must be a non-empty string when set"],
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_pr_context_invalid");
    assert.equal(calls.length, 0);
  });

  it("refuses PR creation when the integration branch advances after attestation", async () => {
    let prCreateCalled = false;
    const runner = async (command, args) => {
      if (command === "gh") {
        if (args[0] === "pr" && args[1] === "create") prCreateCalled = true;
        throw new Error("unexpected GitHub write");
      }
      const op = gitOperation(args);
      if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
      if (op[0] === "status") return { stdout: "" };
      if (op[0] === "fetch") return { stdout: "" };
      if (op[0] === "rev-parse") {
        const ref = op[op.length - 1];
        if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
        if (ref.startsWith("refs/remotes/origin/dev")) return { stdout: `${"5".repeat(40)}\n` };
        return { stdout: `${RESULT}\n` };
      }
      if (op[0] === "ls-remote") return { stdout: `${RESULT}\trefs/heads/${BRANCH}\n` };
      if (op[0] === "merge-base") return { stdout: "" };
      throw new Error(`unexpected git operation: ${op.join(" ")}`);
    };
    const result = await runCreateSynchronizedImplementPr({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      recordId: RECORD,
      title: "feat: require synchronized implement PRs",
      body: renderedPrBody(),
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      commandRunner: runner,
      contextResolver: async () => context(),
      issueThreadReader: requirementsThreadReader(),
      syncRecordReader: async () => ({
        ok: true,
        record: {
          valid: true,
          recordId: RECORD,
          issueNumber: ISSUE,
          branchName: BRANCH,
          baseBranch: "dev",
          remoteRef: "refs/remotes/origin/dev",
          preSyncSha: PRE,
          fetchedBaseSha: BASE,
          outcome: "merged_clean",
          resultingFeatureSha: RESULT,
          verifiedTreeSha: TREE,
        },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_pr_sync_stale");
    assert.equal(result.next_action, "return_to_the_synchronization_boundary");
    assert.equal(prCreateCalled, false);
  });

  it("pins PR lookup and creation to the authorized repository", async () => {
    const calls = [];
    const runner = async (command, args) => {
      calls.push([command, args]);
      if (command === "gh") {
        const { method, path } = ghRestCall(args);
        if (method === "GET" && path.includes("/pulls?")) return { stdout: "[]\n" };
        if (method === "POST" && path.endsWith("/pulls")) {
          return { stdout: JSON.stringify({ number: 200, html_url: "https://github.com/autarchy-ai/Ground-Control/pull/200" }) };
        }
      }
      const op = gitOperation(args);
      if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
      if (op[0] === "status") return { stdout: "" };
      if (op[0] === "fetch" || op[0] === "merge-base") return { stdout: "" };
      if (op[0] === "rev-parse") {
        const ref = op[op.length - 1];
        if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
        if (ref.startsWith("refs/remotes/origin/dev")) return { stdout: `${BASE}\n` };
        return { stdout: `${RESULT}\n` };
      }
      if (op[0] === "ls-remote") return { stdout: `${RESULT}\trefs/heads/${BRANCH}\n` };
      throw new Error(`unexpected operation: ${command} ${args.join(" ")}`);
    };
    const result = await runCreateSynchronizedImplementPr({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      recordId: RECORD,
      title: "feat: require synchronized implement PRs",
      body: renderedPrBody(),
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      commandRunner: runner,
      contextResolver: async () => context(),
      issueThreadReader: requirementsThreadReader(),
      syncRecordReader: async () => ({
        ok: true,
        record: {
          recordId: RECORD,
          issueNumber: ISSUE,
          branchName: BRANCH,
          baseBranch: "dev",
          remoteRef: "refs/remotes/origin/dev",
          preSyncSha: PRE,
          fetchedBaseSha: BASE,
          outcome: "merged_clean",
          resultingFeatureSha: RESULT,
          verifiedTreeSha: TREE,
        },
      }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const ghCalls = calls.filter(([command]) => command === "gh");
    assert.equal(ghCalls.length, 2);
    for (const [, args] of ghCalls) {
      assert.ok(ghRestCall(args).path.startsWith("/repos/autarchy-ai/ground-control/pulls"), args.join(" "));
    }
    assert.equal(result.pr_number, 200);
  });

  it("finds an existing same-repository PR with the branch syntax gh actually accepts", async () => {
    const calls = [];
    let createCalled = false;
    const runner = async (command, args) => {
      calls.push([command, args]);
      if (command === "gh") {
        const { method, path } = ghRestCall(args);
        if (method === "POST") {
          createCalled = true;
          throw new Error("duplicate PR creation attempted");
        }
        const head = new URL(`https://api.github.com${path}`).searchParams.get("head");
        if (head !== `autarchy-ai:${BRANCH}`) return { stdout: "[]\n" };
        return { stdout: JSON.stringify([restPr({ number: 201 })]) };
      }
      const op = gitOperation(args);
      if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
      if (op[0] === "status") return { stdout: "" };
      if (op[0] === "fetch" || op[0] === "merge-base") return { stdout: "" };
      if (op[0] === "rev-parse") {
        const ref = op[op.length - 1];
        if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
        if (ref.startsWith("refs/remotes/origin/dev")) return { stdout: `${BASE}\n` };
        return { stdout: `${RESULT}\n` };
      }
      if (op[0] === "ls-remote") return { stdout: `${RESULT}\trefs/heads/${BRANCH}\n` };
      throw new Error(`unexpected operation: ${command} ${args.join(" ")}`);
    };
    const result = await runCreateSynchronizedImplementPr({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      recordId: RECORD,
      title: "feat: require synchronized implement PRs",
      body: renderedPrBody(),
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      commandRunner: runner,
      contextResolver: async () => context(),
      issueThreadReader: requirementsThreadReader(),
      syncRecordReader: async () => ({
        ok: true,
        record: {
          recordId: RECORD,
          issueNumber: ISSUE,
          branchName: BRANCH,
          baseBranch: "dev",
          remoteRef: "refs/remotes/origin/dev",
          preSyncSha: PRE,
          fetchedBaseSha: BASE,
          outcome: "already_current",
          resultingFeatureSha: RESULT,
          verifiedTreeSha: TREE,
        },
      }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.already_exists, true);
    assert.equal(result.pr_number, 201);
    assert.equal(createCalled, false);
    const listCall = calls.find(([command, args]) => command === "gh" && ghRestCall(args).method === "GET");
    // The REST head filter is owner-qualified; a bare branch name would match nothing.
    assert.equal(new URL(`https://api.github.com${ghRestCall(listCall[1]).path}`).searchParams.get("head"), `autarchy-ai:${BRANCH}`);
  });

  it("refuses an existing PR whose base or rendered content does not match", async () => {
    let createCalled = false;
    const runner = async (command, args) => {
      if (command === "gh") {
        if (ghRestCall(args).method === "POST") createCalled = true;
        return { stdout: JSON.stringify([restPr({ number: 201, baseRef: "main", body: "attacker-controlled body" })]) };
      }
      const op = gitOperation(args);
      if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
      if (op[0] === "status") return { stdout: "" };
      if (op[0] === "fetch" || op[0] === "merge-base") return { stdout: "" };
      if (op[0] === "rev-parse") {
        const ref = op[op.length - 1];
        if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
        if (ref.startsWith("refs/remotes/origin/dev")) return { stdout: `${BASE}\n` };
        return { stdout: `${RESULT}\n` };
      }
      if (op[0] === "ls-remote") return { stdout: `${RESULT}\trefs/heads/${BRANCH}\n` };
      throw new Error(`unexpected operation: ${command} ${args.join(" ")}`);
    };
    const result = await runCreateSynchronizedImplementPr({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      recordId: RECORD,
      title: "feat: require synchronized implement PRs",
      body: renderedPrBody(),
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      commandRunner: runner,
      contextResolver: async () => context(),
      issueThreadReader: requirementsThreadReader(),
      syncRecordReader: async () => ({
        ok: true,
        record: {
          recordId: RECORD,
          issueNumber: ISSUE,
          branchName: BRANCH,
          baseBranch: "dev",
          remoteRef: "refs/remotes/origin/dev",
          preSyncSha: PRE,
          fetchedBaseSha: BASE,
          outcome: "merged_clean",
          resultingFeatureSha: RESULT,
          verifiedTreeSha: TREE,
        },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_pr_existing_identity_mismatch");
    assert.equal(createCalled, false);
  });
});
