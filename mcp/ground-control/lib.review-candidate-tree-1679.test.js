// A review revision proved what the reviewers *received*; nothing proved what
// was later *delivered*. `readTrustedReviewPublicationEvidence` even parsed the
// tuple's `revision_digest` and dropped it, so the PR gate only ever asked
// whether some complete trusted publication existed for the issue (issue #1679).
//
// The missing identity is the candidate tree: the Git tree that `git add -A`
// would stage, which is exactly what the publish action commits. A zero-finding
// review authorises that tree and no other. This exercises the capture against a
// real repository, because the whole point is that it agrees with what Git would
// actually stage — an argv assertion would prove nothing.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCandidateTreeOid } from "./lib.js";

const git = (repo, ...argv) => execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8" }).trim();

describe("the reviewed candidate tree is the tree publish would stage (#1679)", () => {
  let repo;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "gc-candidate-tree-"));
    git(repo, "init", "-q", "--initial-branch", "main");
    git(repo, "config", "user.email", "t@example.test");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-q", "-m", "init");
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  // The oracle: what the real `git add -A` + `write-tree` would produce. Run in a
  // throwaway clone so the subject repository's own index is never touched.
  function stagedTreeOracle() {
    const clone = mkdtempSync(join(tmpdir(), "gc-candidate-oracle-"));
    try {
      execFileSync("cp", ["-a", `${repo}/.`, clone]);
      execFileSync("git", ["-C", clone, "add", "-A"]);
      return execFileSync("git", ["-C", clone, "write-tree"], { encoding: "utf8" }).trim();
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  }

  it("matches what git would stage for a clean tree", async () => {
    assert.equal(await captureCandidateTreeOid(repo), stagedTreeOracle());
  });

  it("covers an unstaged modification", async () => {
    writeFileSync(join(repo, "tracked.txt"), "two\n");
    const oid = await captureCandidateTreeOid(repo);
    assert.equal(oid, stagedTreeOracle());
    assert.notEqual(oid, git(repo, "rev-parse", "HEAD^{tree}"));
  });

  it("covers a staged addition", async () => {
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    git(repo, "add", "staged.txt");
    assert.equal(await captureCandidateTreeOid(repo), stagedTreeOracle());
  });

  it("covers an untracked file, which the publisher stages with git add -A", async () => {
    const before = await captureCandidateTreeOid(repo);
    mkdirSync(join(repo, "nested"), { recursive: true });
    writeFileSync(join(repo, "nested", "untracked.txt"), "new\n");
    const after = await captureCandidateTreeOid(repo);

    assert.notEqual(after, before, "content the publisher would commit must change the identity");
    assert.equal(after, stagedTreeOracle());
  });

  it("covers a deletion", async () => {
    unlinkSync(join(repo, "staged.txt"));
    assert.equal(await captureCandidateTreeOid(repo), stagedTreeOracle());
  });

  it("leaves the repository's own index and working tree untouched", async () => {
    const statusBefore = git(repo, "status", "--porcelain");
    const indexBefore = git(repo, "write-tree");
    await captureCandidateTreeOid(repo);

    assert.equal(git(repo, "status", "--porcelain"), statusBefore);
    assert.equal(git(repo, "write-tree"), indexBefore);
  });

  it("leaves no temporary index behind", async () => {
    const gitDir = join(repo, ".git");
    const before = readdirSync(gitDir);
    await captureCandidateTreeOid(repo);
    assert.deepEqual(readdirSync(gitDir).sort(), before.sort());
  });

  it("is stable across repeated captures of the same content", async () => {
    assert.equal(await captureCandidateTreeOid(repo), await captureCandidateTreeOid(repo));
  });

  // core-F3 (cycle 1): the publisher stages against the repository's existing
  // index. A path force-added from an ignored location is tracked there and gets
  // committed, so a HEAD-seeded temporary index would drop it and the candidate
  // tree would disagree with the delivered tree for content nobody changed.
  it("keeps a force-staged ignored path, exactly as the publisher's staging would", async () => {
    writeFileSync(join(repo, ".gitignore"), "generated/\n");
    git(repo, "add", ".gitignore");
    mkdirSync(join(repo, "generated"), { recursive: true });
    writeFileSync(join(repo, "generated", "fixture.bin"), "fixture\n");
    git(repo, "add", "-f", "generated/fixture.bin");

    const oid = await captureCandidateTreeOid(repo);

    assert.equal(oid, stagedTreeOracle());
    const listed = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", oid], { encoding: "utf8" });
    assert.ok(listed.includes("generated/fixture.bin"), "the force-staged path is part of the delivery");
  });
});

// security-F1 (cycle 1): this issue introduced the first staging operation on the
// review path — the previous capture only listed untracked path *names* and never
// read their contents. `git add -A` runs configured clean and process filters, so
// it executes checkout-controlled code with the MCP server's privileges. Every
// other staging site sits behind the executable-configuration guard; this one has
// to as well, on every caller path, because review reaches it directly and
// publication reaches it again later.
describe("candidate-tree staging refuses a checkout that can run its own code (#1679)", () => {
  let repo;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "gc-candidate-tree-unsafe-"));
    git(repo, "init", "-q", "--initial-branch", "main");
    git(repo, "config", "user.email", "t@example.test");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-q", "-m", "init");
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it("refuses before running any Git command when a clean filter is configured", async () => {
    // The real guard, against a real checkout-local filter.
    git(repo, "config", "filter.pwn.clean", "sh -c 'id > /tmp/pwned'");
    writeFileSync(join(repo, ".gitattributes"), "* filter=pwn\n");

    await assert.rejects(
      () => captureCandidateTreeOid(repo),
      (error) => {
        assert.equal(error.code, "review_checkout_configuration_unsafe");
        assert.match(error.message, /filter\.pwn\.clean/);
        return true;
      },
    );
  });

  it("runs no Git command at all once the guard has refused", async () => {
    let calls = 0;
    await assert.rejects(() => captureCandidateTreeOid(repo, {
      commandRunner: async () => { calls += 1; return { stdout: "" }; },
      assertCheckoutConfiguration: async () => { throw new Error("filter.pwn.clean"); },
    }));
    assert.equal(calls, 0, "nothing may execute in an unsafe checkout");
  });

  it("captures normally once the dangerous configuration is gone", async () => {
    git(repo, "config", "--unset", "filter.pwn.clean");
    const oid = await captureCandidateTreeOid(repo);
    assert.match(oid, /^[0-9a-f]{40}$/);
  });
});
