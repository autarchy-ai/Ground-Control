import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { inspectPhaseEWorkflow, verifyPhaseEReadiness } from "./lib/phase-e-readiness.js";

const workflow = (branches = "[main, dev]") => [
  "name: Ground Control Phase E",
  "on:",
  "  pull_request:",
  "    types: [closed]",
  `    branches: ${branches}`,
  "",
].join("\n");

const PR = { baseRefName: "dev", baseRefOid: "a".repeat(40) };
const authorize = async () => ({ ok: true, repoRoot: "/repo", owner: "acme", name: "widgets" });

describe("Phase E readiness workflow verification", () => {
  it("accepts a closed-pull-request trigger covering the delivery base", () => {
    assert.deepEqual(inspectPhaseEWorkflow(workflow(), "dev"), { ok: true });
    assert.deepEqual(inspectPhaseEWorkflow(workflow("['*']"), "release"), { ok: true });
  });

  it("rejects a workflow whose branch filter excludes the delivery base", () => {
    const result = inspectPhaseEWorkflow(workflow("[main]"), "dev");
    assert.equal(result.ok, false);
    assert.match(result.reason, /excludes delivery base 'dev'/);
  });

  it("rejects a workflow that cannot run when a pull request closes", () => {
    const result = inspectPhaseEWorkflow(workflow().replace("types: [closed]", "types: [opened]"), "dev");
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not include closed/);
  });

  it("fails closed for malformed workflow and branch-filter shapes", () => {
    const cases = [
      ["on: [", /workflow YAML is invalid/],
      ["name: no trigger\n", /does not configure the pull_request event/],
      [workflow("17"), /branches is not a string or string list/],
      [workflow().replace("branches: [main, dev]", "branches-ignore: 17"),
        /branches-ignore is not a string or string list/],
      [workflow().replace("branches: [main, dev]", "branches: [dev]\n    branches-ignore: [main]"),
        /both branches and branches-ignore/],
    ];
    for (const [text, reason] of cases) {
      const result = inspectPhaseEWorkflow(text, "dev");
      assert.equal(result.ok, false);
      assert.match(result.reason, reason);
    }
  });

  it("honors ignored branches and ordered negation patterns", () => {
    const ignored = workflow().replace("branches: [main, dev]", "branches-ignore: [dev]");
    assert.match(inspectPhaseEWorkflow(ignored, "dev").reason, /branches-ignore excludes/);
    assert.equal(inspectPhaseEWorkflow(workflow("['*', '!dev', dev]"), "dev").ok, true);
    assert.equal(inspectPhaseEWorkflow(workflow("['!dev']"), "dev").ok, false);
  });

  it("reads the workflow at the trusted base revision rather than the Actions registry", async () => {
    let path;
    const result = await verifyPhaseEReadiness({ repoPath: "/repo", prNumber: 17 }, {
      authorize,
      readPr: async () => PR,
      readJson: async (_root, requested) => {
        path = requested;
        return { type: "file", encoding: "base64", content: Buffer.from(workflow()).toString("base64"), sha: "b".repeat(40) };
      },
    });
    assert.equal(result.ok, true);
    assert.match(path, /contents\/\.github\/workflows\/ground-control-phase-e\.yml\?ref=a{40}$/);
  });

  it("fails distinctly when a registered workflow is absent from the base revision", async () => {
    const result = await verifyPhaseEReadiness({ repoPath: "/repo", prNumber: 17 }, {
      authorize,
      readPr: async () => PR,
      readJson: async () => { throw new Error("gh: Not Found (HTTP 404)"); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "phase_e_workflow_missing");
    assert.match(result.message, /grndctl init/);
    assert.match(result.message, /already-merged PR/);
    assert.match(result.message, /finalize-merged-pr/);
  });

  it("fails distinctly when the workflow excludes the PR base branch", async () => {
    const result = await verifyPhaseEReadiness({ repoPath: "/repo", prNumber: 17 }, {
      authorize,
      readPr: async () => PR,
      readJson: async () => ({
        type: "file", encoding: "base64", content: Buffer.from(workflow("[main]")).toString("base64"),
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "phase_e_workflow_inapplicable");
    assert.equal(result.next_action, "repair_phase_e_workflow_trigger_then_retry");
  });

  it("propagates authorization refusal without reading GitHub", async () => {
    let reads = 0;
    const result = await verifyPhaseEReadiness({ repoPath: "/repo", prNumber: 17 }, {
      authorize: async () => ({ ok: false, error: "implement_repo_not_authorized" }),
      readPr: async () => { reads += 1; return PR; },
    });
    assert.equal(result.error, "implement_repo_not_authorized");
    assert.equal(reads, 0);
  });

  it("fails closed when pull-request or workflow content evidence is unavailable", async () => {
    const prFailure = await verifyPhaseEReadiness({ repoPath: "/repo", prNumber: 17 }, {
      authorize,
      readPr: async () => { throw new Error("request failed"); },
    });
    assert.equal(prFailure.error, "phase_e_workflow_evidence_unavailable");

    const missingBase = await verifyPhaseEReadiness({ repoPath: "/repo", prNumber: 17 }, {
      authorize,
      readPr: async () => ({ baseRefName: "dev", baseRefOid: null }),
    });
    assert.equal(missingBase.error, "phase_e_workflow_evidence_unavailable");

    const apiFailure = await verifyPhaseEReadiness({ repoPath: "/repo", prNumber: 17 }, {
      authorize,
      readPr: async () => PR,
      readJson: async () => { throw new Error("rate limited"); },
    });
    assert.equal(apiFailure.error, "phase_e_workflow_evidence_unavailable");

    const unreadable = await verifyPhaseEReadiness({ repoPath: "/repo", prNumber: 17 }, {
      authorize,
      readPr: async () => PR,
      readJson: async () => ({ type: "dir" }),
    });
    assert.equal(unreadable.error, "phase_e_workflow_missing");
  });
});
