// gc_release_identity — repository binding, transport argv, and write surface (issue #1579).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedgerRef, githubReleaseLedgerApi, runReleaseIdentity } from "./lib.js";
import { ghRestJson } from "./lib/github-rest.js";
import { launchAuthorizationFor, makeGitRepoWithOrigin } from "./gc-update-issue-requirements.fixture.test.js";
import { execFileSync } from "node:child_process";
import { COVERAGE, familyYaml, withReleaseFixture } from "./release-identity.fixture.test.js";

describe("gc_release_identity — repository binding", () => {
  for (const action of ["reserve", "publish", "abandon", "status"]) {
    it(`${action}: refuses a checkout outside the MCP launch workspace before any GitHub call`, async () => {
      await withReleaseFixture({}, async ({ repoDir, github }) => {
        const elsewhere = makeGitRepoWithOrigin("o/r");
        try {
          const input = { action, repoPath: repoDir, issueNumber: 7, family: "coverage" };
          if (action !== "status") input.idempotencyKey = "capture-1";
          if (action === "abandon") input.reason = "superseded";
          const result = await runReleaseIdentity(input, {
            workspaceAuthorizationResolver: await launchAuthorizationFor(elsewhere),
            restJson: github.restJson,
          });
          assert.equal(result.error, "release_identity_repo_not_authorized");
          assert.equal(github.calls.length, 0);
        } finally {
          rmSync(elsewhere, { recursive: true, force: true });
        }
      });
    });
  }

  it("refuses a caller-supplied repository, revision, version, or path at the library boundary before any GitHub call", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      for (const field of [{ repo: "someone-else/elsewhere" }, { baseRevision: "f".repeat(40) }, { version: "1.0.0" }, { paths: { snapshot: "/etc/x" } }]) {
        const result = await call({ action: "reserve", ...field });
        assert.equal(result.error, "release_identity_input_unexpected_field", JSON.stringify(field));
      }
      assert.equal(github.calls.length, 0);
    });
  });

  it("builds every REST path from the authorized repository", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      assert.equal((await call({ action: "reserve" })).ok, true);
      assert.ok(github.calls.every((c) => c.path === "/user" || c.path.startsWith("/repos/o/r/")));
    });
  });

  it("refuses malformed caller input before touching the filesystem or GitHub", async () => {
    const base = { action: "reserve", repoPath: "/tmp", issueNumber: 7, family: "coverage", idempotencyKey: "k" };
    for (const [override, error] of [
      [{ action: "delete" }, "release_identity_action_invalid"],
      [{ repoPath: "relative" }, "release_identity_repo_path_invalid"],
      [{ family: "../claims" }, "release_identity_family_invalid"],
      [{ issueNumber: 0 }, "release_identity_issue_number_invalid"],
      [{ idempotencyKey: "has space" }, "release_identity_idempotency_key_invalid"],
      [{ idempotencyKey: "k".repeat(129) }, "release_identity_idempotency_key_invalid"],
      [{ action: "abandon", reason: "because" }, "release_identity_reason_invalid"],
    ]) {
      assert.equal((await runReleaseIdentity({ ...base, ...override })).error, error, JSON.stringify(override));
    }
  });
});

describe("gc_release_identity — run authority", () => {
  it("reserves only from the issue's branch in the launch checkout, as read by the server", async () => {
    await withReleaseFixture({}, async ({ repoDir, github, call }) => {
      const refused = await call({ action: "reserve" }, { branch: "checkout" });
      assert.equal(refused.error, "release_identity_run_not_authorized", "the fresh checkout is not on an issue branch");
      assert.equal(github.ledgerRefs().length, 0);
      assert.equal((await call({ action: "reserve" }, { branch: "71-lookalike" })).error, "release_identity_run_not_authorized");

      execFileSync("git", ["-C", repoDir, "checkout", "-q", "-b", "7-forged"]);
      const forged = await call({ action: "reserve" }, { branch: "checkout" });
      assert.equal(forged.error, "release_identity_run_not_authorized", "a local issue-shaped branch is not trusted on its own");
      assert.equal(github.ledgerRefs().length, 0);

      execFileSync("git", ["-C", repoDir, "checkout", "-q", "-b", "7-capture"]);
      const reserved = await call({ action: "reserve" }, { branch: "checkout" });
      assert.equal(reserved.ok, true, JSON.stringify(reserved));
      assert.equal(github.readEvent("refs/gc/release-identities/coverage/claims/1").branch, "7-capture");
    });
  });

  it("lets only the reserving run abandon, while any run may replay or record a verified publication", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      await call({ action: "reserve" });
      const hijack = await call({ action: "abandon", reason: "run_abandoned" }, { branch: "8-other-run" });
      assert.equal(hijack.error, "release_identity_run_not_authorized");
      assert.equal(github.ledgerRefs("coverage", "outcomes").length, 0, "no outcome was written");
      assert.equal((await call({ action: "reserve" }, { branch: "8-other-run" })).reservation.state, "reserved", "replay is read-only");

      github.commitBase("dev", { ".ground-control.yaml": familyYaml({ coverage: COVERAGE }), "docs/coverage/execution-snapshot-v8.json": "{}" });
      assert.equal((await call({ action: "publish" }, { branch: "dev" })).ok, true);
    });
  });
});

describe("gc_release_identity — write surface", () => {
  it("writes only detached ledger commits, ledger references, and issue comments across a full lifecycle", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      await call({ action: "reserve" });
      await call({ action: "reserve", issueNumber: 8 });
      await call({ action: "abandon", issueNumber: 8, reason: "capture_not_needed" });
      const writes = github.calls.filter((c) => c.method !== "GET");
      assert.ok(writes.length > 0);
      for (const write of writes) {
        assert.equal(write.method, "POST", "no reference is ever updated or deleted");
        assert.match(write.path, /^\/repos\/o\/r\/(git\/commits|git\/refs|issues\/\d+\/comments)$/);
        if (write.path.endsWith("/git/refs")) assert.match(write.fields.ref, /^refs\/gc\/release-identities\/coverage\/(claims|outcomes)\/\d+$/);
      }
    });
  });

  it("refuses a derived path that a symlink in the checkout redirects outside it", async () => {
    await withReleaseFixture({}, async ({ repoDir, github, call }) => {
      const outside = mkdtempSync(join(tmpdir(), "gc-ri-outside-"));
      try {
        mkdirSync(join(repoDir, "docs"), { recursive: true });
        symlinkSync(outside, join(repoDir, "docs", "coverage"));
        assert.equal((await call({ action: "reserve" })).error, "release_identity_path_escapes_checkout");
        assert.equal(github.ledgerRefs().length, 0);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("refuses a derived path under a dangling symlink whose missing target lies outside the checkout", async () => {
    await withReleaseFixture({}, async ({ repoDir, github, call }) => {
      const outside = mkdtempSync(join(tmpdir(), "gc-ri-dangling-"));
      try {
        mkdirSync(join(repoDir, "docs"), { recursive: true });
        symlinkSync(join(outside, "not-yet-created"), join(repoDir, "docs", "coverage"));
        assert.equal((await call({ action: "reserve" })).error, "release_identity_path_escapes_checkout");
        assert.equal(github.ledgerRefs().length, 0);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("refuses a derived path the checkout's filesystem cannot resolve, rather than reporting GitHub unavailable", async () => {
    // A 149-character template whose one segment renders to 355 bytes, past the 255-byte name limit.
    const family = { sequence_floor: 1, version_template: `{sequence}${"a".repeat(50)}`, paths: { long: `out/${"x".repeat(100)}${"{version}".repeat(5)}` } };
    await withReleaseFixture({ localFamilies: { coverage: family } }, async ({ repoDir, github, call }) => {
      mkdirSync(join(repoDir, "out"), { recursive: true });
      const result = await call({ action: "reserve" });
      assert.equal(result.error, "release_identity_path_escapes_checkout", JSON.stringify(result));
      assert.equal(github.ledgerRefs().length, 0);
    });
  });

  it("never returns gh stderr or argv in a failure", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      github.fail({ method: "GET", match: /\/git\/matching-refs\//, message: "token ghp_secretvalue leaked" });
      const result = await call({ action: "status", idempotencyKey: undefined });
      assert.equal(result.error, "release_identity_github_unavailable");
      assert.ok(!JSON.stringify(result).includes("ghp_secretvalue"));
    });
  });
});

describe("gc_release_identity — gh api transport", () => {
  function adapterWith(responses) {
    const argv = [];
    const options = [];
    const execFile = async (command, args, opts) => {
      argv.push([command, ...args]);
      options.push(opts);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return { stdout: JSON.stringify(response ?? {}) };
    };
    const api = githubReleaseLedgerApi({
      repoRoot: "/repo", owner: "o", name: "r",
      restJson: (root, path, opts) => ghRestJson(root, path, { ...opts, execFile }),
    });
    return { api, argv, options };
  }

  it("pins the host, bounds the call, and creates a single-parent commit and a reference with argv fields", async () => {
    const { api, argv, options } = adapterWith([{ sha: "c".repeat(40) }, { ref: "refs/gc/x" }]);
    await api.createCommit({ message: "m", treeSha: "a".repeat(40), parentSha: "b".repeat(40) });
    await api.createRef("refs/gc/release-identities/coverage/claims/1", "c".repeat(40));
    assert.deepEqual(argv[0], ["gh", "api", "--method", "POST", "--hostname", "github.com", "/repos/o/r/git/commits", "-f", "message=m", "-f", `tree=${"a".repeat(40)}`, "-f", `parents[]=${"b".repeat(40)}`]);
    assert.deepEqual(argv[1], ["gh", "api", "--method", "POST", "--hostname", "github.com", "/repos/o/r/git/refs", "-f", "ref=refs/gc/release-identities/coverage/claims/1", "-f", `sha=${"c".repeat(40)}`]);
    assert.ok(options.every((o) => o.timeout > 0));
  });

  it("decides a failed create by reading the exact reference back, never from the status code alone", async () => {
    const exists = Object.assign(new Error("Command failed"), { stderr: "gh: Reference already exists (HTTP 422)" });
    const ref = "refs/gc/release-identities/coverage/claims/1";
    const mine = "c".repeat(40);
    const decide = (readBack) => createLedgerRef(adapterWith([exists, readBack]).api, ref, mine);
    assert.equal(await decide([[{ ref, object: { sha: "d".repeat(40) } }]]), "taken");
    assert.equal(await decide([[{ ref, object: { sha: mine } }]]), "created");
    assert.equal(await decide([[{ ref: `${ref}0`, object: { sha: "d".repeat(40) } }]]), "undecided", "a 422 with no such reference is not contention");
    assert.equal(await decide(new Error("read failed")), "undecided");
  });
});
