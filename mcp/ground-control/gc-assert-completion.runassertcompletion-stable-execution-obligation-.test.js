// Split from gc-assert-completion.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runAssertCompletion, runPostFinalReport } from "./lib.js";
import { restPullRequest } from "./github-rest.test-helpers.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers (mirrored from gc-grc-reconciled.test.js)
// ---------------------------------------------------------------------------

const GH_NAME_WITH_OWNER = "nameWithOwner";

function initGitRepo(dir) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README"), "x\n");
  execFileSync("git", ["-C", dir, "add", "README"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  // Real origin so owner/repo resolves from the git remote, as production does. git ignores
  // GH_REPO; the `gh repo view` fallback honours it.
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
  return dir;
}

function buildGhRouteShimSource(configPath) {
  return String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
const argv = process.argv.slice(2);
function match(prefix) { return prefix.every((p, i) => argv[i] === p); }
for (const route of cfg.routes) {
  if (match(route.argv_prefix)) {
    if (route.exit_code != null && route.exit_code !== 0) {
      process.stderr.write(route.stderr || "");
      process.exit(route.exit_code);
    }
    process.stdout.write(route.stdout || "");
    process.exit(0);
  }
}
process.stderr.write("gh shim: unhandled argv: " + JSON.stringify(argv) + "\n");
process.exit(2);
`;
}

function makeRouteShimRepo({ ghHandler, repoPrefix, binPrefix }) {
  const repoDir = initGitRepo(mkdtempSync(join(tmpdir(), repoPrefix)));
  const binDir = mkdtempSync(join(tmpdir(), binPrefix));
  const configPath = join(binDir, "config.json");
  writeFileSync(configPath, JSON.stringify(ghHandler));
  writeFileSync(join(binDir, "gh"), buildGhRouteShimSource(configPath), { mode: 0o755 });
  return {
    repoDir, binDir,
    cleanup() { rmSync(repoDir, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); },
  };
}

async function withShimPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

// `gh api --paginate --slurp` wraps each page's comments array in an outer array.
function slurpComments(comments) {
  return JSON.stringify([comments]);
}

// Make a shim repo for runAssertCompletion tests. Handles MULTIPLE POST calls
// (traceability_reconciled marker, grc_reconciled marker, final report comment).
// All POST routes return the same response since makeRouteShimRepo uses
// first-match — the shim finds the "api --method POST" route and uses it
// for every POST call.
function makeCompletionShimRepo({
  comments = [],
  commentIdSeq = [9500, 9501, 9502],
  prNumber = 42,
  prMerged = true,
  permissions = {
    fake: "write",
    "other-collaborator": "write",
    automation: "write",
    "repository-owner": "admin",
  },
} = {}) {
  // We need to handle multiple POSTs. Use a counter in a wrapper script.
  // Build a shim that cycles through commentIdSeq for each POST call.
  const repoDir = initGitRepo(mkdtempSync(join(tmpdir(), "gc-completion-shim-")));
  const binDir = mkdtempSync(join(tmpdir(), "gc-completion-bin-"));
  const counterPath = join(binDir, "counter.json");
  writeFileSync(counterPath, JSON.stringify({ index: 0, ids: commentIdSeq }));

  // The post_merge completion path resolves the linked PR from the issue's REST timeline and the
  // PR's REST record, and gates on it being merged (issues #963, #1584).
  const restPull = restPullRequest({
    number: prNumber,
    state: prMerged ? "MERGED" : "OPEN",
    mergedAt: prMerged ? "2026-06-22T02:00:00Z" : null,
  });

  const configPath = join(binDir, "config.json");
  const ghHandler = {
    restPull,
    routes: [
      {
        argv_prefix: ["api", "user", "--jq", ".login"],
        stdout: "fake\n",
      },
      {
        argv_prefix: ["repo", "view", "--json", GH_NAME_WITH_OWNER],
        stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
      },
      {
        // Phase markers are believed only from an author with repository permission.
        argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"],
        stdout: "write\n",
      },
      {
        argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
        stdout: slurpComments(comments),
      },
    ],
  };
  writeFileSync(configPath, JSON.stringify(ghHandler));

  // Custom gh shim that handles multiple POSTs with sequential comment IDs
  const shimSource = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
const counterData = JSON.parse(fs.readFileSync(${JSON.stringify(counterPath)}, "utf8"));
const permissions = ${JSON.stringify(permissions)};
const argv = process.argv.slice(2);
function match(prefix) { return prefix.every((p, i) => argv[i] === p); }

// Handle POST specially with counter
if (argv[0] === "api" && argv[1] === "--method" && argv[2] === "POST") {
  const idx = counterData.index;
  const id = counterData.ids[idx] ?? (9500 + idx);
  counterData.index = idx + 1;
  fs.writeFileSync(${JSON.stringify(counterPath)}, JSON.stringify(counterData));
  process.stdout.write(JSON.stringify({ id, html_url: "https://github.com/fake/repo/issues/1103#issuecomment-" + id }));
  process.exit(0);
}
// REST linked-PR resolution: the issue timeline cross-references the PR, then the PR's record.
const restPath = argv.find((a) => typeof a === "string" && a.startsWith("/repos/fake/repo/")) || "";
if (/\\/issues\\/\\d+\\/timeline/.test(restPath)) {
  process.stdout.write(JSON.stringify([[{ event: "cross-referenced", source: { issue: { number: cfg.restPull.number, pull_request: {}, repository: { full_name: "fake/repo" } } } }]]));
  process.exit(0);
}
if (/\\/pulls\\/\\d+$/.test(restPath)) {
  process.stdout.write(JSON.stringify(cfg.restPull));
  process.exit(0);
}
if (restPath.includes("/protection/required_status_checks")) {
  process.stdout.write(JSON.stringify({ contexts: ["tests"] })); process.exit(0);
}
if (restPath.includes("/check-runs")) {
  process.stdout.write(JSON.stringify([{ check_runs: [{ name: "tests", status: "completed", conclusion: "success" }] }])); process.exit(0);
}
if (restPath.endsWith("/status")) {
  process.stdout.write(JSON.stringify({ statuses: [] })); process.exit(0);
}
const permissionEndpoint = argv.find((arg) => arg.includes("/collaborators/") && arg.endsWith("/permission"));
if (permissionEndpoint) {
  const login = decodeURIComponent(permissionEndpoint.split("/collaborators/")[1].split("/permission")[0]);
  if (permissions[login]) {
    process.stdout.write(permissions[login] + "\\n");
    process.exit(0);
  }
  process.stderr.write("HTTP 404");
  process.exit(1);
}

// Issue-body fetch for runGetIssueThread post-merge scope derivation (issue #1541).
// Empty body → no in-scope requirements → verification is skipped (requirement-free).
if (argv[0] === "api" && typeof argv[1] === "string" && argv[1].startsWith("/repos/fake/repo/issues/") && !argv[1].endsWith("/comments")) {
  process.stdout.write(JSON.stringify({ number: 1, title: "t", body: "", state: "open", html_url: "https://github.com/fake/repo/issues/1", labels: [] }));
  process.exit(0);
}

for (const route of cfg.routes) {
  if (match(route.argv_prefix)) {
    if (route.exit_code != null && route.exit_code !== 0) {
      process.stderr.write(route.stderr || "");
      process.exit(route.exit_code);
    }
    process.stdout.write(route.stdout || "");
    process.exit(0);
  }
}
process.stderr.write("gh shim: unhandled argv: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
  writeFileSync(join(binDir, "gh"), shimSource, { mode: 0o755 });
  return {
    repoDir, binDir,
    cleanup() {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}

describe("runAssertCompletion — stable execution-obligation authority", () => {
  it("retains an obligation opened by a different authorized collaborator", async () => {
    const marker =
      '<!-- gc:execution-obligation schema="gc.implement.execution-obligation/v1" ' +
      'issue="1416" id="OB-COLLABORATOR" event="opened" -->';
    const shim = makeCompletionShimRepo({
      comments: [{
        id: 7001,
        body: marker,
        user: { login: "other-collaborator" },
        author_association: "COLLABORATOR",
      }],
      prMerged: false,
    });
    try {
      const result = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 1416,
          prNumber: 42,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
          ciStatus: "green",
          sonarStatus: "skipped",
          plainEnglishOutcome: "Ready for review.",
          phase: "pre_merge",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(result.ok, false);
      assert.equal(result.error, "completion_open_execution_obligations");
      assert.deepEqual(result.open_obligation_ids, ["OB-COLLABORATOR"]);
    } finally {
      shim.cleanup();
    }
  });

  it("fails closed when a wontfix resolution lacks a verified authorization record", async () => {
    const comments = [
      {
        id: 7001,
        body:
          '<!-- gc:execution-obligation schema="gc.implement.execution-obligation/v1" ' +
          'issue="1416" id="OB-WONTFIX" event="opened" -->',
        user: { login: "fake" },
        author_association: "OWNER",
      },
      {
        id: 7002,
        body:
          '<!-- gc:execution-obligation schema="gc.implement.execution-obligation/v1" ' +
          'issue="1416" id="OB-WONTFIX" event="resolved" disposition="wontfix" -->',
        user: { login: "fake" },
        author_association: "OWNER",
      },
    ];
    const shim = makeCompletionShimRepo({ comments, prMerged: false });
    try {
      const result = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 1416,
          prNumber: 42,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
          ciStatus: "green",
          sonarStatus: "skipped",
          plainEnglishOutcome: "Ready for review.",
          phase: "pre_merge",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(result.ok, false);
      assert.equal(result.error, "execution_obligation_authorization_unverifiable");
    } finally {
      shim.cleanup();
    }
  });

  it("accepts a wontfix resolution bound to a structured authorized record", async () => {
    const comments = [
      {
        id: 6999,
        body: "/ground-control authorize-wontfix OB-WONTFIX",
        user: { login: "repository-owner" },
        author_association: "OWNER",
      },
      {
        id: 7000,
        body:
          '<!-- gc:execution-obligation-authorization ' +
          'schema="gc.implement.execution-obligation-authorization/v1" ' +
          'issue="1416" id="OB-WONTFIX" action="authorize_wontfix" ' +
          'source_comment_id="6999" -->',
        user: { login: "automation" },
        author_association: "MEMBER",
      },
      {
        id: 7001,
        body:
          '<!-- gc:execution-obligation schema="gc.implement.execution-obligation/v1" ' +
          'issue="1416" id="OB-WONTFIX" event="opened" -->',
        user: { login: "automation" },
        author_association: "MEMBER",
      },
      {
        id: 7002,
        body:
          '<!-- gc:execution-obligation schema="gc.implement.execution-obligation/v1" ' +
          'issue="1416" id="OB-WONTFIX" event="resolved" disposition="wontfix" ' +
          'authorization_comment_id="7000" -->',
        user: { login: "automation" },
        author_association: "MEMBER",
      },
    ];
    const shim = makeCompletionShimRepo({ comments, prMerged: false });
    try {
      const result = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 1416,
          prNumber: 42,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
          ciStatus: "green",
          sonarStatus: "skipped",
          plainEnglishOutcome: "Ready for review.",
          phase: "pre_merge",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally {
      shim.cleanup();
    }
  });

  it("does not trust an organization member without effective repository permission", async () => {
    const marker =
      '<!-- gc:execution-obligation schema="gc.implement.execution-obligation/v1" ' +
      'issue="1416" id="OB-OUTSIDER" event="opened" -->';
    const shim = makeCompletionShimRepo({
      comments: [{
        id: 7001,
        body: marker,
        user: { login: "org-member" },
        author_association: "MEMBER",
      }],
      prMerged: false,
      permissions: {},
    });
    try {
      const result = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 1416,
          prNumber: 42,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
          ciStatus: "green",
          sonarStatus: "skipped",
          plainEnglishOutcome: "Ready for review.",
          phase: "pre_merge",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(result.ok, false);
      assert.equal(result.error, "execution_obligation_provenance_unverifiable");
    } finally {
      shim.cleanup();
    }
  });
});

describe("runPostFinalReport — unresolved-work excuses are rejected", () => {
  it("rejects scope/provenance as justification for non-action before posting", async () => {
    const result = await runPostFinalReport({
      repoPath: "/does/not/need/to/exist",
      issueNumber: 1416,
      prNumber: 42,
      requirements: [],
      reviews: [{ reviewer: "codex", summary: "The failure is unrelated, so it will be left unresolved." }],
      ciStatus: "green",
      sonarStatus: "passed",
      plainEnglishOutcome: "The requested workflow hardening is ready.",
      phase: "pre_merge",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "final_report_unresolved_work_excuse");
  });
});
