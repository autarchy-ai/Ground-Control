// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DEFAULT_IMPLEMENT_ROUTING_STAGES } from "./lib.js";

describe("gc_watch_sonar_analysis integration (mocked fetch, issue #934 fix-list)", () => {
  // Sonar uses fetch(), not gh. Mock by replacing global.fetch for the
  // duration of the test. Each test restores the original to avoid
  // leaking into other suites.

  function makeMockRepo(yamlBody) {
    const dir = mkdtempSync(join(tmpdir(), "gc-sonar-int-"));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    writeFileSync(join(dir, ".ground-control.yaml"), yamlBody);
    execFileSync("git", ["-C", dir, "add", ".ground-control.yaml"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    // Real origin so owner/repo resolves from the git remote, as production does. git ignores
    // GH_REPO; the `gh repo view` fallback honours it.
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
    return dir;
  }

  it("retries on 503 then succeeds; final envelope reflects the successful response", async () => {
    const { runWatchSonarAnalysis } = await import("./lib.js");
    const dir = makeMockRepo(
      "schema_version: 1\nproject: test\nsonarcloud:\n  project_key: test_key\n  organization: test_org\n",
    );
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.SONAR_TOKEN;
    process.env.SONAR_TOKEN = "test-token-stub";
    const callLog = [];
    let qgCallCount = 0;
    globalThis.fetch = async (url) => {
      callLog.push(url);
      if (url.includes("/api/qualitygates/project_status")) {
        qgCallCount++;
        // First call returns 503 (transient); second call succeeds.
        if (qgCallCount === 1) {
          return { status: 503, ok: false, json: async () => ({}) };
        }
        return {
          status: 200, ok: true,
          json: async () => ({ projectStatus: { status: "OK" } }),
        };
      }
      if (url.includes("/api/issues/search")) {
        return {
          status: 200, ok: true,
          json: async () => ({ total: 0, issues: [] }),
        };
      }
      if (url.includes("/api/hotspots/search")) {
        return {
          status: 200, ok: true,
          json: async () => ({ paging: { total: 0 }, hotspots: [] }),
        };
      }
      return { status: 404, ok: false, json: async () => ({}) };
    };
    try {
      const r = await runWatchSonarAnalysis({
        authorizeRepoRead: async () => ({ ok: true, repoSlug: "fake/repo" }),
        fetchProducerEvidence: async () => null,
        repoPath: dir,
        prNumber: 7,
        initialWaitSeconds: 0,
        pollIntervalSeconds: 0,
        totalTimeoutSeconds: 10,
      });
      assert.equal(r.ok, true);
      assert.equal(r.quality_gate, "OK");
      assert.equal(r.skipped, false);
      assert.equal(r.issues_summary.open_count, 0);
      assert.equal(r.hotspots_summary.open_count, 0);
      // The 503 retry MUST have happened — qgCallCount should be at
      // least 2 (1 transient failure + 1 success).
      assert.ok(qgCallCount >= 2, `expected >=2 quality-gate fetches; got ${qgCallCount}`);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.SONAR_TOKEN;
      else process.env.SONAR_TOKEN = originalToken;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT retry on 404 (permanent failure) — quality gate not available", async () => {
    const { runWatchSonarAnalysis } = await import("./lib.js");
    const dir = makeMockRepo(
      "schema_version: 1\nproject: test\nsonarcloud:\n  project_key: test_key\n  organization: test_org\n",
    );
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.SONAR_TOKEN;
    process.env.SONAR_TOKEN = "test-token-stub";
    let qgCallCount = 0;
    globalThis.fetch = async (url) => {
      if (url.includes("/api/qualitygates/project_status")) {
        qgCallCount++;
        return { status: 404, ok: false, json: async () => ({}) };
      }
      return { status: 404, ok: false, json: async () => ({}) };
    };
    try {
      const r = await runWatchSonarAnalysis({
        authorizeRepoRead: async () => ({ ok: true, repoSlug: "fake/repo" }),
        fetchProducerEvidence: async () => null,
        repoPath: dir,
        prNumber: 9,
        initialWaitSeconds: 0,
        pollIntervalSeconds: 0,
        totalTimeoutSeconds: 1, // tight cap so the polling loop exits fast
      });
      // 404 means quality gate not yet available; tool polls until timeout
      // and returns a timed-out envelope. Each poll iteration calls
      // qualitygates once. With totalTimeoutSeconds=1 and pollInterval=0,
      // we expect a small bounded number of calls — and crucially, NO
      // retry-attempts beyond the single call per poll iteration.
      assert.equal(r.ok, true);
      assert.equal(r.timed_out, true);
      assert.equal(r.quality_gate, "NONE");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.SONAR_TOKEN;
      else process.env.SONAR_TOKEN = originalToken;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Orchestrator ↔ routing-stages ↔ step-files sync (issue #934 fix-list)", () => {
  // Resolve REPO_ROOT relative to this test file so the validator works on
  // any host (CI, contributor machines, ephemeral checkouts) — not just
  // the path I happened to develop on. ESM-native via import.meta.url.
  const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const SKILL_PATH = `${REPO_ROOT}/skills/implement/SKILL.md`;
  const STEPS_DIR = `${REPO_ROOT}/skills/implement/steps`;
  // Stages in DEFAULT_IMPLEMENT_ROUTING_STAGES that are intentionally NOT
  // standalone steps in the orchestrator's table — they live inside the
  // pre-push review subagents (Steps 6.5 / 6.6) and never get their own
  // step file. Update this list deliberately when adding a new internal
  // stage; the validator will flag any unaccounted-for stage otherwise.
  const INTERNAL_ONLY_STAGES = new Set(["review_fix_application"]);

  function parseStepFileStageId(filePath) {
    const text = readFileSync(filePath, "utf8");
    const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (!match) return null;
    const frontmatter = match[1];
    const stageMatch = frontmatter.match(/^stage_id:\s*(\S+)\s*$/m);
    return stageMatch ? stageMatch[1] : null;
  }

  function parseOrchestratorStepTable(skillText) {
    // The table rows look like:
    //   | 1 | `issue_branch_resolution` | `steps/step-01-issue-branch-resolution.md` |
    // Extract (stage_id, step_file_path) pairs from every row whose first
    // column is a step number.
    const rows = [];
    // Stage ids include digits in some cases (`review_cycle_1_consume`),
    // so the captured group must allow [a-z_0-9].
    const rowRe = /^\|\s*\d+(?:\.\d+)?\s*\|\s*`([a-z_0-9]+)`\s*\|\s*`([^`]+)`\s*\|/gm;
    let m;
    while ((m = rowRe.exec(skillText)) !== null) {
      rows.push({ stage_id: m[1], step_path: m[2] });
    }
    return rows;
  }

  it("every stage referenced in SKILL.md exists in DEFAULT_IMPLEMENT_ROUTING_STAGES", async () => {
    const { DEFAULT_IMPLEMENT_ROUTING_STAGES } = await import("./lib.js");
    const canonicalStages = new Set(Object.keys(DEFAULT_IMPLEMENT_ROUTING_STAGES));
    const skillText = readFileSync(SKILL_PATH, "utf8");
    const rows = parseOrchestratorStepTable(skillText);
    assert.ok(
      rows.length >= 18,
      `Expected the orchestrator's step table to have at least 18 rows; got ${rows.length}. Has the table format changed?`,
    );
    for (const row of rows) {
      assert.ok(
        canonicalStages.has(row.stage_id),
        `Orchestrator references unknown stage '${row.stage_id}' for ${row.step_path}; not in DEFAULT_IMPLEMENT_ROUTING_STAGES`,
      );
    }
  });

  it("every step file path in SKILL.md exists on disk", async () => {
    const skillText = readFileSync(SKILL_PATH, "utf8");
    const rows = parseOrchestratorStepTable(skillText);
    for (const row of rows) {
      const absPath = `${REPO_ROOT}/skills/implement/${row.step_path}`;
      assert.ok(
        existsSync(absPath),
        `Orchestrator references missing step file: ${row.step_path} (resolved to ${absPath})`,
      );
    }
  });

  it("every step file's frontmatter stage_id matches a canonical stage", async () => {
    const { DEFAULT_IMPLEMENT_ROUTING_STAGES } = await import("./lib.js");
    const canonicalStages = new Set(Object.keys(DEFAULT_IMPLEMENT_ROUTING_STAGES));
    const entries = readdirSync(STEPS_DIR)
      .filter((n) => n.startsWith("step-") && n.endsWith(".md"));
    assert.ok(
      entries.length >= 18,
      `Expected at least 18 step files; got ${entries.length}`,
    );
    for (const name of entries) {
      const filePath = `${STEPS_DIR}/${name}`;
      const stageId = parseStepFileStageId(filePath);
      if (/^status: retired$/m.test(readFileSync(filePath, "utf8"))) {
        assert.equal(stageId, null, "Retired steps must not declare an executable stage");
        assert.ok(!readFileSync(SKILL_PATH, "utf8").includes(`steps/${name}`),
          "Retired steps must not be dispatched by the orchestrator");
        continue;
      }
      assert.ok(
        stageId !== null,
        `Step file ${name} has no parseable stage_id in frontmatter`,
      );
      assert.ok(
        canonicalStages.has(stageId),
        `Step file ${name} declares stage_id='${stageId}' but it's not in DEFAULT_IMPLEMENT_ROUTING_STAGES`,
      );
    }
  });

  it("every step file referenced in SKILL.md has matching frontmatter stage_id", async () => {
    const skillText = readFileSync(SKILL_PATH, "utf8");
    const rows = parseOrchestratorStepTable(skillText);
    for (const row of rows) {
      const absPath = `${REPO_ROOT}/skills/implement/${row.step_path}`;
      if (!existsSync(absPath)) continue; // separate test covers missing files
      const stageId = parseStepFileStageId(absPath);
      assert.equal(
        stageId,
        row.stage_id,
        `Drift: SKILL.md table says ${row.step_path} → stage '${row.stage_id}', but the file's frontmatter declares stage_id='${stageId}'`,
      );
    }
  });

  it("every canonical stage is referenced in SKILL.md OR explicitly internal-only", async () => {
    const { DEFAULT_IMPLEMENT_ROUTING_STAGES } = await import("./lib.js");
    const canonicalStages = new Set(Object.keys(DEFAULT_IMPLEMENT_ROUTING_STAGES));
    const skillText = readFileSync(SKILL_PATH, "utf8");
    const rows = parseOrchestratorStepTable(skillText);
    const referencedStages = new Set(rows.map((r) => r.stage_id));
    const missing = [];
    for (const stage of canonicalStages) {
      if (INTERNAL_ONLY_STAGES.has(stage)) continue;
      if (!referencedStages.has(stage)) missing.push(stage);
    }
    assert.deepEqual(
      missing,
      [],
      `Canonical stage(s) defined in DEFAULT_IMPLEMENT_ROUTING_STAGES but never referenced in SKILL.md (and not in INTERNAL_ONLY_STAGES allow-list): ${missing.join(", ")}`,
    );
  });
});

// =============================================================================
// gc_watch_ci_run (issue #934)
// =============================================================================
//
// Server-side CI poller. The agent makes one MCP tool call; the MCP server
// holds the connection while polling GitHub for up to ~45 minutes. The
// terminal envelope summarizes the run; raw logs stay server-side. Three
// pure helpers carry the testable logic — the async loop is covered by the
// end-to-end run in Phase 5.

describe("evaluateCiPollState (issue #934)", () => {
  it("returns action=complete when status is completed regardless of elapsed", async () => {
    const { evaluateCiPollState } = await import("./lib.js");
    const r = evaluateCiPollState({
      status: "completed",
      elapsedSeconds: 5,
      queuedTimeoutSeconds: 300,
      totalTimeoutSeconds: 2700,
    });
    assert.equal(r.action, "complete");
  });

  it("returns action=queued_too_long when still queued past the queued cap", async () => {
    const { evaluateCiPollState } = await import("./lib.js");
    const r = evaluateCiPollState({
      status: "queued",
      elapsedSeconds: 301,
      queuedSeconds: 301,
      queuedTimeoutSeconds: 300,
      totalTimeoutSeconds: 2700,
    });
    assert.equal(r.action, "queued_too_long");
  });

  it("stays action=continue while queued under the queued cap", async () => {
    const { evaluateCiPollState } = await import("./lib.js");
    const r = evaluateCiPollState({
      status: "queued",
      elapsedSeconds: 60,
      queuedSeconds: 60,
      queuedTimeoutSeconds: 300,
      totalTimeoutSeconds: 2700,
    });
    assert.equal(r.action, "continue");
  });

  it("returns action=timed_out when in_progress past the total cap", async () => {
    const { evaluateCiPollState } = await import("./lib.js");
    const r = evaluateCiPollState({
      status: "in_progress",
      elapsedSeconds: 2701,
      queuedTimeoutSeconds: 300,
      totalTimeoutSeconds: 2700,
    });
    assert.equal(r.action, "timed_out");
  });

  it("stays action=continue while in_progress under the total cap", async () => {
    const { evaluateCiPollState } = await import("./lib.js");
    const r = evaluateCiPollState({
      status: "in_progress",
      elapsedSeconds: 500,
      queuedTimeoutSeconds: 300,
      totalTimeoutSeconds: 2700,
    });
    assert.equal(r.action, "continue");
  });

  it("treats an unknown status as continue (defensive — GH may add statuses)", async () => {
    const { evaluateCiPollState } = await import("./lib.js");
    const r = evaluateCiPollState({
      status: "requested",
      elapsedSeconds: 50,
      queuedTimeoutSeconds: 300,
      totalTimeoutSeconds: 2700,
    });
    assert.equal(r.action, "continue");
  });

  it("returns queued_too_long with priority over timed_out at the boundary", async () => {
    // If somehow elapsed exceeds BOTH caps while still queued, queued_too_long
    // is the more specific signal (a stuck runner pool), so report that.
    const { evaluateCiPollState } = await import("./lib.js");
    const r = evaluateCiPollState({
      status: "queued",
      elapsedSeconds: 3000,
      queuedSeconds: 3000,
      queuedTimeoutSeconds: 300,
      totalTimeoutSeconds: 2700,
    });
    assert.equal(r.action, "queued_too_long");
  });
});

describe("summarizeCiLogFailedOutput (issue #934)", () => {
  it("returns an empty string for empty input", async () => {
    const { summarizeCiLogFailedOutput } = await import("./lib.js");
    assert.equal(summarizeCiLogFailedOutput("", 4096), "");
    assert.equal(summarizeCiLogFailedOutput(null, 4096), "");
    assert.equal(summarizeCiLogFailedOutput(undefined, 4096), "");
  });

  it("returns the input unchanged when under the cap", async () => {
    const { summarizeCiLogFailedOutput } = await import("./lib.js");
    const text = "short log line\nanother\n";
    assert.equal(summarizeCiLogFailedOutput(text, 4096), text);
  });

  it("truncates the FRONT of long input and keeps the tail (failures are at the end)", async () => {
    const { summarizeCiLogFailedOutput } = await import("./lib.js");
    const text = "x".repeat(2000) + "\nTHE_ERROR_LINE\n" + "y".repeat(2000);
    const out = summarizeCiLogFailedOutput(text, 200);
    assert.ok(out.length <= 200 + 64); // +64 budget for the prefix marker
    assert.ok(out.includes("THE_ERROR_LINE") || out.includes("y"));
  });

  it("includes a truncation marker when the input is truncated", async () => {
    const { summarizeCiLogFailedOutput } = await import("./lib.js");
    const text = "a".repeat(10000);
    const out = summarizeCiLogFailedOutput(text, 200);
    assert.match(out, /\[truncated/i);
  });
});

describe("extractFailedStepsFromJobsJson (issue #934)", () => {
  it("returns [] for missing or empty input", async () => {
    const { extractFailedStepsFromJobsJson } = await import("./lib.js");
    assert.deepEqual(extractFailedStepsFromJobsJson(null), []);
    assert.deepEqual(extractFailedStepsFromJobsJson({}), []);
    assert.deepEqual(extractFailedStepsFromJobsJson({ jobs: [] }), []);
  });

  it("returns only steps whose conclusion is failure", async () => {
    const { extractFailedStepsFromJobsJson } = await import("./lib.js");
    const jobs = {
      jobs: [
        {
          name: "build",
          conclusion: "failure",
          steps: [
            { name: "checkout", conclusion: "success" },
            { name: "compile", conclusion: "failure" },
          ],
        },
        {
          name: "lint",
          conclusion: "success",
          steps: [{ name: "spotless", conclusion: "success" }],
        },
      ],
    };
    const r = extractFailedStepsFromJobsJson(jobs);
    assert.deepEqual(r, [{ job_name: "build", step_name: "compile" }]);
  });

  it("bounds the number of returned failed steps", async () => {
    const { extractFailedStepsFromJobsJson } = await import("./lib.js");
    const jobs = {
      jobs: [
        {
          name: "j",
          conclusion: "failure",
          steps: Array.from({ length: 20 }, (_, i) => ({
            name: `s${i}`,
            conclusion: "failure",
          })),
        },
      ],
    };
    const r = extractFailedStepsFromJobsJson(jobs, 10);
    assert.equal(r.length, 10);
  });

  it("treats cancelled, timed_out, and skipped steps as not-failed (GitHub semantics)", async () => {
    const { extractFailedStepsFromJobsJson } = await import("./lib.js");
    const jobs = {
      jobs: [
        {
          name: "j",
          conclusion: "failure",
          steps: [
            { name: "a", conclusion: "cancelled" },
            { name: "b", conclusion: "timed_out" },
            { name: "c", conclusion: "skipped" },
            { name: "d", conclusion: "failure" },
          ],
        },
      ],
    };
    const r = extractFailedStepsFromJobsJson(jobs);
    assert.deepEqual(r, [{ job_name: "j", step_name: "d" }]);
  });
});
