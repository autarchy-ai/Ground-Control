// The synchronized PR gate used to take the caller's word for which lane a run
// belonged to. The lane remains a delivery authority even though issue #1693
// makes review publication observational rather than a PR-creation condition.
//
// The lane is now derived from the pickup record the MCP server wrote under its
// own identity. These drive the gate far enough to observe which branch it took:
// a refused review gate never reaches Git, and a granted waiver falls through to
// the synchronization checks below it.

import { execFile as execFileCb } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCreateSynchronizedImplementPr } from "./lib.js";

const execFile = promisify(execFileCb);
const REPO_ROOT = realpathSync(new URL("../..", import.meta.url).pathname);
const ISSUE = 1679;
const BRANCH = "1679-review-gate-ci-fixes";
const RECORD = "4".repeat(32);

function prBody() {
  return [
    "## Summary", "", "summary", "",
    "## Requirement UIDs", "", "- (none)", "",
    "## Related Issues", "", `Closes #${ISSUE}`, "",
    "## ADR Impact", "", "- ADR-021", "",
    "## Changes", "", "- change", "",
    "## Test Plan", "", "- tests", "",
    "## Ground Control Checks", "",
    "- [x] Repository policy checks required in CI before merge",
    "- [x] Pre-push Codex review completed; all findings fixed or dispositioned",
    "", "## Traceability", "", "- IMPLEMENTS: n/a", "- TESTS: n/a", "",
    "## Checklist", "", "- [x] done",
  ].join("\n");
}

async function workspaceAuthorization() {
  const [gitDir, gitCommonDir, origin] = await Promise.all([
    execFile("git", ["-C", REPO_ROOT, "rev-parse", "--absolute-git-dir"]),
    execFile("git", ["-C", REPO_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    execFile("git", ["-C", REPO_ROOT, "remote", "get-url", "origin"]),
  ]);
  return {
    workspaceRoot: REPO_ROOT,
    gitDir: realpathSync(gitDir.stdout.trim()),
    gitCommonDir: realpathSync(gitCommonDir.stdout.trim()),
    origin: origin.stdout.trim(),
    owner: "autarchy-ai",
    name: "ground-control",
  };
}

// Reaching Git means lane derivation accepted the call; these tests only care
// which side of that authority boundary the call landed on.
const PAST_THE_GATE = "reached the synchronization boundary";

async function createPr({ lane, derivedLane, reviewPublished = false }) {
  return runCreateSynchronizedImplementPr({
    repoPath: REPO_ROOT,
    issueNumber: ISSUE,
    branchName: BRANCH,
    recordId: RECORD,
    title: "fix: close the reported review-gate claims",
    body: prBody(),
    ...(lane === undefined ? {} : { lane }),
  }, {
    workspaceAuthorizationResolver: workspaceAuthorization,
    contextResolver: async () => ({ status: "ok", workflow: { base_branch: "dev", pr_title: null } }),
    issueThreadReader: async () => ({ ok: true, body: "## Description\nNo requirements.\n" }),
    reviewEvidenceReader: async () => ({ ok: true, published: reviewPublished }),
    laneReader: async () => ({ ok: true, lane: derivedLane }),
    commandRunner: async () => { throw new Error(PAST_THE_GATE); },
  });
}

describe("the PR gate derives the lane instead of accepting it (#1679)", () => {
  it("refuses the review waiver for an /implement run that asks for it", async () => {
    const result = await createPr({ lane: "quickfix", derivedLane: "implement" });

    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_pr_lane_mismatch");
  });

  it("does not require a published review for an /implement run", async () => {
    const result = await createPr({ lane: "implement", derivedLane: "implement" });

    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_pr_create_failed");
  });

  it("does not require a published review when the caller states no lane", async () => {
    const result = await createPr({ lane: undefined, derivedLane: "implement" });

    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_pr_create_failed");
  });

  it("continues with a server-picked quickfix lane", async () => {
    const result = await createPr({ lane: "quickfix", derivedLane: "quickfix" });

    // The lane was accepted, so the call proceeded to synchronization checks.
    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_pr_create_failed");
    assert.notEqual(result.error, "implement_pr_review_publication_missing");
  });

  it("refuses rather than guessing when the lane cannot be derived", async () => {
    const result = await runCreateSynchronizedImplementPr({
      repoPath: REPO_ROOT,
      issueNumber: ISSUE,
      branchName: BRANCH,
      recordId: RECORD,
      title: "fix: close the reported review-gate claims",
      body: prBody(),
      lane: "quickfix",
    }, {
      workspaceAuthorizationResolver: workspaceAuthorization,
      contextResolver: async () => ({ status: "ok", workflow: { base_branch: "dev", pr_title: null } }),
      issueThreadReader: async () => ({ ok: true, body: "## Description\nNo requirements.\n" }),
      reviewEvidenceReader: async () => ({ ok: true, published: false }),
      laneReader: async () => ({ ok: false, error: "run_lane_unverifiable", message: "no identity" }),
      commandRunner: async () => { throw new Error(PAST_THE_GATE); },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "run_lane_unverifiable");
  });
});
