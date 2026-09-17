import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runImplementMechanical } from "./gc-implement-mechanical.js";

const TREE = "a".repeat(40);
const BASE = "b".repeat(40);
const TOOL = "c".repeat(64);
const BRANCH = "1626-eliminate-redundant-verification";

function dependencies() {
  const gateCalls = [];
  const posted = [];
  const execFile = async (file, args) => {
    const command = args.at(-1);
    if (file === "bash" && command === "fingerprint") {
      return { stdout: `${TOOL}\n`, stderr: "" };
    }
    if (file === "bash") {
      gateCalls.push(command);
      return { stdout: "", stderr: "" };
    }
    if (file === "git" && args.includes("write-tree")) return { stdout: `${TREE}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const runGit = async (repoRoot, args, commandRunner) => {
    if (args.includes("--show-current")) return { stdout: `${BRANCH}\n`, stderr: "" };
    if (args.includes("rev-parse")) return { stdout: `${BASE}\n`, stderr: "" };
    if (args.includes("status")) return { stdout: "", stderr: "" };
    return commandRunner("git", ["-C", repoRoot, ...args], { cwd: repoRoot });
  };
  return {
    gateCalls,
    posted,
    deps: {
      authorizeRepo: async () => ({ ok: true, repoRoot: "/repo" }),
      authorizeRequirementUid: async () => ({ ok: true, requirementUid: null }),
      getContext: async () => ({
        status: "ok",
        github_repo: "autarchy-ai/Ground-Control",
        workflow: {
          base_branch: "dev",
          completion_command: "make check",
          policy_command: "make policy",
          verification: { toolchain_fingerprint_command: "fingerprint" },
        },
      }),
      execFile,
      runGit,
      readVerificationAttestations: async () => ({
        ok: true,
        records: posted.map((record) => ({
          record: { ...record, valid: true, authenticated: true },
          commentId: 1,
        })),
      }),
      postVerificationAttestation: async (repoRoot, owner, name, record) => {
        posted.push(record);
      },
    },
  };
}

describe("verify exact-input reuse (issue #1626)", () => {
  it("executes broad gates once across verify attempts with different transport keys", async () => {
    const { deps, gateCalls, posted } = dependencies();
    const args = { action: "verify", repoPath: "/repo", issueNumber: 1626, requirements: [] };

    const first = await runImplementMechanical(args, deps);
    const second = await runImplementMechanical(args, deps);

    assert.equal(first.verification_decision, "executed");
    assert.equal(first.broad_gates_executed, 2);
    assert.equal(second.verification_decision, "reused");
    assert.equal(second.broad_gates_executed, 0);
    assert.deepEqual(gateCalls, ["make check", "make policy"]);
    assert.equal(posted.length, 1);
  });
});
