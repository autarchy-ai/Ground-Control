// Shared dependency doubles for the runImplementMechanical suites. Extracted
// from gc-implement-mechanical.runimplementmechanical-publish.test.js under issue
// #1692 so the publish and monitor suites each stay under the 500-line limit
// (docs/CODING_STANDARDS.md). Fixture bodies are unchanged.
import { requestedRequirementUidAuthorization } from "./lib.js";

export const SHA_A = "a".repeat(40);

export const SHA_B = "b".repeat(40);

export const RECORD_ID = "c".repeat(32);

const IMPLEMENT_BRANCH = "1426-script-phases";

function context() {
  return {
    status: "ok",
    project: "ground-control",
    workflow: { base_branch: "dev", completion_command: "make check" },
  };
}

export function baseDeps(overrides = {}) {
  const deps = {
    authorizeRepo: async (path) => ({ ok: true, repoRoot: path }),
    getContext: async () => context(),
    prepareBranch: async () => ({
      ok: true,
      repo_path: "/repo",
      branch: IMPLEMENT_BRANCH,
    }),
    getIssueThread: async () => ({
      ok: true,
      title: "Script phases",
      body: "## Requirements\n- GC-O007\n",
      labels: ["enhancement"],
      comments: [],
      url: "https://github.test/issues/1426",
      hash: "thread-hash",
    }),
    getRequirement: async (uid) => ({
      id: `id-${uid}`,
      uid,
      title: "Requirement",
      statement: "The system shall work.",
      status: "DRAFT",
      wave: 1,
    }),
    getTraceabilityByArtifact: async () => [{ id: "link-1" }],
    markPickedUp: async () => ({ ok: true, comment_url: "https://github.test/pickup" }),
    synchronize: async () => ({ ok: true, status: "complete", recordId: RECORD_ID }),
    remoteSnapshot: async () => ({ ok: true, head_sha: "a".repeat(40), branch: IMPLEMENT_BRANCH, failures: [], passed: true }),
    // Readiness binds the delivery handoff to the head whose hosted checks it read (#1671).
    readRemoteGates: async () => ({ ok: true, passed: true, state: "OPEN", head_sha: "a".repeat(40) }),
    verifyPhaseEWorkflow: async () => ({ ok: true, base_ref: "dev", base_sha: "b".repeat(40) }),
    recordDeliveryReadiness: async () => ({ ok: true, record_comment_id: 4242 }),
    monitorSleep: async () => new Promise((resolve) => setImmediate(resolve)),
    watchCi: async () => ({ ok: true, conclusion: "success" }),
    watchSonar: async () => ({
      ok: true,
      quality_gate: "OK",
      issues_summary: { open_count: 0 },
      hotspots_summary: { open_count: 0 },
    }),
    assertCompletion: async ({ phase }) => ({
      ok: true,
      phase,
      readiness_report: phase === "pre_merge" ? "ready" : undefined,
    }),
    closeIssue: async () => ({ ok: true, closed: true }),
    execFile: async () => ({ stdout: "", stderr: "" }),
    // Mechanical-publish recovery seams (issue #1495): stubbed so the publish
    // tests exercise staging/commit/sync without touching a real filesystem lease.
    resolvePublishGitDir: async () => "/repo/.git",
    acquirePublishLock: async () => async () => {},
    reconcileInterruptedPublish: async () => ({ proceed: true }),
    writePublishJournal: () => {},
    removePublishJournal: () => {},
  };
  Object.assign(deps, overrides);
  // Mirrors the production wiring: the authorizer binds the requested UID to
  // the same issue thread the rest of the run reads.
  deps.authorizeRequirementUid ??= async ({ requestedRequirementUid }) => {
    const thread = await deps.getIssueThread({});
    return requestedRequirementUidAuthorization(thread.body, requestedRequirementUid);
  };
  deps.runGit ??= async (repoRoot, argv, commandRunner) =>
    commandRunner("git", ["-C", repoRoot, ...argv], { cwd: repoRoot });
  deps.preCommit ??= async (repoRoot, context) =>
    deps.execFile(
      "bash",
      ["-c", context?.workflow?.precommit_command ?? "pre-commit run --hook-stage pre-commit"],
      { cwd: repoRoot },
    );
  return deps;
}

export function publishExec({ paths = ["src/change.js"] } = {}) {
  const calls = [];
  return {
    calls,
    execFile: async (file, argv) => {
      calls.push([file, ...argv]);
      if (file === "git" && argv.includes("--show-current")) {
        return { stdout: `${IMPLEMENT_BRANCH}\n`, stderr: "" };
      }
      if (file === "git" && argv.includes("-z")) {
        if (argv.includes("--cached") || argv.includes("--others")) {
          return { stdout: "", stderr: "" };
        }
        return { stdout: paths.map((path) => `${path}\0`).join(""), stderr: "" };
      }
      if (file === "git" && argv.includes("--cached") && argv.includes("--name-only")) {
        return { stdout: paths.join("\n"), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  };
}

export function completionInput() {
  return {
    requirements: [],
    files: { modified: ["src/change.js"] },
    reviews: [{ reviewer: "review-cycle", summary: "passed" }],
    ci_status: "green",
    sonar_status: "passed",
    plain_english_outcome: "Mechanical workflow stages now run without model turns.",
  };
}
