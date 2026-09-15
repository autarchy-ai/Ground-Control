// Versioned artifact-release identity reservation tool registration (issue #1579, ADR-097).
//
// One action-multiplexed tool for one aggregate. There is deliberately no repository, base
// revision, version, or path input: the server derives each of them.

import { z } from "zod";
import {
  ASYNC_JOB_IDEMPOTENCY_KEY_MAX,
  ASYNC_JOB_IDEMPOTENCY_KEY_RE,
  RELEASE_FAMILY_NAME_RE,
  RELEASE_IDENTITY_ABANDON_REASONS,
  RELEASE_IDENTITY_ACTIONS,
  runReleaseIdentity,
} from "../lib.js";
import { ok, err } from "./respond.js";

export const GC_RELEASE_IDENTITY_DESCRIPTION =
  "Reserve and track versioned artifact-release identities (evidence releases, snapshots) for a family declared under " +
  "release_families in .ground-control.yaml, so concurrent runs never derive the same 'next' version from their checkouts. " +
  "Inputs: action, repo_path, issue_number, family, idempotency_key, reason. " +
  "action='reserve' (issue_number, family, idempotency_key) atomically claims the next identity against the family's base " +
  "branch head, using the family definition at that commit, and returns its sequence, version, and derived paths; call it " +
  "BEFORE generating a capture and write only to the returned paths. Re-running with the same issue_number, family, and " +
  "idempotency_key returns the stored reservation in any state and never allocates again. reserve runs only from the issue's " +
  "<issue>-<slug> branch in the launch checkout, which it records. action='publish' records the " +
  "reservation as published once every derived path is a regular file at the base branch head. action='abandon' (reason) " +
  "burns an unused identity with a closed reason code, only from the branch recorded at reservation; identities are never " +
  "reissued. action='status' (family, optional " +
  "issue_number, no idempotency_key) lists the family's reservations. repo_path is bound to the MCP launch workspace; the " +
  "repository, base revision, version, and paths are server-derived. Each event is recorded on the issue thread. The tool " +
  "never creates or edits evidence files and does not change any completion, review, CI, SonarCloud, or merge gate.";

export function registerReleaseIdentity(server) {
  server.tool(
    "gc_release_identity",
    GC_RELEASE_IDENTITY_DESCRIPTION,
    {
      action: z.enum(RELEASE_IDENTITY_ACTIONS),
      repo_path: z.string().min(1),
      issue_number: z.number().int().positive().optional()
        .describe("Required for reserve, publish, and abandon; optional filter for status"),
      family: z.string().regex(RELEASE_FAMILY_NAME_RE),
      idempotency_key: z.string().min(1).max(ASYNC_JOB_IDEMPOTENCY_KEY_MAX).regex(ASYNC_JOB_IDEMPOTENCY_KEY_RE).optional()
        .describe("Non-secret workflow key reused on every retry of the same capture; required except for status"),
      reason: z.enum(RELEASE_IDENTITY_ABANDON_REASONS).optional().describe("Required for abandon only"),
    },
    async ({ action, repo_path, issue_number, family, idempotency_key, reason }) => {
      try {
        return ok(JSON.stringify(await runReleaseIdentity({
          action,
          repoPath: repo_path,
          issueNumber: issue_number,
          family,
          idempotencyKey: idempotency_key,
          reason,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}
