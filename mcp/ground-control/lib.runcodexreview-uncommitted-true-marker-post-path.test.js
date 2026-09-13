// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CODEX_REVIEW_PREPUSH_HARD_CAP, computeReviewDiff, dedupFindings, runCodexReview } from "./lib.js";

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


  it("returns ok=true with cycle metadata when codex is clean and the marker POST succeeds", async () => {
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
            // Marker POST → success
            argv_prefix: ["api", "--method", "POST"],
            stdout: JSON.stringify({ id: 999, html_url: "https://example.test/c/999" }),
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
        });
        assert.equal(result.uncommitted, true);
        assert.equal(result.issue_number, 796);
        assert.equal(result.branch, "796-x");
        assert.equal(result.cycle, 1);
        assert.equal(result.cap, CODEX_REVIEW_PREPUSH_HARD_CAP);
        assert.equal(result.finding_count, 0);
        // Clean cycle should signal "proceed_clean" — the cap-evaluator's
        // pre-run "fix..." hint is overridden when there are no findings.
        assert.equal(result.next_action, "proceed_clean");
        assert.equal(result.override, false);
        // Issue #793: the new tail format must round-trip cleanly. parse_errors
        // populated would mean the test passed for the wrong reason
        // (silent fallback to zero findings), so assert it explicitly.
        assert.deepEqual(result.parse_errors, []);
        assert.deepEqual(result.post_failures, []);
        // Issue #804: every successful pre-push cycle posts a findings record
        // to the resolved issue thread; its URL surfaces in the response.
        assert.match(result.findings_comment_url, /example\.test/);
      });
    } finally {
      shim.cleanup();
    }
  });


  it("(pre-push) fails with review_comment_post_failed when the issue-thread findings post fails (issue #804)", async () => {
    // Mirror of the post-push failure test for the pre-push path: the issue
    // thread is the durable record per ADR-029, so a failed post must surface
    // a structured error.
    //
    // Pre-push has only one POST surface: the resolved issue thread (used
    // by both the new findings record AND the cycle marker). Per #804
    // review-cycle-1 finding 1 the findings record posts FIRST; a failure
    // there must NOT consume a cycle (no marker is written). Sequence the
    // shim so the first POST attempt fails — and assert the marker was
    // never reached by checking that no cycle is recorded in the response.
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
            // First POST attempt = findings record → fail.
            // Second POST attempt would have been the cycle marker → must
            // never fire (the run returns the failure envelope first).
            argv_prefix: ["api", "--method", "POST"],
            sequenced: true,
            sequence: [
              { exit_code: 1, stderr: "HTTP 502: gateway timeout\n" },
              { exit_code: 99, stderr: "TEST_FAILURE: cycle marker MUST NOT post after findings record fails\n" },
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
          issueNumber: 796,
        });
        assert.equal(result.ok, false);
        assert.equal(result.error, "review_comment_post_failed");
        assert.match(result.message, /HTTP 502|gateway/);
        // Findings preserved in the failure envelope.
        assert.equal(typeof result.core_review_text, "string");
        assert.equal(typeof result.security_review_text, "string");
      });
    } finally {
      shim.cleanup();
    }
  });


  it("honors an explicit issue_number even when the branch has no numeric prefix", async () => {
    // Strong-assertion replacement for the deleted weak input-gating test:
    // proves that an explicit issue_number is honored when the branch has no
    // numeric prefix that derivation could pick up. End-to-end through to the
    // marker POST so we observe the resolved issue_number in the response.
    const shim = makeFullShimRepo({
      branch: "feature-x", // no leading digits → derivation returns null
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
            stdout: JSON.stringify({ id: 1, html_url: "https://example.test/c/1" }),
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
          issueNumber: 4242,
        });
        // Explicit issue_number is the resolved issue, not derived from
        // "feature-x" (which derivation returns null for).
        assert.equal(result.issue_number, 4242);
        assert.equal(result.branch, "feature-x");
        assert.equal(result.cycle, 1);
        assert.equal(result.finding_count, 0);
        assert.equal(result.next_action, "proceed_clean");
      });
    } finally {
      shim.cleanup();
    }
  });


  it("(post-push) posts each codex finding via MCP and surfaces comment ids", async () => {
    // End-to-end coverage of issue #793: codex emits two findings as a JSON
    // payload, MCP performs the POSTs from the host, the response contains
    // the comment ids and is free of post_failures / parse_errors.
    //
    // The shim accepts a sequence of GitHub interactions:
    //   1. `gh repo view --json nameWithOwner` (resolve owner/name)
    //   2. `gh api ... GET /repos/.../issues/<pr>/comments` (cycle marker counter)
    //   3. REST `GET /repos/<o>/<r>/pulls/<pr>` (plan-gate closing-reference lookup, #1584)
    //   4. `gh api ... GET .../issues/<issue>/comments` (plan phase marker)
    //   5. REST `GET /repos/<o>/<r>/pulls/<pr>` (head-SHA fetch for posting, #1584)
    //   6. N x `gh api --method POST .../pulls/<pr>/comments` (one per finding)
    //   7. `gh api graphql ...` (thread-id enrichment)
    //   8. `gh api --method POST .../issues/<pr>/comments` (cycle marker)
    //
    // Routes are matched by argv prefix in declaration order; the first
    // matching route wins. The comment-marker GET (step 2) and the issue-
    // marker GET (step 4) share the `["api","--method","GET","--paginate"]`
    // prefix and both return empty pages — that's fine, the canned response
    // works for both.
    const findingsTail = "===REVIEW===\n" + JSON.stringify({verdict: "ship-with-fixes", architectural_read: "Reviewed.", blocking: [
      { path: "src/foo.java", line: 42, title: "Missing input validation", body: "Detail A", classification: "one-off", sweep_evidence: "tested-sweep" },
      { path: "src/bar.java", line: 88, title: "Bypasses ScopedRequirementRepository", body: "Detail B", classification: "one-off", sweep_evidence: "tested-sweep" },
    ]}) + "\n===END===\n";
    // Closing-issues fetch is part of the post-push gate; return one closing
    // issue (#998) that has a `plan` phase marker on its thread.
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
            // Closing-issues lookup for the plan-gate.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, body: "Closes #998", head: { sha: "abc1234" } }),
          },
          {
            // Phase markers are believed only from an author with repository permission.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"],
            stdout: "write\n",
          },
          {
            // Comment-thread reads (cycle marker count + plan marker check).
            argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"],
            stdout: JSON.stringify([[{ id: 1, body: planMarker, user: { login: "tester" } }]]),
          },
          {
            // Head-SHA fetch for posting findings.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, body: "", head: { sha: "abc1234567" } }),
          },
          {
            // GraphQL thread-id enrichment.
            argv_prefix: ["api", "graphql"],
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        { id: "thread-1", comments: { nodes: [{ databaseId: 7001 }] } },
                        { id: "thread-2", comments: { nodes: [{ databaseId: 7002 }] } },
                      ],
                    },
                  },
                },
              },
            }),
          },
          {
            // POSTs: inline comment posts AND the cycle marker post both go
            // through `api --method POST`. The cycle marker handler comes
            // after the inline-comment posts in declaration order, but since
            // routing is first-match, both POST shapes hit this single route.
            // That's OK — both POSTs succeed and the response shape is the
            // same (id + html_url).
            argv_prefix: ["api", "--method", "POST"],
            stdout: JSON.stringify({ id: 7001, html_url: "https://example.test/c/7001" }),
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
        });
        assert.equal(result.pr_number, 520);
        assert.deepEqual(result.parse_errors, []);
        assert.deepEqual(result.post_failures, []);
        // Both reviewers (core, security) emit the same two findings against
        // the same shimmed prompt response. dedupFindings keys on path + line +
        // title-prefix; the [core] / [security] title prefixes are different,
        // so the entries don't collapse. Expect 2 findings × 2 reviewers = 4
        // entries.
        assert.equal(result.finding_count, 4);
        const reviewers = new Set(result.comments.map((c) =>
          c.title.startsWith("[core]") ? "core" : c.title.startsWith("[security]") ? "security" : null,
        ));
        assert.deepEqual([...reviewers].sort(), ["core", "security"]);
        for (const c of result.comments) {
          assert.equal(c.comment_id, 7001);
          assert.match(c.html_url, /example\.test/);
        }
        assert.equal(result.cycle, 1);
        // Issue #804: the run also posts a findings record to the resolved
        // issue thread; its URL surfaces in the response so the agent can
        // reference it.
        assert.match(result.findings_comment_url, /example\.test/);
      });
    } finally {
      shim.cleanup();
    }
  });


  it("(post-push) does NOT consume a cycle marker when the issue-thread findings post fails (issue #804 review-cycle-1 finding 1)", async () => {
    // Codex review (cycle 1) flagged the ordering bug: cycle marker was being
    // posted BEFORE the findings record. If the record then fails, the cap
    // counter still ticks — a retry burns a cycle without ever producing the
    // durable record this change is meant to guarantee. Fix the ordering so
    // a failed findings post leaves the cap untouched.
    const planMarker = '<!-- gc:phase phase="plan" issue="998" -->';
    const findingsTail = "===REVIEW===\n" + JSON.stringify({verdict: "ship", architectural_read: "Reviewed.", blocking: []}) + "\n===END===\n";

    const shim = makeFullShimRepo({
      branch: "998-add-thing",
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          { argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"], stdout: JSON.stringify({ number: 520, body: "Closes #998", head: { sha: "abc1234" } }) },
          // Phase markers are believed only from an author with repository permission.
          { argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"], stdout: "write\n" },
          { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: JSON.stringify([[{ id: 1, body: planMarker, user: { login: "tester" } }]]) },
          { argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"], stdout: JSON.stringify({ number: 520, body: "", head: { sha: "abc1234" } }) },
          { argv_prefix: ["api", "graphql"], stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }) },
          // Inline POSTs to /pulls/520/comments succeed.
          { argv_prefix: ["api", "--method", "POST", "/repos/fake/repo/pulls/520/comments"], stdout: JSON.stringify({ id: 7001, html_url: "https://example.test/c/7001" }) },
          // Findings record on /issues/998/comments → fails.
          { argv_prefix: ["api", "--method", "POST", "/repos/fake/repo/issues/998/comments"], exit_code: 1, stderr: "HTTP 502\n" },
          // Cycle marker on /issues/520/comments — must NEVER be reached.
          // If reached, the test fails on the assertion below by detecting
          // any cycle markers on issue 520's thread (the marker route is
          // intentionally unwired so any attempt to post it produces a
          // non-zero exit and the run would surface that error too).
          { argv_prefix: ["api", "--method", "POST", "/repos/fake/repo/issues/520/comments"], exit_code: 99, stderr: "TEST_FAILURE: cycle marker MUST NOT be posted before the findings record fails\n" },
        ],
      },
      codexHandler: { tail: findingsTail },
    });
    ensureBaseRef(shim.repoDir);

    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReview({ repoPath: shim.repoDir, uncommitted: false, prNumber: 520 });
        assert.equal(result.ok, false);
        assert.equal(result.error, "review_comment_post_failed");
        // The cycle was NOT consumed — cycle/cap surface as null so the
        // agent retry doesn't burn a count without the durable record.
        assert.equal(result.cycle, null);
        assert.equal(result.cap, null);
      });
    } finally {
      shim.cleanup();
    }
  });
});
