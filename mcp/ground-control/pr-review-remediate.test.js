// Maintainer PR-review lane — remediation tests: validation, identity binding,
// checkout guards, and sync_base (issue #1535).
//
// Acceptance criteria covered here: the workflow performs NO mutation before an
// explicit authorization; an authorized change updates the EXISTING PR branch in
// the current checkout via a real integration-branch merge (no worktree, no
// rebase, no reset, no force); fork / branch-access failures are stable
// non-mutating refusals; stale-base handling merges cleanly or surfaces
// conflicts for manual resolution.

import { execFile as execFileCb } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REVIEW_REMEDIATION_APPROVAL_PHRASE, readLivePullRequest, runRemediatePullRequest } from "./lib.js";
import { restPullRequest } from "./github-rest.test-helpers.js";

const execFile = promisify(execFileCb);
const REPO_ROOT = realpathSync(new URL("../..", import.meta.url).pathname);

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const RESULT = "d".repeat(40);
const approvalReview = (over = {}) =>
  ({ user: { login: "maint" }, commit_id: HEAD, body: `looks good — ${REVIEW_REMEDIATION_APPROVAL_PHRASE}`, state: "COMMENTED", ...over });

async function workspaceAuthorization() {
  const [gitCommonDir, origin] = await Promise.all([
    execFile("git", ["-C", REPO_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    execFile("git", ["-C", REPO_ROOT, "remote", "get-url", "origin"]),
  ]);
  return {
    workspaceRoot: REPO_ROOT,
    gitDir: REPO_ROOT,
    gitCommonDir: realpathSync(gitCommonDir.stdout.trim()),
    origin: origin.stdout.trim(),
    owner: "autarchy-ai",
    name: "ground-control",
  };
}

function reviewedIdentity(overrides = {}) {
  return { base_ref: "dev", head_ref: "contributor-branch", base_oid: BASE, head_oid: HEAD, cross_repository: false, ...overrides };
}

// The live PR as GET /repos/{o}/{r}/pulls/42 returns it; overrides take the
// restPullRequest options (e.g. `headOwner` for a fork, `mergedAt` for a merge).
function livePr(overrides = {}) {
  return restPullRequest({
    owner: "autarchy-ai", name: "ground-control", number: 42,
    headRefName: "contributor-branch", headRefOid: HEAD, baseRefName: "dev", baseRefOid: BASE,
    maintainerCanModify: true, mergeableState: "clean", ...overrides,
  });
}

function gitOp(args) {
  const marker = args.indexOf("-C");
  return args.slice(marker + 2);
}

// One configurable, git-state-aware runner covering every op the lane issues.
function runner(spec = {}) {
  const s = {
    live: livePr(), activeBranch: "contributor-branch", status: "", localHead: HEAD,
    ancestor: false, headLineage: true, mergeThrows: false, unmerged: [], mergeHead: false,
    detached: false, fetchThrows: false, gateFail: false, pushThrows: false,
    contextStatus: "ok", commentThrows: false, existingComments: [], baseBranch: null,
    reviews: [approvalReview()], permission: "write", ...spec,
  };
  const calls = [];
  let committed = false;
  let mergeInProgress = s.mergeHead;
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === "gh") {
      // GraphQL is exhausted: every GraphQL-backed gh call fails, so remediation must use REST.
      if (args[1] === "graphql" || args[0] === "pr") {
        const e = new Error("GraphQL: API rate limit exceeded"); e.stderr = "RATE_LIMITED"; throw e;
      }
      const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
      if (args[0] === "api" && method === "POST") { // comment POST
        if (s.commentThrows) { const e = new Error("comment failed"); e.stderr = "HTTP 403"; throw e; }
        return { stdout: JSON.stringify({ html_url: "https://github.com/o/r/pull/42#issuecomment-1", id: 1 }) };
      }
      if (args[0] === "api") { // reads
        const path = args.find((a) => a.startsWith("/repos/")) ?? "";
        if (/\/pulls\/42$/.test(path)) return { stdout: JSON.stringify(s.live) };
        if (path.includes("/reviews")) return { stdout: JSON.stringify(s.reviews) };
        return { stdout: JSON.stringify(s.existingComments) }; // GET comments (idempotency)
      }
      throw new Error(`unexpected gh: ${JSON.stringify(args)}`);
    }
    const op = gitOp(args);
    switch (op[0]) {
      case "add": return { stdout: "" };
      case "symbolic-ref":
        if (s.detached) { const e = new Error("detached"); e.code = 1; throw e; }
        return { stdout: `${s.activeBranch}\n` };
      case "status": return { stdout: s.status };
      case "rev-parse": {
        const ref = op[op.length - 1];
        if (ref === "@{upstream}") {
          if (s.upstream == null) { const e = new Error("no upstream"); e.code = 128; throw e; }
          return { stdout: `${s.upstream}\n` };
        }
        if (ref.startsWith("MERGE_HEAD")) {
          if (!mergeInProgress) { const e = new Error("no MERGE_HEAD"); e.code = 128; throw e; }
          return { stdout: `${BASE}\n` };
        }
        if (ref.includes("refs/remotes/origin/")) return { stdout: `${BASE}\n` };
        return { stdout: `${committed ? RESULT : s.localHead}\n` };
      }
      case "fetch":
        if (s.fetchThrows) { const e = new Error("fetch failed"); e.stderr = "remote"; throw e; }
        return { stdout: "" };
      case "merge-base": {
        // ["merge-base","--is-ancestor", A, B]. A === reviewed head OID asks the
        // lineage question; otherwise it is the base-ancestor question.
        const a = op[2];
        const yes = a === HEAD ? s.headLineage : s.ancestor;
        if (yes) return { stdout: "" };
        { const e = new Error("not ancestor"); e.code = 1; throw e; }
      }
      case "merge":
        mergeInProgress = true;
        if (s.mergeThrows) { const e = new Error("merge conflict"); e.code = 1; throw e; }
        return { stdout: "" };
      case "ls-files":
        return { stdout: mergeInProgress ? s.unmerged.map((p) => `100644 x 1\t${p}`).join("\n") : "" };
      case "commit": committed = true; mergeInProgress = false; return { stdout: "" };
      case "push":
        if (s.pushThrows) { const e = new Error("rejected"); e.stderr = "non-fast-forward"; throw e; }
        return { stdout: "" };
      default: throw new Error(`unexpected git op: ${op.join(" ")}`);
    }
  };
  const injections = {
    commandRunner: run,
    workspaceAuthorizationResolver: workspaceAuthorization,
    contextResolver: async () => ({ status: s.contextStatus, workflow: { base_branch: s.baseBranch, completion_command: "make mcp-test", policy_command: "make policy" } }),
    permissionResolver: async () => s.permission,
  };
  return { calls, run: (input) => runRemediatePullRequest(input, injections), run_command: run, calls_ref: calls };
}

function baseInput(action, overrides = {}) {
  return { repoPath: REPO_ROOT, prNumber: 42, action, authorization: "please fix the null check", reviewedIdentity: reviewedIdentity(), ...overrides };
}

function assertNoMutation(calls) {
  const mutating = new Set(["fetch", "merge", "commit", "push", "reset", "rebase", "cherry-pick", "switch", "checkout", "add"]);
  for (const [command, args] of calls) {
    if (command === "git") assert.ok(!mutating.has(gitOp(args)[0]), `unexpected mutation: ${gitOp(args)[0]}`);
    if (command === "gh" && args.includes("--method")) {
      const method = args[args.indexOf("--method") + 1];
      assert.ok(!["POST", "PATCH", "PUT", "DELETE"].includes(String(method).toUpperCase()), "unexpected gh write");
    }
  }
}

describe("runRemediatePullRequest — validation & authorization", () => {
  it("rejects an unknown action", async () => {
    const r = runner();
    const out = await r.run(baseInput("frobnicate"));
    assert.equal(out.error, "pr_remediation_action_invalid");
    assertNoMutation(r.calls_ref);
  });

  it("refuses without an explicit authorization — no mutation", async () => {
    const r = runner();
    const out = await r.run(baseInput("sync_base", { authorization: "" }));
    assert.equal(out.error, "pr_remediation_authorization_missing");
    assert.equal(r.calls_ref.length, 0);
  });

  it("rejects an ill-formed reviewed identity", async () => {
    const r = runner();
    const out = await r.run(baseInput("sync_base", { reviewedIdentity: { head_ref: "x" } }));
    assert.equal(out.ok, false);
    assert.match(out.error, /^pr_review_(identity|ref|oid)_invalid$/);
  });
});

describe("runRemediatePullRequest — trusted-host confirmation (F6 / cycle-3 F5)", () => {
  it("refuses remediation without an approval review carrying the phrase", async () => {
    const r = runner({ reviews: [approvalReview({ body: "LGTM, no phrase" })] });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_confirmation_required");
    assertNoMutation(r.calls_ref);
  });

  it("refuses an approval review bound to an earlier head (backdate-proof)", async () => {
    const r = runner({ reviews: [approvalReview({ commit_id: "e".repeat(40) })] });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_confirmation_required");
    assertNoMutation(r.calls_ref);
  });

  it("refuses when the approving reviewer lacks write permission", async () => {
    const r = runner({ permission: null });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_confirmation_unverified");
    assertNoMutation(r.calls_ref);
  });
});

describe("runRemediatePullRequest — identity binding (CAS)", () => {
  it("refuses when the PR head advanced since review", async () => {
    const r = runner({ live: livePr({ headRefOid: RESULT }) });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_remote_head_moved");
    assertNoMutation(r.calls_ref);
  });

  it("refuses when the PR base branch changed since review", async () => {
    const r = runner({ live: livePr({ baseRefName: "main" }) });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_stale_authorization");
    assertNoMutation(r.calls_ref);
  });

  it("refuses when the PR cross-repository status changed since review", async () => {
    // reviewedIdentity.cross_repository is false; the live PR is now a fork.
    const r = runner({ live: livePr({ headOwner: "fork" }) });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_stale_authorization");
    assertNoMutation(r.calls_ref);
  });
});

describe("runRemediatePullRequest — REST live read with GraphQL exhausted (issue #1586)", () => {
  it("maps the REST pull request onto the live identity the safety checks compare", async () => {
    const r = runner({ live: livePr({ headOwner: "fork", maintainerCanModify: true }) });
    const out = await readLivePullRequest(REPO_ROOT, "autarchy-ai", "ground-control", 42, r.run_command);
    assert.deepEqual(out.live, {
      state: "OPEN", head_ref: "contributor-branch", head_oid: HEAD, base_ref: "dev", base_oid: BASE,
      cross_repository: true, head_repository_deleted: false, maintainer_can_modify: true, merged_at: null,
      url: "https://github.com/autarchy-ai/ground-control/pull/42",
    });
  });

  it("completes sync_base while every GraphQL-backed gh call fails", async () => {
    const r = runner({ ancestor: false });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.ok, true);
    assert.equal(out.outcome, "merged_clean");
  });

  it("refuses a merged pull request without mutating", async () => {
    const r = runner({ live: livePr({ mergedAt: "2026-09-13T00:00:00Z" }) });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_pr_not_open");
    assert.equal(out.pr_state, "MERGED");
    assertNoMutation(r.calls_ref);
  });

  it("refuses a closed pull request without mutating", async () => {
    const r = runner({ status: STAGED, ancestor: true, live: livePr({ state: "CLOSED" }) });
    const out = await r.run(publishInput());
    assert.equal(out.error, "pr_remediation_pr_not_open");
    assert.equal(out.pr_state, "CLOSED");
    assertNoMutation(r.calls_ref);
  });

  it("refuses when the REST pull request cannot be read", async () => {
    const r = runner({ live: { message: "Not Found" } });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_pr_unavailable");
    assertNoMutation(r.calls_ref);
  });
});

describe("runRemediatePullRequest — fork / branch access", () => {
  it("refuses in-place remediation of a fork (cross-repository) PR — no mutation", async () => {
    const r = runner({ live: livePr({ headOwner: "fork", maintainerCanModify: true }) });
    const out = await r.run(baseInput("sync_base", { reviewedIdentity: reviewedIdentity({ cross_repository: true }) }));
    assert.equal(out.error, "pr_remediation_fork_pr_unsupported");
    assertNoMutation(r.calls_ref);
  });

  it("refuses fork remediation even when the fork head repository is gone", async () => {
    // REST returns a deleted fork's head.repo as null; that must still read as cross-repository.
    const r = runner({ live: livePr({ headRepoDeleted: true }) });
    const out = await r.run(baseInput("publish", { reviewedIdentity: reviewedIdentity({ cross_repository: true }), commitMessage: "fix" }));
    assert.equal(out.error, "pr_remediation_fork_pr_unsupported");
    assertNoMutation(r.calls_ref);
  });
});

describe("runRemediatePullRequest — checkout guards", () => {
  it("refuses a checkout on the wrong branch", async () => {
    const r = runner({ activeBranch: "some-other-branch" });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_wrong_branch");
    assertNoMutation(r.calls_ref);
  });

  it("refuses a detached HEAD", async () => {
    const r = runner({ detached: true });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_detached_head");
  });

  it("refuses a dirty working tree", async () => {
    const r = runner({ status: " M src/a.js\n" });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_dirty_tree");
    assertNoMutation(r.calls_ref);
  });

  it("refuses when the checkout is off the reviewed head lineage", async () => {
    const r = runner({ headLineage: false });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_local_head_mismatch");
    assertNoMutation(r.calls_ref);
  });
});

describe("runRemediatePullRequest — sync_base (stale-base handling)", () => {
  it("refuses when the PR base is not the configured integration branch", async () => {
    const r = runner({ baseBranch: "main" }); // PR targets 'dev', config integration branch is 'main'
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_base_branch_mismatch");
    const ops = r.calls_ref.filter(([c]) => c === "git").map(([, a]) => gitOp(a)[0]);
    assert.ok(!ops.includes("fetch") && !ops.includes("merge"), "must not fetch/merge on a base mismatch");
  });

  it("reports already-current when the base is an ancestor", async () => {
    const r = runner({ ancestor: true });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.ok, true);
    assert.equal(out.outcome, "already_current");
    // fetched to compare, but never merged/committed
    const ops = r.calls_ref.filter(([c]) => c === "git").map(([, a]) => gitOp(a)[0]);
    assert.ok(!ops.includes("merge"));
    assert.ok(!ops.includes("commit"));
  });

  it("merges the integration branch with --no-ff --no-commit and commits it", async () => {
    const r = runner({ ancestor: false });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.ok, true);
    assert.equal(out.outcome, "merged_clean");
    const mergeCall = r.calls_ref.find(([c, a]) => c === "git" && gitOp(a)[0] === "merge");
    assert.ok(mergeCall, "expected a merge");
    assert.deepEqual(gitOp(mergeCall[1]).slice(0, 3), ["merge", "--no-ff", "--no-commit"]);
    // Never rebases or resets.
    const ops = r.calls_ref.filter(([c]) => c === "git").map(([, a]) => gitOp(a)[0]);
    assert.ok(!ops.includes("rebase") && !ops.includes("reset"));
  });

  it("surfaces merge conflicts for manual resolution without aborting", async () => {
    const r = runner({ ancestor: false, mergeThrows: true, mergeHead: true, unmerged: ["src/a.js"] });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.error, "pr_remediation_merge_conflicts");
    assert.deepEqual(out.unmerged_files, ["src/a.js"]);
    const ops = r.calls_ref.filter(([c]) => c === "git").map(([, a]) => gitOp(a)[0]);
    assert.ok(!ops.includes("commit"), "must not commit a conflicted merge");
    // Never runs `merge --abort` or `reset`.
    assert.ok(!ops.includes("reset"));
  });

  it("commits a resolved in-progress merge on re-invocation", async () => {
    const r = runner({ mergeHead: true, unmerged: [] });
    const out = await r.run(baseInput("sync_base"));
    assert.equal(out.ok, true);
    assert.equal(out.outcome, "merged_conflicts_resolved");
    const ops = r.calls_ref.filter(([c]) => c === "git").map(([, a]) => gitOp(a)[0]);
    assert.ok(ops.includes("commit"));
  });
});

const STAGED = "M  src/a.js\n";

function publishInput(overrides = {}) {
  return baseInput("publish", { commitMessage: "fix the null dereference", ...overrides });
}

describe("runRemediatePullRequest — publish", () => {
  it("commits and pushes with a compare-and-swap lease bound to the reviewed head", async () => {
    const r = runner({ status: STAGED, ancestor: true });
    const out = await r.run(publishInput());
    assert.equal(out.ok, true);
    assert.equal(out.action, "publish");
    assert.equal(out.pushed_ref, "contributor-branch");
    assert.equal(out.pushed_remote, "origin");
    const push = r.calls_ref.find(([c, a]) => c === "git" && gitOp(a)[0] === "push");
    const pushArgs = gitOp(push[1]);
    assert.ok(pushArgs.includes(`--force-with-lease=refs/heads/contributor-branch:${HEAD}`), "lease bound to the reviewed head OID");
    assert.deepEqual(pushArgs.slice(-2), ["origin", "HEAD:refs/heads/contributor-branch"]);
    // A lease compare-and-swap, never a blind force.
    assert.ok(!pushArgs.includes("--force") && !pushArgs.includes("-f"));
  });

  it("refuses to publish while an integration merge is still in progress", async () => {
    const r = runner({ status: STAGED, mergeHead: true });
    const out = await r.run(publishInput());
    assert.equal(out.error, "pr_remediation_merge_incomplete");
  });

  it("refuses to publish with nothing staged", async () => {
    const r = runner({ status: "", ancestor: true });
    const out = await r.run(publishInput());
    assert.equal(out.error, "pr_remediation_nothing_to_publish");
  });

  it("returns to the merge boundary when the base moved since sync", async () => {
    const r = runner({ status: STAGED, ancestor: false });
    const out = await r.run(publishInput());
    assert.equal(out.error, "pr_remediation_base_moved");
  });

  it("does not execute the contributor's gate commands locally (defers to CI)", async () => {
    const r = runner({ status: STAGED, ancestor: true });
    const out = await r.run(publishInput());
    assert.equal(out.ok, true);
    assert.equal(out.verification, "deferred_to_pull_request_ci");
    // No `make`/`bash` gate execution against the contributor tree in the host.
    const gateExec = r.calls_ref.filter(([c]) => c === "make" || c === "bash");
    assert.equal(gateExec.length, 0, "must not run gate commands in the privileged host");
  });

  it("reports a rejected non-force push without force-retrying", async () => {
    const r = runner({ status: STAGED, ancestor: true, pushThrows: true });
    const out = await r.run(publishInput());
    assert.equal(out.error, "pr_remediation_push_rejected");
    const pushes = r.calls_ref.filter(([c, a]) => c === "git" && gitOp(a)[0] === "push");
    assert.equal(pushes.length, 1, "must not retry the push");
  });

  it("requires a commit message", async () => {
    const r = runner({ status: STAGED, ancestor: true });
    const out = await r.run(baseInput("publish"));
    assert.equal(out.error, "pr_remediation_commit_message_missing");
  });

  it("stages the working tree itself (the skill never runs git)", async () => {
    const r = runner({ status: STAGED, ancestor: true });
    const out = await r.run(publishInput());
    assert.equal(out.ok, true);
    const add = r.calls_ref.find(([c, a]) => c === "git" && gitOp(a)[0] === "add");
    assert.ok(add, "publish must stage via git add");
    assert.deepEqual(gitOp(add[1]), ["add", "-A"]);
    assert.equal(out.pushed_ref, "contributor-branch");
  });

  it("posts the optional bound comment after a successful push", async () => {
    const r = runner({ status: STAGED, ancestor: true });
    const out = await r.run(publishInput({ commentBody: "Applied the null-check fix; CI will verify." }));
    assert.equal(out.ok, true);
    assert.equal(out.comment.ok, true);
    assert.equal(out.comment.comment_id, 1);
    const posts = r.calls_ref.filter(([c, a]) => c === "gh" && a.includes("--method") && a[a.indexOf("--method") + 1] === "POST");
    assert.equal(posts.length, 1, "exactly one comment");
  });

  it("rejects a secret in the optional comment before the push", async () => {
    const r = runner({ status: STAGED, ancestor: true });
    const secret = "ghp_" + "a".repeat(36);
    const out = await r.run(publishInput({ commentBody: `pushed a fix. token ${secret}` }));
    assert.equal(out.error, "pr_remediation_comment_rejected");
    const ops = r.calls_ref.filter(([c]) => c === "git").map(([, a]) => gitOp(a)[0]);
    assert.ok(!ops.includes("push"), "a rejected comment fails before the push");
  });

  it("reports a comment failure after a successful push as a partial outcome", async () => {
    const r = runner({ status: STAGED, ancestor: true, commentThrows: true });
    const out = await r.run(publishInput({ commentBody: "Applied the fix." }));
    assert.equal(out.ok, true); // the push itself succeeded
    assert.equal(out.comment.ok, false);
    assert.equal(out.comment.error, "pr_remediation_comment_failed");
  });

  it("does not double-post an identical bound comment", async () => {
    const body = "Applied the fix; CI will verify.";
    const r = runner({ status: STAGED, ancestor: true, existingComments: [{ id: 55, html_url: "u", body }] });
    const out = await r.run(publishInput({ commentBody: body }));
    assert.equal(out.comment.idempotent, true);
    assert.equal(out.comment.comment_id, 55);
    const posts = r.calls_ref.filter(([c, a]) => c === "gh" && a.includes("--method") && a[a.indexOf("--method") + 1] === "POST");
    assert.equal(posts.length, 0, "no duplicate post");
  });
});
