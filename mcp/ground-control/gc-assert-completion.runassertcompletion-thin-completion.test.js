// Thin post-merge completion contract (issue #1500). Traceability reconciliation is
// retired with the backend: runAssertCompletion no longer runs a server-side
// reconcile assertion, so the post-merge happy path carries an empty assertions[]
// and depends only on the gh/git gates — merge state, open-obligation scrub, and the
// runPostFinalReport gates (CI green, Sonar pass-or-legit-skipped, mandatory Codex
// review). These tests are entirely hermetic: a gh route shim stands in for GitHub
// and there is no backend to mock.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runAssertCompletion } from "./lib.js";
import { restPullRequest } from "./github-rest.test-helpers.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

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

async function withShimPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

// `gh api --paginate --slurp` wraps each page's comments array in an outer array.
function slurpComments(comments) {
  return JSON.stringify([comments]);
}

// Shim repo for runAssertCompletion tests. Handles the issue→PR timeline lookup
// (merge gate), collaborator-permission checks (obligation-marker trust), the
// paginated comment read (obligation scrub), and the final-report POST.
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
  const provenance = `schema="gc.review-publication/v1" publication="${"a".repeat(64)}" original="${"b".repeat(64)}" revision="${"c".repeat(64)}" sanitized="${"d".repeat(64)}"`;
  comments = [...comments,
    { id: 8997, user: { login: "fake" }, author_association: "OWNER", body: `<!-- gc:review-publication stage="findings" reviewer="codex" issue="1103" cycle="1" ${provenance} -->\n\n**gc_codex_review** — sanitized deferred publication` },
    { id: 8998, user: { login: "fake" }, author_association: "OWNER", body: `<!-- gc:codex-prepush-cycle issue="1103" branch="x" cycle="1" ${provenance} -->\n\n_gc_codex_review pre-push cycle 1 complete` },
    { id: 8999, user: { login: "fake" }, author_association: "OWNER", body: `<!-- gc:decision-record reviewer="codex" cycle="1" issue="1103" ${provenance} -->\n\n## Review decision record — codex cycle 1` },
  ];
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
      { argv_prefix: ["api", "user", "--jq", ".login"], stdout: "fake\n" },
      { argv_prefix: ["repo", "view", "--json", GH_NAME_WITH_OWNER], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
      { argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"], stdout: "write\n" },
      { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: slurpComments(comments) },
    ],
  };
  writeFileSync(configPath, JSON.stringify(ghHandler));

  // Custom gh shim that handles multiple POSTs with sequential comment IDs.
  const shimSource = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
const counterData = JSON.parse(fs.readFileSync(${JSON.stringify(counterPath)}, "utf8"));
const permissions = ${JSON.stringify(permissions)};
const argv = process.argv.slice(2);
function match(prefix) { return prefix.every((p, i) => argv[i] === p); }

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

// Shim that always fails for gh calls (used for fail-fast tests).
function makeFailShimRepo() {
  const repoDir = initGitRepo(mkdtempSync(join(tmpdir(), "gc-completion-fail-shim-")));
  const binDir = mkdtempSync(join(tmpdir(), "gc-completion-fail-bin-"));
  const shimSource = `#!/usr/bin/env node
process.stderr.write("gh shim: unexpected call in fail-fast test: " + JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(1);
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

// ---------------------------------------------------------------------------
// Happy path — no in-scope requirements, ci green / sonar skipped, codex review
// present, PR merged → ok:true. The gate records trusted published-review
// evidence without restoring the removed GRC reconciliation assertion.
// ---------------------------------------------------------------------------

describe("runAssertCompletion — thin post-merge happy path", () => {
  it("returns ok:true with published-review evidence and a final report", async () => {
    const shim = makeCompletionShimRepo({ comments: [], commentIdSeq: [9500, 9501, 9502] });
    try {
      const r = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 1103,
          prNumber: 42,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
          ciStatus: "green",
          sonarStatus: "skipped",
          plainEnglishOutcome: "Consolidates Phase D completion into a single tool call.",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(r.ok, true, `expected ok:true; got: ${JSON.stringify(r)}`);
      assert.ok(Array.isArray(r.assertions));
      assert.deepEqual(r.assertions, [{
        name: "codex_review_published",
        ok: true,
        comment_id: 8999,
      }]);
      assert.ok(r.final_report != null);
      assert.ok(typeof r.final_report.comment_url === "string");
    } finally {
      shim.cleanup();
    }
  });

  it("posts the slim quickfix report after merge without review or implement-only outcome", async () => {
    const shim = makeCompletionShimRepo({ comments: [], commentIdSeq: [9510, 9511] });
    try {
      const r = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 1103,
          prNumber: 42,
          lane: "quickfix",
          requirements: [],
          reviews: [],
          ciStatus: "green",
          sonarStatus: "skipped",
          summary: "The bounded quickfix shipped.",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(r.ok, true, `expected ok:true; got: ${JSON.stringify(r)}`);
      assert.equal(r.assertions.length, 0);
      assert.ok(typeof r.final_report.comment_url === "string");
    } finally {
      shim.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed final-report input → early ok:false BEFORE any side effects.
// ---------------------------------------------------------------------------

describe("runAssertCompletion — malformed input early rejection", () => {
  it("returns ok:false with completion_final_report_input_invalid before any gh call", async () => {
    const shim = makeFailShimRepo();
    try {
      const r = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 1103,
          prNumber: -1, // invalid → validateFinalReportInput returns ok:false
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
          ciStatus: "green",
          sonarStatus: "skipped",
          plainEnglishOutcome: "Consolidates Phase D completion into a single tool call.",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "completion_final_report_input_invalid");
      assert.ok(Array.isArray(r.assertions));
      assert.equal(r.assertions.length, 0);
      assert.equal(r.final_report, null);
    } finally {
      shim.cleanup();
    }
  });
});
