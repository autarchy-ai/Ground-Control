// Split from gc-implement-contract.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildExecutionObligationMarker,
  evaluateExecutionObligations,
  parseExecutionObligationMarkers,
  runAuthorizeExecutionObligationWontfix,
  runMarkImplementIssuePickedUp,
  runRecordExecutionObligation,
  validateExecutionObligationInput,
} from "./lib.js";

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gc-implement-contract-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "initial"]);
  execFileSync("git", ["-C", repo, "branch", "-M", "dev"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/example/repo.git"]);
  return repo;
}

function authorizationForRepo(repo) {
  // A freshly `git init`'d repo is a main worktree, so --absolute-git-dir and
  // --git-common-dir resolve to the same `.git` (issue #1502).
  const gitDir = realpathSync(
    execFileSync("git", ["-C", repo, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim(),
  );
  return {
    workspaceRoot: realpathSync(repo),
    gitDir,
    gitCommonDir: gitDir,
    origin: execFileSync(
      "git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" },
    ).trim(),
    owner: "example",
    name: "repo",
  };
}

function installGhObligationShim(bin, logPath) {
  const openMarker =
    '<!-- gc:execution-obligation schema="gc.implement.execution-obligation/v1" ' +
    'issue="1416" id="OB-1" event="opened" -->';
  const comments = [[
    {
      id: 8998,
      body: "/ground-control authorize-wontfix OB-1",
      user: { login: "repository-owner" },
      author_association: "OWNER",
    },
    {
      id: 8999,
      body: openMarker,
      user: { login: "automation" },
      author_association: "MEMBER",
    },
    {
      id: 9000,
      body: '<!-- gc:execution-obligation-authorization schema="gc.implement.execution-obligation-authorization/v1" issue="1416" id="OB-1" action="authorize_wontfix" source_comment_id="8998" -->',
      user: { login: "automation" },
      author_association: "MEMBER",
    },
  ]];
  const body = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "api" && argv[1] === "user") {
  process.stdout.write("automation\\n");
  process.exit(0);
}
if (argv.some((arg) => arg.includes("/collaborators/") && arg.endsWith("/permission"))) {
  process.stdout.write("write\\n");
  process.exit(0);
}
if (argv.includes("--method") && argv.includes("GET")) {
  process.stdout.write(${JSON.stringify(JSON.stringify(comments))});
  process.exit(0);
}
if (argv.includes("--method") && argv.includes("POST")) {
  fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv));
  process.stdout.write(JSON.stringify({id: 9001, html_url: "https://github.com/example/repo/issues/1416#issuecomment-9001"}));
  process.exit(0);
}
process.stderr.write("unexpected gh argv: " + JSON.stringify(argv));
process.exit(2);
`;
  writeFileSync(join(bin, "gh"), body, { mode: 0o755 });
}

function installGhApiShim(bin, comments, logPath) {
  const pages = [comments];
  const body = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + "\\n");
const endpoint = argv.find((arg) => arg.startsWith("/repos/")) || "";
if (endpoint.includes("/collaborators/") && endpoint.endsWith("/permission")) {
  process.stdout.write("write\\n");
  process.exit(0);
}
if (argv.includes("GET") && endpoint.includes("/issues/") && endpoint.endsWith("/comments")) {
  process.stdout.write(${JSON.stringify(JSON.stringify(pages))});
  process.exit(0);
}
if (argv.includes("GET") && endpoint.endsWith("/labels/in-progress")) {
  process.stdout.write("{}");
  process.exit(0);
}
if (argv.includes("POST")) {
  process.stdout.write(JSON.stringify({id: 9900, html_url: "https://github.com/example/repo/issues/1416#issuecomment-9900"}));
  process.exit(0);
}
process.stderr.write("unexpected gh argv: " + JSON.stringify(argv));
process.exit(2);
`;
  writeFileSync(join(bin, "gh"), body, { mode: 0o755 });
}

async function withPath(bin, fn) {
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = old;
  }
}

describe("execution obligation ledger", () => {
  it("keeps escalation open and closes only on a valid terminal resolution", () => {
    const opened = buildExecutionObligationMarker({
      issueNumber: 1416, obligationId: "OB-1", event: "opened",
    });
    const escalated = buildExecutionObligationMarker({
      issueNumber: 1416, obligationId: "OB-1", event: "escalated",
    });
    const resolved = buildExecutionObligationMarker({
      issueNumber: 1416, obligationId: "OB-1", event: "resolved", disposition: "fix",
    });
    const openState = evaluateExecutionObligations(
      parseExecutionObligationMarkers([opened, escalated], 1416),
    );
    assert.deepEqual(openState.open_obligation_ids, ["OB-1"]);
    const closedState = evaluateExecutionObligations(
      parseExecutionObligationMarkers([opened, escalated, resolved], 1416),
    );
    assert.deepEqual(closedState.open_obligation_ids, []);
  });

  it("requires a concrete decision request for escalation", () => {
    const result = validateExecutionObligationInput({
      issueNumber: 1416,
      obligationId: "OB-1",
      event: "escalated",
      category: "security",
      observedState: "A security boundary is ambiguous.",
      evidence: ["Policy and implementation disagree."],
      impact: "Choosing incorrectly could weaken authorization.",
      obligation: "Resolve and verify the authorization boundary.",
      pauseClass: "significant_security_decision",
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("decisionRequest")));
  });

  it("allows not-applicable only when the reported condition is factually false", () => {
    const result = validateExecutionObligationInput({
      issueNumber: 1416,
      obligationId: "OB-1",
      event: "resolved",
      category: "quality",
      observedState: "The reported condition was checked.",
      evidence: ["The referenced path does not exist in this repository."],
      impact: "No product behavior is affected.",
      obligation: "Verify whether the condition applies.",
      disposition: "not-applicable",
      correctiveAction: "Confirmed the report is factually false for this repository.",
      verification: ["Repository-wide path and symbol search returned no matching surface."],
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("requires wontfix authorization to reference a durable issue comment", () => {
    const result = validateExecutionObligationInput({
      issueNumber: 1416,
      obligationId: "OB-1",
      event: "resolved",
      category: "quality",
      observedState: "The issue is real.",
      evidence: ["Reproduced locally."],
      impact: "The quality gate remains weakened.",
      obligation: "Repair the quality gate.",
      disposition: "wontfix",
      correctiveAction: "No corrective action was authorized.",
      verification: ["The authorization record was checked."],
      userAuthorization: "the user said this was fine",
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("issue-comment URL")));
  });

  it("rejects obligation mutation outside the MCP launch workspace", async () => {
    const repo = initRepo();
    try {
      const result = await runRecordExecutionObligation({
        repoPath: repo,
        issueNumber: 1416,
        obligationId: "OB-1",
        event: "opened",
        category: "security",
        observedState: "A security issue was found.",
        evidence: ["A focused test reproduces it."],
        impact: "The completion gate could be bypassed.",
        obligation: "Repair and verify the completion gate.",
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, "execution_obligation_repo_not_authorized");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects a mutable origin retarget before obligation mutation", async () => {
    const repo = initRepo();
    try {
      const authorization = authorizationForRepo(repo);
      execFileSync("git", [
        "-C", repo, "remote", "set-url", "origin", "https://github.com/example/other.git",
      ]);
      const result = await runRecordExecutionObligation({
        repoPath: repo,
        issueNumber: 1416,
        obligationId: "OB-1",
        event: "opened",
        category: "security",
        observedState: "A security issue was found.",
        evidence: ["A focused test reproduces it."],
        impact: "The completion gate could be bypassed.",
        obligation: "Repair and verify the completion gate.",
      }, { workspaceAuthorizationResolver: async () => authorization });
      assert.equal(result.ok, false);
      assert.equal(result.error, "implement_repo_identity_changed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("binds a wontfix marker to its verified authorization comment", async () => {
    const repo = initRepo();
    const bin = mkdtempSync(join(tmpdir(), "gc-obligation-bin-"));
    const log = join(bin, "post.log");
    installGhObligationShim(bin, log);
    try {
      const result = await withPath(bin, () =>
        runRecordExecutionObligation({
          repoPath: repo,
          issueNumber: 1416,
          obligationId: "OB-1",
          event: "resolved",
          category: "quality",
          observedState: "The issue is real.",
          evidence: ["Reproduced locally."],
          impact: "The issue remains accepted by explicit user decision.",
          obligation: "Repair the issue or record explicit authorization.",
          disposition: "wontfix",
          correctiveAction: "Recorded the explicit user disposition.",
          verification: ["Verified the durable authorization comment and signer."],
          userAuthorization:
            "https://github.com/example/repo/issues/1416#issuecomment-9000",
        }, { workspaceAuthorizationResolver: async () => authorizationForRepo(repo) }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.match(readFileSync(log, "utf8"), /authorization_comment_id=\\"9000\\"/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("rejects negated, questioned, quoted, and reported wontfix prose", async () => {
    const rejectedBodies = [
      "I do not authorize wontfix for OB-1",
      "Should I authorize wontfix for OB-1?",
      "\"/ground-control authorize-wontfix OB-1\"",
      "Alice said /ground-control authorize-wontfix OB-1",
    ];
    for (const sourceBody of rejectedBodies) {
      const repo = initRepo();
      const bin = mkdtempSync(join(tmpdir(), "gc-authorization-bin-"));
      const log = join(bin, "gh.log");
      writeFileSync(log, "");
      installGhApiShim(bin, [{
        id: 9100,
        body: sourceBody,
        user: { login: "repository-owner" },
        author_association: "OWNER",
      }], log);
      try {
        const result = await withPath(bin, () =>
          runAuthorizeExecutionObligationWontfix({
            repoPath: repo,
            issueNumber: 1416,
            obligationId: "OB-1",
            authorizationSourceUrl:
              "https://github.com/example/repo/issues/1416#issuecomment-9100",
          }, {
            workspaceAuthorizationResolver: async () => authorizationForRepo(repo),
          }),
        );
        assert.equal(result.ok, false, sourceBody);
        assert.equal(result.error, "execution_obligation_authorization_unverifiable");
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(bin, { recursive: true, force: true });
      }
    }
  });

  it("records pickup label and comment through the pinned server operation", async () => {
    const repo = initRepo();
    const bin = mkdtempSync(join(tmpdir(), "gc-pickup-bin-"));
    const log = join(bin, "gh.log");
    writeFileSync(log, "");
    installGhApiShim(bin, [], log);
    try {
      const result = await withPath(bin, () =>
        runMarkImplementIssuePickedUp({
          repoPath: repo,
          issueNumber: 1416,
          driver: "codex",
          branchName: "1416-implement-principles",
        }, {
          workspaceAuthorizationResolver: async () => authorizationForRepo(repo),
          now: () => new Date("2026-07-25T12:00:00.000Z"),
        }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      const calls = readFileSync(log, "utf8");
      assert.match(calls, /labels\/in-progress/);
      assert.match(calls, /labels\[\]=in-progress/);
      assert.match(calls, /Picked up by \/implement/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("records a lane-specific quickfix pickup comment", async () => {
    const repo = initRepo();
    const bin = mkdtempSync(join(tmpdir(), "gc-pickup-bin-"));
    const log = join(bin, "gh.log");
    writeFileSync(log, "");
    installGhApiShim(bin, [], log);
    try {
      const result = await withPath(bin, () =>
        runMarkImplementIssuePickedUp({
          repoPath: repo,
          issueNumber: 1637,
          driver: "codex",
          branchName: "1637-simplify-quickfix",
          lane: "quickfix",
        }, {
          workspaceAuthorizationResolver: async () => authorizationForRepo(repo),
          now: () => new Date("2026-09-17T12:00:00.000Z"),
        }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.match(readFileSync(log, "utf8"), /Picked up by \/quickfix/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
