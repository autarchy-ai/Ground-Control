// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildReviewAutoDispositionRecord,
  effectiveReviewerCap,
  evaluateAutoDispositionGrant,
  normalizeReviewDispositionConfig,
  parseCodexReviewPrePushCycleMarkers,
  parseGroundControlYaml,
  runCodexReviewCycle,
  runTestQualityReviewCycle,
  verifyAutoDispositionGrant,
} from "./lib.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

async function withShimPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

// Pure helpers shared by the evaluator and verifier tests.
const TRUSTED_LOGIN = "gc-bot";

function grantComment(issue, reviewer, grant, { cap = 1, author = TRUSTED_LOGIN, mode = "authoritative" } = {}) {
  return {
    body: buildReviewAutoDispositionRecord({
      issueNumber: issue,
      reviewer,
      cycle: cap,
      cap,
      mode,
      disposition: "one_more_cycle",
      rationale: "codex high-risk",
      signalsSnapshot: { diff: {} },
      grantNumber: grant,
    }),
    authorLogin: author,
  };
}

function codexCycleComment(issue, cycle, { author = TRUSTED_LOGIN } = {}) {
  // Mirrors the gc:codex-prepush-cycle marker shape parseCodexReviewPrePushCycleMarkers reads.
  const branch = JSON.stringify(`${issue}-x`);
  return {
    body: `<!-- gc:codex-prepush-cycle issue="${issue}" branch="${branch.slice(1, -1)}" cycle="${cycle}" -->`,
    authorLogin: author,
  };
}

describe("normalizeReviewDispositionConfig", () => {
  it("defaults to disabled when absent", () => {
    const r = normalizeReviewDispositionConfig(null);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { enabled: false, mode: "shadow", max_auto_overrides: 1, judge: { enabled: false, model: null } });
  });

  it("rejects an unknown key", () => {
    const r = normalizeReviewDispositionConfig({ bogus: true });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("unknown key")), JSON.stringify(r.errors));
  });

  it("rejects out-of-range max_auto_overrides", () => {
    const r = normalizeReviewDispositionConfig({ max_auto_overrides: 99 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("max_auto_overrides")), JSON.stringify(r.errors));
  });

  it("a malformed present config returns ok:false (not silent defaults)", () => {
    const r = normalizeReviewDispositionConfig({ enabled: "yes", mode: "bogus" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 2, JSON.stringify(r.errors));
  });

  it("accepts a fully-specified valid block", () => {
    const r = normalizeReviewDispositionConfig({
      enabled: true,
      mode: "authoritative",
      max_auto_overrides: 2,
      judge: { enabled: true, model: "claude-sonnet-4-6" },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, {
      enabled: true,
      mode: "authoritative",
      max_auto_overrides: 2,
      judge: { enabled: true, model: "claude-sonnet-4-6" },
    });
  });

  it("flows through parseGroundControlYaml into workflow.review_disposition", () => {
    const yaml = [
      "schema_version: 1",
      "project: x",
      "workflow:",
      "  review_disposition:",
      "    enabled: true",
      "    mode: authoritative",
      "    max_auto_overrides: 2",
      "",
    ].join("\n");
    const result = parseGroundControlYaml(yaml);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.value.workflow.review_disposition.enabled, true);
    assert.equal(result.value.workflow.review_disposition.mode, "authoritative");
    assert.equal(result.value.workflow.review_disposition.max_auto_overrides, 2);
  });

  it("absent review_disposition still returns the disabled default in workflow", () => {
    const result = parseGroundControlYaml("schema_version: 1\nproject: x\n");
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.workflow.review_disposition, {
      enabled: false,
      mode: "shadow",
      max_auto_overrides: 1,
      judge: { enabled: false, model: null },
    });
  });
});

describe("effectiveReviewerCap", () => {
  it("falls back to the module default (1) when no cap is configured", () => {
    assert.equal(effectiveReviewerCap({ codex_review: { pre_push_cap: null } }, "codex"), 1);
    assert.equal(effectiveReviewerCap({ test_quality_review: { pre_push_cap: null } }, "test-quality"), 1);
    assert.equal(effectiveReviewerCap(null, "codex"), 1);
  });

  it("uses the configured per-reviewer cap when set", () => {
    assert.equal(effectiveReviewerCap({ codex_review: { pre_push_cap: 3 } }, "codex"), 3);
    assert.equal(effectiveReviewerCap({ test_quality_review: { pre_push_cap: 2 } }, "test-quality"), 2);
  });
});

describe("evaluateAutoDispositionGrant (pure authorization logic)", () => {
  const authoritative = { enabled: true, mode: "authoritative", max_auto_overrides: 1 };

  it("authorizes a trusted, authoritative, same-boundary, unspent grant", () => {
    const r = evaluateAutoDispositionGrant({
      config: authoritative,
      trustedLogin: TRUSTED_LOGIN,
      authored: [grantComment(7, "codex", 1)],
      issueNumber: 7,
      reviewer: "codex",
      cyclesRun: 1, // only the in-cap cycle has run; the over-cap grant is unspent
      effectiveCap: 1,
    });
    assert.deepEqual(r, { authorized: true, grant_number: 1 });
  });

  it("refuses when current config is shadow mode (record-only)", () => {
    const r = evaluateAutoDispositionGrant({
      config: { enabled: true, mode: "shadow", max_auto_overrides: 1 },
      trustedLogin: TRUSTED_LOGIN,
      authored: [grantComment(7, "codex", 1)],
      issueNumber: 7,
      reviewer: "codex",
      cyclesRun: 1,
      effectiveCap: 1,
    });
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "review_disposition_mode_not_authoritative");
  });

  it("refuses a grant MINTED in shadow mode even after the repo flips to authoritative", () => {
    const r = evaluateAutoDispositionGrant({
      config: authoritative, // current config is authoritative...
      trustedLogin: TRUSTED_LOGIN,
      // ...but the marker itself was issued under shadow mode.
      authored: [grantComment(7, "codex", 1, { mode: "shadow" })],
      issueNumber: 7,
      reviewer: "codex",
      cyclesRun: 1,
      effectiveCap: 1,
    });
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "grant_not_authoritative_mode");
  });

  it("refuses when the grant's cap boundary does not match the effective cap", () => {
    const r = evaluateAutoDispositionGrant({
      config: authoritative,
      trustedLogin: TRUSTED_LOGIN,
      authored: [grantComment(7, "codex", 1, { cap: 2 })], // grant minted against cap 2
      issueNumber: 7,
      reviewer: "codex",
      cyclesRun: 1,
      effectiveCap: 1, // server enforces cap 1 now
    });
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "grant_cap_boundary_mismatch");
  });

  it("refuses when the effective cap cannot be resolved", () => {
    const r = evaluateAutoDispositionGrant({
      config: authoritative,
      trustedLogin: TRUSTED_LOGIN,
      authored: [grantComment(7, "codex", 1)],
      issueNumber: 7,
      reviewer: "codex",
      cyclesRun: 1,
      effectiveCap: null,
    });
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "effective_cap_unresolved");
  });

  it("refuses a grant marker forged by a non-trusted commenter (provenance)", () => {
    const r = evaluateAutoDispositionGrant({
      config: authoritative,
      trustedLogin: TRUSTED_LOGIN,
      authored: [grantComment(7, "codex", 1, { author: "attacker" })],
      issueNumber: 7,
      reviewer: "codex",
      cyclesRun: 1,
      effectiveCap: 1,
    });
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "no_auto_disposition_grant");
  });

  it("refuses when the trusted poster cannot be resolved", () => {
    const r = evaluateAutoDispositionGrant({
      config: authoritative,
      trustedLogin: null,
      authored: [grantComment(7, "codex", 1)],
      issueNumber: 7,
      reviewer: "codex",
      cyclesRun: 1,
      effectiveCap: 1,
    });
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "trusted_poster_unresolved");
  });

  it("refuses once the granted over-cap cycle has already run (single-use)", () => {
    const r = evaluateAutoDispositionGrant({
      config: authoritative,
      trustedLogin: TRUSTED_LOGIN,
      authored: [grantComment(7, "codex", 1)],
      issueNumber: 7,
      reviewer: "codex",
      cyclesRun: 2, // cap=1 boundary + 1 over-cap cycle already ran → grant spent
      effectiveCap: 1,
    });
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "auto_grant_already_consumed");
  });

  it("refuses when grants exceed the ceiling", () => {
    const r = evaluateAutoDispositionGrant({
      config: authoritative,
      trustedLogin: TRUSTED_LOGIN,
      authored: [grantComment(7, "codex", 1), grantComment(7, "codex", 2)],
      issueNumber: 7,
      reviewer: "codex",
      cyclesRun: 1,
      effectiveCap: 1,
    });
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "auto_override_ceiling_exceeded");
  });

  it("refuses when the grant marker carries no cap boundary", () => {
    // Hand-build an authoritative-mode grant marker whose data block omits cap.
    const body =
      '<!-- gc:review-auto-disposition issue="7" reviewer="codex" ' +
      'schema="gc.implement.review-auto-disposition/v1" disposition="one_more_cycle" mode="authoritative" grant="true" -->\n' +
      '<!-- gc:review-auto-disposition-data {"schema":"gc.implement.review-auto-disposition/v1","disposition":"one_more_cycle","reviewer":"codex","cycle":1,"mode":"authoritative","grant":1} -->';
    const r = evaluateAutoDispositionGrant({
      config: authoritative,
      trustedLogin: TRUSTED_LOGIN,
      authored: [{ body, authorLogin: TRUSTED_LOGIN }],
      issueNumber: 7,
      reviewer: "codex",
      cyclesRun: 1,
      effectiveCap: 1,
    });
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "grant_missing_cap_boundary");
  });

  it("refuses when disabled", () => {
    const r = evaluateAutoDispositionGrant({
      config: { enabled: false, mode: "authoritative", max_auto_overrides: 1 },
      trustedLogin: TRUSTED_LOGIN,
      authored: [grantComment(7, "codex", 1)],
      issueNumber: 7,
      reviewer: "codex",
      cyclesRun: 1,
      effectiveCap: 1,
    });
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "review_disposition_disabled");
  });
});

describe("verifyAutoDispositionGrant", () => {
  // Hermetic git repo + PATH-shimmed gh so the comment + identity reads are
  // deterministic. The shim answers `gh api user --jq .login` with the trusted
  // login and serves the configured comments (each with a user.login author).
  function makeRepo({ enabled = true, mode = "authoritative", maxAuto = 1, comments = [], login = TRUSTED_LOGIN }) {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-disp-repo-"));
    execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", "dev"]);
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
    const yaml = [
      "schema_version: 1",
      "project: fake",
      "workflow:",
      "  review_disposition:",
      `    enabled: ${enabled ? "true" : "false"}`,
      `    mode: ${mode}`,
      `    max_auto_overrides: ${maxAuto}`,
      "",
    ].join("\n");
    writeFileSync(join(repoDir, ".ground-control.yaml"), yaml);
    const binDir = mkdtempSync(join(tmpdir(), "gc-disp-bin-"));
    // comments: array of { body, authorLogin } → comment objects with user.login.
    const page = JSON.stringify([
      comments.map((c) => ({ body: c.body, user: { login: c.authorLogin } })),
    ]);
    const loginOut = login == null ? "" : String(login);
    const ghShim = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "api" && argv[1] === "user") {
  ${login == null ? 'process.stderr.write("no login\\n"); process.exit(1);' : `process.stdout.write(${JSON.stringify(loginOut)} + "\\n"); process.exit(0);`}
}
if (argv[0] === "api" && argv.includes("--slurp")) {
  process.stdout.write(${JSON.stringify(page)});
  process.exit(0);
}
process.stderr.write("gh shim: unhandled argv: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
    writeFileSync(join(binDir, "gh"), ghShim, { mode: 0o755 });
    return {
      repoDir,
      binDir,
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

  it("authorizes a trusted, authoritative, unspent grant end-to-end", async () => {
    const repo = makeRepo({
      enabled: true,
      maxAuto: 1,
      comments: [grantComment(7, "codex", 1)],
    });
    try {
      await withShimPath(repo.binDir, async () => {
        const r = await verifyAutoDispositionGrant(
          { repoPath: repo.repoDir, issueNumber: 7, reviewer: "codex" },
          { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo.repoDir) },
        );
        assert.equal(r.ok, true);
        assert.equal(r.authorized, true);
        assert.equal(r.grant_number, 1);
      });
    } finally {
      repo.cleanup();
    }
  });

  it("refuses end-to-end once the over-cap cycle marker is on the thread (single-use)", async () => {
    const repo = makeRepo({
      enabled: true,
      maxAuto: 1,
      // cap=1 in-cap cycle (1) ran, the grant posted, then the over-cap cycle
      // (2) ran and posted its marker → two cycle markers → grant is spent.
      comments: [codexCycleComment(7, 1), grantComment(7, "codex", 1), codexCycleComment(7, 2)],
    });
    try {
      await withShimPath(repo.binDir, async () => {
        const r = await verifyAutoDispositionGrant(
          { repoPath: repo.repoDir, issueNumber: 7, reviewer: "codex" },
          { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo.repoDir) },
        );
        assert.equal(r.ok, true);
        assert.equal(r.authorized, false);
        assert.equal(r.reason, "auto_grant_already_consumed");
      });
    } finally {
      repo.cleanup();
    }
  });

  it("refuses in shadow mode before any GitHub read", async () => {
    const repo = makeRepo({ enabled: true, mode: "shadow", comments: [grantComment(7, "codex", 1)] });
    try {
      await withShimPath(repo.binDir, async () => {
        const r = await verifyAutoDispositionGrant(
          { repoPath: repo.repoDir, issueNumber: 7, reviewer: "codex" },
          { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo.repoDir) },
        );
        assert.equal(r.ok, true);
        assert.equal(r.authorized, false);
        assert.equal(r.reason, "review_disposition_mode_not_authoritative");
      });
    } finally {
      repo.cleanup();
    }
  });

  it("does not authorize when review_disposition is disabled", async () => {
    const repo = makeRepo({ enabled: false, comments: [grantComment(7, "codex", 1)] });
    try {
      await withShimPath(repo.binDir, async () => {
        const r = await verifyAutoDispositionGrant(
          { repoPath: repo.repoDir, issueNumber: 7, reviewer: "codex" },
          { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo.repoDir) },
        );
        assert.equal(r.ok, true);
        assert.equal(r.authorized, false);
        assert.equal(r.reason, "review_disposition_disabled");
      });
    } finally {
      repo.cleanup();
    }
  });
});

describe("review cycle wrappers — auto_grant knob off (input validation unchanged)", () => {
  it("runCodexReviewCycle with autoGrant absent still rejects invalid input without I/O", async () => {
    const r = await runCodexReviewCycle({ repoPath: "", issueNumber: 1, uncommitted: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, "codex_review_cycle_input_invalid");
    const r2 = await runCodexReviewCycle({ repoPath: "/tmp", issueNumber: 0, uncommitted: true });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, "codex_review_cycle_input_invalid");
  });

  it("runTestQualityReviewCycle with autoGrant absent still rejects invalid input without I/O", async () => {
    const r = await runTestQualityReviewCycle({ repoPath: "", issueNumber: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "test_quality_review_cycle_input_invalid");
    const r2 = await runTestQualityReviewCycle({ repoPath: "/tmp", issueNumber: -3 });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, "test_quality_review_cycle_input_invalid");
  });
});
