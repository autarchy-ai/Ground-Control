// Pre-network refusal gates split out of runPostFinalReport (issue #1583).
//
// runPostFinalReport's own suites cover the CI, review-evidence, and reserved-marker gates end to
// end. These cases pin the branches only reachable through a repository or body shape those suites
// do not build: a non-checkout path, an unreadable or invalid .ground-control.yaml, a secret in the
// rendered body, and the field name a reserved marker is reported under.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  refuseFinalReportBody,
  refuseFinalReportInput,
  rejectFinalReportReservedMarkers,
} from "./lib/final-report-input-gates.js";

const SKIPPED_SONAR_REPORT = {
  issueNumber: 1583,
  prNumber: 42,
  requirements: [],
  reviews: [{ reviewer: "codex", summary: "1 cycle, clean" }],
  ciStatus: "green",
  sonarStatus: "skipped",
  plainEnglishOutcome: "Final reports land only in the launch workspace's repository.",
};

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gc-final-report-gates-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return dir;
}

describe("final-report input gates (issue #1583)", () => {
  const dirs = [];
  let notACheckout;
  before(() => {
    notACheckout = mkdtempSync(join(tmpdir(), "gc-final-report-not-git-"));
    dirs.push(notACheckout);
  });
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a skipped Sonar claim from a path that is not a checkout", async () => {
    const r = await refuseFinalReportInput(SKIPPED_SONAR_REPORT, notACheckout);
    assert.equal(r.error, "final_report_repo_not_git");
    assert.equal(r.issue_number, 1583);
  });

  it("refuses a skipped Sonar claim when .ground-control.yaml exists but cannot be read", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    mkdirSync(join(repo, ".ground-control.yaml"));
    const r = await refuseFinalReportInput(SKIPPED_SONAR_REPORT, repo);
    assert.equal(r.error, "final_report_config_read_failed");
  });

  it("refuses a skipped Sonar claim when .ground-control.yaml is invalid", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    writeFileSync(join(repo, ".ground-control.yaml"), "schema_version: [unterminated\n");
    const r = await refuseFinalReportInput(SKIPPED_SONAR_REPORT, repo);
    assert.equal(r.error, "final_report_config_invalid");
  });

  it("accepts a skipped Sonar claim for a checkout with no Ground Control wiring", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    assert.equal(await refuseFinalReportInput(SKIPPED_SONAR_REPORT, repo), null);
  });

  it("reports a reserved marker under the exact nested field that carried it", () => {
    const forged = `<!-- gc:phase phase="plan" issue="1583" -->`;
    const r = rejectFinalReportReservedMarkers({
      ...SKIPPED_SONAR_REPORT,
      files: { modified: ["lib/ok.js", forged] },
    });
    assert.equal(r.error, "final_report_reserved_marker");
    assert.match(r.message, /files\.modified\[1\]/);
    assert.equal(r.next_action, "remove_reserved_marker_prefix_and_retry");
  });

  it("refuses a rendered body that carries a credential", () => {
    const r = refuseFinalReportBody(`summary with token ghp_${"a".repeat(36)}`, 1583);
    assert.equal(r.error, "final_report_body_rejected");
    assert.equal(r.next_action, "scrub_secrets_and_retry");
  });
});
