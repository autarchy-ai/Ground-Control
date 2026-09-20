// Split from gc-assert-completion.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runAssertCompletion } from "./lib.js";
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
  hostedChecks = [{ name: "tests", status: "completed", conclusion: "success" }],
  commentIdSeq = [9500, 9501, 9502],
  prNumber = 42,
  prMerged = true,
  publishedReview = true,
  permissions = {
    fake: "write",
    "other-collaborator": "write",
    automation: "write",
    "repository-owner": "admin",
  },
} = {}) {
  if (publishedReview) {
    const provenance = `schema="gc.review-publication/v1" publication="${"a".repeat(64)}" original="${"b".repeat(64)}" revision="${"c".repeat(64)}" sanitized="${"d".repeat(64)}"`;
    comments = [...comments,
      { id: 8997, user: { login: "fake" }, author_association: "OWNER", body: `<!-- gc:review-publication stage="findings" reviewer="codex" issue="963" cycle="1" ${provenance} -->\n\n**gc_codex_review** — sanitized deferred publication` },
      { id: 8998, user: { login: "fake" }, author_association: "OWNER", body: `<!-- gc:codex-prepush-cycle issue="963" branch="x" cycle="1" ${provenance} -->\n\n_gc_codex_review pre-push cycle 1 complete` },
      { id: 8999, user: { login: "fake" }, author_association: "OWNER", body: `<!-- gc:decision-record reviewer="codex" cycle="1" issue="963" ${provenance} -->\n\n## Review decision record — codex cycle 1` },
    ];
  }
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
  process.stdout.write(JSON.stringify([{ check_runs: ${JSON.stringify(hostedChecks)} }])); process.exit(0);
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

// ---------------------------------------------------------------------------
// Test 7: post_merge merge gate — unmerged PR → completion_pr_not_merged,
// no assertions run, no final report (issue #963)
// ---------------------------------------------------------------------------

describe("runAssertCompletion — post_merge refuses when PR not merged", () => {
  it("returns ok:false completion_pr_not_merged, empty assertions, final_report null", async () => {
    // PR #42 is linked but NOT merged (state OPEN, mergedAt null).
    const shim = makeCompletionShimRepo({ comments: [], prMerged: false });
    try {
      const r = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 963,
          prNumber: 42,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
          ciStatus: "green",
          sonarStatus: "skipped",
          plainEnglishOutcome: "Moves Phase D reconciliation post-merge.",
          // phase defaults to post_merge
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "completion_pr_not_merged");
      assert.equal(r.pr_state, "OPEN");
      assert.equal(r.pr_merged_at, null);
      assert.equal(r.next_action, "wait_for_user_to_merge_the_pr");
      assert.ok(Array.isArray(r.assertions));
      assert.equal(r.assertions.length, 0, "no assertions should run before the merge gate passes");
      assert.equal(r.final_report, null);
    } finally {
      shim.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: pre_merge readiness — posts ready-for-review record, no merge gate,
// only the published-review evidence assertion (issue #963; ADR-089 §2
// removed the GRC pre-merge assertion).
// ---------------------------------------------------------------------------

describe("runAssertCompletion — pre_merge readiness report", () => {
  it("returns ok:true phase:pre_merge with readiness_report and published-review evidence", async () => {
    // No traceability markers and an UNMERGED PR. pre_merge must still succeed:
    // it skips the merge gate and every reconciliation assertion.
    const shim = makeCompletionShimRepo({ comments: [], prMerged: false });
    try {
      const r = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 963,
          prNumber: 42,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
          ciStatus: "green",
          sonarStatus: "skipped",
          plainEnglishOutcome: "Ready for review; reconciliation runs on merge.",
          phase: "pre_merge",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(r.ok, true, `expected ok:true; got: ${JSON.stringify(r)}`);
      assert.equal(r.phase, "pre_merge");
      assert.ok(Array.isArray(r.assertions));
      assert.deepEqual(r.assertions, [{
        name: "codex_review_published",
        ok: true,
        comment_id: 8999,
      }]);
      assert.equal(r.final_report, null);
      assert.ok(r.readiness_report != null);
      assert.ok(typeof r.readiness_report.comment_url === "string");
    } finally {
      shim.cleanup();
    }
  });

  it("refuses an unpublished local review before posting readiness", async () => {
    const shim = makeCompletionShimRepo({ comments: [], prMerged: false, publishedReview: false });
    try {
      const r = await withShimPath(shim.binDir, () => runAssertCompletion({
        repoPath: shim.repoDir,
        issueNumber: 963,
        prNumber: 42,
        requirements: [],
        reviews: [{ reviewer: "codex", summary: "retained locally" }],
        ciStatus: "green",
        sonarStatus: "skipped",
        plainEnglishOutcome: "Ready for review.",
        phase: "pre_merge",
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }));
      assert.equal(r.ok, false);
      assert.equal(r.error, "completion_review_publication_missing");
      assert.equal(r.next_action, "publish_the_retained_review_or_run_the_automatic_review_cycle");
    } finally {
      shim.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 9: pre_merge still enforces the CI-green gate (gate parity, issue #963)
// ---------------------------------------------------------------------------

describe("runAssertCompletion — pre_merge enforces CI-green gate", () => {
  it("returns ok:false final_report_ci_not_green when CI is red", async () => {
    const shim = makeCompletionShimRepo({ comments: [] });
    try {
      const r = await withShimPath(shim.binDir, () =>
        runAssertCompletion({
          repoPath: shim.repoDir,
          issueNumber: 963,
          prNumber: 42,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
          ciStatus: "red",
          sonarStatus: "skipped",
          plainEnglishOutcome: "Ready for review; reconciliation runs on merge.",
          phase: "pre_merge",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }),
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "final_report_ci_not_green");
      assert.equal(r.final_report, null);
    } finally {
      shim.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 10: buildFinalReport pre_merge emits ready_for_review marker + heading,
// post_merge emits gc:final-report marker (issue #963)
// ---------------------------------------------------------------------------

describe("buildFinalReport — phase-aware marker and heading", () => {
  it("pre_merge renders ready_for_review phase marker and 'Ready for review' heading; post_merge renders final-report marker", async () => {
    const { buildFinalReport } = await import("./lib.js");
    const base = {
      issueNumber: 963,
      prNumber: 42,
      requirements: [],
      reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
      ciStatus: "green",
      sonarStatus: "skipped",
      plainEnglishOutcome: "Moves Phase D reconciliation post-merge.",
    };
    const pre = buildFinalReport({ ...base, phase: "pre_merge" });
    assert.ok(pre.includes(`<!-- gc:phase phase="ready_for_review" issue="963" -->`), pre);
    assert.ok(pre.includes("## Ready for review — issue #963"), pre);
    assert.ok(!pre.includes("<!-- gc:final-report"), "pre_merge must NOT carry the final-report marker");
    // Phase E validates and reports; it does not reconcile. The readiness record claimed
    // the #963 ordering until issue #1671 corrected it (#1541 moved both edits into the
    // delivery diff), so the record must not promise post-merge requirement mutation.
    assert.ok(pre.includes("Phase E validates the merged requirement state"), pre);
    assert.ok(!/reconciliation run[s]? in Phase E/.test(pre), pre);

    const post = buildFinalReport({ ...base, phase: "post_merge" });
    assert.ok(post.includes(`<!-- gc:final-report issue="963" pr="42" -->`), post);
    assert.ok(post.includes("## Final report — issue #963 complete"), post);
    assert.ok(!post.includes("ready_for_review"), "post_merge must NOT carry the readiness marker");
  });
});

describe("runAssertCompletion — open execution obligations block readiness", () => {
  it("refuses before posting a pre-merge readiness record", async () => {
    const marker =
      '<!-- gc:execution-obligation schema="gc.implement.execution-obligation/v1" ' +
      'issue="1416" id="OB-SECURITY" event="opened" -->';
    const shim = makeCompletionShimRepo({
      comments: [{ body: marker, user: { login: "fake" }, author_association: "OWNER" }],
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
      assert.deepEqual(result.open_obligation_ids, ["OB-SECURITY"]);
      assert.equal(result.next_action, "fix_and_resolve_open_obligations_then_retry");
      assert.equal(result.final_report, null);
    } finally {
      shim.cleanup();
    }
  });
});


describe("current-head hosted readiness", () => {
  for (const [name, hostedChecks] of [
    ["missing", []],
    ["pending", [{ name: "tests", status: "in_progress", conclusion: null }]],
    ["failed", [{ name: "tests", status: "completed", conclusion: "failure" }]],
  ]) {
    it(`refuses ${name} required checks despite a caller claiming green`, async () => {
      const shim = makeCompletionShimRepo({ prMerged: false, hostedChecks });
      try {
        const result = await withShimPath(shim.binDir, () => runAssertCompletion({
          repoPath: shim.repoDir, issueNumber: 963, prNumber: 42,
          requirements: [], reviews: [{ reviewer: "codex", summary: "clean" }],
          ciStatus: "green", sonarStatus: "skipped", phase: "pre_merge",
          plainEnglishOutcome: "Ready for review.",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) }));
        assert.equal(result.ok, false);
        assert.equal(result.error, "completion_hosted_checks_not_green");
        assert.equal(result.final_report, null);
      } finally {
        shim.cleanup();
      }
    });
  }
});
