// Split from index.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Registration bodies are unchanged.

import { z } from "zod";
import {
  CODEX_REVIEW_HARD_CAP,
  CODEX_REVIEW_PREPUSH_HARD_CAP,
  EXACT_REQUIREMENT_UID_RE,
  GITHUB_REPO_RE,
  KNOWLEDGE_SOURCE_TYPES,
  REQUIREMENT_SCOPE_OPERATIONS,
  TEST_QUALITY_REVIEW_HARD_CAP,
  buildCodexReviewOverrideCapDescription,
  buildCodexReviewOverrideReasonDescription,
  buildCodexReviewToolDescription,
  createGitHubIssueFromRequirement,
  getRepoGroundControlContext,
  runCloseIssueAfterMerge,
  runCodexArchitecturePreflight,
  runCodexReview,
  runPostImplementationPlan,
  runUpdateIssueRequirements,
  runTestQualityReview,
  startAsyncJob,
  writeKnowledgeInbox,
} from "../lib.js";
import { ok, err } from "./respond.js";

export const ASYNC_REVIEW_PARAM_DESC =
  "When true, start the review/preflight as a background job and return " +
  "{ok,status:'running',job_id} immediately instead of blocking the MCP call. " +
  "Poll the job with gc_codex_job (action='poll') until status='done', then dispatch " +
  "on result.next_action exactly as for the synchronous call. Use this in the /implement " +
  "workflow so a multi-minute review never trips the MCP client's tool-call timeout (issue #937).";

export const CODEX_REVIEW_CAPS = { postPushCap: CODEX_REVIEW_HARD_CAP, prepushCap: CODEX_REVIEW_PREPUSH_HARD_CAP };


export function registerQuery(server, ctx) {

  server.tool(
    "gc_get_repo_ground_control_context",
    "Read the repo's .ground-control.yaml and return the workflow config: project, github_repo, workflow commands, sonarcloud, knowledge paths, and inlined plan-rules content. Returns validation errors when the file is missing or invalid.",
    { repo_path: z.string().describe("Absolute path to the target Git repository") },
    async ({ repo_path }) => {
      try { return ok(JSON.stringify(await getRepoGroundControlContext(repo_path), null, 2)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "gc_create_github_issue",
    "Create a GitHub issue from a requirement and auto-link it back. Required for /implement's UID-first path. The title and body are rendered from the requirement (the body seeds the `## Requirements` section /implement parses); `extra_body` is appended. Auto-link uses IMPLEMENTS for ACTIVE requirements and DOCUMENTS otherwise. If the issue is created but the traceability link fails, the result still returns the issue plus a `traceability_error`.",
    {
      uid: z.string(),
      project: z.string().optional(),
      repo_path: z.string().describe("Absolute path to the target Git repository; its origin remote is the authoritative repository identity (GC-P026)"),
      repo: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional().describe("Optional owner/repo assertion; validated against the checkout remote and rejected on mismatch, never used as an alternate destination"),
      labels: z.array(z.string()).optional(),
      extra_body: z.string().optional(),
    },
    async (args) => {
      try {
        return ok(JSON.stringify(await createGitHubIssueFromRequirement({
          uid: args.uid,
          project: args.project,
          repo: args.repo,
          repoRoot: args.repo_path,
          labels: args.labels,
          extraBody: args.extra_body,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    "gc_update_issue_requirements",
    "Set the in-scope requirement UID list in an existing GitHub issue's `## Requirements` section - the section /implement parses as the run's scope. " +
    "This is the only supported way to change that section; no skill or agent runs `gh` to edit an issue body (ADR-027). " +
    "operation='add' unions the UIDs onto the current scope and can never remove one. operation='remove' subtracts only the named UIDs and is restricted to a UID that " +
    "requires a durable authorization comment on that issue from a user with repository write access, reading exactly " +
    "'/ground-control authorize-scope-removal <issue> <UID>...' for that exact UID set. Nothing an agent can do to the checkout authorizes a narrowing, because the requirement " +
    "this tool exists to add is by construction absent from the integration branch. There is no replace mode. Every UID remaining in the result must resolve to docs/requirements/<UID>/requirement.md whose frontmatter id " +
    "matches its directory, or the whole operation is refused with no edit. The write is bounded to that section: surrounding sections, section prose, and line " +
    "endings are preserved, and the result is verified by re-parsing it with the same extractor the gates read. Re-running with the same UID set is a no-op that " +
    "performs no write and leaves the body's content hash unchanged. The destination repository is the pinned MCP launch workspace (GC-P026); an optional `repo` " +
    "is a validated assertion against it, never an alternate destination. It edits the issue body only and posts no comment or marker. The whole read-modify-write runs under a " +
    "workspace lease so concurrent calls cannot interleave and drop one another's UIDs; a contended lease refuses rather than writing unserialized. Requirement-file containment " +
    "is verified against the opened descriptor, so the server must run on a host exposing /proc/self/fd - where it does not, the write is refused rather than checked more weakly.",
    {
      repo_path: z.string().describe("Absolute path to the target Git repository; must be the MCP launch workspace"),
      issue_number: z.number().int().positive(),
      operation: z.enum(REQUIREMENT_SCOPE_OPERATIONS).describe("add unions onto current scope; remove needs a repository writer's authorization comment naming this exact UID set"),
      requirement_uids: z.array(z.string().regex(EXACT_REQUIREMENT_UID_RE)).min(1).max(50)
        .describe("Requirement UIDs to add or remove; never empty, and duplicates are refused"),
      repo: z.string().regex(GITHUB_REPO_RE).optional()
        .describe("Optional owner/repo assertion; validated against the authorized checkout and rejected on mismatch, never used as an alternate destination"),
    },
    async ({ repo_path, issue_number, operation, requirement_uids, repo }) => {
      try {
        return ok(JSON.stringify(await runUpdateIssueRequirements({
          repoPath: repo_path,
          issueNumber: issue_number,
          operation,
          requirementUids: requirement_uids,
          repo,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    "gc_remember",
    "Capture a knowledge-base observation from the calling agent. Writes a structured inbox file in the repository's knowledge base and spawns a detached ingest subprocess that integrates the observation into the wiki. Synchronous success means the inbox entry was durably written; wiki integration happens asynchronously and may be retried by later real-time or scheduled runs. Requires the repository's .ground-control.yaml to declare a knowledge block.",
    {
      repo_path: z.string().describe("Absolute path to the target Git repository"),
      note: z.string().min(1).describe("The observation to capture, as free-form text"),
      source_type: z
        .enum(KNOWLEDGE_SOURCE_TYPES)
        .describe(
          "Source citation type (must match the vocabulary in docs/knowledge/SCHEMA.md)",
        ),
      source_ref: z
        .string()
        .min(1)
        .describe(
          "Source citation reference (short SHA for commit, number for pr/issue, comment id for review, etc.)",
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe("Optional list of tags used for index discovery"),
    },
    async ({ repo_path, note, source_type, source_ref, tags }) => {
      try {
        const result = await writeKnowledgeInbox({
          repoPath: repo_path,
          note,
          sourceType: source_type,
          sourceRef: source_ref,
          tags,
        });
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "gc_codex_architecture_preflight",
    "Run Codex architecture preflight before implementation. Codex inspects the requirement and/or issue plus the repository, updates ADRs/design guidance when needed, and returns guardrails and changed files. At least one of requirement_uid or issue_number must be supplied. Pass async=true to run it as a background job polled via gc_codex_job.",
    {
      requirement_uid: z.string().optional(),
      repo_path: z.string(),
      project: z.string().optional(),
      issue_number: z.number().int().positive().optional(),
      repo: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional(),
      async: z.boolean().optional().describe(ASYNC_REVIEW_PARAM_DESC),
    },
    async ({ requirement_uid, repo_path, project, issue_number, repo, async: asyncMode }) => {
      try {
        const params = {
          requirementUid: requirement_uid, repoPath: repo_path, project,
          issueNumber: issue_number ?? null, repo: repo ?? null,
        };
        if (asyncMode) {
          return ok(JSON.stringify(startAsyncJob(
            "architecture_preflight",
            (signal) => runCodexArchitecturePreflight({ ...params, signal }),
          ), null, 2));
        }
        return ok(JSON.stringify(await runCodexArchitecturePreflight(params), null, 2));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    "gc_post_implementation_plan",
    "Post the implementation plan as a comment on the GitHub issue. Refuses unless a 'preflight' phase marker exists for the issue. Scrubs sensitive content, rejects forged machine blocks / reserved markers, and caps body size. On success writes a 'plan' phase marker.",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      plan_body: z.string().min(1),
      override: z.boolean().optional(),
      override_reason: z.string().optional(),
    },
    async ({ repo_path, issue_number, plan_body, override, override_reason }) => {
      try {
        return ok(JSON.stringify(await runPostImplementationPlan({
          repoPath: repo_path, issueNumber: issue_number, planBody: plan_body,
          override: Boolean(override), overrideReason: override_reason ?? null,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    "gc_close_issue_after_merge",
    "Canonical close substep used by the shared post-merge finalizer for /implement Phase E and /quickfix Q7. Verifies the issue's linked PR is merged (merged_at non-null AND state=MERGED) before running `gh issue close`; refuses otherwise. For a requirement-backed run the PR body uses a non-closing `Refs #<n>` reference so GitHub cannot auto-close ahead of validation, and closing an OPEN issue additionally requires a trusted `gc:final-report` marker for THAT PR — proof that merged requirement-state validation succeeded (issue #1541); it refuses with close_requirement_state_unverified otherwise. Requirement-free runs keep `Closes #<n>`, which GitHub honors only when the PR merges into the default branch: that merge reaches the idempotent already_closed no-op, while a PR merged into the integration branch leaves the issue open and the close requires the lane's gc:final-report marker for that PR (issue #1601). Idempotent — re-running on an already-closed issue returns ok with already_closed=true. pr_number is optional; when omitted the tool resolves the merged PR for the issue via the GitHub timeline. The escape hatch is NOT a caller field: a repo-write human authorizes a close without the validated marker by commenting `gc-authorize-merge-state-override pr=<n> <reason>` on the issue, which the tool verifies server-side (author permission) and which is itself the durable record of the bypass. This tool performs ONLY linked-PR resolution, merge-state verification, the requirement-state marker gate, and idempotent issue closure — it does not list open issues, rank next-work candidates, or return any recommendation field (ADR-089 §5).",
    {
      repo_path: z.string(),
      issue_number: z.number().int().positive(),
      pr_number: z.number().int().positive().optional(),
    },
    async ({ repo_path, issue_number, pr_number }) => {
      try {
        return ok(JSON.stringify(await runCloseIssueAfterMerge({
          repoPath: repo_path,
          issueNumber: issue_number,
          prNumber: pr_number ?? null,
        }), null, 2));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    "gc_codex_review",
    buildCodexReviewToolDescription(CODEX_REVIEW_CAPS),
    {
      repo_path: z.string(),
      base_branch: z.string().optional(),
      uncommitted: z.boolean().optional(),
      pr_number: z.number().int().positive().optional(),
      issue_number: z.number().int().positive().optional(),
      override_cap: z.boolean().optional().describe(buildCodexReviewOverrideCapDescription(CODEX_REVIEW_CAPS)),
      override_reason: z.string().optional().describe(buildCodexReviewOverrideReasonDescription(CODEX_REVIEW_CAPS)),
      override_phase_gate: z.boolean().optional(),
      override_phase_reason: z.string().optional(),
      async: z.boolean().optional().describe(ASYNC_REVIEW_PARAM_DESC),
    },
    async ({ repo_path, base_branch, uncommitted, pr_number, issue_number, override_cap, override_reason, override_phase_gate, override_phase_reason, async: asyncMode }) => {
      try {
        const params = {
          repoPath: repo_path, baseBranch: base_branch ?? null,
          uncommitted: Boolean(uncommitted),
          prNumber: pr_number != null ? pr_number : null,
          issueNumber: issue_number != null ? issue_number : null,
          overrideCap: Boolean(override_cap),
          overrideReason: override_reason ?? null,
          overridePhaseGate: Boolean(override_phase_gate),
          overridePhaseReason: override_phase_reason ?? null,
        };
        if (asyncMode) {
          return ok(JSON.stringify(startAsyncJob(
            "codex_review",
            (signal) => runCodexReview({ ...params, signal }),
          ), null, 2));
        }
        return ok(JSON.stringify(await runCodexReview(params), null, 2));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    "gc_test_quality_review",
    `Run the canonical /implement Step 6.6 pre-push test-quality review against the staged + unstaged + ` +
      `untracked diff vs the base branch. (Issue #906 moved this from the former post-PR Step 13 to ` +
      `pre-push Step 6.6 so the PR opens with both AI-assisted reviewers clean.) Shells out to the ` +
      `\`claude\` CLI (Sonnet 5 by default) with the review-tests rubric and the ` +
      `changed test-file paths, parses the structured JSON output (validated by --json-schema), posts ` +
      `the durable findings record + cycle marker to the issue thread, and returns a structured ` +
      `envelope: \`{ ok, finding_count, findings, cycle, cap, next_action, findings_comment_url, ... }\`. ` +
      `The \`next_action\` field is "fix_findings_and_reinvoke" / "post_clean_decision_record_and_advance_to_phase_c" / ` +
      `"fix_findings_then_summarize_and_escalate" / "post_summary_and_escalate_to_user" — the parent ` +
      `/implement workflow reads it as a directive. "fix_findings_then_summarize_and_escalate" is the ` +
      `last-in-cap action: fix the findings, post the decision record, then summarize and escalate to the ` +
      `user; it is NOT a normal re-invoke path. Replaces the prior Skill("review-tests") boundary, ` +
      `which produced prose findings that the autoregressive parent agent kept echoing back to the user ` +
      `instead of fixing in-turn (issue #884 v1 regression). Default cycle cap: ${TEST_QUALITY_REVIEW_HARD_CAP} per ` +
      `issue (issue #906; configurable per repo via \`workflow.test_quality_review.pre_push_cap\` in ` +
      `.ground-control.yaml; bounds [1, 10]); cycle cap+1 requires override_cap=true + override_reason. ` +
      `Authentication: the review engine's auth is declared in the launch directory's .env — one of ` +
      `CLAUDE_CODE_USE_VERTEX, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY, or ` +
      `ANTHROPIC_AUTH_TOKEN — and is never inherited from the launcher or read from a user-level file ` +
      `(issue #1562). With none declared this returns test_quality_review_auth_missing before spawning ` +
      `claude, which is an operator provisioning fault rather than a station failure. ANTHROPIC_API_KEY ` +
      `is stripped from the subprocess env only when another auth path is declared, so it can still be ` +
      `the sole auth. See docs/DEVELOPMENT_WORKFLOW.md "Test-quality review engine".`,
    {
      repo_path: z.string(),
      base_branch: z.string().optional(),
      issue_number: z.number().int().positive().optional(),
      pr_number: z.number().int().positive().optional(),
      override_cap: z.boolean().optional(),
      override_reason: z.string().optional(),
      model: z.string().optional(),
      async: z.boolean().optional().describe(ASYNC_REVIEW_PARAM_DESC),
    },
    async ({ repo_path, base_branch, issue_number, pr_number, override_cap, override_reason, model, async: asyncMode }) => {
      try {
        const params = {
          repoPath: repo_path,
          // Pass null when not supplied so the runner resolves from
          // .ground-control.yaml; the runner falls back to "dev" only if
          // YAML doesn't declare workflow.base_branch.
          baseBranch: base_branch ?? null,
          issueNumber: issue_number != null ? issue_number : null,
          prNumber: pr_number != null ? pr_number : null,
          overrideCap: Boolean(override_cap),
          overrideReason: override_reason ?? null,
          ...(model ? { model } : {}),
        };
        if (asyncMode) {
          return ok(JSON.stringify(startAsyncJob(
            "test_quality_review",
            (signal) => runTestQualityReview({ ...params, signal }),
          ), null, 2));
        }
        return ok(JSON.stringify(await runTestQualityReview(params), null, 2));
      } catch (e) { return err(e); }
    },
  );
}
