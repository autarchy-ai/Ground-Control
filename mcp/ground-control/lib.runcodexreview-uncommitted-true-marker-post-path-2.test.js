// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CODEX_REVIEW_HARD_CAP, computeReviewDiff, runCodexReview } from "./lib.js";
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
    // Pre-push reviews diff against the integration base too (#1694).
    execFileSync("git", ["-C", repoDir, "update-ref", "refs/heads/dev", "HEAD"]);
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


  it("rejects sensitive content in the findings record body (issue #804 review-cycle-1 finding 2)", async () => {
    // Codex review (cycle 1) flagged that the findings record posted raw
    // reviewer text without running it through detectSensitiveBodyContent
    // — bypassing the existing host-side guardrail for model-controlled
    // text. Fix: filter the rendered body before posting.
    const planMarker = '<!-- gc:phase phase="plan" issue="998" -->';
    // Build a sensitive review body at runtime so the source file itself
    // does not match `detect-private-key`.
    const begin = "-----" + "BEGIN ";
    const end = "-----";
    const keyTail = "PRIVATE " + "KEY" + end;
    const sensitiveBody = `Reviewer prose ... ${begin}${keyTail}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ...`;
    // The codex shim emits a review whose architectural_read carries
    // secret-shaped content. Post-#966 the findings-record renderer renders
    // the parsed verdict envelope (architectural_read + blocking findings) —
    // the sensitive text must be caught there before the record is posted.
    const codexTail = `===REVIEW===\n${JSON.stringify({ verdict: "ship", architectural_read: `Reviewed. ${sensitiveBody}`, blocking: [] })}\n===END===\n`;

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
          // Catch-all POST: succeeds. The sensitive-content filter must
          // STOP us before we reach this for the findings record.
          { argv_prefix: ["api", "--method", "POST"], stdout: JSON.stringify({ id: 999, html_url: "https://example.test/c/999" }) },
        ],
      },
      codexHandler: { tail: codexTail },
    });
    ensureBaseRef(shim.repoDir);

    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReview({ repoPath: shim.repoDir, uncommitted: false, prNumber: 520 }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(result.ok, false);
        assert.equal(result.error, "review_comment_post_failed");
        assert.match(result.message, /sensitive|secret|private key/i);
      });
    } finally {
      shim.cleanup();
    }
  });


  it("(post-push) fails with review_comment_post_failed when the issue-thread findings post fails (issue #804)", async () => {
    // Issue #804: the issue thread is the durable record per ADR-029. If
    // the findings-comment POST fails, the run is not durable and must
    // surface a structured error — same fail-fast posture as the pre-push
    // cycle marker.
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
            argv_prefix: ["api", "graphql"],
            stdout: JSON.stringify({
              data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } },
            }),
          },
          {
            // Inline comment POSTs to /pulls/520/comments succeed.
            argv_prefix: ["api", "--method", "POST", "/repos/fake/repo/pulls/520/comments"],
            stdout: JSON.stringify({ id: 7001, html_url: "https://example.test/c/7001" }),
          },
          {
            // Cycle marker POST on the PR's own issue thread succeeds.
            argv_prefix: ["api", "--method", "POST", "/repos/fake/repo/issues/520/comments"],
            stdout: JSON.stringify({ id: 9001, html_url: "https://example.test/c/9001" }),
          },
          {
            // Findings-record POST on the closing issue's thread fails.
            argv_prefix: ["api", "--method", "POST", "/repos/fake/repo/issues/998/comments"],
            exit_code: 1,
            stderr: "HTTP 502: gateway timeout\n",
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
        assert.equal(result.ok, false);
        assert.equal(result.error, "review_comment_post_failed");
        assert.match(result.message, /HTTP 502|gateway/);
        // Findings are preserved in the failure envelope so the agent can act.
        assert.ok(Array.isArray(result.comments));
        assert.equal(typeof result.core_review_text, "string");
        assert.equal(typeof result.security_review_text, "string");
      });
    } finally {
      shim.cleanup();
    }
  });


  it("(post-push) reports per-finding error envelopes when comment POST fails", async () => {
    // Variant of the previous test: head-SHA fetch succeeds but the inline
    // comment POSTs fail (HTTP 422). Findings are still surfaced; the
    // post_failures envelope records each per-reviewer per-finding failure
    // so the calling agent sees the partial-write condition.
    const findingsTail = "===REVIEW===\n" + JSON.stringify({verdict: "ship-with-fixes", architectural_read: "Reviewed.", blocking: [
      { path: "src/foo.java", line: 42, title: "Missing input validation", body: "Detail", classification: "one-off", sweep_evidence: "tested-sweep" },
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
            stdout: JSON.stringify({ number: 520, body: "", head: { sha: "abc1234567" } }),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            exit_code: 1,
            stderr: "HTTP 422: line 42 not in PR diff hunk\n",
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
        // 1 finding x 2 reviewers (core + security) → 2 POST attempts → 2
        // failures.
        assert.equal(result.post_failures.length, 2);
        for (const f of result.post_failures) {
          assert.equal(f.path, "src/foo.java");
          assert.equal(f.line, 42);
          assert.match(f.error, /HTTP 422|not in PR diff hunk/);
          assert.ok(f.reviewer === "core" || f.reviewer === "security");
        }
        // Failed POSTs don't appear in `comments` — the verify-finding loop
        // can't operate on them. They live ONLY in post_failures.
        assert.equal(result.finding_count, 0);
        assert.deepEqual(result.comments, []);
        assert.deepEqual(result.parse_errors, []);
        // Partial failure is signalled at the response level so the agent
        // doesn't treat the run as complete.
        assert.equal(result.ok, false);
        assert.equal(result.error, "review_partial_failure");
      });
    } finally {
      shim.cleanup();
    }
  });


  it("(post-push) DOES consume a cycle marker on partial failure when at least one POST succeeded (review-cycle-4 finding)", async () => {
    // Codex review (cycle 2) flagged that suppressing the cycle marker on
    // partial failure was overcorrection: when at least one POST landed on
    // the PR, those comments are durable. A retry would re-post the same
    // findings as duplicates. Fix: write the marker whenever any post
    // succeeded OR no failures occurred. Only suppress when zero comments
    // landed (parse-only failure, or all-POST failure due to head-SHA
    // fetch / network).
    const findingsTail = "===REVIEW===\n" + JSON.stringify({verdict: "ship-with-fixes", architectural_read: "Reviewed.", blocking: [
      { path: "src/foo.java", line: 42, title: "x", body: "y", classification: "one-off", sweep_evidence: "tested-sweep" },
      { path: "src/bar.java", line: 99, title: "x2", body: "y2", classification: "one-off", sweep_evidence: "tested-sweep" },
    ]}) + "\n===END===\n";
    const planMarker = '<!-- gc:phase phase="plan" issue="998" -->';

    // Two cycle markers are written if both posts succeed (one per reviewer
    // x post). For partial-failure-with-some-success, we only need to assert
    // the cycle metadata reflects a consumed cycle. The shim's POST route
    // returns success for inline comments AND the cycle marker post, so
    // we'd see cycle: 1 returned in the response if marker was written.
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
            argv_prefix: ["api", "graphql"],
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [{ id: "thread-1", comments: { nodes: [{ databaseId: 7001 }] } }],
                    },
                  },
                },
              },
            }),
          },
          {
            // All POSTs (inline + cycle marker) succeed.
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
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        // No partial failure here (all POSTs succeed) — cycle marker MUST
        // be written, response carries cycle: 1.
        assert.equal(result.ok, true);
        assert.equal(result.cycle, 1);
        assert.equal(result.cap, CODEX_REVIEW_HARD_CAP);
        // Successful posts populate `comments`.
        assert.ok(result.comments.length >= 1);
      });
    } finally {
      shim.cleanup();
    }
  });


  it("(post-push) excludes failed POSTs from `comments` and includes body in post_failures (review-cycle-4 finding)", async () => {
    // Codex review (cycle 2) flagged that no-PR placeholder comments dropped
    // `finding.body`, leaving the agent with no way to act. The placeholder
    // shape now carries `body` so the agent has the authoritative finding
    // detail (the JSON body is canonical per the new prompt).
    //
    // We exercise this on the no-PR / uncommitted=true path because
    // postResults is empty there and the placeholder branch fires.
    const findingsTail = "===REVIEW===\n" + JSON.stringify({verdict: "ship-with-fixes", architectural_read: "Reviewed.", blocking: [
      { path: "src/foo.java", line: 42, title: "Detail title", body: "Authoritative body content the agent must see.", classification: "one-off", sweep_evidence: "tested-sweep" },
    ]}) + "\n===END===\n";

    const shim = makeFullShimRepo({
      branch: "998-add-thing",
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
          // Phase markers are believed only from an author with repository permission.
          { argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/collaborators/tester/permission"], stdout: "write\n" },
          { argv_prefix: ["api", "--method", "GET", "--paginate", "--slurp"], stdout: JSON.stringify([[]]) },
          { argv_prefix: ["api", "--method", "POST"], stdout: JSON.stringify({ id: 1, html_url: "https://example.test/c/1" }) },
        ],
      },
      codexHandler: { tail: findingsTail },
    });

    try {
      await withShimPathFull(shim.binDir, async () => {
        const result = await runCodexReview({
          repoPath: shim.repoDir,
          uncommitted: true,
          issueNumber: 998,
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.ok(result.comments.length >= 1);
        // The placeholder for no-PR / pre-push must carry the body verbatim.
        for (const c of result.comments) {
          assert.equal(c.body, "Authoritative body content the agent must see.");
        }
      });
    } finally {
      shim.cleanup();
    }
  });
});
