// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_REVIEW_CYCLE_MARKER_PREFIX,
  CODEX_REVIEW_HARD_CAP,
  CODEX_VERIFY_CYCLE_MARKER_PREFIX,
  CODEX_VERIFY_HARD_CAP,
  buildCodexReviewCycleMarker,
  buildCodexVerifyCycleMarker,
  deriveIssueNumberFromBranch,
  evaluateCodexReviewCycleCap,
  evaluateCodexVerifyCycleCap,
  parseCodexReviewCycleMarkers,
  parseCodexReviewPrePushCycleMarkers,
  parseCodexVerifyCycleMarkers,
} from "./lib.js";

describe("evaluateCodexReviewCycleCap", () => {
  it("allows cycle 1 when no priors exist and surfaces a fix-and-push next_action", () => {
    const result = evaluateCodexReviewCycleCap({ priorCount: 0, prNumber: 792 });
    assert.equal(result.ok, true);
    assert.equal(result.nextCycle, 1);
    assert.equal(result.cap, CODEX_REVIEW_HARD_CAP);
    assert.equal(result.next_action, "fix_all_findings_and_push");
    assert.notEqual(result.override, true);
  });

  it("allows cycle 2 after one prior with the standard fix-and-push next_action", () => {
    // Cap-3 (issue #804) — cycle 2 is no longer the last cycle, so it
    // returns the normal fix_all_findings_and_push next_action. The
    // fix-and-ask discipline shifts to cycle 3 (the new last).
    const result = evaluateCodexReviewCycleCap({ priorCount: 1, prNumber: 792 });
    assert.equal(result.ok, true);
    assert.equal(result.nextCycle, 2);
    assert.equal(result.next_action, "fix_all_findings_and_push");
  });

  it("allows cycle 3 (the last cycle under cap-3) with the fix-and-ask discipline", () => {
    // Cap-3 (issue #804) — cycle 3 is the new "must fix all + summarize +
    // escalate before the user authorizes a hypothetical cycle 4" cycle.
    const result = evaluateCodexReviewCycleCap({ priorCount: 2, prNumber: 792 });
    assert.equal(result.ok, true);
    assert.equal(result.nextCycle, 3);
    assert.equal(result.next_action, "fix_findings_then_ask_over_cap_or_proceed");
  });

  it("refuses cycle 4 (cap reached) and tells the agent what to do instead", () => {
    // Cap-3 (issue #804) — cycle 4 is the first refused cycle.
    const result = evaluateCodexReviewCycleCap({ priorCount: 3, prNumber: 792 });
    assert.equal(result.ok, false);
    assert.equal(result.error, "codex_review_cap_reached");
    assert.equal(result.prior_cycles, 3);
    assert.equal(result.cap, 3);
    assert.equal(result.pr_number, 792);
    assert.equal(result.next_action, "ask_over_cap_or_proceed");
    assert.match(result.message, /hard cap reached/);
    assert.match(result.message, /or proceed/);
    assert.match(result.message, /clean verdict is not required/);
    assert.match(result.message, /override_cap=true/);
  });

  it("refuses higher counts the same way (cap is a floor, not equality)", () => {
    const result = evaluateCodexReviewCycleCap({ priorCount: 9, prNumber: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.prior_cycles, 9);
  });

  it("respects an override hardCap (used by tests / future per-tool caps)", () => {
    const allowed = evaluateCodexReviewCycleCap({ priorCount: 2, prNumber: 1, hardCap: 5 });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.nextCycle, 3);
    const refused = evaluateCodexReviewCycleCap({ priorCount: 5, prNumber: 1, hardCap: 5 });
    assert.equal(refused.ok, false);
    assert.equal(refused.cap, 5);
  });

  it("allows cycle 4 when overrideCap=true with a non-empty overrideReason", () => {
    // Cap-3 (issue #804) — cycle 4 is the first cap-refused cycle, so this
    // is the cycle a user-authorized override is most likely to enable.
    const result = evaluateCodexReviewCycleCap({
      priorCount: 3,
      prNumber: 792,
      overrideCap: true,
      overrideReason: "user said 'yes run cycle 4 to verify' on 2026-05-09",
    });
    assert.equal(result.ok, true);
    assert.equal(result.override, true);
    assert.equal(result.nextCycle, 4);
    assert.match(result.override_reason, /yes run cycle 4 to verify/);
    assert.equal(result.next_action, "fix_findings_then_ask_over_cap_or_proceed");
  });

  it("rejects overrideCap=true without an overrideReason (audit requirement)", () => {
    const noReason = evaluateCodexReviewCycleCap({ priorCount: 3, prNumber: 1, overrideCap: true });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.error, "codex_review_override_missing_reason");

    const emptyReason = evaluateCodexReviewCycleCap({
      priorCount: 3,
      prNumber: 1,
      overrideCap: true,
      overrideReason: "   ",
    });
    assert.equal(emptyReason.ok, false);
    assert.equal(emptyReason.error, "codex_review_override_missing_reason");
  });

  it("override applies even within the cap (allows arbitrary mid-flight overrides)", () => {
    // A user could authorize a cycle even when the cap hasn't been reached
    // yet (e.g., to skip ahead). The override path doesn't second-guess.
    const result = evaluateCodexReviewCycleCap({
      priorCount: 0,
      prNumber: 792,
      overrideCap: true,
      overrideReason: "user wants cycle 1 marked as override for some reason",
    });
    assert.equal(result.ok, true);
    assert.equal(result.override, true);
    assert.equal(result.nextCycle, 1);
  });

  it("throws on garbage priorCount (defensive, surfaces a real bug rather than counting nothing)", () => {
    assert.throws(() => evaluateCodexReviewCycleCap({ priorCount: -1, prNumber: 1 }));
    assert.throws(() => evaluateCodexReviewCycleCap({ priorCount: NaN, prNumber: 1 }));
    assert.throws(() => evaluateCodexReviewCycleCap({ priorCount: "1", prNumber: 1 }));
  });
});

describe("buildCodexReviewCycleMarker", () => {
  it("produces a marker that round-trips through parseCodexReviewCycleMarkers", () => {
    const marker = buildCodexReviewCycleMarker({ prNumber: 792, cycleNumber: 1 });
    assert.ok(marker.startsWith(CODEX_REVIEW_CYCLE_MARKER_PREFIX));
    assert.equal(parseCodexReviewCycleMarkers([marker], 792), 1);
  });

  it("includes the cycle and cap in the human-readable body so reviewers see the count", () => {
    // Cap-3 (issue #804): the marker for cycle 2 reads "cycle 2 of 3".
    const marker = buildCodexReviewCycleMarker({ prNumber: 100, cycleNumber: 2 });
    assert.match(marker, /cycle 2 of 3/);
    assert.match(marker, /PR #100/);
    assert.match(marker, /#794/); // attribution to the enforcement issue
    assert.match(marker, /#804/); // attribution to the cap-bump
  });

  it("two markers from the same PR are both counted", () => {
    const m1 = buildCodexReviewCycleMarker({ prNumber: 50, cycleNumber: 1 });
    const m2 = buildCodexReviewCycleMarker({ prNumber: 50, cycleNumber: 2 });
    assert.equal(parseCodexReviewCycleMarkers([m1, m2], 50), 2);
    // and a marker for a different PR is not counted
    const other = buildCodexReviewCycleMarker({ prNumber: 999, cycleNumber: 1 });
    assert.equal(parseCodexReviewCycleMarkers([m1, m2, other], 50), 2);
  });

  it("renders an override marker distinguishable from regular cycle markers", () => {
    const reason = 'user authorized cycle 3 to verify cycle-2 fixes';
    const marker = buildCodexReviewCycleMarker({
      prNumber: 792,
      cycleNumber: 3,
      override: true,
      overrideReason: reason,
    });
    // Override markers carry override="true" and a quoted reason= attribute.
    assert.match(marker, /override="true"/);
    assert.match(marker, /reason="[^"]+"/);
    assert.match(marker, /USER-AUTHORIZED OVERRIDE/);
    assert.match(marker, new RegExp(reason));
    // And they still round-trip through the cycle parser (so they count).
    assert.equal(parseCodexReviewCycleMarkers([marker], 792), 1);
  });

  it("escapes quotes in override reasons so the comment HTML stays parseable", () => {
    const tricky = 'user said "yes do it" then ran off';
    const marker = buildCodexReviewCycleMarker({
      prNumber: 1,
      cycleNumber: 3,
      override: true,
      overrideReason: tricky,
    });
    // JSON.stringify escapes the embedded quotes; the marker must still
    // contain the prefix and round-trip.
    assert.match(marker, /reason="user said \\"yes do it\\" then ran off"/);
    assert.equal(parseCodexReviewCycleMarkers([marker], 1), 1);
  });
});

// ---------------------------------------------------------------------------
// gc_codex_verify_finding per-finding cap (#794 extension)
// ---------------------------------------------------------------------------

describe("parseCodexVerifyCycleMarkers", () => {
  it("counts markers for the matching (PR, comment_id) pair", () => {
    const bodies = [
      '<!-- gc:codex-verify-cycle pr="792" comment="42" cycle="1" -->',
      '<!-- gc:codex-verify-cycle pr="792" comment="42" cycle="2" -->',
      '<!-- gc:codex-verify-cycle pr="792" comment="99" cycle="1" -->', // different finding
    ];
    assert.equal(parseCodexVerifyCycleMarkers(bodies, 792, 42), 2);
    assert.equal(parseCodexVerifyCycleMarkers(bodies, 792, 99), 1);
    assert.equal(parseCodexVerifyCycleMarkers(bodies, 792, 1000), 0);
  });

  it("ignores markers for other PRs even with the same comment_id", () => {
    const bodies = [
      '<!-- gc:codex-verify-cycle pr="100" comment="42" cycle="1" -->',
      '<!-- gc:codex-verify-cycle pr="200" comment="42" cycle="1" -->',
    ];
    assert.equal(parseCodexVerifyCycleMarkers(bodies, 100, 42), 1);
    assert.equal(parseCodexVerifyCycleMarkers(bodies, 200, 42), 1);
    assert.equal(parseCodexVerifyCycleMarkers(bodies, 300, 42), 0);
  });

  it("tolerates non-string entries and a non-array input", () => {
    assert.equal(parseCodexVerifyCycleMarkers(["a", 42, null], 1, 1), 0);
    assert.equal(parseCodexVerifyCycleMarkers(null, 1, 1), 0);
  });
});

describe("evaluateCodexVerifyCycleCap", () => {
  it("allows cycle 1 with no priors and surfaces a fix-and-retry next_action", () => {
    const result = evaluateCodexVerifyCycleCap({ priorCount: 0, prNumber: 792, commentId: 42 });
    assert.equal(result.ok, true);
    assert.equal(result.nextCycle, 1);
    assert.equal(result.cap, CODEX_VERIFY_HARD_CAP);
    assert.equal(result.next_action, "fix_finding_and_retry");
  });

  it("allows cycle 2 with one prior and signals the escalate-if-still-unresolved discipline", () => {
    const result = evaluateCodexVerifyCycleCap({ priorCount: 1, prNumber: 792, commentId: 42 });
    assert.equal(result.ok, true);
    assert.equal(result.nextCycle, 2);
    assert.equal(result.next_action, "fix_finding_then_escalate_if_still_unresolved");
  });

  it("refuses cycle 3 with structured error pointing at escalation", () => {
    const result = evaluateCodexVerifyCycleCap({ priorCount: 2, prNumber: 792, commentId: 42 });
    assert.equal(result.ok, false);
    assert.equal(result.error, "codex_verify_cap_reached");
    assert.equal(result.next_action, "escalate_finding_to_user");
    assert.match(result.message, /comment #42/);
    assert.match(result.message, /PR #792/);
  });

  it("override path requires a non-empty reason", () => {
    const noReason = evaluateCodexVerifyCycleCap({
      priorCount: 2,
      prNumber: 1,
      commentId: 1,
      overrideCap: true,
    });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.error, "codex_verify_override_missing_reason");

    const goodOverride = evaluateCodexVerifyCycleCap({
      priorCount: 2,
      prNumber: 1,
      commentId: 1,
      overrideCap: true,
      overrideReason: "user said: try once more on this one",
    });
    assert.equal(goodOverride.ok, true);
    assert.equal(goodOverride.override, true);
    assert.equal(goodOverride.nextCycle, 3);
    assert.equal(
      goodOverride.next_action,
      "fix_finding_then_escalate_if_still_unresolved",
    );
  });

  it("throws on garbage priorCount (defensive)", () => {
    assert.throws(() => evaluateCodexVerifyCycleCap({ priorCount: -1, prNumber: 1, commentId: 1 }));
  });
});

describe("buildCodexVerifyCycleMarker", () => {
  it("round-trips through parseCodexVerifyCycleMarkers", () => {
    const m = buildCodexVerifyCycleMarker({ prNumber: 792, commentId: 42, cycleNumber: 1 });
    assert.ok(m.startsWith(CODEX_VERIFY_CYCLE_MARKER_PREFIX));
    assert.equal(parseCodexVerifyCycleMarkers([m], 792, 42), 1);
  });

  it("override markers are distinguishable but still counted", () => {
    const reason = "user authorized verify cycle 3 for this finding";
    const m = buildCodexVerifyCycleMarker({
      prNumber: 1,
      commentId: 7,
      cycleNumber: 3,
      override: true,
      overrideReason: reason,
    });
    assert.match(m, /override="true"/);
    assert.match(m, /USER-AUTHORIZED OVERRIDE/);
    assert.match(m, new RegExp(reason));
    assert.equal(parseCodexVerifyCycleMarkers([m], 1, 7), 1);
  });
});

// ---------------------------------------------------------------------------
// gc_codex_review pre-push cycle enforcement (#796)
//
// Pre-push reviews (`uncommitted=true`) hit the same diminishing-returns wall
// as post-push reviews, so they inherit GC-O007's hard-cap-2. The marker is a
// new, disjoint family from the post-push one — anchored to (issue, branch)
// instead of (PR) — so the two parsers never accidentally cross-count.
// ---------------------------------------------------------------------------

describe("deriveIssueNumberFromBranch", () => {
  it("extracts the leading integer from a gh-issue-develop-style branch", () => {
    assert.equal(deriveIssueNumberFromBranch("796-cap-pre-push"), 796);
    assert.equal(deriveIssueNumberFromBranch("1-x"), 1);
  });

  it("returns the integer when the branch is just digits", () => {
    assert.equal(deriveIssueNumberFromBranch("796"), 796);
  });

  it("returns null when the branch does not start with digits", () => {
    assert.equal(deriveIssueNumberFromBranch("feature/796-x"), null);
    assert.equal(deriveIssueNumberFromBranch("dev"), null);
    assert.equal(deriveIssueNumberFromBranch("main"), null);
    assert.equal(deriveIssueNumberFromBranch("release-2.0"), null);
  });

  it("returns null on empty / non-string / nullish input", () => {
    assert.equal(deriveIssueNumberFromBranch(""), null);
    assert.equal(deriveIssueNumberFromBranch(null), null);
    assert.equal(deriveIssueNumberFromBranch(undefined), null);
    assert.equal(deriveIssueNumberFromBranch(42), null);
  });

  it("rejects zero or negative leading values (issue numbers are positive)", () => {
    assert.equal(deriveIssueNumberFromBranch("0-foo"), null);
    assert.equal(deriveIssueNumberFromBranch("-1-foo"), null);
  });
});

describe("parseCodexReviewPrePushCycleMarkers", () => {
  it("returns 0 when no comments contain markers", () => {
    const bodies = ["random comment", "another", "## summary"];
    assert.equal(parseCodexReviewPrePushCycleMarkers(bodies, 796), 0);
  });

  it("counts markers for the matching issue regardless of branch", () => {
    const bodies = [
      'cycle 1: <!-- gc:codex-prepush-cycle issue="796" branch="796-foo" cycle="1" -->',
      "unrelated",
      'cycle 2: <!-- gc:codex-prepush-cycle issue="796" branch="796-foo" cycle="2" -->',
    ];
    assert.equal(parseCodexReviewPrePushCycleMarkers(bodies, 796), 2);
  });

  it("ignores markers for other issues", () => {
    const bodies = [
      '<!-- gc:codex-prepush-cycle issue="100" branch="796-foo" cycle="1" -->',
      '<!-- gc:codex-prepush-cycle issue="796" branch="796-foo" cycle="1" -->',
    ];
    assert.equal(parseCodexReviewPrePushCycleMarkers(bodies, 796), 1);
  });

  it("counts markers from any branch on the same issue (closes branch-rename bypass)", () => {
    // Per #800 review cycle 2: a noncompliant agent could rename
    // `796-x` → `796-x-2` to evade per-(issue, branch) keying. The cap is now
    // anchored by issue alone — markers on either branch count toward the same
    // budget. Branch is recorded in the marker for audit context only.
    const bodies = [
      '<!-- gc:codex-prepush-cycle issue="796" branch="796-foo" cycle="1" -->',
      '<!-- gc:codex-prepush-cycle issue="796" branch="796-bar" cycle="2" -->',
    ];
    assert.equal(parseCodexReviewPrePushCycleMarkers(bodies, 796), 2);
  });

  it("does not cross-count post-push cycle markers (different family)", () => {
    const bodies = [
      '<!-- gc:codex-review-cycle cycle="1" pr="500" -->',
      '<!-- gc:codex-review-cycle cycle="2" pr="500" -->',
    ];
    assert.equal(parseCodexReviewPrePushCycleMarkers(bodies, 500), 0);
  });

  it("ignores malformed markers (missing attrs, unquoted, garbled)", () => {
    const bodies = [
      "<!-- gc:codex-prepush-cycle -->",
      '<!-- gc:codex-prepush-cycle issue="796" branch="796-foo" -->', // no cycle
      '<!-- gc:codex-prepush-cycle issue="796" cycle="1" -->', // no branch
      '<!-- gc:codex-prepush-cycle branch="796-foo" cycle="1" -->', // no issue
      "<!-- gc:codex-prepush-cycle issue=796 branch=796-foo cycle=1 -->", // unquoted
    ];
    assert.equal(parseCodexReviewPrePushCycleMarkers(bodies, 796), 0);
  });

  it("tolerates non-string entries and non-array input", () => {
    assert.equal(parseCodexReviewPrePushCycleMarkers(["a", 42, null], 1), 0);
    assert.equal(parseCodexReviewPrePushCycleMarkers(null, 1), 0);
    assert.equal(parseCodexReviewPrePushCycleMarkers("not an array", 1), 0);
  });
});
