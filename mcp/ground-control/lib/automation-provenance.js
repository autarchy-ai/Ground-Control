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
// The binding is the run's `pull_requests` association where GitHub supplies one, and
// otherwise the pull-request number the pinned workflow puts in its own run name. Accepting
// a run on the strength of its event alone would be no binding at all: run ids are public,
// so one real run would vouch for any issue and pull request a comment cared to name.
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

// Exactly the two triggers the Phase E workflow declares. A third one would need to state
// its own binding, so it is listed here deliberately rather than left to a default: silently
// inheriting a binding meant for another trigger is how this check came to be unsatisfiable
// on its primary path (issue #1683).
const TITLE_BOUND_EVENTS = new Set(["pull_request", "workflow_dispatch"]);

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
  // A matching association is the strongest binding, so it wins when GitHub supplies one.
  // It cannot be required: a run is associated with OPEN pull requests only, and this
  // workflow triggers on `pull_request: closed`, so the merged delivery it exists to
  // finalize never has one. Requiring it made this check unsatisfiable on its only real
  // path — the report was posted and the close then refused it (issue #1683). Both triggers
  // therefore fall back to the run name, which is evidence only because the pinned workflow
  // builds it from `github.event.pull_request.number || inputs.pr`; `tools/policy/
  // phase_e_automation.py` pins that expression, because GitHub uses the pull-request title
  // when `run-name:` is absent and attacker-authored text must never bind a run.
  if ((run.pull_requests ?? []).some((pr) => pr?.number === prNumber)) return true;
  if (!TITLE_BOUND_EVENTS.has(run.event)) return false;
  return runNameBindsPr(run.display_title ?? run.name ?? null, prNumber);
}
