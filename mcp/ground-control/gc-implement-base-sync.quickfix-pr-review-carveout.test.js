// The /quickfix lane opens a pull request without a published AI review (issue #1365
// follow-on).
//
// `gc_render_pr_body` has always accepted `lane: "quickfix"` with
// `pre_push_reviews: "not_run"` and rendered the matching attestation, but the PR-
// creation boundary demanded a complete trusted review-publication tuple from every
// caller. The lane's default path therefore rendered a body it could never submit. The
// waiver covers that tuple and nothing else, and it is refused for a requirement-backed
// issue, which is not a legal quickfix.

import { execFile as execFileCb } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCreateSynchronizedImplementPr } from "./lib.js";

const execFile = promisify(execFileCb);

const REPO_ROOT = realpathSync(new URL("../..", import.meta.url).pathname);
const ISSUE = 1365;
const BRANCH = "1365-bind-ci-watcher-head-sha";
const RECORD = "a".repeat(32);
const PRE = "1".repeat(40);
const BASE = "2".repeat(40);
const RESULT = "3".repeat(40);
const TREE = "4".repeat(40);

async function workspaceAuthorization() {
  const [gitDir, gitCommonDir, origin] = await Promise.all([
    execFile("git", ["-C", REPO_ROOT, "rev-parse", "--absolute-git-dir"]),
    execFile("git", ["-C", REPO_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    execFile("git", ["-C", REPO_ROOT, "remote", "get-url", "origin"]),
  ]);
  return {
    workspaceRoot: REPO_ROOT,
    gitDir: realpathSync(gitDir.stdout.trim()),
    gitCommonDir: realpathSync(gitCommonDir.stdout.trim()),
    origin: origin.stdout.trim(),
    owner: "autarchy-ai",
    name: "ground-control",
  };
}

const context = () => ({
  status: "ok",
  workflow: { base_branch: "dev", completion_command: "make check", policy_command: "make policy", pr_title: null },
});

function renderedPrBody(reference = `Closes #${ISSUE}`) {
  return [
    "## Summary", "", "A bounded fix.", "",
    "## Requirement UIDs", "", "- (none — bug/refactor/maintenance run; see Traceability section below)", "",
    "## Related Issues", "", reference, "",
    "## ADR Impact", "", "- ADR-027", "",
    "## Changes", "", "- One change.", "",
    "## Test Plan", "", "- [x] Unit tests pass", "",
    "## Ground Control Checks", "",
    "- [x] Repository policy checks required in CI before merge",
    "- [x] Pre-push Codex review not run for this lane; CI and repository policy gates enforced", "",
    "## Traceability", "", `- IMPLEMENTS: GITHUB_ISSUE ${ISSUE}`, "- TESTS: mcp/ground-control/lib.ci-watcher.test.js", "",
    "## Checklist", "", "- [x] Code follows the project's coding standards", "",
    "## Documentation", "", "Updated: see diff.", "",
  ].join("\n");
}

const gitOperation = (args) => args.slice(args.indexOf(REPO_ROOT) + 1);

function happyRunner() {
  return async (command, args) => {
    if (command === "gh") {
      const path = args.find((arg) => arg.startsWith("/repos/")) ?? "";
      const method = args[args.indexOf("--method") + 1];
      if (method === "GET" && path.includes("/pulls?")) return { stdout: "[]\n" };
      if (method === "POST" && path.endsWith("/pulls")) {
        return { stdout: JSON.stringify({ number: 900, html_url: "https://github.com/autarchy-ai/Ground-Control/pull/900" }) };
      }
    }
    const op = gitOperation(args);
    if (op[0] === "symbolic-ref") return { stdout: `${BRANCH}\n` };
    if (op[0] === "status" || op[0] === "fetch" || op[0] === "merge-base") return { stdout: "" };
    if (op[0] === "rev-parse") {
      const ref = op[op.length - 1];
      if (ref.endsWith("^{tree}")) return { stdout: `${TREE}\n` };
      if (ref.startsWith("refs/remotes/origin/dev")) return { stdout: `${BASE}\n` };
      return { stdout: `${RESULT}\n` };
    }
    if (op[0] === "ls-remote") return { stdout: `${RESULT}\trefs/heads/${BRANCH}\n` };
    throw new Error(`unexpected operation: ${command} ${args.join(" ")}`);
  };
}

const syncRecordReader = async () => ({
  ok: true,
  record: {
    recordId: RECORD, issueNumber: ISSUE, branchName: BRANCH, baseBranch: "dev",
    remoteRef: "refs/remotes/origin/dev", preSyncSha: PRE, fetchedBaseSha: BASE,
    outcome: "merged_clean", resultingFeatureSha: RESULT, verifiedTreeSha: TREE,
    // The delivery binding the record carries (issue #1679). This lane publishes
    // no review, so it names none.
    settledTreeSha: TREE, reviewPublicationId: "-", reviewRevisionDigest: "-", lane: "quickfix",
  },
});

function create(lane, issueBody, deps = {}, reference = undefined) {
  return runCreateSynchronizedImplementPr({
    repoPath: REPO_ROOT,
    issueNumber: ISSUE,
    branchName: BRANCH,
    recordId: RECORD,
    title: "fix: bind the CI watcher to the pushed head commit",
    body: renderedPrBody(reference),
    ...(lane === null ? {} : { lane }),
  }, {
    workspaceAuthorizationResolver: workspaceAuthorization,
    commandRunner: happyRunner(),
    contextResolver: async () => context(),
    issueThreadReader: async () => ({ ok: true, body: issueBody }),
    syncRecordReader,
    reviewEvidenceReader: async () => ({ ok: true, published: false }),
    // The lane is derived from the run's trusted pickup record (issue #1679); each
    // case states which run it is modelling.
    laneReader: async () => ({ ok: true, lane: lane === null ? "implement" : lane }),
    ...deps,
  });
}

describe("gc_create_synchronized_implement_pr — review is observational", () => {
  it("creates the PR for a requirement-free quickfix without consulting review evidence", async () => {
    let consulted = false;
    const result = await create("quickfix", "No requirements section here.", {
      reviewEvidenceReader: async () => {
        consulted = true;
        return { ok: true, published: false };
      },
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.pr_number, 900);
    assert.equal(consulted, false, "a waived gate must not spend a GitHub read either");
  });

  it("refuses a lane it does not define rather than treating it as /implement", async () => {
    const result = await create("yolo", "No requirements section here.");

    assert.equal(result.ok, false);
    assert.equal(result.error, "implement_pr_input_invalid");
  });
});
