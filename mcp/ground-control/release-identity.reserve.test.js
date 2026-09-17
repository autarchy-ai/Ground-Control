// gc_release_identity reserve — allocation, concurrency, idempotency, base authority (issue #1579).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { COVERAGE, FORMAL, familyYaml, withReleaseFixture } from "./release-identity.fixture.test.js";

const CLAIM = (slot, family = "coverage") => `refs/gc/release-identities/${family}/claims/${slot}`;
const DEV = "refs/heads/dev";

describe("gc_release_identity reserve — allocation and the durable record", () => {
  it("claims the family floor against the base head and records who owns it", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      const head = github.refs.get(DEV);
      const result = await call({ action: "reserve" });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.reused, false);
      assert.deepEqual(
        { sequence: result.reservation.sequence, version: result.reservation.version, paths: result.reservation.paths },
        { sequence: 8, version: "8.0.0", paths: { snapshot: "docs/coverage/execution-snapshot-v8.json" } },
      );
      assert.equal(result.reservation.base_revision, head);
      assert.equal(result.reservation.state, "reserved");

      const event = github.readEvent(CLAIM(1));
      assert.equal(event.repository, "o/r");
      assert.equal(event.issue_number, 7);
      assert.equal(event.base_revision, head);
      assert.equal(event.previous_claim, null);
      assert.deepEqual(event.family_definition, { base_branch: "dev", ...COVERAGE });
      assert.ok(!JSON.stringify(event).includes("capture-1"), "the raw idempotency key never enters Git metadata");
      assert.deepEqual(github.commits.get(github.refs.get(CLAIM(1))).parents, [head]);

      const [record] = github.comments();
      assert.ok(record.body.startsWith(`<!-- gc:release-identity family="coverage" slot="1" sequence="8" event="reserved" commit="${github.refs.get(CLAIM(1))}" -->`));
      assert.equal(result.issue_records.reserved, record.html_url);
    });
  });

  it("allocates past every existing claim for a new issue or a new key, chaining each claim to its predecessor", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      assert.equal((await call({ action: "reserve" })).reservation.sequence, 8);
      assert.equal((await call({ action: "reserve", issueNumber: 8 })).reservation.sequence, 9);
      assert.equal((await call({ action: "reserve", idempotencyKey: "capture-2" })).reservation.sequence, 10);
      assert.equal(github.readEvent(CLAIM(3)).previous_claim, github.refs.get(CLAIM(2)));
    });
  });

  it("gives concurrent reservations for one family distinct identities in claim order", async () => {
    const issueNumbers = [1, 2, 3, 4, 5, 6];
    await withReleaseFixture({ issues: Object.fromEntries(issueNumbers.map((n) => [n, "open"])) }, async ({ github, call }) => {
      const results = await Promise.all(issueNumbers.map((issueNumber) => call({ action: "reserve", issueNumber })));
      assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
      assert.deepEqual(results.map((r) => r.reservation.sequence).sort((a, b) => a - b), [8, 9, 10, 11, 12, 13]);
      const creates = github.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/refs")).length;
      assert.ok(creates > issueNumbers.length, "the test must create a real competing claim, not six sequential ones");
      github.ledgerRefs().forEach((_, index) => {
        assert.equal(github.readEvent(CLAIM(index + 1)).sequence, 8 + index, "slot order is sequence order");
      });
    });
  });

  it("never lands a lower sequence after a higher one, even for a caller that read a stale floor", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      github.commitBase("dev", { ".ground-control.yaml": familyYaml({ coverage: { ...COVERAGE, sequence_floor: 20 } }) });
      assert.equal((await call({ action: "reserve" })).reservation.sequence, 20);
      github.commitBase("dev", { ".ground-control.yaml": familyYaml({ coverage: COVERAGE }) });
      const stale = await call({ action: "reserve", issueNumber: 8 });
      assert.equal(stale.reservation.sequence, 21, "the floor never undercuts the log's high-water mark");
    });
  });

  it("lets separate families allocate concurrently from their own floors", async () => {
    const families = { coverage: COVERAGE, formal: FORMAL };
    await withReleaseFixture({ localFamilies: families, issues: { 1: "open", 2: "open" } }, async ({ github, call }) => {
      const results = await Promise.all([1, 2].flatMap((issueNumber) => ["coverage", "formal"].map((family) => call({ action: "reserve", issueNumber, family }))));
      assert.ok(results.every((r) => r.ok));
      assert.deepEqual(github.ledgerRefs("coverage").map((ref) => github.readEvent(ref).sequence), [8, 9]);
      assert.deepEqual(github.ledgerRefs("formal").map((ref) => github.readEvent(ref).sequence), [10, 11]);
      assert.equal(results.find((r) => r.reservation.family === "formal" && r.reservation.sequence === 10).reservation.version, "11.0.0");
    });
  });

  it("refuses rather than guessing when the allocation stays contended", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      // Every create is refused and the exact reference reads back as someone else's object.
      const real = github.restJson;
      github.restJson = async (root, path, options = {}) => {
        if (options.method === "POST" && path.endsWith("/git/refs")) {
          throw Object.assign(new Error("Command failed"), { stderr: "gh: Reference already exists (HTTP 422)" });
        }
        const exact = /\/git\/matching-refs\/(gc\/release-identities\/coverage\/claims\/\d+)$/.exec(path);
        if (exact) return [{ ref: `refs/${exact[1]}`, object: { sha: "f".repeat(40) } }];
        return real(root, path, options);
      };
      const result = await call({ action: "reserve" });
      assert.equal(result.error, "release_identity_allocation_contended");
    });
  });

  it("stops without advancing when a create can be neither confirmed nor refuted", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      github.fail({ method: "POST", match: /\/git\/refs$/ });
      github.fail({ method: "GET", match: /\/git\/matching-refs\/gc\/release-identities\/coverage\/claims\/1$/ });
      const result = await call({ action: "reserve" });
      assert.equal(result.error, "release_identity_write_undecided");
      assert.equal(github.ledgerRefs().length, 0);
      assert.equal(github.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/refs")).length, 1, "no second slot was attempted");
    });
  });
});

describe("gc_release_identity reserve — idempotent retry", () => {
  it("returns the existing reservation for the same issue and key without claiming again", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      const first = await call({ action: "reserve" });
      const again = await call({ action: "reserve" });
      assert.equal(again.ok, true);
      assert.equal(again.reused, true);
      assert.deepEqual(again.reservation, first.reservation);
      assert.equal(github.ledgerRefs().length, 1);
      assert.equal(github.comments().length, 1, "the record is not posted twice");
    });
  });

  it("replays after the issue closes and the family leaves the checkout's configuration", async () => {
    const issues = { 7: "open" };
    await withReleaseFixture({ issues }, async ({ repoDir, call }) => {
      const first = await call({ action: "reserve" });
      writeFileSync(join(repoDir, ".ground-control.yaml"), "schema_version: 1\nproject: widgets\n");
      issues[7] = "closed";
      const replay = await call({ action: "reserve" });
      assert.equal(replay.ok, true, JSON.stringify(replay));
      assert.deepEqual(replay.reservation, first.reservation);
    });
  });

  it("recovers a claim whose issue record failed, posting only the missing record", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      github.fail({ method: "POST", match: /\/issues\/7\/comments$/ });
      const partial = await call({ action: "reserve" });
      assert.equal(partial.ok, false);
      assert.equal(partial.error, "release_identity_issue_record_failed");
      assert.equal(partial.reservation.sequence, 8, "the committed reservation is named");
      assert.deepEqual(partial.pending_records, ["reserved"]);

      const retry = await call({ action: "reserve" });
      assert.equal(retry.ok, true);
      assert.equal(retry.reservation.sequence, 8);
      assert.equal(github.ledgerRefs().length, 1);
      assert.equal(github.comments().length, 1);
    });
  });

  it("does not reserve when the server's own GitHub identity cannot establish the trusted pickup", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      github.fail({ method: "GET", match: /^\/user$/ });
      const result = await call({ action: "reserve" });
      assert.equal(result.error, "release_identity_github_unavailable");
      assert.equal(github.ledgerRefs().length, 0);
      assert.equal(github.comments().length, 0);
    });
  });

  it("treats a lost ref-create response as the claim it made", async () => {
    await withReleaseFixture({}, async ({ github, call }) => {
      github.fail({ method: "POST", match: /\/git\/refs$/, applyFirst: true });
      const result = await call({ action: "reserve" });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.reservation.sequence, 8);
      assert.equal(github.ledgerRefs().length, 1);
    });
  });
});

describe("gc_release_identity reserve — base-branch authority and collisions", () => {
  it("keeps a reservation's stored base and paths when the base advances, and pins new claims to the new head", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      const first = await call({ action: "reserve" });
      const advanced = github.commitBase("dev", {
        ".ground-control.yaml": familyYaml({ coverage: { ...COVERAGE, sequence_floor: 20, version_template: "v{sequence}" } }),
      });
      assert.deepEqual((await call({ action: "reserve" })).reservation, first.reservation, "never recomputed from newer configuration");

      const next = await call({ action: "reserve", issueNumber: 8 });
      assert.equal(next.reservation.sequence, 20);
      assert.equal(next.reservation.version, "v20");
      assert.equal(next.reservation.base_revision, advanced);
      assert.notEqual(next.reservation.family_digest, first.reservation.family_digest);
    });
  });

  it("refuses a family defined only in the checkout, not at the base commit", async () => {
    await withReleaseFixture({ baseFamilies: { formal: FORMAL } }, async ({ github, call }) => {
      assert.equal((await call({ action: "reserve" })).error, "release_identity_family_not_on_base");
      assert.equal(github.ledgerRefs().length, 0);
    });
  });

  it("allocates from the base definition when the checkout's copy differs", async () => {
    await withReleaseFixture({ localFamilies: { coverage: { ...COVERAGE, sequence_floor: 1 } }, baseFamilies: { coverage: COVERAGE } },
      async ({ call }) => {
        assert.equal((await call({ action: "reserve" })).reservation.sequence, 8);
      });
  });

  it("refuses a base configuration that names another repository", async () => {
    await withReleaseFixture({ baseYaml: familyYaml({ coverage: COVERAGE }, { githubRepo: "someone/else" }) }, async ({ call }) => {
      assert.equal((await call({ action: "reserve" })).error, "release_identity_base_repo_mismatch");
    });
  });

  it("refuses an identity whose derived path, or a non-directory ancestor of it, already exists at the base commit", async () => {
    for (const baseFiles of [
      { "docs/coverage/execution-snapshot-v8.json": "{}" },
      { "docs/coverage/execution-snapshot-v8.json": { symlink: "elsewhere" } },
      { "docs/coverage": "not a directory" },
    ]) {
      await withReleaseFixture({ baseFiles }, async ({ github, call }) => {
        assert.equal((await call({ action: "reserve" })).error, "release_identity_identity_collision", JSON.stringify(baseFiles));
        assert.equal(github.ledgerRefs().length, 0);
      });
    }
  });

  it("refuses to recreate a version or path already owned by an earlier claim after a template change", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      await call({ action: "reserve" });
      github.commitBase("dev", { ".ground-control.yaml": familyYaml({ coverage: { ...COVERAGE, paths: { snapshot: "docs/coverage/execution-snapshot-v{sequence-1}.json" } } }) });
      const result = await call({ action: "reserve", issueNumber: 8 });
      assert.equal(result.error, "release_identity_identity_collision", "sequence 9 would render the v8 path sequence 8 owns");
      assert.equal(github.ledgerRefs().length, 1);
    });
  });

  it("detects a path owned by an earlier claim even when the new definition's path key collides with any renamed key", async () => {
    await withReleaseFixture({ issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      await call({ action: "reserve" });
      github.commitBase("dev", {
        ".ground-control.yaml": familyYaml({ coverage: { ...COVERAGE, version_template: "v{sequence}", paths: { other_snapshot: "docs/coverage/execution-snapshot-v{sequence-1}.json" } } }),
      });
      assert.equal((await call({ action: "reserve", issueNumber: 8 })).error, "release_identity_identity_collision");
      assert.equal(github.ledgerRefs().length, 1);
    });
  });

  it("refuses an identity whose rendered event would exceed the log's bounds, before creating anything", async () => {
    // At the floor every path renders within bounds; one more digit in the version pushes it past.
    const family = {
      sequence_floor: 99_999_999,
      version_template: "{sequence}.aaaaaaaaaa",
      paths: { deep: `d/${Array(23).fill("{version}").join("/")}` },
    };
    await withReleaseFixture({ localFamilies: { coverage: family }, issues: { 7: "open", 8: "open" } }, async ({ github, call }) => {
      assert.equal((await call({ action: "reserve" })).ok, true);
      const result = await call({ action: "reserve", issueNumber: 8 });
      assert.equal(result.error, "release_identity_identity_unrepresentable");
      assert.equal(github.ledgerRefs().length, 1, "no claim the fold would reject was created");
      assert.equal((await call({ action: "status", idempotencyKey: undefined })).ok, true, "the log is still valid");
    });
  });

  it("refuses a closed issue, a pull request, and a log with a slot gap or a stray reference", async () => {
    await withReleaseFixture({ issues: { 7: "closed", 9: "pr", 10: "open", 11: "open" } }, async ({ github, call }) => {
      assert.equal((await call({ action: "reserve" })).error, "release_identity_issue_not_open");
      assert.equal((await call({ action: "reserve", issueNumber: 9 })).error, "release_identity_issue_not_an_issue");
      await call({ action: "reserve", issueNumber: 10 });
      github.refs.set(CLAIM(3), github.refs.get(CLAIM(1)));
      assert.equal((await call({ action: "reserve", issueNumber: 11 })).error, "release_identity_log_malformed");
      github.refs.delete(CLAIM(3));
      github.refs.set("refs/gc/release-identities/coverage/claims/not-a-number", "a".repeat(40));
      assert.equal((await call({ action: "reserve", issueNumber: 11 })).error, "release_identity_log_malformed");
    });
  });
});
