// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ARTIFACT_TYPES,
  CODEX_REVIEW_HARD_CAP,
  CODEX_REVIEW_PREPUSH_HARD_CAP,
  LINK_TYPES,
  PHASE_MARKER_PREFIX,
  PRIORITIES,
  RELATION_TYPES,
  REQUIREMENT_TYPES,
  STATUSES,
  buildCodexReviewToolDescription,
  buildPhaseMarker,
  evaluatePhasePrerequisite,
  parsePhaseMarkers,
  runPostImplementationPlan,
} from "./lib.js";
import { workspaceAuthorizationFor } from "./workspace-authorization.test-helpers.js";

async function withShimPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try { return await fn(); } finally { process.env.PATH = oldPath; }
}

describe("evaluatePhasePrerequisite", () => {
  it("allows the next phase when all prerequisites are present", () => {
    const result = evaluatePhasePrerequisite({
      completed: new Set(["preflight"]),
      nextPhase: "plan",
      requires: ["preflight"],
      issueNumber: 791,
    });
    assert.equal(result.ok, true);
    assert.equal(result.next_phase, "plan");
  });

  it("refuses with a structured error when prerequisites are missing", () => {
    const result = evaluatePhasePrerequisite({
      completed: new Set(),
      nextPhase: "plan",
      requires: ["preflight"],
      issueNumber: 791,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "phase_prerequisite_missing");
    assert.equal(result.next_phase, "plan");
    assert.deepEqual(result.missing, ["preflight"]);
    assert.equal(result.issue_number, 791);
    assert.match(result.message, /preflight/);
    assert.match(result.message, /issue #791/);
  });

  it("handles multiple prerequisites and reports every missing one", () => {
    const result = evaluatePhasePrerequisite({
      completed: new Set(["preflight"]),
      nextPhase: "review",
      requires: ["preflight", "plan", "tdd"],
      issueNumber: 1,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing.sort(), ["plan", "tdd"]);
  });

  it("treats requires=[] as 'no prerequisites' (allows unconditionally)", () => {
    const result = evaluatePhasePrerequisite({
      completed: new Set(),
      nextPhase: "preflight",
      requires: [],
      issueNumber: 1,
    });
    assert.equal(result.ok, true);
  });

  it("throws on garbage input (defensive)", () => {
    assert.throws(() =>
      evaluatePhasePrerequisite({ completed: ["array, not Set"], nextPhase: "p", requires: [] }),
    );
    assert.throws(() =>
      evaluatePhasePrerequisite({ completed: new Set(), nextPhase: "", requires: [] }),
    );
  });
});

describe("buildPhaseMarker", () => {
  it("produces a marker that round-trips through parsePhaseMarkers", () => {
    const marker = buildPhaseMarker({ phase: "preflight", issueNumber: 791 });
    assert.ok(marker.startsWith(PHASE_MARKER_PREFIX));
    const phases = parsePhaseMarkers([marker], 791);
    assert.ok(phases.has("preflight"));
  });

  it("two different phases on the same issue both register", () => {
    const m1 = buildPhaseMarker({ phase: "preflight", issueNumber: 1 });
    const m2 = buildPhaseMarker({ phase: "plan", issueNumber: 1 });
    const phases = parsePhaseMarkers([m1, m2], 1);
    assert.deepEqual([...phases].sort(), ["plan", "preflight"]);
  });

  it("a marker for one issue does not register for another", () => {
    const marker = buildPhaseMarker({ phase: "preflight", issueNumber: 791 });
    assert.equal(parsePhaseMarkers([marker], 100).size, 0);
  });

  it("includes attribution to #794 in the human-readable body", () => {
    const marker = buildPhaseMarker({ phase: "plan", issueNumber: 42 });
    assert.match(marker, /issue #794/);
    assert.match(marker, /issue #42/);
    assert.match(marker, /\bplan\b/);
  });
});

describe("runPostImplementationPlan dev_start_gate", () => {
  function makeShimRepo({ configYaml, ghHandler }) {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-plan-gate-"));
    execFileSync("git", ["-C", repoDir, "init", "-q"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
    writeFileSync(join(repoDir, ".ground-control.yaml"), configYaml);
    writeFileSync(join(repoDir, "README"), "x\n");
    execFileSync("git", ["-C", repoDir, "add", "."]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
    // Real origin so owner/repo resolves from the git remote, as production does. git ignores
    // GH_REPO; the `gh repo view` fallback honours it.
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
    const binDir = mkdtempSync(join(tmpdir(), "gc-plan-gate-bin-"));
    const configPath = join(binDir, "config.json");
    writeFileSync(configPath, JSON.stringify(ghHandler));
    const ghShim = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
const argv = process.argv.slice(2);
function match(prefix) { return prefix.every((p, i) => argv[i] === p); }
for (const route of cfg.routes) {
  if (match(route.argv_prefix)) {
    if (route.exit_code != null && route.exit_code !== 0) {
      process.stderr.write(route.stderr || "");
      process.exit(route.exit_code);
    }
    process.stdout.write(route.stdout || "");
    process.exit(0);
  }
}
process.stderr.write("gh shim: unhandled argv: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
    writeFileSync(join(binDir, "gh"), ghShim, { mode: 0o755 });
    return {
      repoDir,
      binDir,
      cleanup() {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      },
    };
  }

  async function withShimPath(binDir, fn) {
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try { return await fn(); } finally { process.env.PATH = oldPath; }
  }

  const enabledGateYaml = [
    "schema_version: 1",
    "project: x",
    "workflow:",
    "  dev_start_gate:",
    "    enabled: true",
    "    blocker_uids: [GC-O007]",
    "",
  ].join("\n");

  it("refuses before posting a plan marker when the enabled gate section is missing", async () => {
    const shim = makeShimRepo({
      configYaml: enabledGateYaml,
      ghHandler: {
        routes: [
          { argv_prefix: ["repo", "view", "--json", "nameWithOwner"], stdout: JSON.stringify({ nameWithOwner: "fake/repo" }) },
        ],
      },
    });
    try {
      await withShimPath(shim.binDir, async () => {
        const r = await runPostImplementationPlan({
          repoPath: shim.repoDir,
          issueNumber: 1194,
          planBody: "## Plan\n\nImplement source work.",
          override: true,
          overrideReason: "test skips preflight to isolate the dev-start gate",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(r.ok, false);
        assert.equal(r.error, "dev_start_gate_invalid");
        assert.equal(r.next_action, "add_valid_dev_start_gate_to_plan_and_retry");
        assert.ok(r.missing.includes("## Dev-Start Gate"));
      });
    } finally {
      shim.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-089 §2: runPostImplementationPlan's phase prerequisite is now
// requires:["preflight"] only — the grc_screening prerequisite and the
// grc_deliverables gate (formerly GC-GRC-010 here) are retired.
// ---------------------------------------------------------------------------

describe("runPostImplementationPlan preflight prerequisite", () => {
  function makeShim({ nameWithOwner = "fake/repo", comments = [], authorPermission = "write" }) {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-plan-prereq-"));
    execFileSync("git", ["-C", repoDir, "init", "-q"]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
    writeFileSync(join(repoDir, ".ground-control.yaml"), "schema_version: 1\nproject: x\n");
    writeFileSync(join(repoDir, "README"), "x\n");
    execFileSync("git", ["-C", repoDir, "add", "."]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
    // Real origin so owner/repo resolves from the git remote, as production does. git ignores
    // GH_REPO; the `gh repo view` fallback honours it.
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);
    const binDir = mkdtempSync(join(tmpdir(), "gc-plan-prereq-bin-"));
    // `gh api --method GET ... comments --paginate --slurp` returns array-of-arrays.
    // Comments carry an author because phase markers are believed only from someone with
    // repository permission, and a fixture without one cannot exercise that rule.
    const commentsSlurp = JSON.stringify([
      comments.map((body, i) => ({ id: i + 1, body, user: { login: "maintainer" } })),
    ]);
    const ghShim = `#!/usr/bin/env node
const argv = process.argv.slice(2);
function has(pre) { return pre.every((p, i) => argv[i] === p); }
function hasAny(sub) { return argv.some((a) => typeof a === "string" && a.includes(sub)); }
if (has(["repo", "view", "--json", "nameWithOwner"])) {
  process.stdout.write(${JSON.stringify(JSON.stringify({ nameWithOwner }))});
  process.exit(0);
}
if (hasAny("/collaborators/")) {
  process.stdout.write(${JSON.stringify(authorPermission)} + "\\n");
  process.exit(0);
}
if (has(["api", "--method", "GET"])) {
  process.stdout.write(${JSON.stringify(commentsSlurp)});
  process.exit(0);
}
if (has(["api", "--method", "POST"])) {
  process.stdout.write(JSON.stringify({ html_url: "https://x/issues/1#c1", id: 1 }));
  process.exit(0);
}
process.stderr.write("gh shim: unhandled argv: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
    writeFileSync(join(binDir, "gh"), ghShim, { mode: 0o755 });
    return {
      repoDir,
      binDir,
      cleanup() { rmSync(repoDir, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); },
    };
  }

  async function withPath(binDir, fn) {
    const old = process.env.PATH;
    process.env.PATH = `${binDir}:${old}`;
    try { return await fn(); } finally { process.env.PATH = old; }
  }

  function phaseBody(phase, issueNumber) {
    return `<!-- gc:phase phase="${phase}" issue="${issueNumber}" -->`;
  }

  it("does not accept a phase marker from an author without repository permission", async () => {
    // Phase markers gate the plan post, the review cap, and the completion record. They were read
    // from comment bodies with no regard for who wrote them, so anyone able to comment on the issue
    // could paste one and satisfy a prerequisite no phase had met. Obligation markers on the same
    // thread already resolve the author's effective permission; these now do too.
    const shim = makeShim({ comments: [phaseBody("preflight", 1123)], authorPermission: "none" });
    try {
      await withPath(shim.binDir, async () => {
        const r = await runPostImplementationPlan({
          repoPath: shim.repoDir,
          issueNumber: 1123,
          planBody: "## Plan\n\nWork.",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(r.ok, false);
        assert.equal(r.error, "phase_prerequisite_missing");
      });
    } finally {
      shim.cleanup();
    }
  });

  it("refuses (non-override) when the preflight prerequisite marker is missing", async () => {
    const shim = makeShim({ comments: [] });
    try {
      await withPath(shim.binDir, async () => {
        const r = await runPostImplementationPlan({
          repoPath: shim.repoDir,
          issueNumber: 1123,
          planBody: "## Plan\n\nWork.",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(r.ok, false);
        assert.equal(r.error, "phase_prerequisite_missing");
        assert.deepEqual(r.missing, ["preflight"]);
        assert.equal(r.next_action, "run_gc_codex_architecture_preflight_first");
      });
    } finally { shim.cleanup(); }
  });

  it("proceeds past the prerequisite check (non-override) when the preflight marker is present", async () => {
    const shim = makeShim({ comments: [phaseBody("preflight", 1123)] });
    try {
      await withPath(shim.binDir, async () => {
        const r = await runPostImplementationPlan({
          repoPath: shim.repoDir,
          issueNumber: 1123,
          planBody: "## Plan\n\nWork.",
        }, { workspaceAuthorizationResolver: workspaceAuthorizationFor(shim.repoDir) });
        assert.equal(r.ok, true);
      });
    } finally { shim.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("STATUSES matches Java Status enum", () => {
    assert.deepEqual(STATUSES, ["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"]);
  });

  it("REQUIREMENT_TYPES matches Java RequirementType enum", () => {
    assert.deepEqual(REQUIREMENT_TYPES, ["FUNCTIONAL", "NON_FUNCTIONAL", "CONSTRAINT", "INTERFACE"]);
  });

  it("PRIORITIES matches Java Priority enum", () => {
    assert.deepEqual(PRIORITIES, ["MUST", "SHOULD", "COULD", "WONT"]);
  });

  it("RELATION_TYPES matches Java RelationType enum", () => {
    assert.deepEqual(RELATION_TYPES, ["PARENT", "DEPENDS_ON", "CONFLICTS_WITH", "REFINES", "SUPERSEDES", "RELATED"]);
  });

  it("ARTIFACT_TYPES matches Java ArtifactType enum", () => {
    assert.deepEqual(ARTIFACT_TYPES, [
      "GITHUB_ISSUE",
      "PULL_REQUEST",
      "CODE_FILE",
      "ADR",
      "CONFIG",
      "POLICY",
      "TEST",
      "SPEC",
      "PROOF",
      "DOCUMENTATION",
      "RISK_SCENARIO",
      "CONTROL",
    ]);
  });

  it("LINK_TYPES matches Java LinkType enum", () => {
    assert.deepEqual(LINK_TYPES, ["IMPLEMENTS", "TESTS", "DOCUMENTS", "CONSTRAINS", "VERIFIES"]);
  });
});

// ---------------------------------------------------------------------------
// gc_codex_review tool description / override description builders (#794)
//
// The MCP tool descriptions for `gc_codex_review` are part of the public
// protocol surface — every LLM client that lists the tool sees them. Inline
// strings in index.js drifted past the cap bumps in #804 (post-push and
// pre-push caps moved 2 → 3) and the pre-push key change in #800 review
// (was (issue, branch), now issue alone per ADR-029). These builders are
// pure functions that interpolate the live constants so the description
// cannot drift again.
// ---------------------------------------------------------------------------

describe("buildCodexReviewToolDescription", () => {
  it("surfaces both live cap values (collapsed when equal)", () => {
    const desc = buildCodexReviewToolDescription({
      postPushCap: CODEX_REVIEW_HARD_CAP,
      prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP,
    });
    assert.ok(
      desc.includes(`${CODEX_REVIEW_HARD_CAP} cycles per PR`),
      `description must mention "${CODEX_REVIEW_HARD_CAP} cycles per PR"; got: ${desc}`,
    );
    assert.ok(
      desc.includes(`${CODEX_REVIEW_PREPUSH_HARD_CAP} cycles per issue`),
      `description must mention "${CODEX_REVIEW_PREPUSH_HARD_CAP} cycles per issue"; got: ${desc}`,
    );
  });

  it("uses a mode-neutral cap heading (not 'Hard-cap-N enforcement') so divergent caps don't mislead", () => {
    const desc = buildCodexReviewToolDescription({
      postPushCap: CODEX_REVIEW_HARD_CAP,
      prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP,
    });
    assert.match(desc, /Cycle-cap enforcement/i);
    assert.ok(
      !/\bHard-cap-\d+\s+enforcement\b/i.test(desc),
      `must not contain a hard-cap-N enforcement phrase anywhere (start of line or inline); got: ${desc}`,
    );
  });

  it("does not contain the stale hard-cap-2 wording", () => {
    const desc = buildCodexReviewToolDescription({
      postPushCap: CODEX_REVIEW_HARD_CAP,
      prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP,
    });
    assert.ok(
      !/hard-cap-2\b/i.test(desc),
      `description must not contain "hard-cap-2"; got: ${desc}`,
    );
    assert.ok(
      !/two cycles per PR/.test(desc),
      `description must not say "two cycles per PR"; got: ${desc}`,
    );
  });

  it("does not advertise the (issue, branch) pair shape (ADR-029: keyed by issue alone)", () => {
    const desc = buildCodexReviewToolDescription({
      postPushCap: CODEX_REVIEW_HARD_CAP,
      prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP,
    });
    assert.ok(
      !/\(issue,\s*branch\)\s+pair/i.test(desc),
      `description must not advertise (issue, branch) pair keying; got: ${desc}`,
    );
  });

  it("references both #794 and #796 so audit history points at the right MVPs", () => {
    const desc = buildCodexReviewToolDescription({
      postPushCap: CODEX_REVIEW_HARD_CAP,
      prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP,
    });
    assert.ok(desc.includes("#794"), `description must reference issue #794; got: ${desc}`);
    assert.ok(desc.includes("#796"), `description must reference issue #796; got: ${desc}`);
  });

  it("documents the override_cap=true / override_reason escape hatch", () => {
    const desc = buildCodexReviewToolDescription({
      postPushCap: CODEX_REVIEW_HARD_CAP,
      prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP,
    });
    assert.ok(desc.includes("override_cap=true"), `must mention override_cap=true; got: ${desc}`);
    assert.ok(
      desc.includes("override_reason"),
      `must mention override_reason; got: ${desc}`,
    );
  });

  it("makes PR auto-detect mode-specific (post-push only, pre-push needs explicit pr_number)", () => {
    const desc = buildCodexReviewToolDescription({
      postPushCap: CODEX_REVIEW_HARD_CAP,
      prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP,
    });
    assert.match(
      desc,
      /post-push.*auto-detects/is,
      `must scope auto-detect to post-push reviews; got: ${desc}`,
    );
    assert.match(
      desc,
      /pre-push.*pr_number.*explicit/is,
      `must clarify pre-push needs an explicit pr_number; got: ${desc}`,
    );
  });

  it("interpolates whatever caps the caller passes (equal case)", () => {
    const desc = buildCodexReviewToolDescription({ postPushCap: 7, prepushCap: 7 });
    assert.match(desc, /hard-cap-7\b/i);
    assert.ok(desc.includes("7 cycles per PR"), `expected "7 cycles per PR"; got: ${desc}`);
    assert.ok(desc.includes("7 cycles per issue"), `expected "7 cycles per issue"; got: ${desc}`);
    assert.ok(!/\b3\s+cycles\s+per\s+PR\b/.test(desc), `must not leak default 3; got: ${desc}`);
  });

  it("surfaces both cap values when post-push and pre-push diverge", () => {
    const desc = buildCodexReviewToolDescription({ postPushCap: 5, prepushCap: 11 });
    assert.ok(desc.includes("5 cycles per PR"), `expected "5 cycles per PR"; got: ${desc}`);
    assert.ok(desc.includes("11 cycles per issue"), `expected "11 cycles per issue"; got: ${desc}`);
    assert.match(desc, /post-push 5.*pre-push 11|pre-push 11.*post-push 5/is);
  });
});
