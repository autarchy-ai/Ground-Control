// Waived and superseded review stations through the real completion path (issue #1578).
//
// #378: a merged, fully green delivery could not complete because (a) a codex observation left
// open by an incomplete-coverage attempt was never reconciled by the later codex verdict, and
// (b) a test-quality station that failed twice had no durable way to be waived. This drives the
// thread through the station-owned writers, the waiver tool, and gc_assert_completion against a
// stateful fake `gh`, so every record is posted and replayed exactly as in production.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";
import {
  buildExecutionObligationV2Marker,
  buildStationObservationObligationId,
  buildStationVerdictMarker,
  buildStationWaiverCommand,
  guardStationReobservation,
  readOpenStationObservationsFromLedger,
  runAssertCompletion,
  runPostFinalReport,
  runWaiveStationObservation,
} from "./lib.js";

const ISSUE = 378;
const MCP = "gc-mcp";
const WRITER = "maintainer";
const CODEX_C1 = buildStationObservationObligationId({ stationId: "codex_review", logicalCycle: 1 });
const TQ_C1 = buildStationObservationObligationId({ stationId: "test_quality_review", logicalCycle: 1 });
const OUTCOME = "Completion accounts for the waived test-quality station.";

let repo;
let bin;
let statePath;

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gc-station-waiver-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README"), "x\n");
  execFileSync("git", ["-C", dir, "add", "README"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
  return dir;
}

function authorization() {
  const gitDir = realpathSync(
    execFileSync("git", ["-C", repo, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim(),
  );
  return {
    workspaceRoot: realpathSync(repo), gitDir, gitCommonDir: gitDir,
    origin: "https://github.com/fake/repo.git", owner: "fake", name: "repo",
  };
}

// Stateful fake: comments persist across calls, POSTs are authored by the MCP identity, and
// repository permission is granted only to the MCP identity and the maintainer.
function installGh() {
  writeFileSync(statePath, JSON.stringify({ nextId: 5000, comments: [] }));
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const argv = process.argv.slice(2);
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (argv[0] === "api" && argv[1] === "user") out(${JSON.stringify(MCP)} + "\\n");
if (argv[0] === "repo" && argv[1] === "view") out(JSON.stringify({ nameWithOwner: "fake/repo" }));
const permission = argv.find((a) => a.includes("/collaborators/") && a.endsWith("/permission"));
if (permission) {
  const login = decodeURIComponent(permission.split("/collaborators/")[1].split("/permission")[0]);
  if (${JSON.stringify([MCP, WRITER])}.includes(login)) out("write\\n");
  process.stderr.write("HTTP 404"); process.exit(1);
}
if (argv[0] === "api" && argv[1] === "graphql") {
  const pr = { __typename: "PullRequest", number: 42, state: "MERGED", mergedAt: "2026-09-01T00:00:00Z",
    url: "https://github.com/fake/repo/pull/42" };
  out(JSON.stringify({ data: { repository: { issue: { timelineItems: { nodes: [
    { __typename: "CrossReferencedEvent", source: pr }] } } } } }));
}
const endpoint = argv.find((a) => a.startsWith("/repos/")) || "";
if (endpoint.endsWith("/comments") && argv.includes("GET")) {
  out(JSON.stringify([state.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.author } }))]));
}
if (endpoint.endsWith("/comments")) {
  const field = argv[argv.indexOf("-f") + 1];
  const id = state.nextId++;
  state.comments.push({ id, author: ${JSON.stringify(MCP)}, body: field.slice("body=".length) });
  fs.writeFileSync(statePath, JSON.stringify(state));
  const url = "https://github.com/fake/repo/issues/${ISSUE}#issuecomment-" + id;
  out(argv.includes("--jq") ? url + "\\n" : JSON.stringify({ id, html_url: url }));
}
if (endpoint.startsWith("/repos/fake/repo/issues/")) {
  out(JSON.stringify({ number: ${ISSUE}, title: "t", body: "", state: "open", labels: [] }));
}
process.stderr.write("gh fake: unhandled argv " + JSON.stringify(argv)); process.exit(2);
`;
  writeFileSync(join(bin, "gh"), source, { mode: 0o755 });
}

/** Append a comment as a human or as the server, the way the real thread accumulates. */
function post(author, body) {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const id = state.nextId++;
  state.comments.push({ id, author, body });
  writeFileSync(statePath, JSON.stringify(state));
  return { id, url: `https://github.com/fake/repo/issues/${ISSUE}#issuecomment-${id}` };
}

function observation(station, event) {
  return buildExecutionObligationV2Marker({
    issueNumber: ISSUE,
    obligationId: buildStationObservationObligationId({ stationId: station, logicalCycle: 1 }),
    event, kind: "station_observation", stationId: station, logicalCycle: 1,
  });
}

/**
 * The #378 thread up to the point the user authorizes continuing without test-quality.
 *
 * The codex outage is reconciled the way a later invocation now does it: the seam recovers the
 * open obligation from the durable ledger (not from the invocation that opened it), the
 * station-owned writer posts a verdict-stamped findings record, and the shared guard resolves the
 * recovered obligation before the cycle marker.
 */
async function build378Thread() {
  post(MCP, observation("codex_review", "opened"));
  post(MCP, observation("codex_review", "escalated"));
  const recovered = await readOpenStationObservationsFromLedger({
    repoPath: repo, issueNumber: ISSUE, stationId: "codex_review",
    workspaceAuthorizationResolver: async () => authorization(),
  });
  assert.deepEqual(recovered, [{ obligationId: CODEX_C1, stationId: "codex_review", logicalCycle: 1 }]);
  const record = post(MCP, `${buildStationVerdictMarker({ issueNumber: ISSUE, stationId: "codex_review", logicalCycle: 1 })}\n\n**gc_codex_review** — cycle 1`);
  const failure = await guardStationReobservation({
    stationObservations: recovered,
    observedCycle: 1, findingsCommentUrl: record.url, repoRoot: repo, issueNumber: ISSUE,
    owner: "fake", name: "repo", buildFailure: (message) => ({ ok: false, message }),
  });
  assert.equal(failure, null);
  post(MCP, `<!-- gc:codex-prepush-cycle issue="${ISSUE}" branch="378-x" cycle="1" -->`);
  post(MCP, observation("test_quality_review", "opened"));
  post(MCP, observation("test_quality_review", "escalated"));
  return post(WRITER, buildStationWaiverCommand({ stationId: "test_quality_review", obligationIds: [TQ_C1] }));
}

function completion(reviews) {
  return runAssertCompletion({
    repoPath: repo, issueNumber: ISSUE, prNumber: 42, requirements: [], reviews,
    ciStatus: "green", sonarStatus: "passed", plainEnglishOutcome: OUTCOME,
  }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo) });
}

async function withGh(fn) {
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try { return await fn(); } finally { process.env.PATH = old; }
}

describe("#378: waived and superseded stations at completion", () => {
  beforeEach(() => {
    repo = initRepo();
    bin = mkdtempSync(join(tmpdir(), "gc-station-waiver-bin-"));
    statePath = join(bin, "state.json");
    installGh();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it("refuses completion while the test-quality station is unobserved and unwaived", async () => {
    await withGh(async () => {
      await build378Thread();
      const result = await completion([{ reviewer: "codex", summary: "1 cycle, findings fixed" }]);
      assert.equal(result.ok, false);
      assert.equal(result.error, "completion_open_execution_obligations");
      // The codex outage is reconciled by its later verdict; only the unwaived station blocks.
      assert.deepEqual(result.open_obligation_ids, [TQ_C1]);
    });
  });

  it("completes once the exact waiver is recorded, reporting the missing verdict", async () => {
    await withGh(async () => {
      const source = await build378Thread();
      const waiver = await runWaiveStationObservation({
        repoPath: repo, issueNumber: ISSUE, stationId: "test_quality_review",
        obligationIds: [TQ_C1], authorizationSourceUrl: source.url,
      }, { workspaceAuthorizationResolver: async () => authorization() });
      assert.equal(waiver.ok, true, JSON.stringify(waiver));
      assert.equal(waiver.already_recorded, false);

      const replay = await runWaiveStationObservation({
        repoPath: repo, issueNumber: ISSUE, stationId: "test_quality_review",
        obligationIds: [TQ_C1], authorizationSourceUrl: source.url,
      }, { workspaceAuthorizationResolver: async () => authorization() });
      assert.equal(replay.already_recorded, true);

      const result = await completion([{ reviewer: "codex", summary: "1 cycle, findings fixed" }]);
      assert.equal(result.ok, true, JSON.stringify(result));
      const { comments } = JSON.parse(readFileSync(statePath, "utf8"));
      const report = comments.find((c) => c.id === result.final_report.comment_id).body;
      assert.match(report, /### Waived review stations/);
      assert.match(report, new RegExp(`test_quality_review\` cycle 1 \\(\`${TQ_C1}\`\\) — no verdict; waived by \`${WRITER}\``));
    });
  });

  it("refuses a report that claims the waived reviewer completed", async () => {
    await withGh(async () => {
      const source = await build378Thread();
      await runWaiveStationObservation({
        repoPath: repo, issueNumber: ISSUE, stationId: "test_quality_review",
        obligationIds: [TQ_C1], authorizationSourceUrl: source.url,
      }, { workspaceAuthorizationResolver: async () => authorization() });
      const result = await completion([
        { reviewer: "codex", summary: "1 cycle, findings fixed" },
        { reviewer: "test-quality", summary: "clean" },
      ]);
      assert.equal(result.ok, false);
      assert.equal(result.error, "final_report_waived_station_review_claimed");
    });
  });

  it("refuses a waiver whose source is not an exact command from a writer", async () => {
    await withGh(async () => {
      await build378Thread();
      const prose = post(WRITER, "Fine to continue without the test-quality review.");
      const outsider = post("drive-by", buildStationWaiverCommand({ stationId: "test_quality_review", obligationIds: [TQ_C1] }));
      for (const source of [prose, outsider]) {
        const result = await runWaiveStationObservation({
          repoPath: repo, issueNumber: ISSUE, stationId: "test_quality_review",
          obligationIds: [TQ_C1], authorizationSourceUrl: source.url,
        }, { workspaceAuthorizationResolver: async () => authorization() });
        assert.equal(result.error, "station_waiver_authorization_unverifiable");
      }
      const state = await completion([{ reviewer: "codex", summary: "1 cycle" }]);
      assert.equal(state.error, "completion_open_execution_obligations");
    });
  });

  it("refuses to waive an obligation of another station or one that is not open", async () => {
    await withGh(async () => {
      await build378Thread();
      const codexSource = post(WRITER, buildStationWaiverCommand({ stationId: "codex_review", obligationIds: [CODEX_C1] }));
      const result = await runWaiveStationObservation({
        repoPath: repo, issueNumber: ISSUE, stationId: "codex_review",
        obligationIds: [CODEX_C1], authorizationSourceUrl: codexSource.url,
      }, { workspaceAuthorizationResolver: async () => authorization() });
      assert.equal(result.error, "station_waiver_obligation_not_open");
    });
  });

  it("accepts a verified codex waiver in place of the mandatory codex review entry", async () => {
    await withGh(async () => {
      post(MCP, observation("codex_review", "opened"));
      const source = post(WRITER, buildStationWaiverCommand({ stationId: "codex_review", obligationIds: [CODEX_C1] }));
      const noWaiver = await runPostFinalReport({
        repoPath: repo, issueNumber: ISSUE, prNumber: 42, requirements: [], reviews: [],
        ciStatus: "green", sonarStatus: "passed", plainEnglishOutcome: OUTCOME,
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo) });
      assert.equal(noWaiver.error, "final_report_no_reviews");
      const waiver = await runWaiveStationObservation({
        repoPath: repo, issueNumber: ISSUE, stationId: "codex_review",
        obligationIds: [CODEX_C1], authorizationSourceUrl: source.url,
      }, { workspaceAuthorizationResolver: async () => authorization() });
      assert.equal(waiver.ok, true, JSON.stringify(waiver));
      const report = await runPostFinalReport({
        repoPath: repo, issueNumber: ISSUE, prNumber: 42, requirements: [], reviews: [],
        ciStatus: "green", sonarStatus: "passed", plainEnglishOutcome: OUTCOME,
      }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(repo) });
      assert.equal(report.ok, true, JSON.stringify(report));
    });
  });

  it("reads waiver evidence and posts only for the MCP launch workspace", async () => {
    await withGh(async () => {
      const source = await build378Thread();
      // The server was launched for a different checkout: nothing may be read from or posted to
      // the caller-selected repository, whatever its ledger says.
      const launched = initRepo();
      try {
        const elsewhere = { workspaceAuthorizationResolver: async () => ({ ...authorization(), workspaceRoot: realpathSync(launched) }) };
        const recover = (resolver) => readOpenStationObservationsFromLedger({
          repoPath: repo, issueNumber: ISSUE, stationId: "test_quality_review", ...resolver,
        });
        assert.equal((await recover({ workspaceAuthorizationResolver: async () => authorization() })).length, 1);
        assert.deepEqual(await recover(elsewhere), []);
        const refusedWaiver = await runWaiveStationObservation({
          repoPath: repo, issueNumber: ISSUE, stationId: "test_quality_review",
          obligationIds: [TQ_C1], authorizationSourceUrl: source.url,
        }, elsewhere);
        assert.equal(refusedWaiver.ok, false);
        await runWaiveStationObservation({
          repoPath: repo, issueNumber: ISSUE, stationId: "test_quality_review",
          obligationIds: [TQ_C1], authorizationSourceUrl: source.url,
        }, { workspaceAuthorizationResolver: async () => authorization() });
        const before = JSON.parse(readFileSync(statePath, "utf8")).comments.length;
        const completed = await runAssertCompletion({
          repoPath: repo, issueNumber: ISSUE, prNumber: 42, requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle" }],
          ciStatus: "green", sonarStatus: "passed", plainEnglishOutcome: OUTCOME,
        }, elsewhere);
        assert.equal(completed.error, "completion_repo_not_authorized");
        const report = await runPostFinalReport({
          repoPath: repo, issueNumber: ISSUE, prNumber: 42, requirements: [],
          reviews: [{ reviewer: "codex", summary: "1 cycle" }],
          ciStatus: "green", sonarStatus: "passed", plainEnglishOutcome: OUTCOME,
        }, elsewhere);
        assert.equal(report.error, "final_report_repo_not_authorized");
        assert.equal(JSON.parse(readFileSync(statePath, "utf8")).comments.length, before);
      } finally {
        rmSync(launched, { recursive: true, force: true });
      }
    });
  });
});
