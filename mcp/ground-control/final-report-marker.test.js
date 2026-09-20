// The shared final-report marker helper and the verified automation trust class (#1671).
//
// `gc_close_issue_after_merge` closes an issue only when a TRUSTED `gc:final-report`
// marker proves post-merge requirement-state validation succeeded. Trust has always been
// repository write permission on the comment author, and `github-actions[bot]` reports
// `permission: "none"` — so an automated finalizer could validate correctly and still be
// unable to close. These tests pin the narrow second trust class that fixes it: a marker
// authored by the repository's own Actions identity counts only when the run it cites
// resolves, through the Actions API, to this repository's pinned finalizer workflow and is
// bound to this pull request. They also pin what the class must NOT unlock.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PHASE_E_WORKFLOW_PATH,
  verifyFinalizerRunProvenance,
} from "./lib/automation-provenance.js";
import {
  buildFinalizerRunMarker,
  findTrustedFinalReportMarker,
  parseFinalReportMarkers,
} from "./lib/final-report-marker.js";
import { buildFinalReportMarker } from "./lib/doc-coverage.js";

const ISSUE = 1671;
const PR = 1680;
const RUN = 987654321;

function humanComment(body, { id = 1, login = "maintainer" } = {}) {
  return { id, body, authorLogin: login, authorAssociation: "MEMBER", authorType: "User" };
}

// The body automation posts: the record's marker, then its provenance.
function reportWithRun(issue, pr, runId) {
  return [
    buildFinalReportMarker({ issueNumber: issue, prNumber: pr }),
    ...buildFinalizerRunMarker({ prNumber: pr, runId }),
  ].join("\n");
}

function botComment(body, { id = 2 } = {}) {
  return { id, body, authorLogin: "github-actions[bot]", authorAssociation: "NONE", authorType: "Bot" };
}

// The production resolver's two classes, stubbed: repo-write humans are trusted, and the
// repository's own Actions identity is recognised as automation but is not `isTrusted`.
async function resolveTrust(_repoRoot, _owner, _name, _comments) {
  return {
    isTrusted: (c) => c.authorType === "User" && c.authorLogin === "maintainer",
    isRepositoryAutomation: (c) => c.authorType === "Bot" && c.authorLogin === "github-actions[bot]",
  };
}

function runsApi(run) {
  return async (_repoRoot, path) => {
    assert.match(path, /\/actions\/runs\/\d+$/);
    if (run == null) throw new Error("HTTP 404: Not Found");
    return run;
  };
}

const GOOD_RUN = {
  path: PHASE_E_WORKFLOW_PATH,
  event: "pull_request",
  repository: { full_name: "autarchy-ai/Ground-Control" },
  pull_requests: [{ number: PR }],
};

function find(comments, { run = GOOD_RUN } = {}) {
  return findTrustedFinalReportMarker(
    { repoRoot: "/repo", owner: "autarchy-ai", name: "Ground-Control", issueNumber: ISSUE, prNumber: PR },
    { readComments: async () => comments, resolveTrust, ghJson: runsApi(run) },
  );
}

describe("final-report marker parsing", () => {
  it("leaves the record's own marker untouched, so existing reports still match", () => {
    const marker = buildFinalReportMarker({ issueNumber: ISSUE, prNumber: PR });
    assert.equal(marker, `<!-- gc:final-report issue="${ISSUE}" pr="${PR}" -->`);
    const [parsed] = parseFinalReportMarkers(marker);
    assert.deepEqual(parsed, { issue: ISSUE, pr: PR });
  });

  it("adds provenance as a separate marker only when automation is the author", () => {
    assert.deepEqual(buildFinalizerRunMarker({ prNumber: PR, runId: null }), []);
    assert.deepEqual(
      buildFinalizerRunMarker({ prNumber: PR, runId: RUN }),
      [`<!-- gc:finalizer-run pr="${PR}" id="${RUN}" -->`],
    );
  });
});

describe("trusted final-report marker", () => {
  it("trusts a repo-write human, with no Actions lookup at all", async () => {
    const result = await findTrustedFinalReportMarker(
      { repoRoot: "/repo", owner: "autarchy-ai", name: "Ground-Control", issueNumber: ISSUE, prNumber: PR },
      {
        readComments: async () => [humanComment(buildFinalReportMarker({ issueNumber: ISSUE, prNumber: PR }))],
        resolveTrust,
        ghJson: async () => assert.fail("a human-authored marker must not need run provenance"),
      },
    );
    assert.equal(result.found, true);
    assert.equal(result.viaAutomation, false);
  });

  it("trusts the repository's own finalizer run", async () => {
    const result = await find([botComment(reportWithRun(ISSUE, PR, RUN))]);
    assert.equal(result.found, true);
    assert.equal(result.viaAutomation, true);
  });

  it("rejects a bot marker citing no run", async () => {
    const result = await find([botComment(buildFinalReportMarker({ issueNumber: ISSUE, prNumber: PR }))]);
    assert.equal(result.found, false);
  });

  it("rejects a bot marker whose run belongs to another workflow", async () => {
    const result = await find(
      [botComment(reportWithRun(ISSUE, PR, RUN))],
      { run: { ...GOOD_RUN, path: ".github/workflows/ci.yml" } },
    );
    assert.equal(result.found, false);
  });

  it("rejects a bot marker whose run is bound to a different pull request", async () => {
    const result = await find(
      [botComment(reportWithRun(ISSUE, PR, RUN))],
      { run: { ...GOOD_RUN, pull_requests: [{ number: 4242 }] } },
    );
    assert.equal(result.found, false);
  });

  it("rejects a bot marker whose run cannot be resolved", async () => {
    const result = await find(
      [botComment(reportWithRun(ISSUE, PR, RUN))],
      { run: null },
    );
    assert.equal(result.found, false);
  });

  it("rejects a marker from an unprivileged commenter impersonating the shape", async () => {
    const forged = humanComment(reportWithRun(ISSUE, PR, RUN), {
      login: "drive-by",
    });
    const result = await find([forged]);
    assert.equal(result.found, false);
  });

  it("does not accept a marker bound to a different pull request on the same issue", async () => {
    const stale = humanComment(buildFinalReportMarker({ issueNumber: ISSUE, prNumber: 1599 }));
    const result = await find([stale]);
    assert.equal(result.found, false);
  });
});

describe("finalizer run provenance", () => {
  const dispatch = (overrides = {}) => ({ ...GOOD_RUN, event: "workflow_dispatch", pull_requests: [], ...overrides });

  it("accepts a maintainer-started dispatch run bound by the name the workflow gave it", async () => {
    const ok = await verifyFinalizerRunProvenance(
      { repoRoot: "/repo", owner: "autarchy-ai", name: "Ground-Control", prNumber: PR, runId: RUN },
      { ghJson: runsApi(dispatch({ display_title: `Ground Control Phase E for PR ${PR}` })) },
    );
    assert.equal(ok, true);
  });

  // Run ids are public. Accepting a dispatch run on its event alone would let one real run
  // vouch for any issue and pull request a comment cared to name.
  it("rejects a dispatch run whose name binds it to nothing", async () => {
    const ok = await verifyFinalizerRunProvenance(
      { repoRoot: "/repo", owner: "autarchy-ai", name: "Ground-Control", prNumber: PR, runId: RUN },
      { ghJson: runsApi(dispatch({ display_title: "Ground Control Phase E" })) },
    );
    assert.equal(ok, false);
  });

  it("rejects a dispatch run that names a different pull request", async () => {
    const ok = await verifyFinalizerRunProvenance(
      { repoRoot: "/repo", owner: "autarchy-ai", name: "Ground-Control", prNumber: PR, runId: RUN },
      { ghJson: runsApi(dispatch({ display_title: "Ground Control Phase E for PR 4242" })) },
    );
    assert.equal(ok, false);
  });

  it("does not let a longer number satisfy a shorter one", async () => {
    const ok = await verifyFinalizerRunProvenance(
      { repoRoot: "/repo", owner: "autarchy-ai", name: "Ground-Control", prNumber: 168, runId: RUN },
      { ghJson: runsApi(dispatch({ display_title: "Ground Control Phase E for PR 1680" })) },
    );
    assert.equal(ok, false);
  });

  it("rejects a run recorded against another repository", async () => {
    const ok = await verifyFinalizerRunProvenance(
      { repoRoot: "/repo", owner: "autarchy-ai", name: "Ground-Control", prNumber: PR, runId: RUN },
      { ghJson: runsApi({ ...GOOD_RUN, repository: { full_name: "someone/else" } }) },
    );
    assert.equal(ok, false);
  });
});
