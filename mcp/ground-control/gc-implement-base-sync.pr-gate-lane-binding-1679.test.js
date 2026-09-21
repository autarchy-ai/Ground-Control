// The synchronized PR gate used to take the caller's word for which lane a run
// belonged to. `lane: "quickfix"` plus an issue with no requirement UIDs waived
// the mandatory pre-push review gate — but a requirement-free issue is an
// ordinary `/implement` target too, so the pair proved nothing and any caller
// could open a PR for work that was never reviewed (issue #1679).
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

// Reaching Git at all means the review gate let the call through; these tests
// only care which side of that gate the call landed on.
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

  it("still requires a published review for an /implement run on a requirement-free issue", async () => {
    const result = await createPr({ lane: "implement", derivedLane: "implement" });

    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_pr_review_publication_missing");
  });

  it("requires a published review when the caller states no lane at all", async () => {
    const result = await createPr({ lane: undefined, derivedLane: "implement" });

    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_pr_review_publication_missing");
  });

  it("waives the review gate only for a run the server picked up as /quickfix", async () => {
    const result = await createPr({ lane: "quickfix", derivedLane: "quickfix" });

    // The waiver was granted, so the call proceeded to the synchronization
    // checks; nothing else about the gate was relaxed.
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
