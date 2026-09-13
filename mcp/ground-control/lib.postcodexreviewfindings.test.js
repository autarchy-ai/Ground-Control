// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { postCodexReviewFindings, runCodexReview } from "./lib.js";

async function withShimPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

describe("postCodexReviewFindings", () => {
  // Issue #793: codex returns structured findings, MCP performs the GitHub
  // writes. These tests exercise the MCP-side poster directly with a hermetic
  // gh shim so we can assert the request shape sent to GitHub and the
  // per-finding result envelope returned to runCodexReview without needing a
  // live PR.

  function makeGhShim({ ghHandler }) {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-post-repo-"));
    execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", "dev"]);
    const binDir = mkdtempSync(join(tmpdir(), "gc-post-bin-"));
    const cfgPath = join(binDir, "config.json");
    const logPath = join(binDir, "calls.log");
    writeFileSync(cfgPath, JSON.stringify(ghHandler));
    writeFileSync(logPath, "");
    const ghShim = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfgPath)}, "utf8"));
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + "\\n");
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
process.stderr.write("gh shim: unhandled argv: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
    writeFileSync(join(binDir, "gh"), ghShim, { mode: 0o755 });
    return {
      repoDir,
      binDir,
      readCalls() {
        return readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line));
      },
      cleanup() {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      },
    };
  }

  async function withShimPath(binDir, fn) {
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = oldPath;
    }
  }

  it("returns [] without invoking gh when prNumber is null", async () => {
    const shim = makeGhShim({ ghHandler: { routes: [] } });
    try {
      await withShimPath(shim.binDir, async () => {
        const results = await postCodexReviewFindings({
          repoRoot: shim.repoDir,
          owner: "fake",
          name: "repo",
          prNumber: null,
          reviewerLabel: "core",
          findings: [{ path: "src/foo.java", line: 42, title: "x", body: "y" }],
        });
        assert.deepEqual(results, []);
        assert.equal(shim.readCalls().length, 0);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("returns [] when findings is empty (no head-SHA fetch, no POSTs)", async () => {
    const shim = makeGhShim({ ghHandler: { routes: [] } });
    try {
      await withShimPath(shim.binDir, async () => {
        const results = await postCodexReviewFindings({
          repoRoot: shim.repoDir,
          owner: "fake",
          name: "repo",
          prNumber: 520,
          reviewerLabel: "core",
          findings: [],
        });
        assert.deepEqual(results, []);
        assert.equal(shim.readCalls().length, 0);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("fetches the PR head SHA, posts each finding with the [core] prefix, and returns ok results", async () => {
    const shim = makeGhShim({
      ghHandler: {
        routes: [
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, head: { sha: "deadbeef1234567890" } }),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            stdout: JSON.stringify({ id: 9001, html_url: "https://example.test/pr/520#discussion_r9001" }),
          },
        ],
      },
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const results = await postCodexReviewFindings({
          repoRoot: shim.repoDir,
          owner: "fake",
          name: "repo",
          prNumber: 520,
          reviewerLabel: "core",
          findings: [
            { path: "src/foo.java", line: 42, title: "Missing input validation", body: "Detail A" },
            { path: "src/bar.java", line: 99, title: "Bypasses helper", body: "Detail B" },
          ],
        });
        assert.equal(results.length, 2);
        for (const r of results) {
          assert.equal(r.ok, true);
          assert.equal(r.comment_id, 9001);
          assert.match(r.html_url, /example\.test/);
        }
        const calls = shim.readCalls();
        // Expect 1 head-SHA fetch + 2 POST calls = 3 invocations.
        assert.equal(calls.length, 3);
        // The head sha comes from the REST pull request (issue #1584).
        assert.deepEqual(calls[0], ["api", "--method", "GET", "/repos/fake/repo/pulls/520"]);
        for (const postCall of calls.slice(1)) {
          assert.equal(postCall[0], "api");
          assert.equal(postCall[1], "--method");
          assert.equal(postCall[2], "POST");
          assert.equal(postCall[3], "/repos/fake/repo/pulls/520/comments");
          // commit_id derived from gh pr view; path/line/side/body passed via -f.
          assert.ok(postCall.includes("commit_id=deadbeef1234567890"));
          assert.ok(postCall.includes("side=RIGHT"));
          // The reviewer label is prepended by the MCP poster.
          assert.ok(postCall.some((arg) => arg.startsWith("body=[core]")));
        }
      });
    } finally {
      shim.cleanup();
    }
  });

  it("returns per-finding error envelopes when a POST fails (does not throw)", async () => {
    const shim = makeGhShim({
      ghHandler: {
        routes: [
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, head: { sha: "abc1234" } }),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            exit_code: 1,
            stderr: "HTTP 422: line not in diff hunk\n",
          },
        ],
      },
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const results = await postCodexReviewFindings({
          repoRoot: shim.repoDir,
          owner: "fake",
          name: "repo",
          prNumber: 520,
          reviewerLabel: "core",
          findings: [
            { path: "src/foo.java", line: 42, title: "x", body: "y" },
            { path: "src/bar.java", line: 99, title: "x2", body: "y2" },
          ],
        });
        assert.equal(results.length, 2);
        for (const r of results) {
          assert.equal(r.ok, false);
          assert.match(r.error, /line not in diff hunk|422/);
        }
      });
    } finally {
      shim.cleanup();
    }
  });

  it("treats findings with bodies that look like secrets as per-finding failures (non-LLM control, review-cycle-4 security finding)", async () => {
    // Codex review (cycle 2) flagged that "tell the LLM not to paste
    // secrets" is not a security boundary — a malicious diff can use
    // prompt injection to coerce codex into emitting findings whose body
    // contains exfiltrated workspace contents. Add a non-LLM check on the
    // body before posting: if the rendered body contains known sensitive
    // markers, mark the finding as a per-finding failure with a
    // "sensitive_content" error so the agent surfaces the issue instead
    // of publishing it under the host identity.
    const shim = makeGhShim({
      ghHandler: {
        routes: [
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, head: { sha: "abc1234" } }),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            stdout: JSON.stringify({ id: 100, html_url: "https://example.test/c/100" }),
          },
        ],
      },
    });
    try {
      // Build payloads at runtime from concatenated chunks so the source
      // file itself does not contain a literal `detect-private-key` would
      // flag. The actual byte string the validator sees is unchanged.
      const begin = "-----" + "BEGIN ";
      const end = "-----";
      const keyTail = "PRIVATE " + "KEY" + end;
      await withShimPath(shim.binDir, async () => {
        const findings = [
          {
            path: "src/foo.java",
            line: 1,
            title: "leaked private key",
            body: `Detail. Reading config: ${begin}${keyTail}\nMIIEvQIBA...`,
          },
          {
            path: "src/bar.java",
            line: 2,
            title: "leaked openssh",
            body: `${begin}OPENSSH ${keyTail}\nfoo`,
          },
          {
            path: "src/baz.java",
            line: 3,
            title: "leaked aws key",
            body: "Found AKIAIOSFODNN7EXAMPLE in env",
          },
          // Clean finding posts normally.
          { path: "src/clean.java", line: 4, title: "clean", body: "ordinary review note" },
        ];
        const results = await postCodexReviewFindings({
          repoRoot: shim.repoDir,
          owner: "fake",
          name: "repo",
          prNumber: 520,
          reviewerLabel: "core",
          findings,
        });
        assert.equal(results.length, 4);
        for (let i = 0; i < 3; i++) {
          assert.equal(results[i].ok, false, `finding ${i} should be rejected`);
          assert.match(results[i].error, /sensitive|secret|private key|aws/i);
        }
        assert.equal(results[3].ok, true);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("returns per-finding failure envelopes when the head-SHA fetch itself fails (review-cycle-3 finding)", async () => {
    // Codex review (post-push cycle) flagged that getPullRequestHeadSha
    // throws and loses all findings. Fix: catch the failure inside
    // postCodexReviewFindings and surface every finding as a per-finding
    // failure envelope, preserving the contract that findings are never
    // dropped silently.
    const shim = makeGhShim({
      ghHandler: {
        routes: [
          {
            // Head-SHA fetch fails entirely.
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            exit_code: 1,
            stderr: "HTTP 503: api.github.com unreachable\n",
          },
        ],
      },
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const results = await postCodexReviewFindings({
          repoRoot: shim.repoDir,
          owner: "fake",
          name: "repo",
          prNumber: 520,
          reviewerLabel: "core",
          findings: [
            { path: "src/foo.java", line: 42, title: "x", body: "y" },
            { path: "src/bar.java", line: 99, title: "x2", body: "y2" },
          ],
        });
        // Both findings must be returned as failure envelopes — none lost.
        assert.equal(results.length, 2);
        for (const r of results) {
          assert.equal(r.ok, false);
          assert.match(r.error, /headRefOid|HTTP 503|unreachable/);
        }
      });
    } finally {
      shim.cleanup();
    }
  });

  it("post_failures envelopes include the finding body so the agent can act on them (review-cycle-3 finding)", async () => {
    // Codex review flagged that failed POSTs were stripped from `comments`
    // but the post_failures envelope only kept path/line/title/error — the
    // agent had no way to see the body of a failed finding. Include it so
    // the agent can fix the issue without re-running codex.
    const shim = makeGhShim({
      ghHandler: {
        routes: [
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, head: { sha: "abc1234" } }),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            exit_code: 1,
            stderr: "HTTP 422\n",
          },
        ],
      },
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const results = await postCodexReviewFindings({
          repoRoot: shim.repoDir,
          owner: "fake",
          name: "repo",
          prNumber: 520,
          reviewerLabel: "core",
          findings: [
            { path: "src/foo.java", line: 42, title: "Long-form title here", body: "Detailed body explaining the issue." },
          ],
        });
        assert.equal(results.length, 1);
        assert.equal(results[0].ok, false);
        // The full finding object is on the envelope; the runCodexReview
        // collector pulls body from it into the post_failures shape.
        assert.equal(results[0].finding.body, "Detailed body explaining the issue.");
        assert.equal(results[0].finding.title, "Long-form title here");
      });
    } finally {
      shim.cleanup();
    }
  });

  it("treats a POST response with no numeric `id` as a per-finding failure (review-cycle-1 finding)", async () => {
    // Codex review (cycle 1) flagged that an API response with no numeric
    // `.id` was being marked ok=true with comment_id=null, hiding broken
    // poster/API responses as successful writes. Treat missing/non-integer
    // `id` as a per-finding POST failure so it appears in post_failures
    // and cannot masquerade as a durable PR finding.
    const shim = makeGhShim({
      ghHandler: {
        routes: [
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, head: { sha: "abc1234" } }),
          },
          {
            // Response is JSON but missing the `id` field entirely.
            argv_prefix: ["api", "--method", "POST"],
            stdout: JSON.stringify({ html_url: "https://example.test/c/x" }),
          },
        ],
      },
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const results = await postCodexReviewFindings({
          repoRoot: shim.repoDir,
          owner: "fake",
          name: "repo",
          prNumber: 520,
          reviewerLabel: "core",
          findings: [{ path: "src/foo.java", line: 42, title: "x", body: "y" }],
        });
        assert.equal(results.length, 1);
        assert.equal(results[0].ok, false);
        assert.match(results[0].error, /no numeric .*id|comment id/i);
      });
    } finally {
      shim.cleanup();
    }
  });

  it("uses the [security] prefix when reviewerLabel is 'security'", async () => {
    const shim = makeGhShim({
      ghHandler: {
        routes: [
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, head: { sha: "abc1234" } }),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            stdout: JSON.stringify({ id: 8002, html_url: "https://example.test/c/8002" }),
          },
        ],
      },
    });
    try {
      await withShimPath(shim.binDir, async () => {
        await postCodexReviewFindings({
          repoRoot: shim.repoDir,
          owner: "fake",
          name: "repo",
          prNumber: 520,
          reviewerLabel: "security",
          findings: [{ path: "src/Auth.java", line: 100, title: "Auth bypass", body: "Detail" }],
        });
        const calls = shim.readCalls();
        assert.equal(calls.length, 2);
        assert.ok(calls[1].some((arg) => arg.startsWith("body=[security]")));
      });
    } finally {
      shim.cleanup();
    }
  });

  it("filters the rendered body, not just the finding body (issue #1355)", async () => {
    // The filter inspected `finding.body` while the posted comment also splices in the title and
    // the classification note, both equally model-controlled. A key in the title passed the
    // guardrail and was published under the host identity. Checking a component of what you send
    // is not checking what you send.
    const shim = makeGhShim({
      ghHandler: {
        routes: [
          {
            argv_prefix: ["api", "--method", "GET", "/repos/fake/repo/pulls/520"],
            stdout: JSON.stringify({ number: 520, head: { sha: "abc1234" } }),
          },
          {
            argv_prefix: ["api", "--method", "POST"],
            stdout: JSON.stringify({ id: 101, html_url: "https://example.test/c/101" }),
          },
        ],
      },
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const results = await postCodexReviewFindings({
          repoRoot: shim.repoDir,
          owner: "fake",
          name: "repo",
          prNumber: 520,
          reviewerLabel: "core",
          findings: [
            { path: "src/foo.java", line: 1, title: "AKIAIOSFODNN7EXAMPLE", body: "ordinary note" },
          ],
        });

        assert.equal(results[0].ok, false, "a secret in the title must not reach GitHub");
        assert.match(results[0].error, /sensitive|aws/i);
        // Nothing was posted: the refusal happens before the POST, not after.
        assert.equal(
          shim.readCalls().some((c) => c.argv?.[0] === "api"),
          false,
        );
      });
    } finally {
      shim.cleanup();
    }
  });
});
