// The PR-body review attestation must match the station ledger (issue #1578).
//
// A waived station did not complete its review. The synchronized PR writer is the only canonical
// PR-write path, so it refuses a body that claims the reviews completed while the thread records a
// waived, unobserved station — and a body that claims a waiver the thread cannot prove.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PR_BODY_REVIEW_CHECK_LINE_COMPLETED,
  PR_BODY_REVIEW_CHECK_LINE_NOT_RUN,
  PR_BODY_REVIEW_CHECK_LINE_WAIVED,
  assertPrBodyReviewAttestationMatchesLedger,
} from "./lib.js";

const waivedTestQuality = async () => ({
  ok: true,
  evidence: { waivers: [{ station: "test_quality_review" }], unobserved_waived_stations: ["test_quality_review"] },
});
const noWaivers = async () => ({ ok: true, evidence: { waivers: [], unobserved_waived_stations: [] } });

function check(line, reader) {
  return assertPrBodyReviewAttestationMatchesLedger({
    body: `## Ground Control Checks\n\n${line}\n`,
    issueNumber: 378,
    stationEvidenceReader: reader,
  });
}

describe("PR review attestation against the station ledger", () => {
  it("refuses a completed or not-run attestation while a station stands waived", async () => {
    for (const line of [PR_BODY_REVIEW_CHECK_LINE_COMPLETED, PR_BODY_REVIEW_CHECK_LINE_NOT_RUN]) {
      const result = await check(line, waivedTestQuality);
      assert.equal(result.ok, false);
      assert.equal(result.error, "implement_pr_review_attestation_inaccurate");
      assert.deepEqual(result.waived_stations, ["test_quality_review"]);
    }
  });

  it("accepts the waived attestation only when the ledger proves a waiver", async () => {
    assert.equal((await check(PR_BODY_REVIEW_CHECK_LINE_WAIVED, waivedTestQuality)).ok, true);
    const unproven = await check(PR_BODY_REVIEW_CHECK_LINE_WAIVED, noWaivers);
    assert.equal(unproven.error, "implement_pr_review_attestation_inaccurate");
  });

  it("leaves the ordinary attestations untouched when nothing was waived", async () => {
    for (const line of [PR_BODY_REVIEW_CHECK_LINE_COMPLETED, PR_BODY_REVIEW_CHECK_LINE_NOT_RUN]) {
      assert.equal((await check(line, noWaivers)).ok, true);
    }
  });

  it("fails closed when the ledger cannot be verified", async () => {
    const result = await check(PR_BODY_REVIEW_CHECK_LINE_COMPLETED, async () => ({
      ok: false, message: "An execution-obligation marker was authored outside the signer set",
    }));
    assert.equal(result.error, "implement_pr_station_evidence_unverifiable");
  });
});
