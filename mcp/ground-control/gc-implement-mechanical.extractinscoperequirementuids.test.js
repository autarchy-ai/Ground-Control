// Split from gc-implement-mechanical.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractInScopeRequirementUids, runImplementMechanical } from "./gc-implement-mechanical.js";
import { REQUIREMENT_UID_GATE_ENV_VAR, requestedRequirementUidAuthorization } from "./lib.js";

const RECORD_ID = "c".repeat(32);

function context() {
  return {
    status: "ok",
    project: "ground-control",
    workflow: { base_branch: "dev", completion_command: "make check" },
  };
}

function baseDeps(overrides = {}) {
  const deps = {
    authorizeRepo: async (path) => ({ ok: true, repoRoot: path }),
    getContext: async () => context(),
    prepareBranch: async () => ({
      ok: true,
      repo_path: "/repo",
      branch: "1426-script-phases",
    }),
    getIssueThread: async () => ({
      ok: true,
      title: "Script phases",
      body: "## Requirements\n- GC-O007\n",
      labels: ["enhancement"],
      comments: [],
      url: "https://github.test/issues/1426",
      hash: "thread-hash",
    }),
    getRequirement: async (uid) => ({
      id: `id-${uid}`,
      uid,
      title: "Requirement",
      statement: "The system shall work.",
      status: "DRAFT",
      wave: 1,
    }),
    getTraceabilityByArtifact: async () => [{ id: "link-1" }],
    markPickedUp: async () => ({ ok: true, comment_url: "https://github.test/pickup" }),
    synchronize: async () => ({ ok: true, status: "complete", recordId: RECORD_ID }),
    watchCi: async () => ({ ok: true, conclusion: "success" }),
    watchSonar: async () => ({
      ok: true,
      quality_gate: "OK",
      issues_summary: { open_count: 0 },
      hotspots_summary: { open_count: 0 },
    }),
    assertCompletion: async ({ phase }) => ({
      ok: true,
      phase,
      readiness_report: phase === "pre_merge" ? "ready" : undefined,
    }),
    closeIssue: async () => ({ ok: true, closed: true }),
    readRunLane: async () => ({ ok: true, lane: "implement", pickup_found: false }),
    execFile: async () => ({ stdout: "", stderr: "" }),
  };
  Object.assign(deps, overrides);
  // Mirrors the production wiring: the authorizer binds the requested UID to
  // the same issue thread the rest of the run reads.
  deps.authorizeRequirementUid ??= async ({ requestedRequirementUid }) => {
    const thread = await deps.getIssueThread({});
    return requestedRequirementUidAuthorization(thread.body, requestedRequirementUid);
  };
  deps.runGit ??= async (repoRoot, argv, commandRunner) =>
    commandRunner("git", ["-C", repoRoot, ...argv], { cwd: repoRoot });
  deps.preCommit ??= async (repoRoot, commandRunner, context) =>
    commandRunner(
      "bash",
      ["-c", context?.workflow?.precommit_command ?? "pre-commit run --hook-stage pre-commit"],
      { cwd: repoRoot },
    );
  return deps;
}

describe("extractInScopeRequirementUids", () => {
  it("reads only valid UID bullets from a level 2-4 Requirements section", () => {
    const body = [
      "GC-OUTSIDE1",
      "### Requirements",
      "- `GC-O007`",
      "* GC-O-008, GC-O007",
      "- prose GC-O009 prose",
      "#### Detail",
      "+ GC-T010",
      "### Later",
      "- GC-OUTSIDE2",
    ].join("\n");
    assert.deepEqual(
      extractInScopeRequirementUids(body),
      ["GC-O007", "GC-O-008", "GC-T010"],
    );
  });

  it("extracts allocator-minted short UIDs (issue #1425)", () => {
    // The failure this guards is the one the issue describes: dropping APP-2
    // here turns a requirement-backed run into a requirement-free one, which
    // then trips the orphaned-link audit on a correct link.
    assert.deepEqual(
      extractInScopeRequirementUids("## Requirements\n- APP-2\n- `A-1`\n- PLAT-10"),
      ["APP-2", "A-1", "PLAT-10"],
    );
  });

  it("returns an empty set when the authoritative section is absent or empty", () => {
    assert.deepEqual(extractInScopeRequirementUids("Fix noted in GC-O007."), []);
    assert.deepEqual(extractInScopeRequirementUids("## Requirements\n\n## Notes\n- GC-O007"), []);
  });
});

describe("runImplementMechanical bootstrap", () => {
  it("rejects a requirement-backed quickfix before branch mutation or pickup", async () => {
    let prepareCalls = 0;
    let pickupCalls = 0;
    const result = await runImplementMechanical({
      action: "bootstrap",
      lane: "quickfix",
      repoPath: "/repo",
      invocationRoot: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      driver: "codex",
    }, baseDeps({
      prepareBranch: async () => {
        prepareCalls += 1;
        return { ok: true, repo_path: "/repo", branch: "1426-script-phases" };
      },
      markPickedUp: async () => {
        pickupCalls += 1;
        return { ok: true };
      },
    }));

    assert.equal(result.ok, false);
    assert.equal(result.error, "quickfix_requirements_in_scope");
    assert.deepEqual(result.requirement_uids, ["GC-O007"]);
    assert.equal(prepareCalls, 0);
    assert.equal(pickupCalls, 0);
  });

  it("uses the shared bootstrap with a quickfix-specific pickup on an empty scope", async () => {
    let pickupInput;
    const result = await runImplementMechanical({
      action: "bootstrap",
      lane: "quickfix",
      repoPath: "/repo",
      invocationRoot: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      driver: "codex",
    }, baseDeps({
      getIssueThread: async () => ({ ok: true, title: "Small fix", body: "", comments: [] }),
      markPickedUp: async (input) => {
        pickupInput = input;
        return { ok: true };
      },
    }));

    assert.equal(result.ok, true);
    assert.equal(pickupInput.lane, "quickfix");
    assert.equal(result.next_action, "implement_the_bounded_fix_and_run_targeted_tests");
  });

  it("prepares the branch, records pickup, and returns issue context in one call", async () => {
    let pickupCalls = 0;
    const result = await runImplementMechanical({
      action: "bootstrap",
      repoPath: "/repo",
      invocationRoot: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      driver: "codex",
    }, baseDeps({
      markPickedUp: async () => {
        pickupCalls += 1;
        return { ok: true };
      },
    }));

    assert.equal(result.ok, true);
    assert.equal(result.phase, "bootstrap_complete");
    assert.deepEqual(result.requirement_uids, ["GC-O007"]);
    assert.equal(result.in_scope_requirements[0].id, "id-GC-O007");
    assert.deepEqual(result.issue_traceability_links, [{ id: "link-1" }]);
    assert.equal(pickupCalls, 1);
  });

  // The pickup record is what the trusted lane reader derives a run's lane from,
  // so reuse must key on an exact trusted record (issue #1679, core-F5).
  const pickupRecord = (lane, branch, author = "gc-bot") => ({
    author,
    body: `🛠️ Picked up by /${lane} - driver codex, branch \`${branch}\`, 2026-09-21T00:00:00.000Z.`,
  });

  async function bootstrapWithComments(comments, { lane, onPickup, readRunLane }) {
    return runImplementMechanical({
      action: "bootstrap",
      repoPath: "/repo",
      invocationRoot: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      driver: "codex",
      ...(lane ? { lane } : {}),
    }, baseDeps({
      getIssueThread: async () => ({ ok: true, title: "Script phases", body: "", comments }),
      ...(readRunLane ? { readRunLane } : {}),
      authenticatedLogin: async () => "gc-bot",
      markPickedUp: async () => { onPickup(); return { ok: true }; },
    }));
  }

  it("does not duplicate an existing pickup record for the same branch", async () => {
    let pickupCalls = 0;
    const result = await bootstrapWithComments(
      [pickupRecord("implement", "1426-script-phases")],
      {
        onPickup: () => { pickupCalls += 1; },
        readRunLane: async () => ({ ok: true, lane: "implement", pickup_found: true }),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.pickup.reused, true);
    assert.equal(pickupCalls, 0);
  });

  // Issue #1679: the run's lane is the newest trusted pickup record for the
  // branch. When the maintainer says to move on without a review, the agent
  // bootstraps the same branch as /quickfix, and that must write a record - it is
  // the only place the switch is recorded before any gate reads it.
  it("records a switch from /implement to /quickfix on the same branch", async () => {
    let pickupLane = null;
    const result = await runImplementMechanical({
      action: "bootstrap",
      repoPath: "/repo",
      invocationRoot: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      driver: "codex",
      lane: "quickfix",
    }, baseDeps({
      getIssueThread: async () => ({
        ok: true, title: "Script phases", body: "",
        comments: [{ id: 1, ...pickupRecord("implement", "1426-script-phases") }],
      }),
      readRunLane: async () => ({ ok: true, lane: "implement", pickup_found: true }),
      markPickedUp: async (input) => { pickupLane = input.lane; return { ok: true }; },
    }));

    assert.equal(result.ok, true);
    assert.equal(pickupLane, "quickfix", "the switch must be written, not folded into the old record");
  });

  it("reuses the pickup when the branch's newest record is already this lane", async () => {
    let pickupCalls = 0;
    const result = await runImplementMechanical({
      action: "bootstrap",
      repoPath: "/repo",
      invocationRoot: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      driver: "codex",
      lane: "quickfix",
    }, baseDeps({
      getIssueThread: async () => ({
        ok: true, title: "Script phases", body: "",
        comments: [
          { id: 1, ...pickupRecord("implement", "1426-script-phases") },
          { id: 2, ...pickupRecord("quickfix", "1426-script-phases") },
        ],
      }),
      readRunLane: async () => ({ ok: true, lane: "quickfix", pickup_found: true }),
      markPickedUp: async () => { pickupCalls += 1; return { ok: true }; },
    }));

    assert.equal(result.ok, true);
    assert.equal(pickupCalls, 0);
  });

  it("reuses a trusted pickup through the shared lane reader without a server login", async () => {
    let pickupCalls = 0;
    const result = await runImplementMechanical({
      action: "bootstrap",
      repoPath: "/repo",
      invocationRoot: "/repo",
      issueNumber: 1426,
      branchName: "1426-script-phases",
      driver: "codex",
      lane: "quickfix",
    }, baseDeps({
      getIssueThread: async () => ({ ok: true, title: "Script phases", body: "", comments: [] }),
      authenticatedLogin: async () => { throw new Error("/user is unavailable"); },
      readRunLane: async () => ({ ok: true, lane: "quickfix", pickup_found: true }),
      markPickedUp: async () => { pickupCalls += 1; return { ok: true }; },
    }));

    assert.equal(result.ok, true);
    assert.equal(result.pickup.reused, true);
    assert.equal(pickupCalls, 0);
  });

  for (const [label, comments] of [
    ["prose that merely quotes the pickup text", [{
      author: "someone-else",
      body: "Picked up by /implement on branch `1426-script-phases` — is this still going?",
    }]],
    ["an exact record posted by somebody other than this server", [
      pickupRecord("implement", "1426-script-phases", "someone-else"),
    ]],
    ["this server's record for a different branch", [
      pickupRecord("implement", "1426-other-branch"),
    ]],
  ]) {
    it(`still writes an attributable record when the thread carries ${label}`, async () => {
      let pickupCalls = 0;
      const result = await bootstrapWithComments(comments, { onPickup: () => { pickupCalls += 1; } });

      assert.equal(result.ok, true);
      assert.equal(pickupCalls, 1, "without its own record the lane can never be derived");
    });
  }

  for (const [label, uid, expected] of [
    ["an invalid", "DSL-437; rm -rf /", "implement_requested_requirement_uid_invalid"],
    ["an out-of-scope", "OTHER-999", "implement_requested_requirement_uid_out_of_scope"],
  ]) {
    it(`refuses ${label} requirement UID before recording pickup (#1434)`, async () => {
      let pickupCalls = 0;
      const result = await runImplementMechanical({
        action: "bootstrap",
        repoPath: "/repo",
        invocationRoot: "/repo",
        issueNumber: 1434,
        branchName: "1426-script-phases",
        driver: "claude",
        requestedRequirementUid: uid,
      }, baseDeps({
        markPickedUp: async () => {
          pickupCalls += 1;
          return { ok: true };
        },
      }));

      assert.equal(result.ok, false);
      assert.equal(result.agent_required, true);
      assert.equal(result.error, expected);
      assert.equal(pickupCalls, 0);
    });
  }
});
