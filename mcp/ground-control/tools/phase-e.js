// Automated Phase E tool registration (issue #1671).
//
// The deterministic executor normally runs from the packaged CLI inside the merged-pull-request
// GitHub Actions job, with no model in the loop at all. This registration is the maintainer's
// repair path: when a job left a `gc:delivery-finalization-failed` record and the cause has been
// fixed, the same library function can be re-run from an agent session without re-deriving any
// evidence by hand. It takes the pull-request number and nothing else, because every other input
// — the issue, the lane, and the completion payload — is resolved server-side from the trusted
// Phase D records.

import { z } from "zod";
import { runAutomatedPhaseE } from "../implement/phase-e-automation.js";
import { ok, err } from "./respond.js";

export function registerPhaseE(server) {
  server.tool(
    "gc_finalize_merged_pr",
    "Finish Phase E for an already-merged Ground Control delivery pull request, with no model or " +
    "agent reasoning in the decision path. Inputs are repo_path and pr_number. The server resolves " +
    "the issue from the trusted delivery pointer on the pull request, verifies the trusted Phase D " +
    "delivery-readiness record against the MERGED head, and replays its recorded completion payload " +
    "through gc_implement_mechanical action='finalize' — so the merge gate, the immutable " +
    "merged-revision requirement verification, the final-report marker, and the idempotent close all " +
    "still apply unchanged. Pull-request title, body, labels, branch name, and closing keywords " +
    "confer no authority. A pull request with no delivery pointer returns status='skipped'; an " +
    "unmerged one is refused. Replay is safe: an already-reported delivery posts no second final " +
    "report. On failure it leaves one bounded, scrubbed, idempotent issue-thread record, leaves the " +
    "issue OPEN, and returns ok=false. This is the repair path for a failed automated run; the " +
    "merged-pull-request workflow is the normal one.",
    {
      repo_path: z.string().min(1),
      pr_number: z.number().int().positive(),
    },
    async ({ repo_path, pr_number }) => {
      try {
        return ok(JSON.stringify(
          await runAutomatedPhaseE({ repoPath: repo_path, prNumber: pr_number }),
          null,
          2,
        ));
      } catch (e) { return err(e); }
    },
  );
}
