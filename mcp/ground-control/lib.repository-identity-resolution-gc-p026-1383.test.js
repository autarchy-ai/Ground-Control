// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_POLICY_COMMAND,
  DEFAULT_PRECOMMIT_COMMAND,
  REQUIREMENT_UID_GATE_ENV_VAR,
  buildGroundControlContextSnippet,
  buildSuggestedGroundControlYaml,
  implementGateEnvironment,
  parseGroundControlYaml,
  resolveWorkflowPolicyCommand,
  resolveWorkflowPrecommitCommand,
  runImplementPreCommit,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Repository identity resolution (GC-P026 / #1383)
// ---------------------------------------------------------------------------

describe("repository identity resolution (GC-P026 / #1383)", () => {
  // Repo-bound reads and mutations derive the target slug from the checkout's
  // git origin remote and never honor process.env.GH_REPO — closing the
  // env-hijack class. git ignores GH_REPO, so a real throwaway repo pins the
  // derivation deterministically.

  function gitRepoWithOrigin(slug) {
    const dir = mkdtempSync(join(tmpdir(), "gc-p026-repo-"));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", `https://github.com/${slug}.git`]);
    return dir;
  }

  function gitRepoNoOrigin() {
    const dir = mkdtempSync(join(tmpdir(), "gc-p026-noorigin-"));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    return dir;
  }

  function nonGitDir() {
    return mkdtempSync(join(tmpdir(), "gc-p026-nogit-"));
  }

  // A PATH-shim `gh` that records its argv to a file and prints `stdout`.
  function ghShim(stdout) {
    const binDir = mkdtempSync(join(tmpdir(), "gc-p026-bin-"));
    const argvLog = join(binDir, "argv.json");
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(stdout)});
process.exit(0);
`;
    writeFileSync(join(binDir, "gh"), script, { mode: 0o755 });
    return {
      binDir,
      called() { return existsSync(argvLog); },
      argv() { return JSON.parse(readFileSync(argvLog, "utf8")); },
      cleanup() { rmSync(binDir, { recursive: true, force: true }); },
    };
  }

  // Run `fn` with `binDir` prepended to PATH and (optionally) GH_REPO set,
  // restoring both afterward.
  async function withEnv(binDir, fn, { ghRepo } = {}) {
    const oldPath = process.env.PATH;
    const oldGhRepo = process.env.GH_REPO;
    if (binDir) process.env.PATH = `${binDir}:${oldPath}`;
    if (ghRepo !== undefined) process.env.GH_REPO = ghRepo;
    try {
      return await fn();
    } finally {
      process.env.PATH = oldPath;
      if (oldGhRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = oldGhRepo;
    }
  }

  it("createGitHubIssue throws 'Invalid GitHub repo format' for a malformed repo assertion", async () => {
    const { createGitHubIssue } = await import("./lib.js");
    const shim = ghShim("https://github.com/good/repo/issues/1\n");
    const repoDir = gitRepoWithOrigin("good/repo");
    try {
      await withEnv(shim.binDir, () =>
        assert.rejects(
          () => createGitHubIssue({ title: "t", body: "b", repo: "not-a-slug", repoRoot: repoDir }),
          /Invalid GitHub repo format/,
        ),
      );
      assert.equal(shim.called(), false, "gh must not be called when the repo assertion is malformed");
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("createGitHubIssue throws 'does not match' when repo is a valid but different slug", async () => {
    const { createGitHubIssue } = await import("./lib.js");
    const shim = ghShim("https://github.com/good/repo/issues/1\n");
    const repoDir = gitRepoWithOrigin("good/repo");
    try {
      await withEnv(shim.binDir, () =>
        assert.rejects(
          () => createGitHubIssue({ title: "t", body: "b", repo: "other/repo", repoRoot: repoDir }),
          /does not match/,
        ),
      );
      assert.equal(shim.called(), false, "gh must not be called on an identity mismatch");
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("createGitHubIssue throws 'cannot resolve' when the checkout has no github origin", async () => {
    const { createGitHubIssue } = await import("./lib.js");
    const shim = ghShim("https://github.com/good/repo/issues/1\n");
    const noGit = nonGitDir();
    const noOrigin = gitRepoNoOrigin();
    try {
      await withEnv(shim.binDir, async () => {
        await assert.rejects(
          () => createGitHubIssue({ title: "t", body: "b", repoRoot: noGit }),
          /cannot resolve/,
        );
        await assert.rejects(
          () => createGitHubIssue({ title: "t", body: "b", repoRoot: noOrigin }),
          /cannot resolve/,
        );
      });
      assert.equal(shim.called(), false, "gh must not be called when identity cannot be resolved");
    } finally {
      shim.cleanup();
      rmSync(noGit, { recursive: true, force: true });
      rmSync(noOrigin, { recursive: true, force: true });
    }
  });

  it("createGitHubIssue ignores a stale process.env.GH_REPO and pins the REST path to the checkout origin", async () => {
    const { createGitHubIssue } = await import("./lib.js");
    const shim = ghShim('{"number":1,"html_url":"https://github.com/good/repo/issues/1"}');
    const repoDir = gitRepoWithOrigin("good/repo");
    try {
      const result = await withEnv(
        shim.binDir,
        () => createGitHubIssue({ title: "t", body: "b", repoRoot: repoDir }),
        { ghRepo: "evil/evil" },
      );
      assert.equal(result.number, 1);
      assert.ok(shim.called(), "gh should have been invoked");
      const argv = shim.argv();
      // REST issue creation (issue #1584): the repository is pinned in the endpoint path.
      assert.deepEqual(argv.slice(0, 4), ["api", "--method", "POST", "/repos/good/repo/issues"]);
      assert.doesNotMatch(argv.join(" "), /evil\/evil/, "GH_REPO must never leak into the gh argv");
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("getOwnerRepo(dir, {allowGhFallback:false}) rejects for a git repo with no origin remote", async () => {
    const { getOwnerRepo } = await import("./lib.js");
    const noOrigin = gitRepoNoOrigin();
    try {
      await assert.rejects(
        () => getOwnerRepo(noOrigin, { allowGhFallback: false }),
        /refusing to fall back/,
      );
    } finally {
      rmSync(noOrigin, { recursive: true, force: true });
    }
  });

  it("getIssueContext returns a warning (never throws) when cwd is omitted", async () => {
    const { getIssueContext } = await import("./lib.js");
    const result = await getIssueContext(5, undefined);
    assert.equal(result.number, 5);
    assert.match(result.warning, /no checkout path/);
  });

  it("getIssueContext returns a warning when the repo assertion is malformed", async () => {
    const { getIssueContext } = await import("./lib.js");
    const shim = ghShim('{"number":5}');
    const repoDir = gitRepoWithOrigin("good/repo");
    try {
      const result = await withEnv(shim.binDir, () =>
        getIssueContext(5, "not-a-slug", { cwd: repoDir }),
      );
      assert.equal(result.number, 5);
      assert.match(result.warning, /Invalid GitHub repo format/);
      assert.equal(shim.called(), false, "gh must not be called on a malformed repo assertion");
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("getIssueContext returns a warning when the repo assertion mismatches the checkout", async () => {
    const { getIssueContext } = await import("./lib.js");
    const shim = ghShim('{"number":5}');
    const repoDir = gitRepoWithOrigin("good/repo");
    try {
      const result = await withEnv(shim.binDir, () =>
        getIssueContext(5, "other/repo", { cwd: repoDir }),
      );
      assert.equal(result.number, 5);
      assert.match(result.warning, /does not match/);
      assert.equal(shim.called(), false, "gh must not be called on an identity mismatch");
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("getIssueContext returns the REST issue and pins the path to the checkout, ignoring GH_REPO", async () => {
    const { getIssueContext } = await import("./lib.js");
    const shim = ghShim('{"number":5,"title":"x","body":"y"}');
    const repoDir = gitRepoWithOrigin("good/repo");
    try {
      const result = await withEnv(
        shim.binDir,
        () => getIssueContext(5, undefined, { cwd: repoDir }),
        { ghRepo: "evil/evil" },
      );
      assert.deepEqual(result, { number: 5, title: "x", body: "y" });
      assert.ok(shim.called(), "gh should have been invoked");
      const argv = shim.argv();
      // REST issue read (issue #1584): the repository is pinned in the endpoint path.
      assert.deepEqual(argv, ["api", "/repos/good/repo/issues/5"]);
      assert.doesNotMatch(argv.join(" "), /evil\/evil/, "GH_REPO must never leak into the gh argv");
    } finally {
      shim.cleanup();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("parseGroundControlYaml rejects a malformed github_repo", async () => {
    const { parseGroundControlYaml: parse } = await import("./lib.js");
    const result = parse("schema_version: 1\nproject: x\ngithub_repo: not-a-slug\n");
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes("github_repo")),
      `expected a github_repo error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it("parseGroundControlYaml accepts a well-formed github_repo", async () => {
    const { parseGroundControlYaml: parse } = await import("./lib.js");
    const result = parse("schema_version: 1\nproject: x\ngithub_repo: autarchy-ai/Ground-Control\n");
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    assert.equal(result.value.github_repo, "autarchy-ai/Ground-Control");
  });
});

// ---------------------------------------------------------------------------
// Ground Control context helpers
// ---------------------------------------------------------------------------

describe("buildGroundControlContextSnippet", () => {
  it("renders a pointer section for AGENTS.md that references .ground-control.yaml", () => {
    const snippet = buildGroundControlContextSnippet();
    assert.ok(snippet.includes("## Ground Control Context"));
    assert.ok(snippet.includes(".ground-control.yaml"));
    assert.ok(snippet.includes("gc_get_repo_ground_control_context"));
  });
});

describe("buildSuggestedGroundControlYaml", () => {
  it("renders a starter yaml with schema_version and project", () => {
    const yaml = buildSuggestedGroundControlYaml("aces-sdl");
    assert.ok(yaml.includes("schema_version: 1"));
    assert.ok(yaml.includes("project: aces-sdl"));
    assert.ok(yaml.includes("workflow:"));
    assert.ok(yaml.includes("sonarcloud:"));
    assert.ok(yaml.includes("rules:"));
  });
});

describe("resolveWorkflowPolicyCommand", () => {
  it("returns the configured repository policy command", () => {
    assert.equal(
      resolveWorkflowPolicyCommand({ workflow: { policy_command: "bin/gate --ci" } }),
      "bin/gate --ci",
    );
  });

  it("falls back to the default for a context that does not carry the field", () => {
    // Guards against a context shape older than issue #1429 (or a hand-built
    // test double) silently disabling the gate.
    assert.equal(resolveWorkflowPolicyCommand({ workflow: {} }), DEFAULT_POLICY_COMMAND);
    assert.equal(resolveWorkflowPolicyCommand({}), DEFAULT_POLICY_COMMAND);
    assert.equal(resolveWorkflowPolicyCommand(null), DEFAULT_POLICY_COMMAND);
  });

  it("never resolves to an empty command", () => {
    assert.equal(
      resolveWorkflowPolicyCommand({ workflow: { policy_command: "   " } }),
      DEFAULT_POLICY_COMMAND,
    );
  });
});

describe("implementGateEnvironment (#1434)", () => {
  const base = Object.freeze({ PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0" });

  it("injects the requested requirement UID without dropping the base environment", () => {
    const env = implementGateEnvironment("DSL-437", base);
    assert.equal(env[REQUIREMENT_UID_GATE_ENV_VAR], "DSL-437");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  });

  it("strips ambient requirement context when no UID is requested", () => {
    const ambient = Object.freeze({
      ...base,
      [REQUIREMENT_UID_GATE_ENV_VAR]: "GC-STALE",
    });
    for (const absent of [undefined, null, ""]) {
      const env = implementGateEnvironment(absent, ambient);
      assert.equal(REQUIREMENT_UID_GATE_ENV_VAR in env, false);
      assert.deepEqual(env, base);
      assert.equal(ambient[REQUIREMENT_UID_GATE_ENV_VAR], "GC-STALE");
    }
  });

  it("refuses a UID that is not a bounded requirement identifier", () => {
    for (const hostile of ["DSL-437; rm -rf /", "$(id)", "a".repeat(51), "-leading"]) {
      assert.throws(
        () => implementGateEnvironment(hostile, base),
        (error) => error.code === "implement_requested_requirement_uid_invalid",
        `expected refusal for ${hostile}`,
      );
    }
  });
});

describe("resolveWorkflowPrecommitCommand / runImplementPreCommit", () => {
  function recordingRunner() {
    const calls = [];
    return {
      calls,
      runner: async (...args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      },
    };
  }

  it("runs the repository's configured pre-commit command", async () => {
    const { calls, runner } = recordingRunner();
    await runImplementPreCommit("/repo", runner, {
      workflow: { precommit_command: "lefthook run pre-commit" },
    });
    assert.equal(calls[0][0], "bash");
    assert.deepEqual(calls[0][1], ["-c", "lefthook run pre-commit"]);
    assert.equal(calls[0][2].cwd, "/repo");
  });

  it("defaults to the pre-commit framework invocation", async () => {
    const { calls, runner } = recordingRunner();
    await runImplementPreCommit("/repo", runner, { workflow: {} });
    assert.equal(DEFAULT_PRECOMMIT_COMMAND, "pre-commit run --hook-stage pre-commit");
    assert.deepEqual(calls[0][1], ["-c", DEFAULT_PRECOMMIT_COMMAND]);
  });

  it("keeps the hardened Git environment the boundary already used", async () => {
    const { calls, runner } = recordingRunner();
    await runImplementPreCommit("/repo", runner, { workflow: {} });
    assert.ok(calls[0][2].env, "pre-commit must keep its sanitized environment");
  });

  it("never resolves to an empty command", () => {
    assert.equal(
      resolveWorkflowPrecommitCommand({ workflow: { precommit_command: "  " } }),
      DEFAULT_PRECOMMIT_COMMAND,
    );
    assert.equal(resolveWorkflowPrecommitCommand(null), DEFAULT_PRECOMMIT_COMMAND);
  });

  it("carries the requested requirement UID to the pre-commit gate (#1434)", async () => {
    const { calls, runner } = recordingRunner();
    await runImplementPreCommit("/repo", runner, { workflow: {} }, "DSL-437");
    assert.equal(calls[0][2].env[REQUIREMENT_UID_GATE_ENV_VAR], "DSL-437");
    assert.equal(
      calls[0][2].env.GIT_TERMINAL_PROMPT,
      "0",
      "the hardened Git environment must survive the UID injection",
    );
  });

  it("leaves the pre-commit gate environment alone when no UID is requested", async () => {
    const { calls, runner } = recordingRunner();
    await runImplementPreCommit("/repo", runner, { workflow: {} });
    assert.equal(REQUIREMENT_UID_GATE_ENV_VAR in calls[0][2].env, false);
  });
});
