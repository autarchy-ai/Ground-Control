// The Phase E workflow a consumer repository installs (issue #1671).
//
// It ships as a module rather than a packaged file because `templates/` is assembled at pack
// time, while `lib/` is already part of the published package. Ground Control's own copy at
// `.github/workflows/ground-control-phase-e.yml` runs the checkout's server so a change to
// the finalizer is exercised by the delivery that makes it; a consumer repository runs the
// published release, pinned to an exact version rather than a moving tag.

// One declaration of the path: the close gate's trust anchor and the installer must name
// the same file, or renaming it would silently disable automated finalization.
export { PHASE_E_WORKFLOW_PATH } from "./automation-provenance.js";

const VERSION_PLACEHOLDER = "__GRNDCTL_VERSION__";

export const PHASE_E_WORKFLOW_TEMPLATE = [
  "name: Ground Control Phase E",
  "",
  "# A merged Ground Control delivery pull request finishes Phase E here, with no model or",
  "# agent session. The agent records a trusted delivery-readiness handoff at Phase D and may",
  "# then terminate permanently; this job is a trigger and a transport.",
  "#",
  "# It holds no `gh` logic, no marker parser, and no completion reconstruction. It passes the",
  "# event's pull-request number to `grndctl finalize-merged-pr`, which resolves the issue from",
  "# the trusted pointer and replays the recorded payload through the incumbent finalizer \u2014 so",
  "# the merge gate, the immutable merged-revision requirement verification, the final-report",
  "# marker, and the idempotent close all still apply, unchanged.",
  "#",
  "# It runs no tests, no policy suite, and no review, and it waits for no other post-merge job.",
  "#",
  "# Written by `grndctl init`. The pinned version below is the grndctl that wrote it; bump it",
  "# deliberately rather than tracking a moving tag.",
  "",
  "on:",
  "  pull_request:",
  "    types: [closed]",
  "    branches: [main, dev]",
  "  workflow_dispatch:",
  "    inputs:",
  "      pr:",
  "        description: Pull request number to finalize (maintainer repair path)",
  "        required: true",
  "        type: string",
  "",
  "concurrency:",
  "  # Serialize per pull request so a replay cannot race itself. Never cancel: a cancelled",
  "  # finalization leaves neither a final report nor a failure record.",
  "  group: gc-phase-e-${{ github.event.pull_request.number || inputs.pr }}",
  "  cancel-in-progress: false",
  "",
  "permissions:",
  "  contents: read",
  "  pull-requests: read",
  "  # The close gate verifies this job's own run through the Actions API before it accepts an",
  "  # automation-authored final-report marker.",
  "  actions: read",
  "  # The final report and the issue close. This is the job's only write.",
  "  issues: write",
  "",
  "jobs:",
  "  finalize:",
  "    if: ${{ github.event_name == 'workflow_dispatch' || github.event.pull_request.merged == true }}",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      # The immutable merge revision, never the pull-request head. Phase E reads requirement",
  "      # state from the merged tree and executes none of the delivered code; `fetch-depth: 0`",
  "      # brings every branch, so the merge commit is present on the dispatch path too.",
  "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4",
  "        with:",
  "          ref: ${{ github.event.pull_request.merge_commit_sha || github.sha }}",
  "          fetch-depth: 0",
  "          persist-credentials: false",
  "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
  "        with:",
  "          node-version: 22",
  "      - name: Finalize the merged delivery",
  "        env:",
  "          GH_TOKEN: ${{ github.token }}",
  "          PR: ${{ github.event.pull_request.number || inputs.pr }}",
  "        run: npx --yes grndctl@__GRNDCTL_VERSION__ finalize-merged-pr --pr \"$PR\"",
  "",
].join("\n");

export function renderPhaseEWorkflow(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error("renderPhaseEWorkflow requires the installed grndctl version");
  }
  return PHASE_E_WORKFLOW_TEMPLATE.replaceAll(VERSION_PLACEHOLDER, version);
}
