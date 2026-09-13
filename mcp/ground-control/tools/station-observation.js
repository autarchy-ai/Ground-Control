// Station-observation tool surface (issue #1578).

import { z } from "zod";
import { REVIEW_STATION_IDS, runWaiveStationObservation } from "../lib.js";
import { ok, err } from "./respond.js";

export function registerStationObservation(server) {
  server.tool(
    "gc_waive_station_observation",
    "Record an explicit user waiver of review-station observations that rendered no verdict. " +
    "Inputs are repo_path, issue_number, station_id, obligation_ids, and authorization_source_url. " +
    "The source comment must be exactly '/ground-control waive-station <station_id> <OBLIGATION_ID>...' " +
    "on this issue, naming every requested obligation, from a user with effective write permission on " +
    "the pinned repository. Each obligation must be an open station_observation for that station. The " +
    "posted audit record states that no verdict was produced: it never reports the reviewer as " +
    "completed, clean, or passed, and it dispositions no finding. Replay re-verifies the command, its " +
    "author, and its ordering after each obligation's latest opening; the final report lists the station " +
    "as waived and refuses a review claim for it. Repeating a recorded waiver is a no-op.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      station_id: z.enum(REVIEW_STATION_IDS),
      obligation_ids: z.array(z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/)).min(1).max(10),
      authorization_source_url: z.string().url(),
    },
    async ({ repo_path, issue_number, station_id, obligation_ids, authorization_source_url }) => {
      try {
        return ok(JSON.stringify(await runWaiveStationObservation({
          repoPath: repo_path,
          issueNumber: issue_number,
          stationId: station_id,
          obligationIds: obligation_ids,
          authorizationSourceUrl: authorization_source_url,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}
