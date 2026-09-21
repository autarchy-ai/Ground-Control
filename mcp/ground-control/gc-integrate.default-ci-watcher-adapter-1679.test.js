// The /integrate lane's production CI adapter (issue #1679).
//
// `defaultRunCiWatcher` mapped every non-ok `runWatchCiRun` envelope onto
// `{conclusion: "skipped"}`, and the readiness gate blocks only on failure,
// queued_too_long and timed_out. A head-binding refusal — no run registered for
// the head, a run that built a different commit, an authorization failure — was
// therefore converted into an allowed skip, and a rebased PR could be marked
// ready with no build for the commit it now carries. GC-O011(c) requires the CI
// signal to be *watched* before a PR is marked ready; inability to observe is
// not observation.
//
// Every other test in this lane injects `runCiWatcher` as a fake that already
// speaks the hook contract, so the mapping itself was never exercised. These
// drive the adapter directly, with the watcher injected.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultRunCiWatcher } from "./gc-integrate/exec-file-async.js";

const PR = { pr_number: 1679, head_ref: "1679-review-gate-ci-fixes", pushed_head_sha: "c".repeat(40) };
const CTX = { repoRoot: "/repo" };

const adapt = (envelope) => defaultRunCiWatcher(PR, CTX, undefined, async () => envelope);

describe("defaultRunCiWatcher — watcher envelope to hook contract", () => {
  for (const error of [
    "ci_watch_no_run_for_head_sha",
    "ci_watch_run_head_mismatch",
    "ci_watch_head_sha_unresolved",
    "ci_watch_run_lookup_failed",
    "ci_watch_repo_not_authorized",
  ]) {
    it(`refuses to convert '${error}' into an allowed skip`, async () => {
      const result = await adapt({ ok: false, error, head_sha: PR.pushed_head_sha });

      assert.notEqual(result.conclusion, "skipped");
      assert.equal(result.conclusion, "unverified");
      assert.equal(result.reason, error);
      assert.equal(result.head_sha, PR.pushed_head_sha);
    });
  }

  it("treats an explicit CI skip as unobserved rather than as readiness", async () => {
    const result = await adapt({ ok: true, conclusion: "skipped", url: "https://ci.test/1" });

    assert.equal(result.conclusion, "unverified");
    assert.equal(result.reason, "ci_conclusion_skipped");
  });

  it("passes the conclusive outcomes through unchanged", async () => {
    assert.equal((await adapt({ ok: true, conclusion: "success" })).conclusion, "success");
    assert.equal((await adapt({ ok: true, conclusion: "queued_too_long" })).conclusion, "queued_too_long");
    assert.equal((await adapt({ ok: true, conclusion: "timed_out" })).conclusion, "timed_out");

    const failure = await adapt({ ok: true, conclusion: "failure", url: "https://ci.test/2" });
    assert.equal(failure.conclusion, "failure");
    assert.equal(failure.details_url, "https://ci.test/2");
  });

  it("binds the watch to the commit this lane pushed", async () => {
    let seen = null;
    await defaultRunCiWatcher(PR, CTX, undefined, async (args) => {
      seen = args;
      return { ok: true, conclusion: "success" };
    });
    assert.equal(seen.expectedHeadSha, PR.pushed_head_sha);
    assert.equal(seen.branch, PR.head_ref);
  });
});
