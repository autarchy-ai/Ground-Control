// Commits made through the /implement Git boundary (issue #1580).
//
// The boundary follows the host's commit-signing configuration instead of
// forcing `commit.gpgSign=false`: a host that requires signed commits gets
// signed publish, base-sync, and remediation commits. What stays forbidden is a
// signing *program* chosen by the checkout itself; that is refused before any
// mutation by assertSafeImplementCheckoutConfiguration.
//
// Git never downgrades a required signature to an unsigned commit; a failed
// signature aborts the commit. The only work here is naming that failure so the
// caller can route it to a signing repair instead of a generic commit repair.

import { runImplementGit } from "./codex-workflow-2.js";
import { execFile } from "./runtime-primitives.js";

export const IMPLEMENT_COMMIT_SIGNING_FAILED = "implement_commit_signing_failed";

// builtin/commit.c dies with this message when commit_tree_extended fails, which
// with signing enabled is the signature step. The commit runs under the C locale
// so the message is not translated.
const COMMIT_OBJECT_WRITE_FAILED = "failed to write commit object";

async function hostRequiresCommitSigning(repoRoot, commandRunner) {
  try {
    const { stdout } = await runImplementGit(
      repoRoot,
      ["config", "--type=bool", "--get", "commit.gpgSign"],
      commandRunner,
    );
    return stdout.trim() === "true";
  } catch {
    // Exit 1 means unset. Any other failure leaves the requirement unknown, and
    // the caller then surfaces the original commit failure unchanged.
    return false;
  }
}

// Run `git commit <args>` through the implement boundary. Resolves `{ ok: true }`
// on success, resolves a bounded envelope when a required signature could not be
// produced (no commit was created), and rethrows every other failure unchanged.
export async function runImplementCommit(repoRoot, args, commandRunner = execFile) {
  try {
    await runImplementGit(repoRoot, ["commit", ...args], commandRunner, { LC_ALL: "C" });
    return { ok: true };
  } catch (error) {
    const output = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
    if (
      output.includes(COMMIT_OBJECT_WRITE_FAILED)
      && await hostRequiresCommitSigning(repoRoot, commandRunner)
    ) {
      return {
        ok: false,
        error: IMPLEMENT_COMMIT_SIGNING_FAILED,
        message:
          "Git requires signed commits (commit.gpgSign) and the commit could not be signed; no commit was created",
        next_action: "repair_the_host_commit_signing_key_or_agent_and_retry",
      };
    }
    throw error;
  }
}
