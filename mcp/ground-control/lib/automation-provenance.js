// Verified provenance for the repository's own Phase E finalizer (issue #1671).
//
// `github-actions[bot]` is a shared GitHub App identity: the collaborator-permission
// endpoint reports `permission: "none"` for it, so the repo-write trust rule that governs
// every other durable workflow record cannot recognise it. Simply trusting the login would
// be too broad — any workflow in the repository can speak as that identity, including one
// that echoes untrusted text into a comment.
//
// So provenance is verified rather than asserted. A record that claims to come from the
// finalizer names its `GITHUB_RUN_ID`, and that run must resolve through the Actions API to
// THIS repository's pinned finalizer workflow, bound to the pull request the record names.
// A `workflow_dispatch` run has no pull request attached and is accepted on its own,
// because only a user with repository write access can start one.
//
// A forged run id fails the lookup. A workflow that merely echoes attacker-controlled text
// cannot produce a finalizer run bound to the pull request that text names.

import { ghRestJson } from "./github-rest.js";

// The trust anchor. `tools/policy/phase_e_automation.py` pins the same path from the other
// side, so renaming the workflow fails policy instead of silently disabling finalization.
export const PHASE_E_WORKFLOW_PATH = ".github/workflows/ground-control-phase-e.yml";

// The GitHub Actions service identity. Repository automation speaks as exactly this login;
// a fork pull request receives a read-only token and cannot post as it at all.
export const GITHUB_ACTIONS_BOT_LOGIN = "github-actions[bot]";

/** True when a comment was authored by this repository's own Actions identity. */
export function isRepositoryAutomationAuthor(comment) {
  return comment?.authorType === "Bot"
    && (comment.authorLogin ?? "").toLowerCase() === GITHUB_ACTIONS_BOT_LOGIN;
}

export async function verifyFinalizerRunProvenance(
  { repoRoot, owner, name, prNumber, runId },
  { ghJson = ghRestJson } = {},
) {
  if (!Number.isInteger(runId) || runId <= 0) return false;
  let run;
  try {
    run = await ghJson(repoRoot, `/repos/${owner}/${name}/actions/runs/${runId}`);
  } catch {
    return false;
  }
  if (run?.path !== PHASE_E_WORKFLOW_PATH) return false;
  const fullName = `${owner}/${name}`.toLowerCase();
  if ((run.repository?.full_name ?? "").toLowerCase() !== fullName) return false;
  if (run.event === "workflow_dispatch") return true;
  return (run.pull_requests ?? []).some((pr) => pr?.number === prNumber);
}
