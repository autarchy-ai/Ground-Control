// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";
import {
  CODEX_REVIEW_PREPUSH_HARD_CAP,
  CODEX_REVIEW_PREPUSH_MARKER_PREFIX,
  buildCodexReviewPrePushCycleMarker,
  evaluateCodexReviewPrePushCycleCap,
  parseCodexReviewPrePushCycleMarkers,
  runCodexReview,
} from "./lib.js";

describe("evaluateCodexReviewPrePushCycleCap", () => {
  // Default (no hardCap arg) — issue #906 dropped the module-default cap from
  // 3 to 1. Cycle 1 is therefore the only allowed in-cap cycle; next_action
  // is the "this is the last cycle" disposition. Repos that want the
  // historical cap-3 behavior set `.ground-control.yaml::workflow.codex_review.pre_push_cap: 3`;
  // those tests are below in the explicit-cap section.
  it("allows cycle 1 under the cap-1 default with the summarize-and-escalate disposition", () => {
    const r = evaluateCodexReviewPrePushCycleCap({
      priorCount: 0,
      issueNumber: 796,
      branchName: "796-foo",
    });
    assert.equal(r.ok, true);
    assert.equal(r.nextCycle, 1);
    assert.equal(r.cap, CODEX_REVIEW_PREPUSH_HARD_CAP);
    assert.equal(r.cap, 1);
    // Cycle 1 IS the last cycle under cap 1, so the agent must fix every
    // finding then summarize + escalate, not run cycle 2.
    assert.equal(r.next_action, "fix_all_findings_then_summarize_and_escalate");
    assert.notEqual(r.override, true);
  });

  it("refuses cycle 2 under the cap-1 default with codex_review_prepush_cap_reached", () => {
    const r = evaluateCodexReviewPrePushCycleCap({
      priorCount: 1,
      issueNumber: 796,
      branchName: "796-foo",
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "codex_review_prepush_cap_reached");
    assert.equal(r.prior_cycles, 1);
    assert.equal(r.cap, 1);
    assert.equal(r.next_action, "post_summary_and_escalate_to_user");
  });

  // Explicit cap-3 — historical default (issue #804) and the contract repos
  // restore by setting `workflow.codex_review.pre_push_cap: 3`. Tests assert
  // the per-cycle next_action surface still works at cap 3.
  it("allows cycle 1 under explicit cap-3 with the fix-and-restage disposition", () => {
    const r = evaluateCodexReviewPrePushCycleCap({
      priorCount: 0,
      issueNumber: 796,
      branchName: "796-foo",
      hardCap: 3,
    });
    assert.equal(r.ok, true);
    assert.equal(r.nextCycle, 1);
    assert.equal(r.cap, 3);
    assert.equal(r.next_action, "fix_all_findings_and_restage");
  });

  it("allows cycle 2 under explicit cap-3 with the standard fix-and-restage next_action", () => {
    const r = evaluateCodexReviewPrePushCycleCap({
      priorCount: 1,
      issueNumber: 796,
      branchName: "796-foo",
      hardCap: 3,
    });
    assert.equal(r.ok, true);
    assert.equal(r.nextCycle, 2);
    assert.equal(r.next_action, "fix_all_findings_and_restage");
  });

  it("allows cycle 3 under explicit cap-3 with the summarize-and-escalate discipline", () => {
    const r = evaluateCodexReviewPrePushCycleCap({
      priorCount: 2,
      issueNumber: 796,
      branchName: "796-foo",
      hardCap: 3,
    });
    assert.equal(r.ok, true);
    assert.equal(r.nextCycle, 3);
    assert.equal(r.next_action, "fix_all_findings_then_summarize_and_escalate");
  });

  it("refuses cycle 4 under explicit cap-3 with codex_review_prepush_cap_reached", () => {
    const r = evaluateCodexReviewPrePushCycleCap({
      priorCount: 3,
      issueNumber: 796,
      branchName: "796-foo",
      hardCap: 3,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "codex_review_prepush_cap_reached");
    assert.equal(r.prior_cycles, 3);
    assert.equal(r.cap, 3);
    assert.equal(r.issue_number, 796);
    assert.equal(r.branch, "796-foo");
    assert.equal(r.next_action, "post_summary_and_escalate_to_user");
    assert.match(r.message, /hard cap reached/);
    assert.match(r.message, /escalate to the user/);
    assert.match(r.message, /override_cap=true/);
  });

  it("refuses higher counts the same way (cap is a floor)", () => {
    const r = evaluateCodexReviewPrePushCycleCap({
      priorCount: 9,
      issueNumber: 1,
      branchName: "1-x",
    });
    assert.equal(r.ok, false);
    assert.equal(r.prior_cycles, 9);
  });

  it("respects an override hardCap (used by tests / future per-tool caps)", () => {
    const allowed = evaluateCodexReviewPrePushCycleCap({
      priorCount: 2,
      issueNumber: 1,
      branchName: "1-x",
      hardCap: 5,
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.nextCycle, 3);
    const refused = evaluateCodexReviewPrePushCycleCap({
      priorCount: 5,
      issueNumber: 1,
      branchName: "1-x",
      hardCap: 5,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.cap, 5);
  });

  it("allows cycle 4 when overrideCap=true with a non-empty overrideReason", () => {
    // Cap-3 (issue #804) — cycle 4 is the first cap-refused cycle.
    const r = evaluateCodexReviewPrePushCycleCap({
      priorCount: 3,
      issueNumber: 796,
      branchName: "796-foo",
      overrideCap: true,
      overrideReason: "user said 'yes run cycle 4 to verify' on 2026-05-09",
    });
    assert.equal(r.ok, true);
    assert.equal(r.override, true);
    assert.equal(r.nextCycle, 4);
    assert.match(r.override_reason, /yes run cycle 4 to verify/);
    assert.equal(r.next_action, "fix_findings_then_summarize_and_escalate");
  });

  it("rejects overrideCap=true without an overrideReason (audit requirement)", () => {
    const r1 = evaluateCodexReviewPrePushCycleCap({
      priorCount: 3,
      issueNumber: 1,
      branchName: "1-x",
      overrideCap: true,
    });
    assert.equal(r1.ok, false);
    assert.equal(r1.error, "codex_review_prepush_override_missing_reason");

    const r2 = evaluateCodexReviewPrePushCycleCap({
      priorCount: 3,
      issueNumber: 1,
      branchName: "1-x",
      overrideCap: true,
      overrideReason: "   ",
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, "codex_review_prepush_override_missing_reason");
  });

  it("override applies even within the cap (allows arbitrary mid-flight overrides)", () => {
    const r = evaluateCodexReviewPrePushCycleCap({
      priorCount: 0,
      issueNumber: 796,
      branchName: "796-foo",
      overrideCap: true,
      overrideReason: "user wants cycle 1 marked as override for some reason",
    });
    assert.equal(r.ok, true);
    assert.equal(r.override, true);
    assert.equal(r.nextCycle, 1);
  });

  it("throws on garbage priorCount (defensive)", () => {
    assert.throws(() =>
      evaluateCodexReviewPrePushCycleCap({
        priorCount: -1,
        issueNumber: 1,
        branchName: "x",
      }),
    );
    assert.throws(() =>
      evaluateCodexReviewPrePushCycleCap({
        priorCount: NaN,
        issueNumber: 1,
        branchName: "x",
      }),
    );
    assert.throws(() =>
      evaluateCodexReviewPrePushCycleCap({
        priorCount: "1",
        issueNumber: 1,
        branchName: "x",
      }),
    );
  });
});

describe("buildCodexReviewPrePushCycleMarker", () => {
  it("produces a marker that round-trips through parseCodexReviewPrePushCycleMarkers", () => {
    const marker = buildCodexReviewPrePushCycleMarker({
      issueNumber: 796,
      branchName: "796-foo",
      cycleNumber: 1,
    });
    assert.ok(marker.startsWith(CODEX_REVIEW_PREPUSH_MARKER_PREFIX));
    assert.equal(parseCodexReviewPrePushCycleMarkers([marker], 796), 1);
  });

  it("includes the cycle, cap, issue, and branch in the human-readable body", () => {
    // Pass an explicit hardCap so this test documents the marker's "cycle N
    // of M" shape independent of the module default (which dropped to 1 in
    // issue #906). The cap value in the marker is whatever the resolved
    // workflow.codex_review.pre_push_cap was for that cycle.
    const marker = buildCodexReviewPrePushCycleMarker({
      issueNumber: 796,
      branchName: "796-foo",
      cycleNumber: 2,
      hardCap: 3,
    });
    assert.match(marker, /cycle 2 of 3/);
    assert.match(marker, /issue #796/);
    assert.match(marker, /796-foo/);
    assert.match(marker, /#796\b/); // attribution stays scoped
    assert.match(marker, /#804/); // attribution to the cap-bump
  });

  it("two markers for the same issue are both counted regardless of branch", () => {
    const m1 = buildCodexReviewPrePushCycleMarker({
      issueNumber: 50,
      branchName: "50-x",
      cycleNumber: 1,
    });
    const m2 = buildCodexReviewPrePushCycleMarker({
      issueNumber: 50,
      branchName: "50-x-renamed",
      cycleNumber: 2,
    });
    // Same issue, different branches → both count under per-issue keying.
    assert.equal(parseCodexReviewPrePushCycleMarkers([m1, m2], 50), 2);
    const other = buildCodexReviewPrePushCycleMarker({
      issueNumber: 999,
      branchName: "999-x",
      cycleNumber: 1,
    });
    assert.equal(parseCodexReviewPrePushCycleMarkers([m1, m2, other], 50), 2);
  });

  it("renders an override marker distinguishable from regular cycle markers", () => {
    const reason = "user authorized cycle 3 to verify cycle-2 fixes";
    const marker = buildCodexReviewPrePushCycleMarker({
      issueNumber: 796,
      branchName: "796-foo",
      cycleNumber: 3,
      override: true,
      overrideReason: reason,
    });
    assert.match(marker, /override="true"/);
    assert.match(marker, /reason="[^"]+"/);
    assert.match(marker, /USER-AUTHORIZED OVERRIDE/);
    assert.match(marker, new RegExp(reason));
    assert.equal(parseCodexReviewPrePushCycleMarkers([marker], 796), 1);
  });

  it("escapes quotes in override reasons so the comment HTML stays parseable", () => {
    const tricky = 'user said "yes do it" then ran off';
    const marker = buildCodexReviewPrePushCycleMarker({
      issueNumber: 1,
      branchName: "1-x",
      cycleNumber: 3,
      override: true,
      overrideReason: tricky,
    });
    assert.match(marker, /reason="user said \\"yes do it\\" then ran off"/);
    assert.equal(parseCodexReviewPrePushCycleMarkers([marker], 1), 1);
  });

  it("supports branches with slashes in the audit-context attribute", () => {
    const marker = buildCodexReviewPrePushCycleMarker({
      issueNumber: 200,
      branchName: "feat/200-cool",
      cycleNumber: 1,
    });
    // JSON-encoding preserves slashes; the marker round-trips.
    assert.equal(parseCodexReviewPrePushCycleMarkers([marker], 200), 1);
    // Different issue still doesn't match.
    assert.equal(parseCodexReviewPrePushCycleMarkers([marker], 999), 0);
  });

  it("attribution mentions both enforcement issues (#796 cap-2, #804 cap-3) so reviewers can audit", () => {
    const marker = buildCodexReviewPrePushCycleMarker({
      issueNumber: 1,
      branchName: "1-x",
      cycleNumber: 1,
    });
    assert.match(marker, /#796/);
    assert.match(marker, /#804/);
  });
});

describe("runCodexReview uncommitted=true input gating", () => {
  // These tests exercise the uncommitted=true decision tree before any gh /
  // codex shells out. The refusal paths (detached HEAD, missing issue) are the
  // most important pre-flight checks because they are the only thing standing
  // between an unresolvable input and a half-completed run that no marker can
  // anchor.
  function makeTempRepo({ branch = "main", detached = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "gc-prepush-test-"));
    execFileSync("git", ["-C", dir, "init", "-q", "--initial-branch", branch]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
    // Need at least one commit so HEAD points somewhere we can detach onto.
    writeFileSync(join(dir, "README"), "x\n");
    execFileSync("git", ["-C", dir, "add", "README"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    // Real origin so owner/repo resolves from the git remote, as production does. git ignores
    // GH_REPO; the `gh repo view` fallback honours it.
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
    if (detached) {
      const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
      execFileSync("git", ["-C", dir, "-c", "advice.detachedHead=false", "checkout", "-q", sha]);
    }
    return dir;
  }

  it("refuses with prepush_branch_unresolved on detached HEAD before invoking gh/codex", async () => {
    const dir = makeTempRepo({ detached: true });
    try {
      const result = await runCodexReview(
        { repoPath: dir, uncommitted: true },
        { workspaceAuthorizationResolver: workspaceAuthorizationFor(dir) },
      );
      assert.equal(result.ok, false);
      assert.equal(result.error, "prepush_branch_unresolved");
      assert.equal(result.next_action, "checkout_named_feature_branch");
      assert.equal(result.finding_count, 0);
      assert.deepEqual(result.comments, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses with prepush_issue_unresolved when the branch has no numeric prefix and no issue_number is passed", async () => {
    const dir = makeTempRepo({ branch: "feature-x" });
    try {
      const result = await runCodexReview(
        { repoPath: dir, uncommitted: true },
        { workspaceAuthorizationResolver: workspaceAuthorizationFor(dir) },
      );
      assert.equal(result.ok, false);
      assert.equal(result.error, "prepush_issue_unresolved");
      assert.equal(result.branch, "feature-x");
      assert.equal(result.next_action, "pass_issue_number_or_use_numeric_branch_prefix");
      assert.equal(result.finding_count, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Note: the "numeric-prefix branch derives issueNumber" path is exercised by
  // every test in the cap-enforcement and marker-post suites below (all of
  // which use a numeric-prefix branch and rely on derivation). A standalone
  // weak-assertion test for it is subsumed and intentionally not duplicated.
  // The "explicit issue_number on a non-numeric branch" path is covered by
  // the strong assertion test at the bottom of the marker-post suite.
});
