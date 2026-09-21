// `/quickfix` waives the mandatory pre-push review gate. Until issue #1679 the
// waiver was granted by a bare `lane` argument on the PR-creation call, so
// nothing recorded the choice and an `/implement` run could take it at its last
// step.
//
// A lane is now a property of the run: the MCP server records it in a pickup
// comment under its own identity when a branch is bootstrapped, and the branch's
// lane is the newest such record. Switching lanes - the maintainer telling an
// agent to move on without a review - is therefore itself recorded, and no
// further human signal is required.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { currentPickupLane, laneClaimRefusal, readTrustedRunLane } from "./lib.js";

const OWNER = "fake";
const NAME = "repo";
const ISSUE = 1679;
const BRANCH = "1679-review-gate-ci-fixes";
const SERVER = "gc-bot";

const pickup = (lane, id, { branch = BRANCH, login = SERVER } = {}) => ({
  id,
  body: `🛠️ Picked up by /${lane} - driver claude, branch \`${branch}\`, 2026-09-21T00:00:00.000Z.`,
  authorLogin: login,
});

function read(comments, { login = SERVER } = {}) {
  return readTrustedRunLane(
    { repoRoot: "/repo", owner: OWNER, name: NAME, issueNumber: ISSUE, branchName: BRANCH },
    { readComments: async () => comments, authenticatedLogin: async () => login },
  );
}

describe("the run lane is the branch's newest recorded pickup (#1679)", () => {
  it("derives quickfix from this server's quickfix pickup record", async () => {
    const result = await read([pickup("quickfix", 1)]);
    assert.equal(result.ok, true);
    assert.equal(result.lane, "quickfix");
  });

  it("derives implement from this server's implement pickup record", async () => {
    assert.equal((await read([pickup("implement", 1)])).lane, "implement");
  });

  it("treats a branch with no pickup record as /implement, so absence waives nothing", async () => {
    assert.equal((await read([])).lane, "implement");
  });

  // The maintainer's "move on without a review": the agent bootstraps the same
  // branch as /quickfix, which records the switch; nothing else is needed.
  it("follows a recorded switch from /implement to /quickfix", async () => {
    assert.equal((await read([pickup("implement", 1), pickup("quickfix", 2)])).lane, "quickfix");
  });

  it("follows a recorded switch back to /implement", async () => {
    assert.equal((await read([pickup("implement", 1), pickup("quickfix", 2), pickup("implement", 3)])).lane, "implement");
  });

  it("orders by comment id, not by the order the API happened to return", async () => {
    assert.equal((await read([pickup("quickfix", 9), pickup("implement", 4)])).lane, "quickfix");
  });

  it("ignores a pickup-shaped comment posted by anyone but this server", async () => {
    // Otherwise any commenter could switch a run onto the waived lane.
    const result = await read([pickup("implement", 1), pickup("quickfix", 2, { login: "someone-else" })]);
    assert.equal(result.lane, "implement");
  });

  it("ignores a pickup recorded for a different branch", async () => {
    const result = await read([pickup("implement", 1), pickup("quickfix", 2, { branch: "1679-other-branch" })]);
    assert.equal(result.lane, "implement");
  });

  it("ignores pickup-shaped prose that is not the server's exact record", async () => {
    const forged = {
      id: 2,
      authorLogin: SERVER,
      body: `Note: 🛠️ Picked up by /quickfix - driver claude, branch \`${BRANCH}\`, 2026-09-21T00:00:00.000Z. (quoted)`,
    };
    assert.equal((await read([pickup("implement", 1), forged])).lane, "implement");
  });

  it("refuses rather than guessing when the server's own identity is unknown", async () => {
    const result = await read([pickup("quickfix", 1)], { login: null });
    assert.equal(result.ok, false);
    assert.equal(result.error, "run_lane_unverifiable");
  });

  it("refuses rather than guessing when the thread cannot be read", async () => {
    const result = await readTrustedRunLane(
      { repoRoot: "/repo", owner: OWNER, name: NAME, issueNumber: ISSUE, branchName: BRANCH },
      { readComments: async () => { throw new Error("gh api 502"); }, authenticatedLogin: async () => SERVER },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "run_lane_unverifiable");
  });

  it("reports no lane at all for a branch this server never picked up", () => {
    assert.equal(currentPickupLane([pickup("quickfix", 1, { login: "other" })], SERVER, BRANCH), null);
  });
});

// One rule for every consumer that relaxes a gate for /quickfix: a caller's
// stated lane must agree with the recorded one.
describe("a caller's stated lane is an assertion that must agree (#1679)", () => {
  it("agrees when no lane is stated or the lanes match", () => {
    assert.equal(laneClaimRefusal({ ok: true, lane: "implement" }, undefined), null);
    assert.equal(laneClaimRefusal({ ok: true, lane: "quickfix" }, "quickfix"), null);
  });

  it("refuses a mismatch in either direction, and says how to switch", () => {
    const refusal = laneClaimRefusal({ ok: true, lane: "implement" }, "quickfix");
    assert.equal(refusal.reason, "lane_mismatch");
    assert.match(refusal.message, /bootstrap the branch in that lane first/);
    assert.equal(laneClaimRefusal({ ok: true, lane: "quickfix" }, "implement").reason, "lane_mismatch");
  });
});
