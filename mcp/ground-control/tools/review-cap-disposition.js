// Split from index.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Registration bodies are unchanged.

import { z } from "zod";
import {
  ASYNC_JOB_ID_MAX,
  ASYNC_JOB_ID_RE,
  EXACT_REQUIREMENT_UID_RE,
  EXECUTION_OBLIGATION_CATEGORIES,
  EXECUTION_OBLIGATION_DISPOSITIONS,
  EXECUTION_OBLIGATION_EVENTS,
  EXECUTION_OBLIGATION_PAUSE_CLASSES,
  IMPLEMENT_BASE_SYNC_ACTIONS,
  IMPLEMENT_BASE_SYNC_OUTCOMES,
  IMPLEMENT_CHECKOUT_MODES,
  TELEMETRY_TIERS,
  cancelAsyncJob,
  pollAsyncJob,
  runAuthorizeExecutionObligationWontfix,
  runCodexVerifyFinding,
  runCreateSynchronizedImplementPr,
  runMarkImplementIssuePickedUp,
  runPrepareImplementBranch,
  runRecordExecutionObligation,
  runResolveWorkflowRoute,
  runReviewCapDisposition,
  runSynchronizeImplementBranch,
  runWatchSonarAnalysis,
  startAsyncJob,
} from "../lib.js";
import {
  GC_IMPLEMENT_MECHANICAL_DESCRIPTION,
  gcImplementMechanicalToolHandler,
  gcImplementMechanicalZodShape,
} from "../gc-implement-mechanical.js";
import { ASYNC_REVIEW_PARAM_DESC } from "./query.js";
import { ok, err } from "./respond.js";


export function registerReviewCapDisposition(server, ctx) {
  _registerGcReviewCapDisposition(server);
  _registerGcCodexJob(server);
  _registerGcWatchSonarAnalysis(server);
  _registerGcPrepareImplementBranch(server);
  _registerGcImplementMechanical(server);
  _registerGcSynchronizeImplementBranch(server);
  _registerGcCreateSynchronizedImplementPr(server);
  _registerGcRecordExecutionObligation(server);
  _registerGcMarkImplementIssuePickedUp(server);
  _registerGcAuthorizeExecutionObligationWontfix(server);
  _registerGcResolveWorkflowRoute(server);
  _registerGcCodexVerifyFinding(server);
}

function _registerGcReviewCapDisposition(server) {
  server.tool(
    "gc_review_cap_disposition",
    "Optional, config-gated auto-disposition of the pre-push review cap (workflow.review_disposition; disabled by default — when disabled this returns {ok:true,skipped:true,disposition:null} and does nothing else). Scores the change with a deterministic risk model (diff size, changed-surface class, security-finding shape, prior auto-overrides) and returns one of disposition='proceed' | 'one_more_cycle' | 'escalate_to_human' with a next_action directive. Cap/cycle authority is derived SERVER-SIDE (the effective reviewer cap from config, the over-cap count from durable cycle markers); the passed cycle/cap are advisory display only, and the call is refused (disposition_before_cap_boundary) before the cap boundary is reached. In mode='shadow' (default) the returned next_action is clamped to escalation — the disposition is recorded for agreement data but never drives control flow. A one_more_cycle disposition records a durable over-cap auto-grant (carrying its issuance mode + server-derived cap boundary) that gc_codex_review_cycle / gc_test_quality_review_cycle verify (via auto_grant=true) before running an over-cap cycle — honored only when posted by the trusted MCP identity, issued under authoritative mode, bound to the current cap, and not already spent. The hard ceiling (max_auto_overrides) is enforced in the scorer and re-clamped after any judge so the auto path can never grant a 2nd over-cap cycle. Returns {ok, disposition, next_action, mode, effective_cap, rationale, decided_by, risk_score, signals_snapshot, over_cap_grant_number, decision_record_url}.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      reviewer: z.enum(["codex", "test-quality"]),
      cycle: z.number().int().positive(),
      cap: z.number().int().positive(),
      base_branch: z.string().nullable().optional(),
      uncommitted: z.boolean().optional(),
      findings_summary: z
        .object({
          one_off_count: z.number().int().nonnegative().optional(),
          class_count: z.number().int().nonnegative().optional(),
          has_security_finding: z.boolean().optional(),
          top_categories: z
            .array(
              z
                .object({
                  shape: z.string(),
                  instance_count: z.number().int().nonnegative().optional(),
                })
                .passthrough(),
            )
            .max(50)
            .optional(),
        })
        .passthrough()
        .nullable()
        .optional()
        .describe(
          "The last-in-cap cycle's server-produced findings summary (from the gc_codex_review_cycle / " +
            "gc_test_quality_review_cycle envelope). Feeds the risk scorer's finding-shape signal. When omitted, " +
            "the scorer treats finding shape as unknown and refuses the proceed fast-path (fail-safe).",
        ),
      async: z.boolean().optional().describe(ASYNC_REVIEW_PARAM_DESC),
    },
    async ({ repo_path, issue_number, reviewer, cycle, cap, base_branch, uncommitted, findings_summary, async: asyncMode }) => {
      try {
        const params = {
          repoPath: repo_path,
          issueNumber: issue_number,
          reviewer,
          cycle,
          cap,
          baseBranch: base_branch ?? null,
          uncommitted: uncommitted ?? true,
          findingsSummary: findings_summary ?? null,
        };
        if (asyncMode) {
          return ok(JSON.stringify(startAsyncJob(
            "review_cap_disposition",
            (signal) => runReviewCapDisposition({ ...params, signal }),
          ), null, 2));
        }
        return ok(JSON.stringify(await runReviewCapDisposition(params), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcCodexJob(server) {
  server.tool(
    "gc_codex_job",
    "Poll or cancel a shared async job started by gc_codex_review, gc_codex_review_cycle, " +
      "gc_codex_architecture_preflight, gc_test_quality_review, gc_test_quality_review_cycle, or " +
      "gc_implement_mechanical with async=true. action='poll' returns {ok:true,status:'running'} while " +
      "work continues, and {ok:true,status:'done',result:<original tool envelope>} once it finishes. " +
      "A running poll may carry a bounded `progress` snapshot (current gate phase plus last child-output " +
      "activity and byte counts) so a slow-but-healthy verification sweep is distinguishable from a dead job; " +
      "it is observability only, never a liveness or cancellation guarantee. " +
      "Dispatch on result.next_action exactly as for the synchronous originating tool. A failed or cancelled " +
      "job returns ok=false; a failed one carries a bounded, head-and-tail-preserving `message` and, when the " +
      "failing tool attached one, a bounded `diagnostics` object of scalars and string lists — for a killed " +
      "architecture preflight that names the checkout paths the failed run already wrote, so a retry does not " +
      "silently build on partial output. action='cancel' aborts only jobs whose complete execution path supports it; " +
      "review-cycle and mechanical jobs currently return job_not_cancellable and continue to their ordinary terminal result. " +
      "Jobs are reaped 30 minutes after they finish; a poll for an unknown or expired job_id returns " +
      "error='job_not_found'. For a review-cycle job, refresh and reconcile the authoritative issue thread before " +
      "another attempt; for other jobs, follow the originating tool's retry contract.",
    {
      action: z.enum(["poll", "cancel"]),
      job_id: z.string().min(1).max(ASYNC_JOB_ID_MAX).regex(ASYNC_JOB_ID_RE),
    },
    async ({ action, job_id }) => {
      try {
        const result = action === "cancel" ? cancelAsyncJob(job_id) : pollAsyncJob(job_id);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcWatchSonarAnalysis(server) {
  server.tool(
    "gc_watch_sonar_analysis",
    "Poll SonarCloud for a PR's quality gate and open issues / hotspots server-side. Returns one compact terminal envelope: {quality_gate, issues_summary, hotspots_summary, full_issue_export_path}. Designed for /implement Step 11: the agent makes one tool call; the MCP server holds the connection through the analysis propagation wait (60s default) and quality-gate polling; total_timeout_seconds (30 min default) bounds the whole call including that wait. Before waiting, the server reads the PR's check-run rollup and stops immediately with ok=false error='sonar_watch_analysis_not_produced' when the SonarCloud producer check is already terminal — no analysis will ever exist, so the wait cannot succeed. That envelope carries bounded scope_evidence (repo, pr, head sha, project key, selector, matched check conclusions) and terminates the watch; it does NOT clear the gate, because a check-run records a skip without recording its cause. The producer is named by the optional sonarcloud.analysis_check in .ground-control.yaml, else any check or workflow matching /sonar/i. When the repo has no sonarcloud block the tool returns ok=true skipped=true quality_gate='NONE'; an invalid .ground-control.yaml returns ok=false error='sonar_watch_config_invalid' rather than a skip, because a gate that could not be read is not a gate that passed. SonarCloud REST authentication uses HTTP Basic with the SONAR_TOKEN env var as the username — read at call time, only after a Sonar request is actually needed, and passed only in the Authorization header (never argv, telemetry, export, or returned envelope); a rejected credential is error='sonar_watch_authentication_failed', distinct from the missing-variable error. The full per-issue + per-hotspot payload is written server-side under `.gc/sonar/<pr>-<ts>.json` for on-demand drilldown; only summaries reach the caller.",
    {
      repo_path: z.string(),
      pr_number: z.number().int().positive(),
      initial_wait_seconds: z.number().int().nonnegative().optional(),
      total_timeout_seconds: z.number().int().nonnegative().optional(),
      poll_interval_seconds: z.number().int().nonnegative().optional(),
    },
    async ({ repo_path, pr_number, initial_wait_seconds, total_timeout_seconds, poll_interval_seconds }) => {
      try {
        return ok(JSON.stringify(await runWatchSonarAnalysis({
          repoPath: repo_path,
          prNumber: pr_number,
          initialWaitSeconds: initial_wait_seconds ?? 60,
          totalTimeoutSeconds: total_timeout_seconds ?? 1800,
          pollIntervalSeconds: poll_interval_seconds ?? 30,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcPrepareImplementBranch(server) {
  server.tool(
    "gc_prepare_implement_branch",
    "Create or switch to an issue branch inside the exact checkout where /implement was invoked. " +
    "Inputs are repo_path, invocation_root, issue_number, branch_name, optional base_branch, and " +
    "checkout_mode. This is the agent-neutral branch-mutation boundary: it supports only " +
    "checkout_mode='same_checkout', " +
    "binds repo_path and repository identity to values captured at MCP launch, rejects origin drift, " +
    "uses fixed argv/cwd plus sanitized Git configuration that disables hooks and external commands, " +
    "never invokes git worktree add, and " +
    "verifies the canonical top-level, Git directory, origin, and compliant active branch after mutation. " +
    "The response never exposes the raw origin URL. A worktree exception is intentionally unavailable " +
    "until a lifecycle owner can guarantee cleanup.",
    {
      repo_path: z.string(),
      invocation_root: z.string(),
      issue_number: z.number().int().positive(),
      branch_name: z.string().min(1).max(50),
      base_branch: z.string().min(1).optional(),
      checkout_mode: z.enum(IMPLEMENT_CHECKOUT_MODES).optional(),
    },
    async ({ repo_path, invocation_root, issue_number, branch_name, base_branch, checkout_mode }) => {
      try {
        return ok(JSON.stringify(await runPrepareImplementBranch({
          repoPath: repo_path,
          invocationRoot: invocation_root,
          issueNumber: issue_number,
          branchName: branch_name,
          baseBranch: base_branch ?? "dev",
          checkoutMode: checkout_mode ?? "same_checkout",
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcImplementMechanical(server) {
  server.tool(
    "gc_implement_mechanical",
    GC_IMPLEMENT_MECHANICAL_DESCRIPTION,
    gcImplementMechanicalZodShape,
    async (args) => {
      try {
        return ok(JSON.stringify(await gcImplementMechanicalToolHandler(args), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcSynchronizeImplementBranch(server) {
  server.tool(
    "gc_synchronize_implement_branch",
    "Synchronize an /implement feature branch with the freshly fetched configured integration branch in the invocation checkout. " +
    "Inputs are repo_path, issue_number, branch_name, and action. action=start fetches an explicit " +
    "refs/heads/<base>:refs/remotes/origin/<base> refspec, returns already-current or leaves a real --no-ff --no-commit merge " +
    "ready for conflict resolution. action=complete additionally requires record_id, pre_sync_sha, " +
    "fetched_base_sha, and outcome; it binds the staged tree to the merge commit, checks the merge graph, " +
    "pushes without force, and idempotently records synchronization identity. CI owns completion and policy suites; " +
    "this boundary runs neither. Optional requested_requirement_uid is validated against the issue scope. " +
    "It never creates a worktree, rebases, resets, aborts, discards work, " +
    "or chooses a conflict side.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      branch_name: z.string().min(1).max(50),
      action: z.enum(IMPLEMENT_BASE_SYNC_ACTIONS),
      record_id: z.string().regex(/^[0-9a-f]{32}$/).optional(),
      pre_sync_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional(),
      fetched_base_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional(),
      outcome: z.enum(IMPLEMENT_BASE_SYNC_OUTCOMES).optional(),
      requested_requirement_uid: z.string().regex(EXACT_REQUIREMENT_UID_RE).optional(),
    },
    async ({ repo_path, issue_number, branch_name, action, record_id, pre_sync_sha, fetched_base_sha, outcome, requested_requirement_uid }) => {
      try {
        return ok(JSON.stringify(await runSynchronizeImplementBranch({
          repoPath: repo_path,
          issueNumber: issue_number,
          branchName: branch_name,
          action,
          recordId: record_id ?? null,
          preSyncSha: pre_sync_sha ?? null,
          fetchedBaseSha: fetched_base_sha ?? null,
          outcome: outcome ?? null,
          requestedRequirementUid: requested_requirement_uid ?? null,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcCreateSynchronizedImplementPr(server) {
  server.tool(
    "gc_create_synchronized_implement_pr",
    "Create an /implement pull request only after revalidating a trusted pre-PR synchronization attestation. " +
    "Inputs are repo_path, issue_number, branch_name, synchronization record_id, title, and the body rendered by " +
    "gc_render_pr_body. Immediately before the GitHub write it re-fetches the configured integration branch, verifies " +
    "the trusted issue-thread record, verified tree, local feature SHA, remote feature SHA, fetched base SHA, ancestry, " +
    "repository identity, repository-scoped existing PR identity/content, and configured Conventional Commit title policy. " +
    "Any stale or missing evidence refuses with a next_action returning " +
    "the workflow to gc_synchronize_implement_branch; callers must not fall back to direct gh pr create.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      branch_name: z.string().min(1).max(50),
      record_id: z.string().regex(/^[0-9a-f]{32}$/),
      title: z.string().min(1).max(256),
      body: z.string().min(1).max(65535),
    },
    async ({ repo_path, issue_number, branch_name, record_id, title, body }) => {
      try {
        return ok(JSON.stringify(await runCreateSynchronizedImplementPr({
          repoPath: repo_path,
          issueNumber: issue_number,
          branchName: branch_name,
          recordId: record_id,
          title,
          body,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcRecordExecutionObligation(server) {
  server.tool(
    "gc_record_execution_obligation",
    "Record a durable /implement execution-obligation event on the GitHub issue thread. " +
    "Inputs include obligation_id, event, category, observed_state, evidence, impact, obligation, " +
    "pause_class, decision_request, disposition, corrective_action, verification, and " +
    "user_authorization. repo_path is bound to the MCP launch workspace. user_authorization for " +
    "wontfix must be the structured authorization URL returned by " +
    "gc_authorize_execution_obligation_wontfix; posting and replay verify its exact source command and " +
    "every record author's effective repository permission. " +
    "Events are opened, escalated, or resolved. Escalation preserves the open obligation and requires " +
    "one documented pause class plus a concrete decision request; workload, difficulty, elapsed time, " +
    "context pressure, and inconvenience are not pause classes. Resolution requires corrective action " +
    "and verification; wontfix requires user authorization and not-applicable is limited to a factually " +
    "false or inapplicable condition. gc_assert_completion re-reads trusted markers and refuses both " +
    "readiness and completion while any obligation remains open.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      obligation_id: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/),
      event: z.enum(EXECUTION_OBLIGATION_EVENTS),
      category: z.enum(EXECUTION_OBLIGATION_CATEGORIES),
      observed_state: z.string().min(1).max(1200),
      evidence: z.array(z.string().min(1).max(800)).min(1).max(10),
      impact: z.string().min(1).max(1200),
      obligation: z.string().min(1).max(1200),
      pause_class: z.enum(EXECUTION_OBLIGATION_PAUSE_CLASSES).optional(),
      decision_request: z.string().min(1).max(1200).optional(),
      disposition: z.enum(EXECUTION_OBLIGATION_DISPOSITIONS).optional(),
      corrective_action: z.string().min(1).max(1200).optional(),
      verification: z.array(z.string().min(1).max(800)).min(1).max(10).optional(),
      user_authorization: z.string().min(1).max(800).optional(),
    },
    async (args) => {
      try {
        return ok(JSON.stringify(await runRecordExecutionObligation({
          repoPath: args.repo_path,
          issueNumber: args.issue_number,
          obligationId: args.obligation_id,
          event: args.event,
          category: args.category,
          observedState: args.observed_state,
          evidence: args.evidence,
          impact: args.impact,
          obligation: args.obligation,
          pauseClass: args.pause_class ?? null,
          decisionRequest: args.decision_request ?? null,
          disposition: args.disposition ?? null,
          correctiveAction: args.corrective_action ?? null,
          verification: args.verification ?? null,
          userAuthorization: args.user_authorization ?? null,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcMarkImplementIssuePickedUp(server) {
  server.tool(
    "gc_mark_implement_issue_picked_up",
    "Mark an /implement issue as actively owned through one server-side operation. " +
    "Inputs are repo_path, issue_number, driver, and branch_name. repo_path is bound to the immutable " +
    "MCP launch workspace and pinned GitHub repository identity. " +
    "The operation creates the in-progress label only when absent, applies it, and posts the canonical " +
    "timestamped pickup comment. Agents must not perform these privileged GitHub writes directly.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      driver: z.string().regex(/^[a-z0-9._-]{1,40}$/i),
      branch_name: z.string().min(1).max(50),
    },
    async ({ repo_path, issue_number, driver, branch_name }) => {
      try {
        return ok(JSON.stringify(await runMarkImplementIssuePickedUp({
          repoPath: repo_path,
          issueNumber: issue_number,
          driver,
          branchName: branch_name,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcAuthorizeExecutionObligationWontfix(server) {
  server.tool(
    "gc_authorize_execution_obligation_wontfix",
    "Convert an exact, durable user command into a structured wontfix authorization record. " +
    "Inputs are repo_path, issue_number, obligation_id, and authorization_source_url. " +
    "The source comment must be '/ground-control authorize-wontfix <OBLIGATION_ID>' exactly, must " +
    "belong to this issue, and its author must have effective write permission on the pinned repository. " +
    "Pass the returned authorization_comment_url to gc_record_execution_obligation; free-form approval " +
    "prose, negations, questions, quotations, and reports of another actor's approval are never authority.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      obligation_id: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/),
      authorization_source_url: z.string().url(),
    },
    async ({ repo_path, issue_number, obligation_id, authorization_source_url }) => {
      try {
        return ok(JSON.stringify(await runAuthorizeExecutionObligationWontfix({
          repoPath: repo_path,
          issueNumber: issue_number,
          obligationId: obligation_id,
          authorizationSourceUrl: authorization_source_url,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcResolveWorkflowRoute(server) {
  server.tool(
    "gc_resolve_workflow_route",
    "Resolve the configured /implement route for a workflow stage or purpose. Returns the provider, agent, canonical model id, tier, fallback policy, and source, or a structured disabled/unavailable response. This is the executable routing contract; callers use it before delegated stages instead of relying on skill prose.",
    {
      repo_path: z.string(),
      stage: z.string().min(1),
      tier: z.enum(TELEMETRY_TIERS).optional(),
    },
    async ({ repo_path, stage, tier }) => {
      try {
        return ok(JSON.stringify(await runResolveWorkflowRoute({
          repoPath: repo_path,
          stage,
          tier: tier ?? null,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcCodexVerifyFinding(server) {
  server.tool(
    "gc_codex_verify_finding",
    "Ask Codex to verify whether a specific PR review finding has been resolved. RESOLVED → mark thread resolved; UNRESOLVED → post threaded reply. Per-finding cap of 2 verify calls.",
    {
      repo_path: z.string(),
      pr_number: z.number().int().positive(),
      comment_id: z.number().int().positive(),
      override_cap: z.boolean().optional(),
      override_reason: z.string().optional(),
    },
    async ({ repo_path, pr_number, comment_id, override_cap, override_reason }) => {
      try {
        return ok(JSON.stringify(await runCodexVerifyFinding({
          repoPath: repo_path, prNumber: pr_number, commentId: comment_id,
          overrideCap: Boolean(override_cap), overrideReason: override_reason ?? null,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}
