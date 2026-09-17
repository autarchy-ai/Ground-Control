import { _resetAsyncJobsForTest } from "./lib/async-job-registry.js";
import { beforeEach } from "node:test";
beforeEach(_resetAsyncJobsForTest);
// runMonitor's SonarCloud branch (issue #946).
//
// A Codex-spawned MCP host carries no SONAR_TOKEN, so gc_watch_sonar_analysis
// returned ok:false. The monitor folded that into the open-findings branch and
// told the driver to fix SonarCloud findings that had never been read, which is
// guidance no driver can act on: there is no defect to repair and re-running is
// deterministic. An unevaluable gate must reach the driver as an infrastructure
// blocker instead.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runMonitor } from "./implement/publish.js";

const ISSUE_BRANCH = "946-sonar-token-resolution";
async function monitorWithSonar(sonar) {
  return runMonitor(
      { action: "monitor", repoPath: "/repo", issueNumber: 946, prNumber: 42, branchName: ISSUE_BRANCH },
      {
        runGit: async () => ({ stdout: ISSUE_BRANCH }),
        execFile: async () => ({ stdout: ISSUE_BRANCH }),
        remoteSnapshot: async () => ({ ok: true, head_sha: "a".repeat(40), branch: "1426-script-phases", failures: [], passed: true }),
    monitorSleep: async () => new Promise((resolve) => setImmediate(resolve)),
    watchCi: async () => ({ ok: true, conclusion: "success" }),
        watchSonar: async () => sonar,
      },
    );
}

describe("runMonitor — SonarCloud gate classification", () => {
  it("advances when the gate is clean", async () => {
    const result = await monitorWithSonar({
      ok: true,
      skipped: false,
      quality_gate: "OK",
      issues_summary: { open_count: 0 },
      hotspots_summary: { open_count: 0 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.next_action, "post_pre_merge_readiness");
  });

  it("reports a missing MCP-host token as an infrastructure blocker, not open findings", async () => {
    const result = await monitorWithSonar({
      ok: false,
      error: "sonar_watch_token_missing",
      message: "SONAR_TOKEN is not set on the MCP host",
      pr_number: 42,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "sonar_watch_token_missing");
    assert.equal(result.sonar_gate, "not_evaluable");
    assert.equal(result.next_action, "provision_sonar_token_on_mcp_host_then_rerun_monitor");
    assert.notEqual(result.error, "sonar_findings_open");
  });

  it("reports an analysis that never appeared as unevaluable rather than a defect", async () => {
    const result = await monitorWithSonar({
      ok: true,
      skipped: false,
      quality_gate: "NONE",
      timed_out: true,
      issues_summary: { open_count: 0 },
      hotspots_summary: { open_count: 0 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.sonar_gate, "not_evaluable");
    assert.equal(result.next_action, "rerun_monitor_after_sonar_analysis_completes");
  });

  it("still routes genuinely open findings to the fix loop", async () => {
    const result = await monitorWithSonar({
      ok: true,
      skipped: false,
      quality_gate: "ERROR",
      issues_summary: { open_count: 4 },
      hotspots_summary: { open_count: 0 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "sonar_findings_open");
    assert.equal(result.sonar_gate, "findings_open");
    assert.equal(result.next_action, "fix_sonar_findings_then_rerun_publish_and_monitor");
  });

  // Issue #1559: the driver's durable obligation has to name what the server
  // observed, or the operator is sent after a cause nobody confirmed.
  it("carries the watcher's scope evidence into the failure envelope", async () => {
    const scope_evidence = {
      source: "github_check_runs",
      repo: "Brad-Edwards/shifter",
      pr_number: 42,
      head_sha: "a9df89dae32854f0915230ffd17ba2fcb65aee68",
      reason: "producer_skipped",
      checks: [{ name: "sonar", status: "completed", conclusion: "skipped" }],
    };
    const result = await monitorWithSonar({
      ok: false,
      error: "sonar_watch_analysis_not_produced",
      message: "no analysis will be published for this pull request",
      scope: "unproved",
      scope_evidence,
    });
    assert.equal(result.ok, false);
    assert.equal(result.sonar_gate, "not_evaluable");
    assert.equal(result.next_action, "diagnose_sonar_scan_scope_then_rerun_monitor");
    assert.deepEqual(result.sonar_scope_evidence, scope_evidence);
  });
});
