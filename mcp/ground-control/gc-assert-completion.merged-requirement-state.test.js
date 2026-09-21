// Integration tests for the post-merge requirement-state verification wired into
// runAssertCompletion (issue #1541). These commit real requirement files into a git
// repo, point the mocked merged PR at that commit OID, and confirm the completion
// assertion validates the MERGED tree — not caller-supplied status — before posting a
// final report.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runAssertCompletion } from "./lib.js";
import { restPullRequest } from "./github-rest.test-helpers.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

function reqFile({ id, status, traceability = [] }) {
  const trace = traceability.length > 0 ? ["", "## Traceability", "", ...traceability] : [];
  return [
    "---", `id: ${id}`, `title: "Title of ${id}"`, `status: ${status}`,
    "type: FUNCTIONAL", "priority: MUST", "wave: 1", "---", "",
    `# ${id} — Title`, "", "## Statement", "", "The system shall do the thing.",
    ...trace, "",
  ].join("\n");
}

function commitReqRepo(uid, content) {
  const dir = mkdtempSync(join(tmpdir(), "gc-mrs-int-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  const d = join(dir, "docs", "requirements", uid);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "requirement.md"), content);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "reqs"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
  const oid = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
  return { dir, oid, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A gh shim serving the routes runAssertCompletion(post_merge) touches: owner/repo,
// the REST issue timeline and PR record (PR merged, merge_commit_sha=<oid>, base ref), the issue body
// (with a Requirements section), an empty comments page, and the final-report POST.
function writeGhShim(dir, { oid, issueBody, issueNumber, comments = [] }) {
  // The branch a run works on is named for its issue, and completion binds to the
  // head that was synchronized on it (issue #1679).
  const branchName = `${issueNumber}-branch`;
  const restPull = restPullRequest({
    number: 42, state: "MERGED", mergedAt: "2026-09-03T00:00:00Z", baseRefName: "dev", mergeCommitOid: oid,
    headRefName: branchName,
  });
  const provenance = `schema="gc.review-publication/v2" publication="${"a".repeat(64)}" original="${"b".repeat(64)}" revision="${"c".repeat(64)}" sanitized="${"d".repeat(64)}" tree="${"1".repeat(40)}" findings="0"`;
  const publication = [
    { id: 8997, user: { login: "fake" }, author_association: "OWNER", body: `<!-- gc:review-publication stage="findings" reviewer="codex" issue="${issueNumber}" cycle="1" ${provenance} -->\n\n**gc_codex_review** — sanitized deferred publication` },
    { id: 8998, user: { login: "fake" }, author_association: "OWNER", body: `<!-- gc:codex-prepush-cycle issue="${issueNumber}" branch="${branchName}" cycle="1" ${provenance} -->\n\n_gc_codex_review pre-push cycle 1 complete` },
    { id: 8996, user: { login: "fake" }, author_association: "OWNER", body: `<!-- gc:implement-base-sync schema="gc.implement.remote-base-sync/v2" record="${"4".repeat(32)}" issue="${issueNumber}" branch="${branchName}" base="dev" source="refs/remotes/origin/dev" pre="${"e".repeat(40)}" fetched="${"f".repeat(40)}" outcome="merged_clean" result="${"a".repeat(40)}" verified="${"5".repeat(40)}" settled="${"1".repeat(40)}" review="${"a".repeat(64)}" revision="${"c".repeat(64)}" lane="implement" -->` },
    { id: 8999, user: { login: "fake" }, author_association: "OWNER", body: `<!-- gc:decision-record reviewer="codex" cycle="1" issue="${issueNumber}" ${provenance} -->\n\n## Review decision record — codex cycle 1` },
  ];
  const cfg = { oid, issueBody, issueNumber, restPull, comments: [...comments, ...publication] };
  const cfgPath = join(dir, "cfg.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const src = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfgPath)}, "utf8"));
const argv = process.argv.slice(2);
const has = (s) => argv.includes(s);
if (argv[0] === "api" && argv[1] === "user") { process.stdout.write("fake\\n"); process.exit(0); }
if (argv[0] === "repo" && argv[1] === "view") { process.stdout.write(JSON.stringify({ nameWithOwner: "fake/repo" })); process.exit(0); }
const restPath = argv.find((a) => typeof a === "string" && a.startsWith("/repos/fake/repo/")) || "";
if (/\\/issues\\/\\d+\\/timeline/.test(restPath)) { process.stdout.write(JSON.stringify([[{ event: "cross-referenced", source: { issue: { number: 42, pull_request: {}, repository: { full_name: "fake/repo" } } } }]])); process.exit(0); }
if (/\\/pulls\\/\\d+$/.test(restPath)) { process.stdout.write(JSON.stringify(cfg.restPull)); process.exit(0); }
if (argv[0] === "api" && argv[1] === "--method" && argv[2] === "POST") { process.stdout.write(JSON.stringify({ id: 9001, html_url: "https://github.com/fake/repo/issues/" + cfg.issueNumber + "#issuecomment-9001" })); process.exit(0); }
const permEndpoint = argv.find((a) => typeof a === "string" && a.includes("/collaborators/") && a.endsWith("/permission"));
if (permEndpoint) { process.stdout.write("write\\n"); process.exit(0); }
if (argv[0] === "api" && has("--paginate") && has("--slurp")) { process.stdout.write(JSON.stringify([cfg.comments])); process.exit(0); }
if (argv[0] === "api" && typeof argv[1] === "string" && argv[1].startsWith("/repos/fake/repo/issues/") && !argv[1].endsWith("/comments")) {
  process.stdout.write(JSON.stringify({ number: cfg.issueNumber, title: "t", body: cfg.issueBody, state: "open", html_url: "https://github.com/fake/repo/issues/" + cfg.issueNumber, labels: [] }));
  process.exit(0);
}
process.stderr.write("gh shim unhandled: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
  writeFileSync(join(dir, "gh"), src, { mode: 0o755 });
}

async function withPath(binDir, fn) {
  const old = process.env.PATH;
  process.env.PATH = `${binDir}:${old}`;
  try { return await fn(); } finally { process.env.PATH = old; }
}

const ISSUE_BODY_WITH_REQ = "## Requirements\n\n- GC-X001 — the requirement\n";
const BASE_INPUT = {
  issueNumber: 1541,
  prNumber: 42,
  reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
  ciStatus: "green",
  sonarStatus: "skipped",
  plainEnglishOutcome: "Verifies merged requirement state before completion.",
};

describe("runAssertCompletion post_merge — merged requirement-state verification", () => {
  it("REGRESSION: a merged DRAFT requirement cannot produce an ACTIVE final report", async () => {
    const repo = commitReqRepo("GC-X001", reqFile({
      id: "GC-X001", status: "DRAFT",
      traceability: ["- IMPLEMENTS → CODE `mcp/ground-control/lib/foo.js` (foo)"],
    }));
    const bin = mkdtempSync(join(tmpdir(), "gc-mrs-bin-"));
    writeGhShim(bin, { oid: repo.oid, issueBody: ISSUE_BODY_WITH_REQ, issueNumber: 1541 });
    try {
      const r = await withPath(bin, () => runAssertCompletion({
        ...BASE_INPUT, repoPath: repo.dir,
        requirements: [{ uid: "GC-X001", title: "Title of GC-X001", status: "ACTIVE" }],
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo.dir) }));
      assert.equal(r.ok, false);
      assert.equal(r.error, "completion_requirement_state_unverified");
      assert.equal(r.final_report, null);
      assert.equal(r.requirement_failures[0].code, "requirement_status_mismatch");
    } finally {
      repo.cleanup();
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("passes when the merged requirement matches the ACTIVE intent with complete traceability", async () => {
    const repo = commitReqRepo("GC-X001", reqFile({
      id: "GC-X001", status: "ACTIVE",
      traceability: [
        "- IMPLEMENTS → CODE `mcp/ground-control/lib/foo.js` (foo)",
        "- TESTS → TEST `mcp/ground-control/foo.test.js` (foo test)",
      ],
    }));
    const bin = mkdtempSync(join(tmpdir(), "gc-mrs-bin-"));
    writeGhShim(bin, { oid: repo.oid, issueBody: ISSUE_BODY_WITH_REQ, issueNumber: 1541 });
    try {
      const r = await withPath(bin, () => runAssertCompletion({
        ...BASE_INPUT, repoPath: repo.dir,
        requirements: [{ uid: "GC-X001", title: "caller-title", status: "ACTIVE" }],
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo.dir) }));
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(r.final_report != null);
    } finally {
      repo.cleanup();
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("refuses when the caller omits an in-scope requirement (scope mismatch)", async () => {
    const repo = commitReqRepo("GC-X001", reqFile({ id: "GC-X001", status: "ACTIVE" }));
    const bin = mkdtempSync(join(tmpdir(), "gc-mrs-bin-"));
    writeGhShim(bin, { oid: repo.oid, issueBody: ISSUE_BODY_WITH_REQ, issueNumber: 1541 });
    try {
      const r = await withPath(bin, () => runAssertCompletion({
        ...BASE_INPUT, repoPath: repo.dir, requirements: [],
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo.dir) }));
      assert.equal(r.ok, false);
      assert.equal(r.error, "completion_scope_mismatch");
      assert.deepEqual(r.missing_from_caller, ["GC-X001"]);
    } finally {
      repo.cleanup();
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("proceeds when a trusted issue-thread override authorizes THIS PR, but a caller flag cannot", async () => {
    const repo = commitReqRepo("GC-X001", reqFile({ id: "GC-X001", status: "DRAFT" }));
    // A repo-write human authorized an override for PR #42 on the issue thread.
    const overrideComment = { body: "gc-authorize-merge-state-override pr=42 corrected out of band", user: { login: "fake" }, author_association: "OWNER" };
    const bin = mkdtempSync(join(tmpdir(), "gc-mrs-bin-"));
    writeGhShim(bin, { oid: repo.oid, issueBody: ISSUE_BODY_WITH_REQ, issueNumber: 1541, comments: [overrideComment] });
    try {
      const r = await withPath(bin, () => runAssertCompletion({
        ...BASE_INPUT, repoPath: repo.dir,
        requirements: [{ uid: "GC-X001", title: "t", status: "ACTIVE" }],
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo.dir) }));
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(r.final_report != null);
    } finally {
      repo.cleanup();
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("does NOT honor a caller-supplied override boolean (a request field is not authorization)", async () => {
    const repo = commitReqRepo("GC-X001", reqFile({ id: "GC-X001", status: "DRAFT" }));
    const bin = mkdtempSync(join(tmpdir(), "gc-mrs-bin-"));
    writeGhShim(bin, { oid: repo.oid, issueBody: ISSUE_BODY_WITH_REQ, issueNumber: 1541 });
    try {
      const r = await withPath(bin, () => runAssertCompletion({
        ...BASE_INPUT, repoPath: repo.dir,
        requirements: [{ uid: "GC-X001", title: "t", status: "ACTIVE" }],
        // A compromised caller cannot bypass by flipping a DTO field.
        override: true, overrideReason: "attacker-supplied reason",
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo.dir) }));
      assert.equal(r.ok, false);
      assert.equal(r.error, "completion_requirement_state_unverified");
      assert.equal(r.final_report, null);
    } finally {
      repo.cleanup();
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
