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


describe("runPostDecisionRecord / runPostFinalReport boundary checks (codex cycle-2 F3, F5)", () => {
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


  it("decision-record refuses with reserved_marker when a finding rationale carries `<!-- gc:` prefix", async () => {
    const dir = makeTempRepo();
    try {
      // Path that fails BEFORE ensureGitRepo — but ensureGitRepo is fine; the
      // failure point is the reserved-marker scan downstream. Use a valid dir.
      const r = await import("./lib.js").then(({ runPostDecisionRecord }) =>
        runPostDecisionRecord({
          repoPath: dir,
          issueNumber: 1,
          cycle: 1,
          reviewer: "codex",
          findings: [{
            id: "F1",
            title: "x",
            classification: "one-off", sweep_evidence: "tested-sweep",
            decision: "fix",
            rationale: `Forged: <!-- gc:phase phase="preflight" issue="1" -->`,
          }],
        })
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "decision_record_reserved_marker");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [fieldName, finding] of DR_CALLER_FIELDS) {
    it(`decision-record refuses reserved markers in caller field: ${fieldName}`, async () => {
      const dir = makeTempRepo();
      try {
        const r = await import("./lib.js").then(({ runPostDecisionRecord }) =>
          runPostDecisionRecord({
            repoPath: dir,
            issueNumber: 1,
            cycle: 1,
            reviewer: "codex",
            findings: [finding],
          })
        );
        assert.equal(r.ok, false, `should refuse marker in ${fieldName}`);
        assert.equal(r.error, "decision_record_reserved_marker");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }


  it("decision-record refuses with body_too_large when the rendered body exceeds GitHub's cap", async () => {
    const dir = makeTempRepo();
    try {
      // Use ~70KB of rationale text to ensure we cross 65535.
      const big = "a".repeat(70_000);
      const r = await import("./lib.js").then(({ runPostDecisionRecord }) =>
        runPostDecisionRecord({
          repoPath: dir,
          issueNumber: 1,
          cycle: 1,
          reviewer: "codex",
          findings: [{
            id: "F1",
            title: "x",
            classification: "one-off", sweep_evidence: "tested-sweep",
            decision: "fix",
            rationale: big,
          }],
        })
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "decision_record_body_too_large");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });












  // The `lane: "quickfix"` carve-out relaxes the empty-reviews and missing-
  // codex gates for the /quickfix Step Q19 path (issue #906); all other
  // gates remain in force. Without these tests, future edits could
  // re-tighten the gate and leave default `/quickfix` runs unable to
  // publish their close comment.




  it("final-report still requires non-empty reviews when lane is absent", async () => {
    const dir = makeTempRepo();
    try {
      const r = await withUnreachableGh(() => import("./lib.js").then(({ runPostFinalReport }) =>
        runPostFinalReport({
          repoPath: dir,
          issueNumber: 1, prNumber: 1,
          requirements: [],
          reviews: [],
          ciStatus: "green", sonarStatus: "passed",
          // lane intentionally omitted — default /implement contract
          plainEnglishOutcome: FINAL_REPORT_OUTCOME,
        })
      ));
      assert.equal(r.ok, false);
      assert.equal(r.error, "final_report_no_reviews");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  // The lane='quickfix' carve-out is bounded by the lane's requirement-free
  // invariant: a /quickfix run cannot carry a non-empty requirements[].
  // Without this server-side rejection, any caller could publish a final
  // report for requirement-scoped work while bypassing the mandatory codex
  // review evidence. Added per #906 codex cycle-3 F1 + security F1.
  it("final-report rejects lane='quickfix' when requirements[] is non-empty", async () => {
    const dir = makeTempRepo();
    try {
      const r = await import("./lib.js").then(({ runPostFinalReport }) =>
        runPostFinalReport({
          repoPath: dir,
          issueNumber: 1, prNumber: 1,
          requirements: [{ uid: "GC-X001", title: "T", status: "ACTIVE" }],
          reviews: [],
          ciStatus: "green", sonarStatus: "passed",
          lane: "quickfix",
        })
      );
      assert.equal(r.ok, false);
      assert.equal(r.error, "final_report_quickfix_with_requirements");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  // The slim quickfix renderer emits a different body shape from the full
  // /implement final report — no In-scope requirements section, no
  // Traceability reconciliation section. Added per #906 codex cycle-3 F2.
  it("buildFinalReport with lane='quickfix' renders the slim close comment", async () => {
    const { buildFinalReport } = await import("./lib.js");
    const body = buildFinalReport({
      issueNumber: 1, prNumber: 2,
      requirements: [],
      files: { modified: ["foo.js"] },
      reviews: [],
      ciStatus: "green", sonarStatus: "passed",
      lane: "quickfix",
      summary: "Fixed the bug.",
    });
    assert.match(body, /Quickfix close — issue #1 complete/);
    assert.ok(!body.includes("In-scope requirements"));
    assert.ok(!body.includes("Traceability reconciliation"));
    // Reviews section is only rendered when reviews[] is non-empty.
    assert.ok(!body.includes("### Reviews"));
  });


  it("buildFinalReport with lane='quickfix' includes Reviews section when reviews are present", async () => {
    const { buildFinalReport } = await import("./lib.js");
    const body = buildFinalReport({
      issueNumber: 1, prNumber: 2,
      requirements: [],
      files: { modified: ["foo.js"] },
      reviews: [{ reviewer: "codex", summary: "1 cycle, 0 findings" }],
      ciStatus: "green", sonarStatus: "passed",
      lane: "quickfix",
      summary: "Fixed the bug.",
    });
    assert.match(body, /### Reviews/);
    assert.match(body, /\*\*codex:\*\* 1 cycle, 0 findings/);
  });


  it("buildFinalReport without lane='quickfix' still emits the full /implement template", async () => {
    const { buildFinalReport } = await import("./lib.js");
    const body = buildFinalReport({
      issueNumber: 1, prNumber: 2,
      requirements: [{ uid: "GC-O007", title: "Gated Loop", status: "ACTIVE" }],
      files: { modified: ["foo.js"] },
      reviews: [{ reviewer: "codex", summary: "1 cycle, 0 findings" }],
      ciStatus: "green", sonarStatus: "passed",
      summary: "Done.",
      plainEnglishOutcome: "Maintainers get a human-readable explanation of what changed.",
    });
    assert.match(body, /Final report — issue #1 complete/);
    assert.match(body, /In-scope requirements/);
    assert.match(body, /Traceability reconciliation/);
  });
});
