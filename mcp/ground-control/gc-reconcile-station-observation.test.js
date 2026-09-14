// gc_reconcile_station_observation end to end over a gh shim (issue #1582).
//
// Replays the Shifter #2123 thread: an observation opened by one cycle-tool call, a verdict and
// cycle marker posted by a later call without the resolution, and a generic v1 `fix` that cannot
// close it. Completion must name the obligation as recoverable, the tool must resolve it from the
// durable records alone, and the resolution it writes must be one replay accepts.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexReviewPrePushCycleMarker,
  buildExecutionObligationMarker,
  buildExecutionObligationV2Marker,
  findRecoverableStationObservations,
  readTrustedExecutionObligationState,
  runAssertCompletion,
  runReconcileStationObservation,
} from "./lib.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

const ISSUE = 2123;
const BRANCH = "2123-model-broker-boundary";
const OBLIGATION = "STATION-OBS-CODEX-REVIEW-C1";
const TRUSTED = "gc-bot";
const recordUrl = (id) => `https://github.com/fake/repo/issues/${ISSUE}#issuecomment-${id}`;

const OPENED = buildExecutionObligationV2Marker({
  issueNumber: ISSUE, obligationId: OBLIGATION, event: "opened",
  kind: "station_observation", stationId: "codex_review", logicalCycle: 1,
});
const RECORD =
  `**gc_codex_review** — cycle 1 of 1 (pre-push) on issue #${ISSUE} (branch \`${BRANCH}\`)\n` +
  "**Diff mode:** inline\n\n## Core review\n\n**Verdict:** `ship-with-fixes`";
const MARKER = buildCodexReviewPrePushCycleMarker({ issueNumber: ISSUE, branchName: BRANCH, cycleNumber: 1 });
const GENERIC_FIX = buildExecutionObligationMarker({
  issueNumber: ISSUE, obligationId: OBLIGATION, event: "resolved", disposition: "fix",
});

function rawComment(id, body, login = TRUSTED) {
  return { id, body, user: { login }, author_association: "OWNER" };
}

const SHIFTER_THREAD = [
  rawComment(5647811988, OPENED),
  rawComment(5648773109, RECORD),
  rawComment(5648773167, MARKER),
  rawComment(5649356059, GENERIC_FIX),
];

const SHIM = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.GC_SHIM_STATE, "utf8"));
const argv = process.argv.slice(2);
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (argv[0] === "api" && argv[1] === "user") out(state.login + "\n");
const permission = argv.find((a) => a.includes("/collaborators/") && a.endsWith("/permission"));
if (permission) out("write\n");
if (argv.includes("--paginate") && argv.some((a) => a.endsWith("/comments"))) out(JSON.stringify([state.comments]));
const bodyArg = argv.find((a) => a.startsWith("body="));
if (bodyArg && argv.some((a) => a.endsWith("/comments"))) {
  const id = 7000000000 + state.comments.length;
  state.comments.push({ id, body: bodyArg.slice(5), user: { login: state.login }, author_association: "OWNER" });
  fs.writeFileSync(process.env.GC_SHIM_STATE, JSON.stringify(state));
  out("https://github.com/fake/repo/issues/${ISSUE}#issuecomment-" + id + "\n");
}
process.stderr.write("gh shim: unhandled argv " + JSON.stringify(argv));
process.exit(2);
`;

describe("gc_reconcile_station_observation recovers the Shifter #2123 thread", () => {
  let repoDir;
  let binDir;
  let statePath;
  let oldEnv;

  before(() => {
    repoDir = mkdtempSync(join(tmpdir(), "gc-reconcile-repo-"));
    execFileSync("git", ["-C", repoDir, "init", "-q"]);
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
    binDir = mkdtempSync(join(tmpdir(), "gc-reconcile-bin-"));
    writeFileSync(join(binDir, "gh"), SHIM, { mode: 0o755 });
    statePath = join(binDir, "state.json");
    oldEnv = { PATH: process.env.PATH, GC_SHIM_STATE: process.env.GC_SHIM_STATE };
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    process.env.GC_SHIM_STATE = statePath;
  });
  after(() => {
    process.env.PATH = oldEnv.PATH;
    if (oldEnv.GC_SHIM_STATE === undefined) delete process.env.GC_SHIM_STATE;
    else process.env.GC_SHIM_STATE = oldEnv.GC_SHIM_STATE;
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  const seed = (comments) => writeFileSync(statePath, JSON.stringify({ login: TRUSTED, comments }));
  const thread = () => JSON.parse(readFileSync(statePath, "utf8")).comments;
  const opts = () => ({ workspaceAuthorizationResolver: workspaceAuthorizationFor(repoDir) });
  const reconcile = (findingsRecordUrl = recordUrl(5648773109)) => runReconcileStationObservation(
    { repoPath: repoDir, issueNumber: ISSUE, obligationId: OBLIGATION, findingsRecordUrl }, opts(),
  );
  const obligationState = () => readTrustedExecutionObligationState(repoDir, "fake", "repo", ISSUE);

  it("readiness names the stranded obligation as recoverable, with the record to reconcile it from", async () => {
    seed(SHIFTER_THREAD);
    const result = await runAssertCompletion({
      repoPath: repoDir,
      issueNumber: ISSUE,
      prNumber: 2164,
      requirements: [],
      reviews: [{ reviewer: "codex", summary: "1 cycle" }],
      ciStatus: "green",
      sonarStatus: "passed",
      plainEnglishOutcome: "Ready.",
      phase: "pre_merge",
    }, opts());
    assert.equal(result.error, "completion_open_execution_obligations");
    assert.deepEqual(result.open_obligation_ids, [OBLIGATION]);
    assert.deepEqual(result.recoverable_station_observations, [{
      obligation_id: OBLIGATION,
      station: "codex_review",
      logical_cycle: 1,
      findings_record_url: recordUrl(5648773109),
    }]);
    assert.equal(result.next_action, "reconcile_station_observations_then_retry");
    assert.match(result.message, /gc_reconcile_station_observation/);
  });

  it("posts a reobserved resolution replay accepts, then is idempotent", async () => {
    seed(SHIFTER_THREAD);
    assert.deepEqual((await obligationState()).open_obligation_ids, [OBLIGATION]);

    const result = await reconcile();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.already_recorded, false);
    assert.equal(result.observation_record_url, recordUrl(5648773109));
    assert.equal(result.cycle_marker_url, recordUrl(5648773167));
    const posted = thread().at(-1).body;
    assert.match(posted, /disposition="reobserved" observation_record_id="5648773109"/);

    const cleared = await obligationState();
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.open_obligation_ids, []);

    const again = await reconcile();
    assert.deepEqual(
      { ok: again.ok, already_recorded: again.already_recorded },
      { ok: true, already_recorded: true },
    );
    assert.equal(thread().length, SHIFTER_THREAD.length + 1, "the replay wrote nothing");
  });

  it("refuses evidence that does not prove the verdict, and writes nothing", async () => {
    const cases = [
      { comments: SHIFTER_THREAD, url: recordUrl(5647811988), error: "station_observation_reconcile_evidence_unverified" },
      { comments: SHIFTER_THREAD, url: "https://github.com/fake/other/issues/2123#issuecomment-5648773109", error: "station_observation_reconcile_evidence_unverified" },
      { comments: SHIFTER_THREAD.slice(0, 2), url: recordUrl(5648773109), error: "station_observation_reconcile_evidence_unverified" },
      {
        comments: [SHIFTER_THREAD[0], rawComment(5648773109, RECORD, "maintainer"), SHIFTER_THREAD[2]],
        url: recordUrl(5648773109),
        error: "station_observation_reconcile_evidence_unverified",
      },
      { comments: [], url: recordUrl(5648773109), error: "station_observation_reconcile_not_open" },
    ];
    for (const { comments, url, error } of cases) {
      seed(comments);
      const result = await reconcile(url);
      assert.equal(result.ok, false, url);
      assert.equal(result.error, error, JSON.stringify(result));
      assert.equal(thread().length, comments.length, "nothing was posted");
    }
  });

  it("keeps the generic next action while a problem obligation is also open", async () => {
    const problem = buildExecutionObligationMarker({ issueNumber: ISSUE, obligationId: "OB-REAL-DEFECT", event: "opened" });
    seed([...SHIFTER_THREAD, rawComment(5649977794, problem)]);
    const result = await runAssertCompletion({
      repoPath: repoDir, issueNumber: ISSUE, prNumber: 2164, requirements: [],
      reviews: [{ reviewer: "codex", summary: "1 cycle" }], ciStatus: "green", sonarStatus: "passed",
      plainEnglishOutcome: "Ready.", phase: "pre_merge",
    }, opts());
    assert.deepEqual(result.open_obligation_ids, ["OB-REAL-DEFECT", OBLIGATION]);
    assert.deepEqual(result.recoverable_station_observations.map((r) => r.obligation_id), [OBLIGATION]);
    assert.equal(result.next_action, "fix_and_resolve_open_obligations_then_retry");
  });

  it("does not report success when the posted resolution does not close the ledger", async () => {
    seed(SHIFTER_THREAD);
    const result = await runReconcileStationObservation(
      { repoPath: repoDir, issueNumber: ISSUE, obligationId: OBLIGATION, findingsRecordUrl: recordUrl(5648773109) },
      {
        ...opts(),
        deps: {
          readComments: async () => SHIFTER_THREAD.map((c) => ({ id: c.id, body: c.body, authorLogin: c.user.login })),
          readTrustedLogin: async () => TRUSTED,
          readObligationState: (...args) => readTrustedExecutionObligationState(...args),
          // A post that reports success but never lands, as a lost write would.
          postReobservation: async () => ({ ok: true, url: recordUrl(7) }),
        },
      },
    );
    assert.equal(result.error, "station_observation_reconcile_unverified_after_post");
  });

  it("returns stable text, not gh output, when the thread or the post fails", async () => {
    seed(SHIFTER_THREAD);
    const leak = "HTTP 502 token=ghp_should_never_surface";
    const base = { repoPath: repoDir, issueNumber: ISSUE, obligationId: OBLIGATION, findingsRecordUrl: recordUrl(5648773109) };
    const unreadable = await runReconcileStationObservation(base, {
      ...opts(),
      deps: { readComments: async () => { throw new Error(leak); } },
    });
    assert.equal(unreadable.error, "station_observation_reconcile_thread_unavailable");
    const unposted = await runReconcileStationObservation(base, {
      ...opts(),
      deps: {
        readComments: async () => SHIFTER_THREAD.map((c) => ({ id: c.id, body: c.body, authorLogin: c.user.login })),
        readTrustedLogin: async () => TRUSTED,
        readObligationState: (...args) => readTrustedExecutionObligationState(...args),
        postReobservation: async () => ({ ok: false, message: leak }),
      },
    });
    assert.equal(unposted.error, "station_observation_reconcile_post_failed");
    for (const result of [unreadable, unposted]) {
      assert.doesNotMatch(JSON.stringify(result), /ghp_|HTTP 502/);
    }
  });

  it("serializes on a per-obligation lease: contention writes nothing, and the lease is always released", async () => {
    seed(SHIFTER_THREAD);
    const base = { repoPath: repoDir, issueNumber: ISSUE, obligationId: OBLIGATION, findingsRecordUrl: recordUrl(5648773109) };
    const contended = await runReconcileStationObservation(base, {
      ...opts(),
      deps: { acquireLock: async () => { throw Object.assign(new Error("held"), { code: "ELOCKED" }); } },
    });
    assert.equal(contended.error, "station_observation_reconcile_lock_contended");
    assert.equal(thread().length, SHIFTER_THREAD.length);

    const keys = [];
    let released = 0;
    const acquireLock = async (_root, key) => { keys.push(key); return async () => { released += 1; }; };
    const refused = await runReconcileStationObservation({ ...base, findingsRecordUrl: recordUrl(5647811988) }, { ...opts(), deps: { acquireLock } });
    assert.equal(refused.ok, false);
    const reconciled = await runReconcileStationObservation(base, { ...opts(), deps: { acquireLock } });
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    assert.deepEqual(keys, [{ issueNumber: ISSUE, obligationId: OBLIGATION }, { issueNumber: ISSUE, obligationId: OBLIGATION }]);
    assert.equal(released, 2);
  });

  it("refuses to reconcile a problem obligation", async () => {
    const problem = buildExecutionObligationMarker({ issueNumber: ISSUE, obligationId: OBLIGATION, event: "opened" });
    seed([rawComment(1, problem), rawComment(2, RECORD), rawComment(3, MARKER)]);
    const result = await reconcile(recordUrl(2));
    assert.equal(result.error, "station_observation_reconcile_not_station_observation");
    assert.equal(thread().length, 3);
  });
});

describe("findRecoverableStationObservations", () => {
  const station = { obligation_id: OBLIGATION, schema_version: 2, kind: "station_observation", station: "codex_review", cycle: 1 };
  const target = { repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: ISSUE };

  it("reads nothing when no open obligation is a station observation", async () => {
    let reads = 0;
    const deps = { readComments: async () => { reads += 1; return []; }, readTrustedLogin: async () => TRUSTED };
    const problem = { obligation_id: "OB-1", schema_version: 1, kind: null, station: null, cycle: null };
    assert.deepEqual(await findRecoverableStationObservations({ ...target, openObligations: [problem], deps }), []);
    assert.equal(reads, 0);
  });

  it("offers no candidate when the thread cannot be read, leaving the refusal unchanged", async () => {
    const deps = { readComments: async () => { throw new Error("HTTP 502"); }, readTrustedLogin: async () => TRUSTED };
    assert.deepEqual(await findRecoverableStationObservations({ ...target, openObligations: [station], deps }), []);
  });

  it("offers no candidate the reconcile action would refuse: an id that is not its station and cycle's id", async () => {
    // A v2 observation whose id does not derive from its station and cycle is refused by the action,
    // so naming it as recoverable would send completion's caller into a loop it can never leave.
    const malformedId = "STATION-OBS-SOMETHING-ELSE";
    const marker = OPENED.replace(`id="${OBLIGATION}"`, `id="${malformedId}"`);
    const deps = {
      readComments: async () => [
        { id: 1, body: marker, authorLogin: TRUSTED },
        { id: 2, body: RECORD, authorLogin: TRUSTED },
        { id: 3, body: MARKER, authorLogin: TRUSTED },
      ],
      readTrustedLogin: async () => TRUSTED,
    };
    const obligation = { ...station, obligation_id: malformedId };
    assert.deepEqual(await findRecoverableStationObservations({ ...target, openObligations: [obligation], deps }), []);
    // The well-formed id over the same evidence is offered, so the refusal above is the id check.
    const wellFormed = { ...deps, readComments: async () => [
      { id: 1, body: OPENED, authorLogin: TRUSTED },
      { id: 2, body: RECORD, authorLogin: TRUSTED },
      { id: 3, body: MARKER, authorLogin: TRUSTED },
    ] };
    assert.equal((await findRecoverableStationObservations({ ...target, openObligations: [station], deps: wellFormed })).length, 1);
  });

  it("offers no candidate for an observation the thread does not prove", async () => {
    const deps = {
      readComments: async () => [{ id: 1, body: OPENED, authorLogin: TRUSTED }],
      readTrustedLogin: async () => TRUSTED,
    };
    assert.deepEqual(await findRecoverableStationObservations({ ...target, openObligations: [station], deps }), []);
  });
});
