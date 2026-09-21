// The Phase E workflow a consumer repository installs (issue #1671).
//
// It ships as a module rather than a packaged file because `templates/` is assembled at pack
// time, while `lib/` is already part of the published package. Ground Control's own copy at
// `.github/workflows/ground-control-phase-e.yml` runs the checkout's server so a change to
// the finalizer is exercised by the delivery that makes it; a consumer repository runs the
// published release.
//
// The content is fixed (issue #1688). GitHub fires `pull_request: closed` only from a file
// committed under `.github/workflows/`, so this file has to exist — but it is a trigger, not
// a configuration surface. The grndctl release it runs is read at job time from
// `phase_e.version` in `.ground-control.yaml`, which is the one Ground Control config a
// repository carries. Baking the version in here made the file a second thing to pin and
// upgrade, and the two could disagree with nothing to notice.

// One declaration of the path: the close gate's trust anchor and the installer must name
// the same file, or renaming it would silently disable automated finalization.
export { PHASE_E_WORKFLOW_PATH } from "./automation-provenance.js";

export const PHASE_E_WORKFLOW_TEMPLATE = [
  "name: Ground Control Phase E",
  "# Carries the pull request into the run record, so a dispatch run \u2014 which has no",
  "# `pull_requests` association \u2014 is still bound to what it finalized (issue #1671).",
  "run-name: Ground Control Phase E for PR ${{ github.event.pull_request.number || inputs.pr }}",
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
  "# Written by `grndctl init`. Its content is fixed: the grndctl release it runs comes from",
  "# `phase_e.version` in .ground-control.yaml, so this file never needs upgrading.",
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
  "      # The single scalar this job needs from the repository's config. Read with sed rather",
  "      # than a YAML tool so the step depends on nothing that is not already on the runner,",
  "      # and fail loudly: an unset version would otherwise resolve to a moving `latest`.",
  "      - name: Resolve the pinned grndctl release",
  "        id: gc",
  "        run: |",
  "          version=\"$(sed -n '/^phase_e:/,/^[^[:space:]]/s/^[[:space:]]*version:[[:space:]]*//p' .ground-control.yaml | tr -d '\"'\"'\"' | head -n 1)\"",
  "          if [ -z \"$version\" ]; then",
  "            echo '::error::phase_e.version is not set in .ground-control.yaml; run grndctl init' >&2",
  "            exit 1",
  "          fi",
  "          echo \"version=$version\" >> \"$GITHUB_OUTPUT\"",
  "      - name: Finalize the merged delivery",
  "        env:",
  "          GH_TOKEN: ${{ github.token }}",
  "          PR: ${{ github.event.pull_request.number || inputs.pr }}",
  "          VERSION: ${{ steps.gc.outputs.version }}",
  "        run: npx --yes \"grndctl@$VERSION\" finalize-merged-pr --pr \"$PR\"",
  "",
].join("\n");

/** The workflow's fixed content. It takes no version: `phase_e.version` supplies that. */
export function renderPhaseEWorkflow() {
  return PHASE_E_WORKFLOW_TEMPLATE;
}
