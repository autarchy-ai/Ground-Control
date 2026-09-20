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
// A `workflow_dispatch` run carries no `pull_requests` association, so it is bound through
// the run name the workflow sets instead. Accepting a dispatch run on the strength of its
// event alone would be no binding at all: run ids are public, so one real dispatch run would
// vouch for any issue and pull request a comment cared to name.
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

// The workflow's `run-name:` renders as the run's `display_title`. Matching the number with
// a boundary on both sides keeps PR #16 from satisfying a record that names PR #1.
function runNameBindsPr(displayTitle, prNumber) {
  if (typeof displayTitle !== "string") return false;
  return new RegExp(String.raw`(^|\D)#?${prNumber}(\D|$)`).test(displayTitle);
}

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
  // A pull-request-triggered run is bound by its own association. A dispatch run has none,
  // so it is bound by the name the workflow gave it.
  if ((run.pull_requests ?? []).some((pr) => pr?.number === prNumber)) return true;
  if (run.event !== "workflow_dispatch") return false;
  return runNameBindsPr(run.display_title ?? run.name ?? null, prNumber);
}
