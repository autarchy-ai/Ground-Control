// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CODEX_REVIEW_PREPUSH_HARD_CAP, computeReviewDiff, runCodexReview } from "./lib.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

describe("runCodexReview uncommitted=true marker-post path (hermetic codex+gh shims)", () => {
  // These tests exercise the post-codex marker-write path. Codex is shimmed to
  // emit a clean ===REVIEW===\n{...verdict:ship...}\n===END=== tail (clean review). gh is shimmed for the
  // entire flow: repo view, paginated slurped comments read, and the issue-
  // comment POST (the marker write). Test 1 succeeds the POST; Test 2 fails
  // the POST and asserts the prepush_cycle_record_failed envelope shape.

  function makeFullShimRepo({ branch, ghHandler, codexHandler }) {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-fullshim-repo-"));
    execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", branch]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
    writeFileSync(join(repoDir, "README"), "x\n");
    execFileSync("git", ["-C", repoDir, "add", "README"]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
    // Real origin so owner/repo resolves from the git remote, as production does. git ignores
    // GH_REPO; the `gh repo view` fallback honours it.
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);

    const binDir = mkdtempSync(join(tmpdir(), "gc-fullshim-bin-"));
    const ghCfgPath = join(binDir, "gh-config.json");
    const ghStatePath = join(binDir, "gh-state.json");
    writeFileSync(ghCfgPath, JSON.stringify(ghHandler));
    writeFileSync(ghStatePath, JSON.stringify({ counters: {} }));
    // The shim supports two route kinds:
    //   - simple: { argv_prefix, stdout?, exit_code?, stderr? } — same response every call.
    //   - sequenced: { argv_prefix, sequenced: true, sequence: [{stdout?, exit_code?, stderr?}, ...] }
    //     Each invocation that matches the prefix consumes the next sequence
    //     entry; once exhausted, the last entry is reused. The counter is
    //     keyed by the route's argv_prefix joined with "|" and persisted in
    //     a JSON state file so successive process invocations can advance.
    const ghShim = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(ghCfgPath)}, "utf8"));
const statePath = ${JSON.stringify(ghStatePath)};
const argv = process.argv.slice(2);
function match(prefix) { return prefix.every((p, i) => argv[i] === p); }
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return { counters: {} }; }
}
function writeState(state) { fs.writeFileSync(statePath, JSON.stringify(state)); }
for (const route of cfg.routes) {
  if (match(route.argv_prefix)) {
    let entry = route;
    if (route.sequenced === true && Array.isArray(route.sequence) && route.sequence.length > 0) {
      const key = route.argv_prefix.join("|");
      const state = readState();
      const idx = state.counters[key] || 0;
      const seqEntry = route.sequence[Math.min(idx, route.sequence.length - 1)];
      state.counters[key] = idx + 1;
      writeState(state);
      entry = seqEntry;
    }
    if (entry.exit_code != null && entry.exit_code !== 0) {
      process.stderr.write(entry.stderr || "");
      process.exit(entry.exit_code);
    }
    process.stdout.write(entry.stdout || "");
    process.exit(0);
  }
}
process.stderr.write("gh shim: unhandled argv: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
    writeFileSync(join(binDir, "gh"), ghShim, { mode: 0o755 });

    // codex shim: parses --output-last-message <path>, writes the canned tail
    // to that path AND to stdout, drains stdin so the prompt pipe doesn't
    // SIGPIPE, then exits 0.
    const codexCfgPath = join(binDir, "codex-config.json");
    writeFileSync(codexCfgPath, JSON.stringify(codexHandler));
    const codexShim = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(codexCfgPath)}, "utf8"));
const args = process.argv.slice(2);
let outputPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output-last-message") outputPath = args[i + 1];
}
let stdinBuf = "";
process.stdin.on("data", (chunk) => { stdinBuf += chunk.toString(); });
process.stdin.on("end", () => {
  const tail = cfg.tail || "**Findings**\\n\\nNo issues found.\\n\\n===REVIEW===\\n{\\"verdict\\":\\"ship\\",\\"architectural_read\\":\\"Reviewed.\\",\\"blocking\\":[]}\\n===END===\\n";
  if (outputPath) fs.writeFileSync(outputPath, tail);
  process.stdout.write(tail);
  process.exit(cfg.exit_code || 0);
});
`;
    writeFileSync(join(binDir, "codex"), codexShim, { mode: 0o755 });

    return {
      repoDir,
      binDir,
      cleanup() {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      },
    };
  }

  async function withShimPathFull(binDir, fn) {
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = oldPath;
    }
  }

  // Helper: post-push reviews compute diffs against a base ref
  // (`origin/dev`, `dev`, `origin/main`, `main`); the makeFullShimRepo helper
  // only creates the feature branch. Create a `dev` ref pointing at the
  // initial commit so computeReviewDiff resolves.
  function ensureBaseRef(repoDir) {
    execFileSync("git", ["-C", repoDir, "update-ref", "refs/heads/dev", "HEAD"]);
  }


  it("(post-push) does NOT consume a review cycle marker when the run is a partial failure (review-cycle-3 finding)", async () => {
    // Codex review (post-push cycle) flagged that the cycle marker is
    // posted before partialFailure is computed, so a parse or POST failure
    // burns one of the two capped cycles even though the run returned
    // ok=false. Don't write the cycle marker on partial failure — partial
    // failures are not "completed" reviews.
    const planMarker = '<!-- gc:phase phase="plan" issue="998" -->';
    const sentinel = "MARKER_POSTED_SENTINEL";

    const shim = makeFullShimRepo({
      branch: "998-add-thing",
      ghHandler: {
        routes: [
          {
            argv_prefix: ["repo", "view", "--json", "nameWithOwner"],
            stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
          },
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, body: "Closes #998", head: { sha: "abc1234" } }),
          },
          {
            // Phase markers are believed only from an author with repository permission.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"],
            stdout: "write\n",
          },
          {
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: JSON.stringify([[{ id: 1, body: planMarker, user: { login: "tester" } }]]),
          },
          {
            // Marker POSTs are routed here. The sentinel lets the test fail
            // loudly if a marker post is attempted.
            argv_prefix: ["api", "--method", "POST"],
            stdout: JSON.stringify({ id: 999, html_url: `https://example.test/c/${sentinel}` }),
          },
        ],
      },
      // Codex emits malformed output (no FINDINGS block) → parse_errors
      // populated → partial failure → cycle marker MUST NOT be posted.
      codexHandler: { tail: "Findings as prose only.\n(no tail block)\n" },
    });
    ensureBaseRef(shim.repoDir);

    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: false,
          prNumber: 520,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        // Confirm the boundary failure was detected and signalled. Since
        // #1414 an unparseable reviewer envelope means a review slice
        // produced no judgment, so the run reports incomplete coverage
        // rather than a completed-but-partially-published review.
        assert.equal(result.ok, false);
        assert.equal(result.error, "review_coverage_incomplete");
        assert.equal(result.review_coverage.chunks_completed, 0);
        assert.equal(result.review_coverage.complete, false);
        // The cycle marker must NOT have been posted on partial failure.
        // The post route would have returned the sentinel id; check that
        // the response carries no evidence of a marker post (the cycle
        // marker would have been counted by the next invocation).
        // We can't observe gh calls directly, but the response should
        // carry cycle: null because we deliberately don't claim a cycle
        // for a partial-failure run.
        assert.equal(result.cycle, null);
      });
    } finally {
      shim.cleanup();
    }
  });


  it("(post-push) returns ok=false with structured next_action when parse_errors are present (review-cycle-2 finding)", async () => {
    // Codex review (cycle 2) flagged that even with parse_errors populated,
    // runCodexReview returns success-shaped output. The call must signal a
    // structured failure so the agent treats it as such — partial reviewer
    // output is not a complete review.
    const planMarker = '<!-- gc:phase phase="plan" issue="998" -->';

    const shim = makeFullShimRepo({
      branch: "998-add-thing",
      ghHandler: {
        routes: [
          {
            argv_prefix: ["repo", "view", "--json", "nameWithOwner"],
            stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
          },
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, body: "Closes #998", head: { sha: "abc1234" } }),
          },
          {
            // Phase markers are believed only from an author with repository permission.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"],
            stdout: "write\n",
          },
          {
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: JSON.stringify([[{ id: 1, body: planMarker, user: { login: "tester" } }]]),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            stdout: JSON.stringify({ id: 1234, html_url: "https://example.test/c/1234" }),
          },
        ],
      },
      codexHandler: { tail: "Findings:\n- src/foo.java:42 missing validation\n(no tail block)\n" },
    });
    ensureBaseRef(shim.repoDir);

    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: false,
          prNumber: 520,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, false);
        // #1414: a malformed reviewer envelope is a coverage failure — the
        // slice produced no judgment, so no durable record is written and the
        // caller is told to retry rather than to publish partial results.
        assert.equal(result.error, "review_coverage_incomplete");
        assert.equal(result.next_action, "retry_review_after_resolving_coverage_failure");
        assert.equal(result.parse_errors.length, 2);
      });
    } finally {
      shim.cleanup();
    }
  });


  it("(post-push) excludes failed POSTs from `comments` and returns ok=false (review-cycle-2 finding)", async () => {
    // Codex review (cycle 2) flagged that failed POSTs were surfaced in the
    // verifiable `comments` list with comment_id=null, even though the
    // verify-finding loop cannot operate on them. The contract: `comments`
    // contains only successfully-posted findings; post failures live ONLY in
    // post_failures, and the response is ok=false so the agent doesn't treat
    // the run as complete.
    const findingsTail = "===REVIEW===\n" + JSON.stringify({verdict: "ship-with-fixes", architectural_read: "Reviewed.", blocking: [
      { path: "src/foo.java", line: 42, title: "x", body: "y", classification: "one-off", sweep_evidence: "tested-sweep" },
    ]}) + "\n===END===\n";
    const planMarker = '<!-- gc:phase phase="plan" issue="998" -->';

    const shim = makeFullShimRepo({
      branch: "998-add-thing",
      ghHandler: {
        routes: [
          {
            argv_prefix: ["repo", "view", "--json", "nameWithOwner"],
            stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
          },
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, body: "Closes #998", head: { sha: "abc1234" } }),
          },
          {
            // Phase markers are believed only from an author with repository permission.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"],
            stdout: "write\n",
          },
          {
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: JSON.stringify([[{ id: 1, body: planMarker, user: { login: "tester" } }]]),
          },
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, body: "", head: { sha: "abc1234" } }),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            exit_code: 1,
            stderr: "HTTP 422\n",
          },
        ],
      },
      codexHandler: { tail: findingsTail },
    });
    ensureBaseRef(shim.repoDir);

    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: false,
          prNumber: 520,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        // post_failures is the source of truth for failed POSTs.
        assert.equal(result.post_failures.length, 2);
        // comments contains ONLY successfully-posted findings (none here).
        assert.equal(result.comments.length, 0);
        assert.equal(result.finding_count, 0);
        assert.equal(result.ok, false);
        assert.equal(result.error, "review_partial_failure");
      });
    } finally {
      shim.cleanup();
    }
  });


  it("(post-push) does NOT signal proceed_clean when parse_errors are present (review-cycle-1 finding)", async () => {
    // Codex review (cycle 1) flagged that parseReviewerTailSafely silently
    // converts parse failures to zero findings, then comments.length===0
    // forces next_action to "proceed_clean". That lets a malformed reviewer
    // output advance the workflow as if it were clean. When parse_errors is
    // populated, the next_action must NOT be proceed_clean — the review is
    // not durable.
    const planMarker = '<!-- gc:phase phase="plan" issue="998" -->';

    const shim = makeFullShimRepo({
      branch: "998-add-thing",
      ghHandler: {
        routes: [
          {
            argv_prefix: ["repo", "view", "--json", "nameWithOwner"],
            stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
          },
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, body: "Closes #998", head: { sha: "abc1234" } }),
          },
          {
            // Phase markers are believed only from an author with repository permission.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"],
            stdout: "write\n",
          },
          {
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: JSON.stringify([[{ id: 1, body: planMarker, user: { login: "tester" } }]]),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            stdout: JSON.stringify({ id: 1234, html_url: "https://example.test/c/1234" }),
          },
        ],
      },
      // Codex emits prose only — NO ===REVIEW===…===END=== block. The safe
      // parser captures the parse failure into parse_errors but returns 0
      // findings.
      codexHandler: { tail: "Findings:\n- src/foo.java:42 missing validation\n(no tail block)\n" },
    });
    ensureBaseRef(shim.repoDir);

    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: false,
          prNumber: 520,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        // parse_errors carries one entry per reviewer that failed to parse
        // (both core and security reviewers see the same malformed tail).
        assert.equal(result.parse_errors.length, 2);
        // The signal must NOT be proceed_clean — there's no proof the review
        // was actually clean.
        assert.notEqual(result.next_action, "proceed_clean");
      });
    } finally {
      shim.cleanup();
    }
  });


  it("returns prepush_cycle_record_failed when the marker POST fails", async () => {
    // Per #804 review-cycle-1 finding 1, the findings record now posts
    // BEFORE the cycle marker. To exercise the marker-fail path: first
    // POST (findings record) succeeds; second POST (cycle marker) fails.
    const shim = makeFullShimRepo({
      branch: "796-x",
      ghHandler: {
        routes: [
          {
            argv_prefix: ["repo", "view", "--json", "nameWithOwner"],
            stdout: JSON.stringify({ nameWithOwner: "fake/repo" }),
          },
          {
            // Phase markers are believed only from an author with repository permission.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"],
            stdout: "write\n",
          },
          {
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: JSON.stringify([[]]),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            sequenced: true,
            sequence: [
              { stdout: JSON.stringify({ id: 999, html_url: "https://example.test/c/findings" }) },
              { exit_code: 1, stderr: "HTTP 500: simulated server error\n" },
            ],
          },
        ],
      },
      codexHandler: { tail: "Clean review.\n\n===REVIEW===\n{\"verdict\":\"ship\",\"architectural_read\":\"Reviewed.\",\"blocking\":[]}\n===END===\n" },
    });

    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, false);
        assert.equal(result.error, "prepush_cycle_record_failed");
        assert.equal(result.next_action, "fix_underlying_marker_post_failure_and_retry");
        assert.equal(result.issue_number, 796);
        assert.equal(result.branch, "796-x");
        assert.equal(result.attempted_cycle, 1);
        assert.equal(result.cap, CODEX_REVIEW_PREPUSH_HARD_CAP);
        // Findings preserved (codex output was clean, so 0 here, but the
        // shape includes the comments array).
        assert.equal(result.finding_count, 0);
        assert.deepEqual(result.comments, []);
        assert.match(result.cycle_record_error, /HTTP 500|simulated/);
      });
    } finally {
      shim.cleanup();
    }
  });
});
