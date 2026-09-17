// Split from index.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Registration bodies are unchanged.

import { z } from "zod";
import {
  DECISION_RECORD_CLASSIFICATIONS,
  DECISION_RECORD_DECISIONS,
  DECISION_RECORD_REVIEWERS,
  EXACT_REQUIREMENT_UID_RE,
  FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX,
  FINAL_REPORT_REVIEW_SUMMARY_MAX,
  FINAL_REPORT_SUMMARY_MAX,
  ASYNC_JOB_IDEMPOTENCY_KEY_MAX,
  ASYNC_JOB_IDEMPOTENCY_KEY_RE,
  PR_BODY_CHANGE_CLASSES,
  PR_BODY_LANES,
  PR_BODY_PRE_PUSH_REVIEW_STATES,
  PR_BODY_SUMMARY_MAX,
  runAssertCompletion,
  runCodexReviewCycle,
  runGetIssueThread,
  runPostDecisionRecord,
  runPostFinalReport,
  runRenderPrBody,
  runWatchCiRun,
  runReviewCycleTransport,
} from "../lib.js";
import { ok, err } from "./respond.js";

const ASYNC_REVIEW_CYCLE_PARAM_DESC =
  "Review-cycle tools are async-only. Omit this field or pass true to return a gc_codex_job " +
  "handle immediately. Passing false returns review_cycle_async_required and never runs synchronously.";

export function registerPostDecisionRecord(server, ctx) {
  _registerGcPostDecisionRecord(server);
  _registerGcPostFinalReport(server);
  _registerGcAssertCompletion(server);
  _registerGcRenderPrBody(server);
  _registerGcGetIssueThread(server);
  _registerGcWatchCiRun(server);
  _registerGcCodexReviewCycle(server);
}

function _registerGcPostDecisionRecord(server) {
  server.tool(
    "gc_post_decision_record",
    "Post the canonical review-cycle decision record as a comment on the GitHub issue (per ADR-029, the issue thread is the durable record). Renders the verdict envelope (verdict, architectural_read, blocking, notes) into the standard decision-record Markdown layout; rejects 'defer' decisions and any body containing detected secrets. Replaces free-prose decision comments from the Step 6.5 review loop. The verdict + architectural_read fields are optional for back-compat; new callers (issue #931) populate them. Returns the posted comment's URL and id. A GitHub update gives exactly what's needed — not more, not less. No restating context the reader already has, no padding sections, no hedging prose.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      cycle: z.number().int().positive(),
      reviewer: z.enum(DECISION_RECORD_REVIEWERS),
      // Verdict envelope (#931). Optional for back-compat; required for the new
      // principal-engineer contract.
      verdict: z.enum(["ship", "ship-with-fixes", "don't-ship"]).optional(),
      architectural_read: z.string().min(1).optional(),
      notes: z.array(z.object({
        text: z.string().min(1),
      })).max(2).optional(),
      findings: z.array(z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        classification: z.enum(DECISION_RECORD_CLASSIFICATIONS),
        decision: z.enum(DECISION_RECORD_DECISIONS),
        rationale: z.string().min(1),
        // Required at runtime when decision === "wontfix" — see ADR-029. The
        // Zod object cannot conditionally require a field, so the validator in
        // lib.js performs the conditional check; expose the field here so MCP
        // callers can supply it. Pass a URL to the user's authorization
        // comment on the issue thread OR a verbatim quote with comment id.
        user_authorization: z.string().optional(),
        location: z.string().optional(),
        comment_url: z.string().optional(),
        instances: z.array(z.string().min(1)).optional(),
      })),
    },
    async ({ repo_path, issue_number, cycle, reviewer, findings, verdict, architectural_read, notes }) => {
      try {
        return ok(JSON.stringify(await runPostDecisionRecord({
          repoPath: repo_path, issueNumber: issue_number, cycle, reviewer, findings,
          verdict, architectural_read, notes,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcPostFinalReport(server) {
  server.tool(
    "gc_post_final_report",
    "Post the canonical /implement Step 19 final report (or the /quickfix Step Q19 slim close comment) as a comment on the GitHub issue. Renders structured input (plain_english_outcome, in-scope requirements, files-by-change-kind, reviews, traceability reconciliation, CI/SonarCloud status) into the standard final-report Markdown layout. `plain_english_outcome` is required for /implement and renders the short product/operator outcome section; lane='quickfix' keeps the slim payload where AI reviews and the outcome field are optional. Every gate (CI green, Sonar pass-or-legit-skipped, sensitive-content / no-defer / reserved-marker scrubs) still applies. Replaces free-prose Step 19 comments. Returns the posted comment's URL and id. A GitHub update gives exactly what's needed — not more, not less. No restating context the reader already has, no padding sections, no hedging prose.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      pr_number: z.number().int().positive(),
      requirements: z.array(z.object({
        // Anchored UID match — `requirements[].uid` must BE a UID (codex cycle-4 F2).
        uid: z.string().regex(EXACT_REQUIREMENT_UID_RE),
        title: z.string().min(1),
        status: z.string().min(1),
        note: z.string().optional(),
      })),
      files: z.object({
        added: z.array(z.string().min(1)).optional(),
        modified: z.array(z.string().min(1)).optional(),
        renamed: z.array(z.string().min(1)).optional(),
        deleted: z.array(z.string().min(1)).optional(),
      }).optional(),
      reviews: z.array(z.object({
        reviewer: z.string().min(1),
        summary: z.string().min(1).max(FINAL_REPORT_REVIEW_SUMMARY_MAX),
      })),
      traceability: z.object({
        added: z.array(z.string()).optional(),
        updated: z.array(z.string()).optional(),
        deleted: z.array(z.string()).optional(),
        notes: z.string().optional(),
      }).optional(),
      ci_status: z.enum(["green", "red", "skipped"]),
      sonar_status: z.enum(["passed", "failed", "skipped"]),
      plan_comment_url: z.string().optional(),
      summary: z.string().max(FINAL_REPORT_SUMMARY_MAX).optional(),
      plain_english_outcome: z.string().min(1).max(FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX).optional(),
      lane: z.enum(["implement", "quickfix"]).optional(),
      documentation_outcome: z.object({
        outcome: z.enum(["updated", "verified_unchanged", "not_updated_authorized"]),
        rationale: z.string().optional(),
      }).optional(),
      override_traceability_gate: z.boolean().optional(),
      override_traceability_reason: z.string().optional(),
    },
    async ({ repo_path, issue_number, pr_number, requirements, files, reviews, traceability, ci_status, sonar_status, plan_comment_url, summary, plain_english_outcome, lane, documentation_outcome, override_traceability_gate, override_traceability_reason }) => {
      try {
        return ok(JSON.stringify(await runPostFinalReport({
          repoPath: repo_path,
          issueNumber: issue_number,
          prNumber: pr_number,
          requirements,
          files: files ?? {},
          reviews,
          traceability: traceability ?? {},
          ciStatus: ci_status,
          sonarStatus: sonar_status,
          planCommentUrl: plan_comment_url ?? null,
          lane: lane ?? null,
          summary: summary ?? null,
          plainEnglishOutcome: plain_english_outcome ?? null,
          documentation_outcome: documentation_outcome ?? null,
          overrideTraceabilityGate: Boolean(override_traceability_gate),
          overrideTraceabilityReason: override_traceability_reason ?? null,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcAssertCompletion(server) {
  server.tool(
    "gc_assert_completion",
    "Run the completion assertions (traceability reconciliation) then post the final report in one deterministic call. " +
    "phase='post_merge' (default) is the Phase E completion: it is MERGE-GATED — it refuses with error='completion_pr_not_merged' unless the linked PR is merged (merged_at non-null AND state='MERGED'), so the ACTIVE transition, IMPLEMENTS/TESTS links, and the durable final report never land ahead of shipped code (issue #963, mirrors gc_close_issue_after_merge). " +
    "phase='pre_merge' is the Phase D terminal readiness record: it skips the traceability assertion and the merge gate, posts a 'Ready for review' comment carrying a `ready_for_review` phase marker (no `gc:final-report` marker), and returns {ok, phase:'pre_merge', readiness_report}; all input gates (CI green, Sonar pass/skip, codex review present, scrubs) still run. " +
    "Composes gc_assert_traceability_reconciled and gc_post_final_report. " +
    "When `project` is omitted, traceability reconciliation infers it from `repo_path`'s `.ground-control.yaml`; an explicit `project` overrides the config. " +
    "Fail-fast: validates the final-report input before any side effects. " +
    "Returns assertions[] (one entry per assertion: {name, ok, comment_url, comment_id}) plus final_report {comment_url, comment_id}. " +
    "Gates inherited from the composed runners: traceability reconciliation (ACTIVE requirements must have IMPLEMENTS links + TESTS links on executable surfaces), " +
    "CI green, Sonar pass-or-skipped, sensitive-content/no-defer/reserved-marker scrubs, reviews present, body size. " +
    "The in-progress label removal is optional best-effort and is NOT a gate here. " +
    "Do NOT remove or call the individual gc_assert_traceability_reconciled / gc_post_final_report tools separately when using this composite tool.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      pr_number: z.number().int().positive(),
      requirements: z.array(z.object({
        uid: z.string().regex(EXACT_REQUIREMENT_UID_RE),
        title: z.string().min(1),
        status: z.enum(["ACTIVE", "DRAFT", "DEPRECATED", "ARCHIVED"]),
        note: z.string().optional(),
      })).default([]),
      files: z.object({
        added: z.array(z.string().min(1)).optional(),
        modified: z.array(z.string().min(1)).optional(),
        renamed: z.array(z.string().min(1)).optional(),
        deleted: z.array(z.string().min(1)).optional(),
      }).optional(),
      reviews: z.array(z.object({
        reviewer: z.string().min(1),
        summary: z.string().min(1).max(FINAL_REPORT_REVIEW_SUMMARY_MAX),
      })),
      traceability: z.object({
        added: z.array(z.string()).optional(),
        updated: z.array(z.string()).optional(),
        deleted: z.array(z.string()).optional(),
        notes: z.string().optional(),
      }).optional(),
      ci_status: z.enum(["green", "red", "skipped"]),
      sonar_status: z.enum(["passed", "failed", "skipped"]),
      plan_comment_url: z.string().optional(),
      summary: z.string().max(FINAL_REPORT_SUMMARY_MAX).optional(),
      plain_english_outcome: z.string().min(1).max(FINAL_REPORT_PLAIN_ENGLISH_OUTCOME_MAX).optional(),
      documentation_outcome: z.object({
        outcome: z.enum(["updated", "verified_unchanged", "not_updated_authorized"]),
        rationale: z.string().optional(),
      }).optional(),
      touched_files: z.array(z.string()).optional(),
      project: z.string().optional(),
      phase: z.enum(["pre_merge", "post_merge"]).optional(),
    },
    async ({ repo_path, issue_number, pr_number, requirements, files, reviews, traceability, ci_status, sonar_status, plan_comment_url, summary, plain_english_outcome, documentation_outcome, touched_files, project, phase }) => {
      try {
        return ok(JSON.stringify(await runAssertCompletion({
          repoPath: repo_path,
          issueNumber: issue_number,
          prNumber: pr_number,
          requirements: requirements.map((r) => ({
            uid: r.uid,
            title: r.title,
            status: r.status,
            note: r.note ?? undefined,
            statusIntent: r.status,
          })),
          files: files ?? {},
          reviews,
          traceability: traceability ?? {},
          ciStatus: ci_status,
          sonarStatus: sonar_status,
          planCommentUrl: plan_comment_url ?? null,
          summary: summary ?? null,
          plainEnglishOutcome: plain_english_outcome ?? null,
          documentation_outcome: documentation_outcome ?? null,
          touchedFiles: touched_files ?? [],
          project: project ?? null,
          phase: phase ?? "post_merge",
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcRenderPrBody(server) {
  server.tool(
    "gc_render_pr_body",
    "Render a repo-neutral PR body that satisfies the Ground Control policy gates (template sections, requirement UIDs, ADR impact, two semantic Ground Control Checks, IMPLEMENTS/TESTS markers, no defer language). Returns the rendered body string to pass as the `body` input to `gc_create_synchronized_implement_pr` — the only canonical PR-write path (it revalidates body shape, repository identity, branch synchronization, and title immediately before the privileged GitHub write, per ADR-027); do not hand it to `gh pr create` from an agent sandbox. Attestations are repo-neutral and never publish configured command strings (issue #1199). change_class shapes a few cells: doc-only marks integration tests / changelog fragment N/A; source requires changelog fragment; source+migration adds a repo-neutral migration-verification reminder (no framework or test-class names). In `release-please` changelog_mode no per-PR changelog fragment is required or accepted (Release Please owns CHANGELOG.md, #1399). Pass dev_start_gate when the repo's configured PR policy requires a ## Dev-Start Gate section. `lane` and `pre_push_reviews` pick which pre-push review attestation the Ground Control Checks section carries (issue #1551): both default to the /implement shape (`implement` / `completed`), and a `pre_push_reviews` of not_run — legal only with `lane` quickfix, whose reviewers are off unless the user passed --review — renders the attestation that they did not run. The attestation is never omitted, only made accurate. A GitHub update gives exactly what's needed — not more, not less. No restating context the reader already has, no padding sections, no hedging prose.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      change_class: z.enum(PR_BODY_CHANGE_CLASSES),
      // Renderer input uses the anchored recognizer, not the looser identity
      // contract, so every UID this tool renders is one the `pr-requirement-uid`
      // policy gate can find in the emitted body (issue #1425). Each array
      // element must BE a UID, not contain one.
      requirement_uids: z.array(z.string().regex(EXACT_REQUIREMENT_UID_RE)),
      adr_refs: z.array(z.string().min(1)),
      summary: z.string().min(1).max(PR_BODY_SUMMARY_MAX),
      changes: z.array(z.string().min(1)),
      traceability: z.object({
        implements: z.array(z.string()),
        tests: z.array(z.string()),
      }),
      changelog_fragment: z.string().optional(),
      changelog_mode: z.enum(["fragments", "release-please"]).optional(),
      test_notes: z.string().optional(),
      dev_start_gate: z.string().optional(),
      documentation_outcome: z.object({
        outcome: z.enum(["updated", "verified_unchanged", "not_updated_authorized"]),
        rationale: z.string().optional(),
      }).optional(),
      lane: z.enum(PR_BODY_LANES).optional(),
      pre_push_reviews: z.enum(PR_BODY_PRE_PUSH_REVIEW_STATES).optional(),
    },
    async ({ repo_path, issue_number, change_class, requirement_uids, adr_refs, summary, changes, traceability, changelog_fragment, changelog_mode, test_notes, dev_start_gate, documentation_outcome, lane, pre_push_reviews }) => {
      try {
        return ok(JSON.stringify(await runRenderPrBody({
          repoPath: repo_path,
          issueNumber: issue_number,
          changeClass: change_class,
          requirementUids: requirement_uids,
          adrRefs: adr_refs,
          summary,
          changes,
          traceability,
          changelogFragment: changelog_fragment ?? null,
          changelogMode: changelog_mode ?? "fragments",
          testNotes: test_notes ?? null,
          devStartGate: dev_start_gate ?? null,
          documentation_outcome: documentation_outcome ?? null,
          lane: lane ?? null,
          prePushReviews: pre_push_reviews ?? null,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcGetIssueThread(server) {
  server.tool(
    "gc_get_issue_thread",
    "Fetch the GitHub issue body + comments with an in-memory content-addressed cache. First call returns the full payload + a sha256 hash; subsequent calls passing `expected_hash` return `{unchanged: true}` without re-fetching when the hash matches. Cache is keyed by (repo, issue_number) — NOT branch-keyed — and is operational only (the GitHub issue thread remains the durable record per ADR-029). Pass expected_hash=null to force a fresh fetch (use after a posting may have failed or when marker state is uncertain).",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      expected_hash: z.string().min(1).nullable().optional(),
    },
    async ({ repo_path, issue_number, expected_hash }) => {
      try {
        return ok(JSON.stringify(await runGetIssueThread({
          repoPath: repo_path,
          issueNumber: issue_number,
          expectedHash: expected_hash ?? null,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcWatchCiRun(server) {
  server.tool(
    "gc_watch_ci_run",
    "Poll a GitHub Actions run to a terminal state server-side and return one compact terminal envelope (conclusion, failed steps, bounded log summary). Designed for the /implement Step 10 monitor: the agent makes one tool call; the MCP server holds the connection while polling so the agent's context is not burned by per-poll turns. Defaults: queued cap 5 min, total cap 45 min, poll every 15s. The queued cap applies per run to the time it has waited for its first runner, measured from its latest attempt's start, so a run that has started any job (including one reading `queued` between jobs) is subject only to the total cap. On queued-too-long or timeout the tool returns ok=true with conclusion='queued_too_long' or 'timed_out' so the caller can decide policy. If run_id is omitted, every run triggered by the branch's newest commit is watched. run_id, status, and url always describe the one run the conclusion is about; a success over several runs sets run_id and url to null, and `runs` lists every watched run. Raw CI logs stay server-side; only a bounded UTF-8 summary (default 4096 bytes from the tail of `--log-failed`) reaches the caller.",
    {
      repo_path: z.string(),
      branch: z.string().min(1),
      run_id: z.number().int().positive().nullable().optional(),
      queued_timeout_seconds: z.number().int().positive().optional(),
      total_timeout_seconds: z.number().int().positive().optional(),
      poll_interval_seconds: z.number().int().positive().optional(),
    },
    async ({ repo_path, branch, run_id, queued_timeout_seconds, total_timeout_seconds, poll_interval_seconds }) => {
      try {
        return ok(JSON.stringify(await runWatchCiRun({
          repoPath: repo_path,
          branch,
          runId: run_id ?? null,
          queuedTimeoutSeconds: queued_timeout_seconds ?? 300,
          totalTimeoutSeconds: total_timeout_seconds ?? 2700,
          pollIntervalSeconds: poll_interval_seconds ?? 15,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}

function _registerGcCodexReviewCycle(server) {
  server.tool(
    "gc_codex_review_cycle",
    "Async-only pre-push codex-review cycle wrapper. Requires one bounded idempotency_key per logical attempt, returns a gc_codex_job handle immediately, runs gc_codex_review (uncommitted=true), and auto-posts the canonical per-cycle decision record. Reuse the same key when the start response is lost; changed input conflicts and concurrent distinct starts for the same repository, issue, and reviewer are refused. Poll gc_codex_job for the compact terminal result: {ok, reviewer, cycle, cap, status, next_action, findings_summary, findings_record_url, decision_record_url, diff_mode, review_coverage}. Verbatim review prose remains server-side.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      base_branch: z.string().nullable().optional(),
      uncommitted: z.boolean().optional(),
      override_cap: z.boolean().optional(),
      override_reason: z.string().nullable().optional(),
      auto_grant: z.boolean().optional(),
      async: z.boolean().optional().describe(ASYNC_REVIEW_CYCLE_PARAM_DESC),
      idempotency_key: z
        .string()
        .min(1)
        .max(ASYNC_JOB_IDEMPOTENCY_KEY_MAX)
        .regex(ASYNC_JOB_IDEMPOTENCY_KEY_RE),
    },
    async ({ repo_path, issue_number, base_branch, uncommitted, override_cap, override_reason, auto_grant, async: asyncMode, idempotency_key }) => {
      try {
        const params = {
          repoPath: repo_path,
          issueNumber: issue_number,
          baseBranch: base_branch ?? null,
          uncommitted: uncommitted ?? true,
          overrideCap: Boolean(override_cap),
          overrideReason: override_reason ?? null,
          autoGrant: Boolean(auto_grant),
        };
        return ok(JSON.stringify(await runReviewCycleTransport({
          reviewer: "codex",
          repoPath: repo_path,
          issueNumber: issue_number,
          idempotencyKey: idempotency_key,
          asyncMode,
          cycleInput: params,
          runCycle: runCodexReviewCycle,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );
}
