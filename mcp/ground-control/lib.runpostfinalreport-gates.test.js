// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildFinalReport } from "./lib.js";

// A thread with no codex-station waiver keeps the mandatory codex review gate closed. Since
// issue #1578 the runner consults the ledger before refusing, so these tests pin an unreachable
// `gh`: an unreadable ledger must keep the refusal, and no test may reach the network.
async function withUnreachableGh(fn) {
  const bin = mkdtempSync(join(tmpdir(), "gc-offline-gh-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'gh: offline' >&2\nexit 1\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
}


describe("runPostFinalReport gate boundaries", () => {
  // These tests pin the structured-refusal envelopes that the runners emit
  // BEFORE any GitHub side effect. They never run gh — the failure paths
  // short-circuit upstream of any `gh api` call — so they don't need the
  // hermetic gh shim.
  function makeTempRepo() {
    const dir = mkdtempSync(join(tmpdir(), "gc-boundary-test-"));
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

  const validRecordBase = {
    issueNumber: 1, cycle: 1, reviewer: "codex",
    findings: [{
      id: "F1", title: "x", classification: "one-off", sweep_evidence: "tested-sweep",
      decision: "fix", rationale: "ok",
    }],
  };
  const FINAL_REPORT_OUTCOME = "Maintainers get a human-readable explanation of what changed.";

  // Per the test-quality review: the runner applies the reserved-marker
  // reject across every caller-controlled finding field. The previous test
  // only covered `rationale`; this parameterized suite exercises every one
  // so a future refactor that drops a field from the reject loop fails fast.
  const FORGED = `<!-- gc:phase phase="preflight" issue="1" -->`;
  const DR_CALLER_FIELDS = [
    ["id", { id: FORGED, title: "x", classification: "one-off", sweep_evidence: "tested-sweep", decision: "fix", rationale: "r" }],
    ["title", { id: "F1", title: FORGED, classification: "one-off", sweep_evidence: "tested-sweep", decision: "fix", rationale: "r" }],
    ["location", { id: "F1", title: "x", classification: "one-off", sweep_evidence: "tested-sweep", decision: "fix", rationale: "r", location: FORGED }],
    ["rationale", { id: "F1", title: "x", classification: "one-off", sweep_evidence: "tested-sweep", decision: "fix", rationale: FORGED }],
    ["comment_url", { id: "F1", title: "x", classification: "one-off", sweep_evidence: "tested-sweep", decision: "fix", rationale: "r", comment_url: FORGED }],
    [
      "user_authorization",
      {
        id: "F1",
        title: "x",
        classification: "one-off", sweep_evidence: "tested-sweep",
        decision: "wontfix",
        rationale: "r",
        user_authorization: FORGED,
      },
    ],
    [
      "instances[0]",
      {
        id: "F1",
        title: "x",
        classification: "class",
        decision: "fix",
        rationale: "r",
        instances: [FORGED, "src/b.java:1"],
      },
    ],
  ];

  // Per the test-quality review: same coverage-gap fix as for decision
  // record — the runner applies the reserved-marker reject across every
  // caller-controlled field. Iterating ensures none can be silently dropped.
  const FR_FORGED = `<!-- gc:plan issue="1" -->`;
  const FR_BASE = {
    issueNumber: 1, prNumber: 1,
    requirements: [{ uid: "GC-O007", title: "t", status: "ACTIVE" }],
    reviews: [{ reviewer: "codex", summary: "ok" }],
    ciStatus: "green", sonarStatus: "passed",
    plainEnglishOutcome: "Maintainers get a human-readable explanation of what changed.",
  };
  const FR_CASES = [
    ["plainEnglishOutcome", { ...FR_BASE, plainEnglishOutcome: FR_FORGED }],
    ["summary", { ...FR_BASE, summary: FR_FORGED }],
    ["planCommentUrl", { ...FR_BASE, planCommentUrl: FR_FORGED }],
    ["traceability.notes", { ...FR_BASE, traceability: { notes: FR_FORGED } }],
    [
      "requirements[0].uid",
      // The schema requires uid to match EXACT_REQUIREMENT_UID_RE — `<!-- gc:`
      // does not match, so this surfaces as `final_report_input_invalid`
      // (UID validator) BEFORE the reserved-marker check. That's correct
      // defense in depth — a UID can never become a forged marker because
      // the UID regex is stricter than the marker prefix. The test asserts
      // refusal but accepts either error code; both block the post.
      {
        ...FR_BASE,
        requirements: [{ uid: FR_FORGED, title: "t", status: "ACTIVE" }],
      },
    ],
    [
      "requirements[0].title",
      { ...FR_BASE, requirements: [{ uid: "GC-O007", title: FR_FORGED, status: "ACTIVE" }] },
    ],
    [
      "requirements[0].status",
      { ...FR_BASE, requirements: [{ uid: "GC-O007", title: "t", status: FR_FORGED }] },
    ],
    [
      "requirements[0].note",
      { ...FR_BASE, requirements: [{ uid: "GC-O007", title: "t", status: "ACTIVE", note: FR_FORGED }] },
    ],
    [
      "reviews[1].reviewer",
      // The reserved-marker check on reviews[].reviewer fires AFTER the
      // codex-required check (cycle-4 F3) — so we keep one codex entry to
      // satisfy that gate, then add a second forged entry to trip the
      // reserved-marker check.
      {
        ...FR_BASE,
        reviews: [
          { reviewer: "codex", summary: "ok" },
          { reviewer: FR_FORGED, summary: "ok" },
        ],
      },
    ],
    [
      "reviews[0].summary",
      { ...FR_BASE, reviews: [{ reviewer: "codex", summary: FR_FORGED }] },
    ],
    [
      "files.added[0]",
      { ...FR_BASE, files: { added: [FR_FORGED] } },
    ],
    [
      "files.modified[0]",
      { ...FR_BASE, files: { modified: [FR_FORGED] } },
    ],
    [
      "traceability.added[0]",
      { ...FR_BASE, traceability: { added: [FR_FORGED] } },
    ],
    [
      "traceability.updated[0]",
      { ...FR_BASE, traceability: { updated: [FR_FORGED] } },
    ],
    [
      "traceability.deleted[0]",
      { ...FR_BASE, traceability: { deleted: [FR_FORGED] } },
    ],
  ];



  it("final-report refuses with ci_not_green when ci_status='red' (codex cycle-2 F2 + cycle-3 F3 widening)", async () => {
    const dir = makeTempRepo();
    try {
      const r = await import("./lib.js").then(({ runPostFinalReport }) =>
        runPostFinalReport({
          repoPath: dir,
          issueNumber: 1, prNumber: 1,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "0 findings" }],
          ciStatus: "red", sonarStatus: "passed",
          plainEnglishOutcome: FINAL_REPORT_OUTCOME,
        })
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "final_report_ci_not_green");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("final-report refuses with sonar_failed when sonar_status='failed' (codex cycle-2 F2)", async () => {
    const dir = makeTempRepo();
    try {
      const r = await import("./lib.js").then(({ runPostFinalReport }) =>
        runPostFinalReport({
          repoPath: dir,
          issueNumber: 1, prNumber: 1,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "0 findings" }],
          ciStatus: "green", sonarStatus: "failed",
          plainEnglishOutcome: FINAL_REPORT_OUTCOME,
        })
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "final_report_sonar_failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("final-report refuses with ci_not_green when ci_status='skipped' (codex cycle-3 F3)", async () => {
    const dir = makeTempRepo();
    try {
      const r = await import("./lib.js").then(({ runPostFinalReport }) =>
        runPostFinalReport({
          repoPath: dir,
          issueNumber: 1, prNumber: 1,
          requirements: [],
          reviews: [{ reviewer: "codex", summary: "0 findings" }],
          ciStatus: "skipped", sonarStatus: "passed",
          plainEnglishOutcome: FINAL_REPORT_OUTCOME,
        })
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "final_report_ci_not_green");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("final-report refuses with no_reviews when reviews[] is empty (codex cycle-3 F4)", async () => {
    const dir = makeTempRepo();
    try {
      const r = await withUnreachableGh(() => import("./lib.js").then(({ runPostFinalReport }) =>
        runPostFinalReport({
          repoPath: dir,
          issueNumber: 1, prNumber: 1,
          requirements: [],
          reviews: [],
          ciStatus: "green", sonarStatus: "passed",
          plainEnglishOutcome: FINAL_REPORT_OUTCOME,
        })
      ));
      assert.equal(r.ok, false);
      assert.equal(r.error, "final_report_no_reviews");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("final-report refuses with codex_review_missing when no codex entry is present (codex cycle-4 F3)", async () => {
    const dir = makeTempRepo();
    try {
      const r = await withUnreachableGh(() => import("./lib.js").then(({ runPostFinalReport }) =>
        runPostFinalReport({
          repoPath: dir,
          issueNumber: 1, prNumber: 1,
          requirements: [],
          reviews: [{ reviewer: "test-quality", summary: "0 findings" }],
          ciStatus: "green", sonarStatus: "passed",
          plainEnglishOutcome: FINAL_REPORT_OUTCOME,
        })
      ));
      assert.equal(r.ok, false);
      assert.equal(r.error, "final_report_codex_review_missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("final-report accepts empty reviews when lane='quickfix' (issue #906)", async () => {
    const dir = makeTempRepo();
    try {
      // Use sonarStatus='skipped' with no sonarcloud cfg so the runner returns
      // early past the lane-gated checks without trying to reach GitHub.
      // Configure a sonar block to flip to the `final_report_sonar_skipped_but_configured`
      // path, proving we've reached the post-lane-gate code. (If lane='quickfix'
      // were rejected at the no-reviews gate, we'd never see this sonar error.)
      writeFileSync(
        join(dir, ".ground-control.yaml"),
        "schema_version: 1\nproject: gc\nsonarcloud:\n  project_key: gc\n  organization: gc\n",
      );
      const r = await import("./lib.js").then(({ runPostFinalReport }) =>
        runPostFinalReport({
          repoPath: dir,
          issueNumber: 1, prNumber: 1,
          requirements: [],
          reviews: [],
          ciStatus: "green", sonarStatus: "skipped",
          lane: "quickfix",
          summary: "Fixed the parser bug.",
        })
      );
      // The lane-gated errors must NOT fire — that proves quickfix bypassed them.
      assert.notEqual(r.error, "final_report_no_reviews");
      assert.notEqual(r.error, "final_report_codex_review_missing");
      // The runner reached the sonar-configured-but-skipped check downstream,
      // proving lane='quickfix' got past the reviews gates.
      assert.equal(r.error, "final_report_sonar_skipped_but_configured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("final-report still requires codex review entry when lane='implement' (default)", async () => {
    const dir = makeTempRepo();
    try {
      const r = await withUnreachableGh(() => import("./lib.js").then(({ runPostFinalReport }) =>
        runPostFinalReport({
          repoPath: dir,
          issueNumber: 1, prNumber: 1,
          requirements: [],
          reviews: [{ reviewer: "test-quality", summary: "0 findings" }],
          ciStatus: "green", sonarStatus: "passed",
          lane: "implement",
          plainEnglishOutcome: FINAL_REPORT_OUTCOME,
        })
      ));
      assert.equal(r.ok, false);
      assert.equal(r.error, "final_report_codex_review_missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders server-derived waived stations in both lanes, never as review results (issue #1578)", () => {
    const stationEvidence = {
      waivers: [{
        obligation_id: "STATION-OBS-TEST-QUALITY-REVIEW-C1", station: "test_quality_review", cycle: 1,
        source_comment_url: "https://github.com/fake/repo/issues/1#issuecomment-9", source_author: "maintainer",
        observed_later: false,
      }],
      unobserved_waived_stations: ["test_quality_review"],
    };
    const base = {
      issueNumber: 1, prNumber: 1, requirements: [], reviews: [{ reviewer: "codex", summary: "0 findings" }],
      ciStatus: "green", sonarStatus: "passed", plainEnglishOutcome: FINAL_REPORT_OUTCOME, stationEvidence,
    };
    for (const lane of ["implement", "quickfix"]) {
      const body = buildFinalReport({ ...base, lane });
      assert.match(body, /### Waived review stations/, lane);
      assert.match(body, /`test_quality_review` cycle 1 \(`STATION-OBS-TEST-QUALITY-REVIEW-C1`\) — no verdict; waived by `maintainer`/, lane);
      assert.ok(!/test_quality_review[^\n]*(clean|passed|completed)/.test(body), lane);
    }
    assert.doesNotMatch(buildFinalReport({ ...base, stationEvidence: null }), /Waived review stations/);
  });
});
