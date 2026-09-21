// The /integrate lane's SonarCloud watcher mapping.
//
// Split out of gc-integrate.gc-integration-manager-sonar-watcher-mapping.test.js
// under issue #1559 for the 500-LOC limit (docs/CODING_STANDARDS.md, ADR-092).
// The shared dep factories moved to gc-integrate.test-helpers.js so both files
// read one copy rather than a duplicated one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makePr, prepareDeps, validYaml } from "./gc-integrate.test-helpers.js";

const { runIntegrationManager } = await import("./gc-integrate.js");

describe("gc_integration_manager — Sonar watcher mapping", () => {
  function sonarWatcherDeps(fakeSonarWatcher, { yaml, prs } = {}) {
    return prepareDeps({
      prs: prs ?? [makePr(1)],
      yaml: yaml ?? validYaml(),
      runCiWatcher: async () => ({ conclusion: "success" }),
      runSonarWatcher: fakeSonarWatcher,
    });
  }

  it("runSonarWatcher returns {quality_gate:'OK'} → outcome:ready", async () => {
    const deps = sonarWatcherDeps(async () => ({ conclusion: "success" }));
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, "ready");
  });

  it("runSonarWatcher returns {conclusion:'failure'} → outcome:blocked, failure_class:sonar_gate_red", async () => {
    const deps = sonarWatcherDeps(async () => ({ conclusion: "failure" }));
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "sonar_gate_red");
  });

  it("runSonarWatcher returns {conclusion:'skipped'} + no sonarcloud config → outcome:ready", async () => {
    // No sonarcloud block in yaml.
    const deps = sonarWatcherDeps(async () => ({ conclusion: "skipped" }), {
      yaml: validYaml(), // no sonarcloud block
    });
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, "ready");
  });

  it("runSonarWatcher returns {conclusion:'skipped'} + sonarcloud config present → outcome:blocked, failure_class:sonar_skipped_but_configured", async () => {
    const yaml = validYaml("sonarcloud:\n  organization: myorg\n  project_key: myrepo\n");
    const deps = sonarWatcherDeps(async () => ({ conclusion: "skipped" }), { yaml });
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(result.results[0].outcome, "blocked");
    assert.equal(result.results[0].failure_class, "sonar_skipped_but_configured");
  });

  // Issue #1559: the adapter flattened every unevaluable envelope to a bare
  // skip, so the lane blamed the repo's Sonar configuration for a scan its own
  // CI declined to run, and dropped the evidence the diagnosis needs. The block
  // still stands; the classification, the action, and the evidence are now the
  // watcher's rather than a generic guess.
  it("routes a terminal producer to scope diagnosis and keeps its evidence", async () => {
    const yaml = validYaml("sonarcloud:\n  organization: myorg\n  project_key: myrepo\n");
    const scope_evidence = {
      source: "github_check_runs",
      repo: "acme/myrepo",
      pr_number: 1,
      head_sha: "a9df89da",
      reason: "producer_skipped",
      checks: [{ name: "sonar", status: "completed", conclusion: "skipped" }],
    };
    const deps = sonarWatcherDeps(
      async () => ({ conclusion: "skipped", reason: "sonar_watch_analysis_not_produced", scope_evidence }),
      { yaml },
    );
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    const record = result.results[0];
    assert.equal(record.outcome, "blocked");
    assert.equal(record.failure_class, "sonar_analysis_not_produced");
    assert.equal(record.next_action, "diagnose_sonar_scan_scope");
    assert.deepEqual(record.sonar_scope_evidence, scope_evidence);
  });

  it("keeps the generic configuration classification for a skip it cannot attribute", async () => {
    const yaml = validYaml("sonarcloud:\n  organization: myorg\n  project_key: myrepo\n");
    const deps = sonarWatcherDeps(
      async () => ({ conclusion: "skipped", reason: "sonar_watch_quality_gate_failed" }),
      { yaml },
    );
    const result = await runIntegrationManager(
      { action: "prepare", repo_path: "/some/repo" },
      deps,
    );
    assert.equal(result.results[0].failure_class, "sonar_skipped_but_configured");
    assert.equal(result.results[0].next_action, "check_sonar_configuration");
    assert.match(result.results[0].summary, /sonar_watch_quality_gate_failed/);
  });

  it("runSonarWatcher is called with pr_number and repo_path", async () => {
    const sonarWatcherCalls = [];
    const fakeSonarWatcher = async (pr, ctx) => {
      sonarWatcherCalls.push({ pr, ctx });
      return { conclusion: "skipped" };
    };
    const deps = sonarWatcherDeps(fakeSonarWatcher, { prs: [makePr(42)] });
    await runIntegrationManager({ action: "prepare", repo_path: "/some/repo" }, deps);
    assert.equal(sonarWatcherCalls.length, 1, "Sonar watcher must be called once per PR");
    const { pr, ctx } = sonarWatcherCalls[0];
    assert.equal(pr.pr_number, 42, `expected pr_number=42, got: ${pr.pr_number}`);
    assert.ok(typeof ctx.repoRoot === "string" && ctx.repoRoot.length > 0, "ctx.repoRoot must be present");
  });
});
