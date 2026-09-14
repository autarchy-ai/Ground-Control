// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ReviewerCapConfigError, findChangedTestFiles, resolveReviewerPrePushCap } from "./lib.js";

// ---------------------------------------------------------------------------
// findChangedTestFiles uncommitted-aware path (issue #906 codex finding F2)
//
// The test-quality review moved pre-push at #906. The legacy file discovery
// looked only at `git diff <base>...HEAD`, which is empty pre-commit; the
// review would have taken the zero-files fast path on every first cycle and
// consumed the cap without reviewing the actual staged test edits. The
// `includeUncommitted: true` option closes that hole.
// ---------------------------------------------------------------------------

describe("findChangedTestFiles uncommitted-aware path", () => {
  const tmpRepos = [];
  function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "gc-findtests-"));
    tmpRepos.push(dir);
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    writeFileSync(join(dir, "seed"), "seed");
    execFileSync("git", ["-C", dir, "add", "seed"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
    execFileSync("git", ["-C", dir, "checkout", "-q", "-b", "feat"]);
    return dir;
  }

  // Clean up at module scope (not after each test) so a single failing test
  // doesn't masquerade as the failure of every subsequent test through a
  // dirty workspace.
  after(() => {
    for (const d of tmpRepos) rmSync(d, { recursive: true, force: true });
  });

  it("includes staged test files when includeUncommitted=true", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "FooTest.java"), "// staged\n");
    execFileSync("git", ["-C", dir, "add", "FooTest.java"]);
    const files = await findChangedTestFiles({
      repoRoot: dir,
      baseBranch: "main",
      includeUncommitted: true,
    });
    assert.ok(files.includes("FooTest.java"));
  });

  it("includes unstaged tracked test edits when includeUncommitted=true", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "BarTest.java"), "// initial\n");
    execFileSync("git", ["-C", dir, "add", "BarTest.java"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "add bar test"]);
    writeFileSync(join(dir, "BarTest.java"), "// edited\n");
    const files = await findChangedTestFiles({
      repoRoot: dir,
      baseBranch: "main",
      includeUncommitted: true,
    });
    assert.ok(files.includes("BarTest.java"));
  });

  it("includes brand-new untracked test files when includeUncommitted=true", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "BazTest.java"), "// untracked\n");
    const files = await findChangedTestFiles({
      repoRoot: dir,
      baseBranch: "main",
      includeUncommitted: true,
    });
    assert.ok(files.includes("BazTest.java"));
  });

  it("returns the empty set when includeUncommitted=false and HEAD has no test changes", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "QuxTest.java"), "// staged but uncommitted\n");
    execFileSync("git", ["-C", dir, "add", "QuxTest.java"]);
    const files = await findChangedTestFiles({
      repoRoot: dir,
      baseBranch: "main",
      includeUncommitted: false,
    });
    assert.equal(files.length, 0);
  });

  it("deduplicates a file that appears in HEAD and in staged/unstaged", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "DupTest.java"), "// initial\n");
    execFileSync("git", ["-C", dir, "add", "DupTest.java"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "dup"]);
    writeFileSync(join(dir, "DupTest.java"), "// edited\n");
    const files = await findChangedTestFiles({
      repoRoot: dir,
      baseBranch: "main",
      includeUncommitted: true,
    });
    assert.equal(files.filter((f) => f === "DupTest.java").length, 1);
  });

  // Predicate-coverage tests for the JS / TS test-file conventions added by
  // #906 codex F3. Without these, a PR that only changes `foo.test.js` or
  // `bar.spec.ts` would take the zero-files fast path and consume the cap
  // without running the reviewer.
  it("matches `.test.js` JS test convention", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "foo.test.js"), "// staged\n");
    execFileSync("git", ["-C", dir, "add", "foo.test.js"]);
    const files = await findChangedTestFiles({
      repoRoot: dir,
      baseBranch: "main",
      includeUncommitted: true,
    });
    assert.ok(files.includes("foo.test.js"));
  });

  it("matches `.test.ts` / `.test.tsx` TypeScript test conventions", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.test.ts"), "// staged\n");
    writeFileSync(join(dir, "b.test.tsx"), "// staged\n");
    execFileSync("git", ["-C", dir, "add", "a.test.ts", "b.test.tsx"]);
    const files = await findChangedTestFiles({
      repoRoot: dir,
      baseBranch: "main",
      includeUncommitted: true,
    });
    assert.ok(files.includes("a.test.ts"));
    assert.ok(files.includes("b.test.tsx"));
  });

  it("matches `.spec.js` / `.spec.ts` alternate test conventions", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "x.spec.js"), "// staged\n");
    writeFileSync(join(dir, "y.spec.ts"), "// staged\n");
    execFileSync("git", ["-C", dir, "add", "x.spec.js", "y.spec.ts"]);
    const files = await findChangedTestFiles({
      repoRoot: dir,
      baseBranch: "main",
      includeUncommitted: true,
    });
    assert.ok(files.includes("x.spec.js"));
    assert.ok(files.includes("y.spec.ts"));
  });

  // `test/` (singular) directory predicate — covers Maven-style src/test/...
  // and similar singular layouts the SKILL.md test-glob contract names.
  // Added per #906 codex cycle-3 F3.
  it("matches files inside a singular `test/` directory anywhere in the path", async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, "src", "test", "parser"), { recursive: true });
    writeFileSync(join(dir, "src", "test", "parser", "case.json"), "{}\n");
    mkdirSync(join(dir, "test", "parser"), { recursive: true });
    writeFileSync(join(dir, "test", "parser", "foo.py"), "# x\n");
    execFileSync("git", ["-C", dir, "add", "src/test/parser/case.json", "test/parser/foo.py"]);
    const files = await findChangedTestFiles({
      repoRoot: dir,
      baseBranch: "main",
      includeUncommitted: true,
    });
    assert.ok(files.includes("src/test/parser/case.json"));
    assert.ok(files.includes("test/parser/foo.py"));
  });

  it("does NOT match non-test files lacking any anchored test-shape substring", async () => {
    const dir = makeRepo();
    // None of these contain `test_`, `_test.`, `Test.`, `.test.`, `.spec.`,
    // or `tests?/` — pure non-test paths.
    writeFileSync(join(dir, "foo.go"), "// x\n");
    writeFileSync(join(dir, "bar.json"), "{}\n");
    execFileSync("git", ["-C", dir, "add", "foo.go", "bar.json"]);
    const files = await findChangedTestFiles({
      repoRoot: dir,
      baseBranch: "main",
      includeUncommitted: true,
    });
    assert.ok(!files.includes("foo.go"));
    assert.ok(!files.includes("bar.json"));
  });
});

// ---------------------------------------------------------------------------
// resolveReviewerPrePushCap config validation surfacing (issue #906 F7)
//
// A malformed `workflow.codex_review.pre_push_cap` (out-of-bounds, non-integer,
// unknown nested keys) used to silently fall back to the module default. The
// fix preserves strict validation: invalid_ground_control_yaml throws
// ReviewerCapConfigError; legitimate absence still falls back.
// ---------------------------------------------------------------------------

describe("resolveReviewerPrePushCap config validation surfacing", () => {
  const tmpRepos = [];
  function makeRepo(yamlText) {
    const dir = mkdtempSync(join(tmpdir(), "gc-resolve-cap-"));
    tmpRepos.push(dir);
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    if (yamlText !== null) {
      writeFileSync(join(dir, ".ground-control.yaml"), yamlText);
    }
    return dir;
  }

  after(() => {
    for (const d of tmpRepos) rmSync(d, { recursive: true, force: true });
  });

  it("returns the module default when the cfg file is missing", async () => {
    const dir = makeRepo(null);
    const cap = await resolveReviewerPrePushCap(dir, "codex_review", 7);
    assert.equal(cap, 7);
  });

  it("returns the module default when the block is absent", async () => {
    const dir = makeRepo("schema_version: 1\nproject: test-proj\n");
    const cap = await resolveReviewerPrePushCap(dir, "codex_review", 7);
    assert.equal(cap, 7);
  });

  it("returns the configured cap when present and valid", async () => {
    const dir = makeRepo(
      "schema_version: 1\nproject: test-proj\nworkflow:\n  codex_review:\n    pre_push_cap: 4\n",
    );
    const cap = await resolveReviewerPrePushCap(dir, "codex_review", 7);
    assert.equal(cap, 4);
  });

  it("throws ReviewerCapConfigError when the cfg is present but invalid", async () => {
    const dir = makeRepo(
      "schema_version: 1\nproject: test-proj\nworkflow:\n  codex_review:\n    pre_push_cap: 0\n",
    );
    await assert.rejects(
      () => resolveReviewerPrePushCap(dir, "codex_review", 7),
      (err) => err instanceof ReviewerCapConfigError && err.blockName === "codex_review",
    );
  });

  it("throws when an unknown nested key is present under the reviewer block", async () => {
    const dir = makeRepo(
      "schema_version: 1\nproject: test-proj\nworkflow:\n  test_quality_review:\n    pre_push_cap: 2\n    bogus_key: true\n",
    );
    await assert.rejects(
      () => resolveReviewerPrePushCap(dir, "test_quality_review", 7),
      (err) => err instanceof ReviewerCapConfigError,
    );
  });
});

// =============================================================================
// gc_get_issue_thread (issue #934)
// =============================================================================
//
// runGetIssueThread caches issue body + comments keyed by {repoRoot, issueNumber}.
// On a hit with matching expected_hash it returns {unchanged: true} without
// re-fetching from GitHub. Cache miss falls back to a fresh `gh` fetch.
//
// Tests here cover input validation, the cache short-circuit, and the
// hash builder's determinism / sensitivity. The live `gh` fetch path is
// covered by the end-to-end run (Phase 5) rather than mocked here, matching
// the existing codebase's "no exec mocking" convention.

describe("hashIssueThreadPayload (issue #934)", () => {
  it("is deterministic for identical inputs", async () => {
    const { hashIssueThreadPayload } = await import("./lib.js");
    const body = "issue body text";
    const comments = [
      { id: 1, body: "first" },
      { id: 2, body: "second" },
    ];
    assert.equal(hashIssueThreadPayload(body, comments), hashIssueThreadPayload(body, comments));
  });

  it("changes when body changes", async () => {
    const { hashIssueThreadPayload } = await import("./lib.js");
    const comments = [{ id: 1, body: "x" }];
    assert.notEqual(hashIssueThreadPayload("a", comments), hashIssueThreadPayload("b", comments));
  });

  it("changes when a comment body changes", async () => {
    const { hashIssueThreadPayload } = await import("./lib.js");
    const a = [{ id: 1, body: "x" }];
    const b = [{ id: 1, body: "y" }];
    assert.notEqual(hashIssueThreadPayload("body", a), hashIssueThreadPayload("body", b));
  });

  it("changes when a comment is appended", async () => {
    const { hashIssueThreadPayload } = await import("./lib.js");
    const a = [{ id: 1, body: "x" }];
    const b = [{ id: 1, body: "x" }, { id: 2, body: "y" }];
    assert.notEqual(hashIssueThreadPayload("body", a), hashIssueThreadPayload("body", b));
  });

  it("does not collide between body and comment text at the same position", async () => {
    const { hashIssueThreadPayload } = await import("./lib.js");
    // Naive concatenation would make these collide. A delimiter must
    // separate the body from the comment list.
    const h1 = hashIssueThreadPayload("ab", [{ id: 1, body: "c" }]);
    const h2 = hashIssueThreadPayload("a", [{ id: 1, body: "bc" }]);
    assert.notEqual(h1, h2);
  });

  it("treats comment id and body as separate fields", async () => {
    const { hashIssueThreadPayload } = await import("./lib.js");
    // Without a delimiter between id and body, these could hash the same.
    const h1 = hashIssueThreadPayload("", [{ id: 12, body: "34" }]);
    const h2 = hashIssueThreadPayload("", [{ id: 1, body: "234" }]);
    assert.notEqual(h1, h2);
  });
});

describe("runGetIssueThread input validation (issue #934)", () => {
  it("refuses when repo_path is missing or empty", async () => {
    const { runGetIssueThread } = await import("./lib.js");
    const r = await runGetIssueThread({ repoPath: "", issueNumber: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "issue_thread_input_invalid");
  });

  it("refuses when issue_number is not a positive integer", async () => {
    const { runGetIssueThread } = await import("./lib.js");
    for (const bad of [0, -1, 1.5, "1", null, undefined]) {
      const r = await runGetIssueThread({ repoPath: "/tmp", issueNumber: bad });
      assert.equal(r.ok, false, `bad=${bad}`);
      assert.equal(r.error, "issue_thread_input_invalid");
    }
  });

  it("refuses when repo_path is not a git repository", async () => {
    const { runGetIssueThread } = await import("./lib.js");
    const dir = mkdtempSync(join(tmpdir(), "gc-issue-thread-not-git-"));
    try {
      const r = await runGetIssueThread({ repoPath: dir, issueNumber: 1 });
      assert.equal(r.ok, false);
      // A path that is not a checkout cannot be the authorized launch workspace (issue #1583).
      assert.equal(r.error, "issue_thread_repo_not_authorized");
      assert.match(r.message, /implement_repo_not_git/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
