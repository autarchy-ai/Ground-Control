// Station-observation recovery tool registration (issue #1582).
//
// A separate tool from gc_record_execution_obligation by design: that tool is the agent-facing
// disposition surface and must never emit `reobserved`. This one accepts no disposition, prose, or
// verification claim — only the identity of an existing record — and writes the resolution only
// when the server itself proves that record is the station's verdict for the obligation's cycle.

import { z } from "zod";
import {
  EXECUTION_OBLIGATION_ID_RE,
  STATION_OBSERVATION_RECORD_URL_MAX,
  runReconcileStationObservation,
} from "../lib.js";
import { ok, err } from "./respond.js";

export function registerStationObservation(server) {
  server.tool(
    "gc_reconcile_station_observation",
    "Resolve a stranded station-observation execution obligation from durable evidence already on the " +
    "issue thread. Inputs are repo_path, issue_number, obligation_id, and findings_record_url. Use it " +
    "when gc_assert_completion lists the obligation under recoverable_station_observations: a review " +
    "station first rendered no verdict, and a later cycle-tool call posted that station's findings " +
    "record and cycle marker without the reobserved resolution. repo_path is bound to the MCP launch " +
    "workspace. Under a per-obligation lease the server re-reads the thread and posts the v2 reobserved " +
    "resolution only when the obligation is an open station_observation whose id matches its station and " +
    "logical cycle, and findings_record_url names the exact findings record that station's cycle marker for " +
    "that cycle consumed: on this repository's issue, after the obligation opened, on the marker's branch, " +
    "both authored by the trusted MCP posting identity; an ambiguous history refuses. It then replays the " +
    "ledger to confirm closure. It accepts no disposition, corrective action, or " +
    "verification claim, and resolves nothing but the missing observation: findings in the record stay " +
    "under the fix / wontfix / not-applicable rules. Idempotent: an already re-observed obligation " +
    "returns already_recorded=true.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      obligation_id: z.string().regex(EXECUTION_OBLIGATION_ID_RE),
      findings_record_url: z.string().url().max(STATION_OBSERVATION_RECORD_URL_MAX),
    },
    async ({ repo_path, issue_number, obligation_id, findings_record_url }) => {
      try {
        return ok(JSON.stringify(await runReconcileStationObservation({
          repoPath: repo_path,
          issueNumber: issue_number,
          obligationId: obligation_id,
          findingsRecordUrl: findings_record_url,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}
