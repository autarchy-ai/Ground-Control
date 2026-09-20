// `grndctl finalize-merged-pr` — the Actions job's transport (issue #1671).
//
// The verb exists so the workflow YAML holds no logic: it forwards one pull-request number
// and its own run identity, then turns the library envelope into an exit code. A job that
// exits 0 on a failed finalization would hide exactly the condition a maintainer must see.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFinalizeArgs, runFinalizeMergedPrCli } from "./lib/grndctl-finalize.js";

function capture() {
  const out = [];
  const errOut = [];
  return { out, errOut, print: (l) => out.push(l), printError: (l) => errOut.push(l) };
}

describe("finalize-merged-pr argument parsing", () => {
  it("accepts both the separated and inline forms", () => {
    assert.deepEqual(parseFinalizeArgs(["--pr", "1680"]), { ok: true, prNumber: 1680 });
    assert.deepEqual(parseFinalizeArgs(["--pr=1680"]), { ok: true, prNumber: 1680 });
  });

  it("refuses anything that is not a positive pull-request number", () => {
    for (const argv of [[], ["--pr", "0"], ["--pr", "-3"], ["--pr", "abc"], ["--pr"]]) {
      assert.equal(parseFinalizeArgs(argv).ok, false, JSON.stringify(argv));
    }
  });

  it("refuses an unrecognized argument rather than ignoring it", () => {
    assert.equal(parseFinalizeArgs(["--pr", "1", "--force"]).ok, false);
  });
});

describe("finalize-merged-pr exit codes", () => {
  it("passes the checkout and the job's own run id to the executor", async () => {
    let seen;
    const io = capture();
    const code = await runFinalizeMergedPrCli(["--pr", "1680"], {
      ...io,
      cwd: "/checkout",
      env: { GITHUB_RUN_ID: "987654321" },
      finalize: async (input) => { seen = input; return { ok: true, status: "finalized" }; },
    });
    assert.equal(code, 0);
    assert.deepEqual(seen, { repoPath: "/checkout", prNumber: 1680, automationRunId: 987654321 });
  });

  it("runs outside Actions with no run id rather than failing", async () => {
    let seen;
    const io = capture();
    await runFinalizeMergedPrCli(["--pr", "1680"], {
      ...io,
      cwd: "/checkout",
      env: {},
      finalize: async (input) => { seen = input; return { ok: true, status: "finalized" }; },
    });
    assert.equal(seen.automationRunId, null);
  });

  it("exits 0 for a pull request that is not a Ground Control delivery", async () => {
    const io = capture();
    const code = await runFinalizeMergedPrCli(["--pr", "1680"], {
      ...io,
      env: {},
      finalize: async () => ({ ok: true, status: "skipped", reason: "delivery_pointer_missing" }),
    });
    assert.equal(code, 0);
  });

  it("exits non-zero when finalization failed, so the job goes red", async () => {
    const io = capture();
    const code = await runFinalizeMergedPrCli(["--pr", "1680"], {
      ...io,
      env: {},
      finalize: async () => ({ ok: false, status: "failed", error: "completion_requirement_state_unverified" }),
    });
    assert.equal(code, 1);
    assert.match(io.out.join("\n"), /completion_requirement_state_unverified/);
  });

  it("exits 2 on a usage error without calling the executor", async () => {
    const io = capture();
    const code = await runFinalizeMergedPrCli([], {
      ...io,
      env: {},
      finalize: async () => assert.fail("bad input must not reach the executor"),
    });
    assert.equal(code, 2);
  });
});

describe("finalize-merged-pr unexpected failures", () => {
  it("reports a thrown error as a failed job rather than an unhandled rejection", async () => {
    const io = capture();
    const code = await runFinalizeMergedPrCli(["--pr", "1680"], {
      ...io,
      env: {},
      finalize: async () => { throw new Error("gh exploded"); },
    });
    assert.equal(code, 1);
    assert.match(io.errOut.join("\n"), /finalize-merged-pr failed: gh exploded/);
  });
});
