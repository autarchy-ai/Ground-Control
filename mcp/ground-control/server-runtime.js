// Ground Control MCP Server runtime.
//
// index.js binds `<launch directory>/.env` and then imports this module
// dynamically, so every environment-derived default in the graph below sees the
// loaded values (issue #1562). Nothing here reads a configuration file; the
// variables it and its dependencies consume are listed in `.env.example` and
// inventoried in lib/server-env.js.
//
// ============================================================================
// TOOL SURFACE (issue #1500 re-platform)
// ============================================================================
//
// The MCP server over repo-local files (issue #1500) exposes 34 tools that
// back the /implement, /quickfix, /integrate, and /review workflow mechanics
// plus the coding-agent<->reviewer separation. There is no backend, database, or
// generic entity CRUD surface — requirements and ADRs are read/edited as
// repo files directly. Registration lives in ./tools/*.js:
//   tools/query.js               — gc_get_repo_ground_control_context,
//                                   gc_create_github_issue, gc_remember,
//                                   gc_codex_architecture_preflight,
//                                   gc_post_implementation_plan,
//                                   gc_close_issue_after_merge, gc_codex_review
//   tools/post-decision-record.js — gc_post_decision_record, gc_post_final_report,
//                                   gc_assert_completion, gc_render_pr_body,
//                                   gc_get_issue_thread, gc_watch_ci_run,
//                                   gc_codex_review_cycle
//   tools/review-cap-disposition.js — gc_review_cap_disposition, gc_codex_job,
//                                   gc_watch_sonar_analysis, gc_prepare_implement_branch,
//                                   gc_implement_mechanical, gc_synchronize_implement_branch,
//                                   gc_create_synchronized_implement_pr,
//                                   gc_record_execution_obligation,
//                                   gc_mark_implement_issue_picked_up,
//                                   gc_authorize_execution_obligation_wontfix,
//                                   gc_resolve_workflow_route, gc_codex_verify_finding
//   tools/integrate.js           — gc_integration_manager (GC-O011)
//   tools/pr-review.js           — gc_get_pr_review_context,
//                                   gc_remediate_pull_request (maintainer /review lane, #1535)
//   tools/station-observation.js — gc_reconcile_station_observation (stranded observation recovery, #1582)
//   tools/release-identity.js    — gc_release_identity (versioned artifact-release reservations, #1579)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerQuery } from "./tools/query.js";
import { registerPostDecisionRecord } from "./tools/post-decision-record.js";
import { registerReviewCapDisposition } from "./tools/review-cap-disposition.js";
import { registerPrReview } from "./tools/pr-review.js";
import { registerIntegrate } from "./tools/integrate.js";
import { registerStationObservation } from "./tools/station-observation.js";
import { registerReleaseIdentity } from "./tools/release-identity.js";
import pkg from "./package.json" with { type: "json" };

// The version advertised to clients in the initialize handshake is sourced from
// package.json so it cannot drift from the package it ships in (issue #633). See
// README.md "Server version and client compatibility" for the bump policy.
const server = new McpServer({ name: "ground-control", version: pkg.version });

// Tool registrations live in ./tools/*.
registerQuery(server);
registerPostDecisionRecord(server);
registerReviewCapDisposition(server);
registerPrReview(server);
registerIntegrate(server);
registerStationObservation(server);
registerReleaseIdentity(server);

// ============================================================================
// Startup
// ============================================================================

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "[ground-control] MCP surface over repo-local files (issue #1500): requirements and ADRs live " +
      "in the repo, no backend and no database. The surviving surface is the /implement workflow " +
      "mechanics plus the coding-agent↔reviewer separation tools.",
  );
} catch (e) {
  console.error(e);
  process.exit(1);
}
