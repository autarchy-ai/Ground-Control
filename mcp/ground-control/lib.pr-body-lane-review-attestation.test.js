// Issue #1551: the Ground Control Checks pre-push review attestation must match
// what the run actually did. /implement runs both reviewers, so it renders
// "completed"; /quickfix leaves them off unless the user passes --review, so a
// default quickfix run must not claim a verification it never performed. The
// attestation is never omitted — only made accurate.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PR_BODY_REVIEW_CHECK_LINE_COMPLETED,
  PR_BODY_REVIEW_CHECK_LINE_NOT_RUN,
  PR_BODY_REVIEW_CHECK_LINE_WAIVED,
  buildPrBody,
  checkPrBodyShape,
  validatePrBodyInput,
} from "./lib.js";

const BASE_INPUT = {
  issueNumber: 4242,
  changeClass: "doc-only",
  requirementUids: [],
  adrRefs: ["ADR-021"],
  summary: "Fix a parser bug.",
  changes: ["Corrected the token boundary"],
  traceability: { implements: [], tests: [] },
};

describe("PR body pre-push review attestation (issue #1551)", () => {
  it("defaults to the completed attestation so /implement callers are unchanged", () => {
    const body = buildPrBody({ ...BASE_INPUT });
    assert.ok(body.includes(PR_BODY_REVIEW_CHECK_LINE_COMPLETED));
    assert.ok(!body.includes(PR_BODY_REVIEW_CHECK_LINE_NOT_RUN));
  });

  it("renders the not-run attestation for a quickfix run with reviews off", () => {
    const body = buildPrBody({ ...BASE_INPUT, lane: "quickfix", prePushReviews: "not_run" });
    assert.ok(body.includes(PR_BODY_REVIEW_CHECK_LINE_NOT_RUN));
    assert.ok(!body.includes(PR_BODY_REVIEW_CHECK_LINE_COMPLETED));
  });

  it("renders the completed attestation for a quickfix run invoked with --review", () => {
    const body = buildPrBody({ ...BASE_INPUT, lane: "quickfix", prePushReviews: "completed" });
    assert.ok(body.includes(PR_BODY_REVIEW_CHECK_LINE_COMPLETED));
  });

  it("refuses to let an implement run claim its mandatory reviews did not run", () => {
    for (const lane of [undefined, "implement"]) {
      const result = validatePrBodyInput({ ...BASE_INPUT, lane, prePushReviews: "not_run" });
      assert.equal(result.ok, false);
      assert.ok(
        result.errors.some((e) => e.includes("requires lane='quickfix'")),
        `expected a lane-mismatch error, got: ${result.errors.join("; ")}`,
      );
    }
  });

  it("refuses an unknown lane or review state", () => {
    const badLane = validatePrBodyInput({ ...BASE_INPUT, lane: "integrate" });
    assert.equal(badLane.ok, false);
    assert.ok(badLane.errors.some((e) => e.startsWith("lane must be one of")));

    const badState = validatePrBodyInput({ ...BASE_INPUT, prePushReviews: "partial" });
    assert.equal(badState.ok, false);
    assert.ok(badState.errors.some((e) => e.startsWith("prePushReviews must be one of")));
  });

  it("accepts either attestation at the shape gate but demands one of them", () => {
    for (const line of [PR_BODY_REVIEW_CHECK_LINE_COMPLETED, PR_BODY_REVIEW_CHECK_LINE_NOT_RUN, PR_BODY_REVIEW_CHECK_LINE_WAIVED]) {
      const body = buildPrBody({ ...BASE_INPUT }).replace(PR_BODY_REVIEW_CHECK_LINE_COMPLETED, line);
      assert.equal(checkPrBodyShape(body).ok, true, `shape gate rejected: ${line}`);
    }
    const stripped = buildPrBody({ ...BASE_INPUT }).replace(PR_BODY_REVIEW_CHECK_LINE_COMPLETED, "");
    const shape = checkPrBodyShape(stripped);
    assert.equal(shape.ok, false);
    assert.ok(shape.errors.some((e) => e.includes("pre-push review attestation")));
  });

  // Issue #1578: a run whose station was waived did not complete that review, so neither of the
  // #1551 lines is accurate for it. The waived line is legal in either lane; whether the thread
  // actually carries a verified waiver is checked at PR creation, not by the renderer.
  it("renders the waived attestation, distinct from the completed one, in either lane", () => {
    for (const lane of [undefined, "implement", "quickfix"]) {
      const body = buildPrBody({ ...BASE_INPUT, lane, prePushReviews: "waived" });
      assert.ok(body.includes(PR_BODY_REVIEW_CHECK_LINE_WAIVED));
      assert.ok(!body.includes(PR_BODY_REVIEW_CHECK_LINE_COMPLETED));
      assert.equal(validatePrBodyInput({ ...BASE_INPUT, lane, prePushReviews: "waived" }).ok, true);
    }
  });
});
