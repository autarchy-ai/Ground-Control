// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexReviewExecArgs,
  buildCodexSecurityReviewPrompt,
  buildDiffBlock,
  dedupFindings,
  execFileWithInput,
  selectDiffMode,
} from "./lib.js";

describe("buildCodexSecurityReviewPrompt", () => {
  const diff = "diff --git a/Auth.java b/Auth.java\n+if (token == null) { allow(); }";

  it("restricts scope to concrete exploitable security issues", () => {
    const prompt = buildCodexSecurityReviewPrompt({
      baseBranch: "dev",
      uncommitted: false,
      prNumber: 520,
      diffText: diff,
    });
    assert.ok(prompt.includes("senior application-security engineer"));
    assert.ok(prompt.includes("concrete, exploitable security issues"));
    assert.ok(prompt.includes("Do not comment on maintainability"));
    assert.ok(prompt.includes("attacker model"));
  });

  it("enumerates the security categories to examine", () => {
    const prompt = buildCodexSecurityReviewPrompt({
      baseBranch: "dev",
      uncommitted: false,
      prNumber: 520,
      diffText: diff,
    });
    assert.ok(prompt.includes("Input validation"));
    assert.ok(prompt.includes("AuthN / AuthZ"));
    assert.ok(prompt.includes("Secrets and crypto"));
    assert.ok(prompt.includes("Data exposure"));
  });

  it("lists noise categories to ignore so the report stays high-signal", () => {
    const prompt = buildCodexSecurityReviewPrompt({
      baseBranch: "dev",
      uncommitted: false,
      prNumber: 520,
      diffText: diff,
    });
    assert.ok(prompt.includes("What NOT to flag"));
    assert.ok(prompt.includes("Rate limiting"));
    assert.ok(prompt.includes("Generic best-practice hardening"));
  });

  it("tags findings with a [security] prefix and embeds the diff", () => {
    const prompt = buildCodexSecurityReviewPrompt({
      baseBranch: "dev",
      uncommitted: false,
      prNumber: 520,
      diffText: diff,
    });
    assert.ok(prompt.includes("[security]"));
    assert.ok(prompt.includes("<<<DIFF"));
    assert.ok(prompt.includes("if (token == null)"));
  });

  it("carries the scope-versus-evidence split into the security prompt (#1557)", () => {
    // Both reviewers share buildCommonReviewPreamble, so the security reviewer
    // must get the same evidence grant and the same scope guarantees.
    const prompt = buildCodexSecurityReviewPrompt({
      baseBranch: "dev",
      uncommitted: false,
      diffText: diff,
    });
    assert.match(prompt, /SCOPE/);
    assert.match(prompt, /EVIDENCE/);
    assert.match(prompt, /ground truth/i);
    assert.ok(prompt.includes("do not re-derive it from git yourself"));
    assert.ok(!prompt.includes("or any shell"));
  });

  it("instructs codex to emit the verdict envelope in the REVIEW block (not by calling gh)", () => {
    const prompt = buildCodexSecurityReviewPrompt({
      baseBranch: "dev",
      uncommitted: false,
      prNumber: 520,
      diffText: diff,
    });
    // Same architecture inversion as the core reviewer — see issue #793 / #931.
    assert.ok(prompt.includes("===REVIEW==="));
    assert.ok(prompt.includes("===END==="));
    assert.ok(prompt.includes("Do NOT invoke `gh`"));
    assert.ok(!prompt.includes("/repos/{owner}/{repo}/pulls/"));
    assert.ok(!prompt.includes("COMMENT_IDS"));
  });
});

describe("dedupFindings", () => {
  it("collapses findings with the same path, line, and title prefix", () => {
    const a = { comment_id: 1, path: "Foo.java", line: 42, title: "[core] Missing validation on input", reviewer: "core" };
    const b = { comment_id: 2, path: "Foo.java", line: 42, title: "[core] Missing validation on input", reviewer: "core" };
    const c = { comment_id: 3, path: "Foo.java", line: 42, title: "[security] Injection risk on input", reviewer: "security" };
    const out = dedupFindings([a, b, c]);
    assert.equal(out.length, 2);
    assert.equal(out[0].comment_id, 1); // first wins
    assert.equal(out[1].comment_id, 3);
  });

  it("treats different lines on the same file as distinct findings", () => {
    const a = { comment_id: 1, path: "Foo.java", line: 42, title: "[core] issue" };
    const b = { comment_id: 2, path: "Foo.java", line: 43, title: "[core] issue" };
    const out = dedupFindings([a, b]);
    assert.equal(out.length, 2);
  });

  it("is case-insensitive on the title prefix", () => {
    const a = { comment_id: 1, path: "Foo.java", line: 42, title: "[core] Missing Validation" };
    const b = { comment_id: 2, path: "Foo.java", line: 42, title: "[core] missing validation" };
    const out = dedupFindings([a, b]);
    assert.equal(out.length, 1);
  });

  it("returns an empty array for an empty input", () => {
    assert.deepEqual(dedupFindings([]), []);
  });
});

describe("execFileWithInput", () => {
  it("rejects with ETIMEDOUT and kills the child when timeoutMs elapses", async () => {
    // sleep 30s but expect the timeout to fire after ~150ms.
    const start = Date.now();
    let err;
    try {
      await execFileWithInput("sleep", ["30"], {
        timeoutMs: 150,
        killGraceMs: 100,
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;
    assert.ok(err, "expected the call to reject");
    assert.equal(err.code, "ETIMEDOUT");
    assert.equal(err.killed, true);
    assert.match(err.message, /sleep did not exit within 150ms/);
    assert.ok(elapsed < 5000, `timeout did not fire promptly (took ${elapsed}ms)`);
  });

  it("returns stdout/stderr cleanly when the child exits before the timeout", async () => {
    const { stdout } = await execFileWithInput("printf", ["hello"], {
      timeoutMs: 5000,
    });
    assert.equal(stdout, "hello");
  });

  it("does not arm a timer when timeoutMs is omitted", async () => {
    const { stdout } = await execFileWithInput("printf", ["ok"], {});
    assert.equal(stdout, "ok");
  });
});

describe("buildCodexReviewExecArgs", () => {
  it("uses codex exec with read-only sandbox, cwd, output capture, and stdin prompt", () => {
    // We dropped `codex review` because it could hang after emitting the
    // structured tail when invoked with a stdin prompt. `codex exec` matches
    // the architecture preflight and verify-finding callers, both of which
    // exit cleanly. The diff is computed by the caller and inlined into the
    // prompt, so we no longer need codex's own --uncommitted/--base flags.
    //
    // Issue #793 / ADR-027 Privileged Side-Effect Boundary: codex returns a
    // structured findings payload and the MCP server performs the GitHub
    // writes from the host. Codex therefore needs no write access — the
    // sandbox is read-only.
    const args = buildCodexReviewExecArgs({
      repoPath: "/tmp/repo",
      outputPath: "/tmp/out.txt",
    });

    assert.deepEqual(args, [
      "exec",
      "--sandbox",
      "read-only",
      "-C",
      "/tmp/repo",
      "--output-last-message",
      "/tmp/out.txt",
      "-",
    ]);
  });
});

describe("buildDiffBlock", () => {
  it("inlines the diff in inline mode", () => {
    const lines = buildDiffBlock({ diffText: "diff --git a/Foo.java b/Foo.java\n+x", mode: "inline" });
    assert.equal(lines[0], "<<<DIFF");
    assert.equal(lines[lines.length - 1], "DIFF>>>");
    assert.ok(lines.join("\n").includes("diff --git a/Foo.java"));
  });

  it("emits an empty-diff marker when the diff text is empty in inline mode", () => {
    const lines = buildDiffBlock({ diffText: "", mode: "inline" });
    assert.ok(lines.join("\n").includes("empty diff"));
  });

  it("inlines the slice alongside a context-only manifest in manifest mode (#1414)", () => {
    const lines = buildDiffBlock({
      diffText: "diff --git a/Foo.java b/Foo.java\n+authoritative slice content",
      mode: "manifest",
      manifest: "10\t2\tFoo.java\n5\t0\tBar.java",
      baseRefDescriptor: "origin/dev",
      slice: { index: 2, total: 4 },
    });
    const text = lines.join("\n");
    // The manifest is still supplied — as whole-change context.
    assert.ok(text.includes("<<<DIFF-MANIFEST"));
    assert.ok(text.includes("DIFF-MANIFEST>>>"));
    assert.ok(text.includes("Bar.java"));
    // The slice's real diff is inlined by the server.
    assert.ok(text.includes("<<<DIFF"));
    assert.ok(text.includes("DIFF>>>"));
    assert.ok(text.includes("+authoritative slice content"));
    // The reviewer is never asked to fetch diffs itself — that delegation is
    // the #1414 defect: nothing proved the fetch happened.
    assert.ok(!text.includes("your shell tool"));
    assert.ok(!/git diff .*\.\.\.HEAD -- <path>/.test(text));
    assert.ok(!text.includes("git show HEAD -- <path>"));
  });

  it("names the base ref in the manifest context line when one is known", () => {
    const withRef = buildDiffBlock({
      diffText: "x",
      mode: "manifest",
      manifest: "1\t1\tFoo.java",
      baseRefDescriptor: "origin/dev",
      slice: { index: 1, total: 2 },
    }).join("\n");
    assert.ok(withRef.includes("origin/dev"));

    const withoutRef = buildDiffBlock({
      diffText: "x",
      mode: "manifest",
      manifest: "1\t1\tFoo.java",
      baseRefDescriptor: null,
      slice: { index: 1, total: 2 },
    }).join("\n");
    assert.ok(withoutRef.includes("<<<DIFF-MANIFEST"));
    assert.ok(!withoutRef.includes("<base-ref>"));
  });

  it("names the additive change-kind block in the manifest context line (#1557)", () => {
    // `0\t297\tfoo.mjs` never says "deleted" and is byte-identical to an
    // emptied-but-retained file. --name-status states it, so the reviewer is
    // told to read the kind rather than infer direction from line counts.
    const lines = buildDiffBlock({
      diffText: "diff --git a/Foo.java b/Foo.java\n+x",
      mode: "manifest",
      manifest: "10\t2\tFoo.java\n\n# kinds\nD\tGone.java",
      baseRefDescriptor: "origin/dev",
      slice: { index: 1, total: 2 },
    });
    const text = lines.join("\n");
    assert.match(text, /change kind/i);
    assert.ok(text.includes("D\tGone.java"));
    // Still context only — the manifest never becomes review evidence (#1414).
    assert.ok(text.includes("CONTEXT ONLY"));
  });

  it("keeps inline-mode output byte-identical when no slice is supplied", () => {
    const diffText = "diff --git a/Foo.java b/Foo.java\n+x";
    assert.deepEqual(
      buildDiffBlock({ diffText, mode: "inline" }),
      buildDiffBlock({ diffText, mode: "inline", slice: null }),
    );
  });
});

describe("selectDiffMode", () => {
  it("counts prompt overhead when selecting manifest mode", () => {
    assert.equal(selectDiffMode({ diffText: "x".repeat(900), maxBytes: 1024,
      promptOverheadBytes: 200 }), "manifest");
  });
  it("returns 'inline' for diffs under the cap", () => {
    assert.equal(selectDiffMode({ diffText: "x".repeat(100), maxBytes: 1024 }), "inline");
  });

  it("returns 'manifest' for diffs over the cap", () => {
    assert.equal(selectDiffMode({ diffText: "x".repeat(2048), maxBytes: 1024 }), "manifest");
  });

  it("returns 'inline' when the cap is disabled (0)", () => {
    assert.equal(selectDiffMode({ diffText: "x".repeat(10_000_000), maxBytes: 0 }), "inline");
  });

  it("counts UTF-8 byte length, not character length", () => {
    // 4-byte UTF-8 character (a single grapheme but 4 bytes per codepoint).
    const fourByteChar = "𝟘"; // U+1D7D8 MATHEMATICAL DOUBLE-STRUCK DIGIT ZERO
    const diffText = fourByteChar.repeat(300); // 1200 bytes, 300 chars
    assert.equal(selectDiffMode({ diffText, maxBytes: 1024 }), "manifest");
  });

  it("returns 'inline' exactly at the cap boundary", () => {
    assert.equal(selectDiffMode({ diffText: "x".repeat(1024), maxBytes: 1024 }), "inline");
    assert.equal(selectDiffMode({ diffText: "x".repeat(1025), maxBytes: 1024 }), "manifest");
  });
});
