// Sonar producer scope classification (issue #1559).
//
// The watcher used to ask only "has an analysis appeared yet?", so a pull
// request whose scan CI had already declared terminal burned the full 30-minute
// cap on a 404 that could never resolve. These tests pin the classifier that
// answers the prior question — "can an analysis appear at all?" — and the
// evidence shape #1533 needs in order to verify a scope exclusion rather than
// trust a caller.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SONAR_SCOPE_EVIDENCE_CHECK_MAX,
  buildSonarScopeEvidence,
  classifySonarProducer,
  fetchSonarProducerEvidence,
  normalizeCheckRollupEntry,
  selectSonarProducerChecks,
} from "./lib/sonar-scope.js";

function checkRun(name, conclusion, { status = "COMPLETED", workflowName = null } = {}) {
  return {
    __typename: "CheckRun",
    name,
    workflowName,
    status,
    conclusion,
    completedAt: "2026-09-06T15:59:10Z",
  };
}

describe("normalizeCheckRollupEntry", () => {
  it("normalizes a CheckRun's status and conclusion without lowercasing its display name", () => {
    const entry = normalizeCheckRollupEntry(checkRun("Quality / SonarCloud", "SKIPPED", { workflowName: "Quality" }));
    assert.deepEqual(entry, {
      name: "Quality / SonarCloud",
      workflow_name: "Quality",
      status: "completed",
      conclusion: "skipped",
      completed_at: "2026-09-06T15:59:10Z",
    });
  });

  it("maps a StatusContext's state onto the same terminal axis", () => {
    const pending = normalizeCheckRollupEntry({
      __typename: "StatusContext", context: "SonarCloud Code Analysis", state: "PENDING",
    });
    assert.equal(pending.status, "pending");
    assert.equal(pending.conclusion, null);

    const failed = normalizeCheckRollupEntry({
      __typename: "StatusContext", context: "SonarCloud Code Analysis", state: "ERROR",
    });
    assert.equal(failed.status, "completed");
    assert.equal(failed.conclusion, "failure");
  });

  it("rejects an entry that carries no usable name", () => {
    assert.equal(normalizeCheckRollupEntry({ __typename: "CheckRun", conclusion: "SUCCESS" }), null);
    assert.equal(normalizeCheckRollupEntry(null), null);
  });
});

describe("selectSonarProducerChecks", () => {
  const entries = [
    checkRun("policy", "SUCCESS"),
    checkRun("sonar", "SUCCESS", { workflowName: "SonarCloud" }),
    checkRun("trivy", "SUCCESS"),
  ].map(normalizeCheckRollupEntry);

  it("matches the default /sonar/i selector on the check name or its workflow name", () => {
    const byName = selectSonarProducerChecks(entries, null);
    assert.deepEqual(byName.map((c) => c.name), ["sonar"]);

    const workflowOnly = [normalizeCheckRollupEntry(checkRun("scan", "SKIPPED", { workflowName: "SonarCloud" }))];
    assert.equal(selectSonarProducerChecks(workflowOnly, null).length, 1);
  });

  it("honours a configured producer name as a case-insensitive exact match", () => {
    assert.deepEqual(selectSonarProducerChecks(entries, "SONAR").map((c) => c.name), ["sonar"]);
    // Exact, not substring: a configured selector must not widen to a sibling.
    assert.deepEqual(selectSonarProducerChecks(entries, "son"), []);
  });
});

describe("classifySonarProducer", () => {
  const classify = (...runs) => classifySonarProducer(runs.map(normalizeCheckRollupEntry));

  it("reports unknown when no producer check was observed", () => {
    assert.equal(classifySonarProducer([]).analysis, "unknown");
  });

  it("reports skipped when every producer check is terminally skipped or neutral", () => {
    const result = classify(checkRun("sonar", "SKIPPED"), checkRun("SonarCloud Code Analysis", "NEUTRAL"));
    assert.equal(result.analysis, "skipped");
    assert.equal(result.reason, "producer_skipped");
  });

  it("reports unavailable when a producer concluded without publishing an analysis", () => {
    const result = classify(checkRun("sonar", "FAILURE"), checkRun("SonarCloud Code Analysis", "SKIPPED"));
    assert.equal(result.analysis, "unavailable");
    assert.equal(result.reason, "producer_terminal_without_analysis");
  });

  it("prefers pending over every terminal observation", () => {
    assert.equal(
      classify(checkRun("sonar", "SKIPPED"), checkRun("sonar re-run", null, { status: "IN_PROGRESS" })).analysis,
      "pending",
    );
  });

  it("prefers a successful producer over a sibling that skipped", () => {
    assert.equal(classify(checkRun("sonar", "SUCCESS"), checkRun("sonar-legacy", "SKIPPED")).analysis, "expected");
  });
});

describe("buildSonarScopeEvidence", () => {
  it("binds the observation to the repository, pull request, and head revision it inspected", () => {
    const evidence = buildSonarScopeEvidence({
      repoSlug: "Brad-Edwards/shifter",
      prNumber: 2114,
      headSha: "a9df89dae32854f0915230ffd17ba2fcb65aee68",
      projectKey: "Brad-Edwards_shifter",
      selector: null,
      checks: [normalizeCheckRollupEntry(checkRun("sonar", "SKIPPED"))],
      reason: "producer_skipped",
    });
    assert.equal(evidence.source, "github_check_runs");
    assert.equal(evidence.repo, "Brad-Edwards/shifter");
    assert.equal(evidence.pr_number, 2114);
    assert.equal(evidence.head_sha, "a9df89dae32854f0915230ffd17ba2fcb65aee68");
    assert.equal(evidence.project_key, "Brad-Edwards_shifter");
    assert.equal(evidence.selector, "default:/sonar/i");
    assert.equal(evidence.reason, "producer_skipped");
    assert.deepEqual(evidence.checks.map((c) => c.conclusion), ["skipped"]);
  });

  it("bounds the recorded check list so a nested payload cannot grow without limit", () => {
    const many = Array.from({ length: SONAR_SCOPE_EVIDENCE_CHECK_MAX + 5 }, (_, i) =>
      normalizeCheckRollupEntry(checkRun(`sonar-${i}`, "SKIPPED")));
    const evidence = buildSonarScopeEvidence({
      repoSlug: "o/r", prNumber: 1, headSha: "abc", projectKey: "k", selector: null,
      checks: many, reason: "producer_skipped",
    });
    assert.equal(evidence.checks.length, SONAR_SCOPE_EVIDENCE_CHECK_MAX);
    assert.equal(evidence.checks_truncated, true);
  });
});

describe("fetchSonarProducerEvidence", () => {
  it("reads the head, check runs, status contexts, and workflow names over REST on a pinned path (issue #1584)", async () => {
    const calls = [];
    const responses = {
      "/repos/autarchy-ai/Ground-Control/pulls/42": { number: 42, head: { sha: "deadbeef" } },
      "/repos/autarchy-ai/Ground-Control/commits/deadbeef/check-runs?per_page=100": [{
        check_runs: [{
          name: "SonarCloud", status: "completed", conclusion: "skipped", completed_at: "2026-09-06T15:59:10Z",
          details_url: "https://github.com/autarchy-ai/Ground-Control/actions/runs/777/job/1",
        }],
      }],
      "/repos/autarchy-ai/Ground-Control/commits/deadbeef/status": { statuses: [{ context: "SonarCloud Code Analysis", state: "pending" }] },
      "/repos/autarchy-ai/Ground-Control/actions/runs/777": { name: "Quality" },
    };
    const result = await fetchSonarProducerEvidence({
      repoRoot: "/repo",
      repoSlug: "autarchy-ai/Ground-Control",
      prNumber: 42,
      execFile: async (bin, args) => {
        calls.push({ bin, args });
        const path = args.find((arg) => arg.startsWith("/repos/"));
        return { stdout: JSON.stringify(responses[path]) };
      },
    });
    assert.ok(calls.every(({ bin, args }) => bin === "gh" && args[0] === "api" && !args.includes("graphql")));
    assert.ok(calls.every(({ args }) => args.find((arg) => arg.startsWith("/repos/")).startsWith("/repos/autarchy-ai/Ground-Control/")));
    assert.equal(result.headSha, "deadbeef");
    assert.deepEqual(result.entries, [
      { name: "SonarCloud", workflow_name: "Quality", status: "completed", conclusion: "skipped", completed_at: "2026-09-06T15:59:10Z" },
      { name: "SonarCloud Code Analysis", workflow_name: null, status: "pending", conclusion: null, completed_at: null },
    ]);
  });

  it("returns null rather than failing the watch when the read is unavailable", async () => {
    const result = await fetchSonarProducerEvidence({
      repoRoot: "/repo",
      repoSlug: "o/r",
      prNumber: 42,
      execFile: async () => { throw new Error("gh: not authenticated"); },
    });
    assert.equal(result, null);
  });
});
