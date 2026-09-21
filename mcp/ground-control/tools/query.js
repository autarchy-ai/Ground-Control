// Split from index.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Registration bodies are unchanged.

import { z } from "zod";
import {
  CODEX_REVIEW_HARD_CAP,
  CODEX_REVIEW_PREPUSH_HARD_CAP,
  EXACT_REQUIREMENT_UID_RE,
  GITHUB_REPO_RE,
  ISSUE_DEPENDENCY_ACTIONS,
  KNOWLEDGE_SOURCE_TYPES,
  REQUIREMENT_SCOPE_OPERATIONS,
  buildCodexReviewOverrideCapDescription,
  buildCodexReviewOverrideReasonDescription,
  buildCodexReviewToolDescription,
  createGitHubIssueFromRequirement,
  getRepoGroundControlContext,
  runCloseIssueAfterMerge,
  runCodexArchitecturePreflight,
  runCodexReviewWithPublication,
  runIssueDependency,
  runPostImplementationPlan,
  runUpdateIssueRequirements,
  startAsyncJob,
  writeKnowledgeInbox,
} from "../lib.js";
import { ok, err } from "./respond.js";

export const ASYNC_REVIEW_PARAM_DESC =
  "When true, start the review/preflight as a background job and return " +
  "{ok,status:'running',job_id} immediately instead of blocking the MCP call. " +
  "Await the job with gc_codex_job (action='await'), which holds one call until status='done' " +
  "instead of costing a model turn per poll tick; a bounded expiry returns the running envelope, " +
  "so await again (issue #1669). action='poll' remains available for an immediate non-blocking " +
  "snapshot. Either way, dispatch on result.next_action exactly as for the synchronous call. Use " +
  "this in the /implement workflow so a multi-minute review never trips the MCP client's " +
  "tool-call timeout (issue #937).";

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
    "gc_issue_dependency",
    "Read, add, or remove a GitHub issue dependency - the 'blocked by' relationship - for an issue in the authorized checkout. " +
    "Always pass action, repo_path, and blocked_issue_number; action='add' and action='remove' also require blocking_issue_number, " +
    "which action='read' refuses because a read has no second operand. Callers stay in issue-number vocabulary: " +
    "GitHub's dependency endpoints key on the blocking issue's numeric REST id, and this tool resolves number -> id itself " +
    "and never returns it. action='read' returns the issue's blocked_by and blocking lists, each normalized to repository, " +
    "number, title, state, url, and in_authorized_repository; an issue with no dependencies returns two empty arrays, not an error. " +
    "A relationship created elsewhere can name an issue in another repository the host credential happens to read, so such an entry " +
    "keeps only its repository and number and has its title, state, and url redacted to null with in_authorized_repository false - " +
    "the edge stays visible without this tool serving content from a repository the call is not authorized for. A mutation returns " +
    "the resulting blocked_by plus an outcome of 'changed', 'already_satisfied' (the state already held, so nothing was written), " +
    "or 'reconciled' (the write failed but the requested state now holds, established by a writer this process cannot identify). " +
    "Replay is safe because idempotency is decided from the current relationship set, never from an HTTP status. " +
    "The repository comes from the checkout, never GH_REPO; the optional repo is an 'owner/name' assertion validated against it " +
    "and refused on mismatch, which is also how a cross-repository reference is refused - there is no alternate destination. " +
    "Expected failures return a named reason: issue_dependency_self_dependency, _blocked_issue_not_found, _blocking_issue_not_found, " +
    "_not_an_issue, _repo_mismatch, _repo_not_authorized, _forbidden, _rejected, _malformed_response, or _transport_unavailable. " +
    "It posts no comment, writes no marker, edits no issue body, and gates no workflow phase.",
    {
      repo_path: z.string().describe("Absolute path to the target Git repository; must be the MCP launch workspace"),
      action: z.enum(ISSUE_DEPENDENCY_ACTIONS),
      blocked_issue_number: z.number().int().positive().describe("The issue whose blockers are read or changed"),
      blocking_issue_number: z.number().int().positive().optional()
        .describe("The issue that blocks it; required for add and remove, refused for read"),
      repo: z.string().regex(GITHUB_REPO_RE).optional()
        .describe("Optional owner/repo assertion; validated against the authorized checkout and rejected on mismatch, never used as an alternate destination"),
    },
    async ({ repo_path, action, blocked_issue_number, blocking_issue_number, repo }) => {
      try {
        return ok(JSON.stringify(await runIssueDependency({
          repoPath: repo_path,
          action,
          blockedIssueNumber: blocked_issue_number,
          blockingIssueNumber: blocking_issue_number ?? null,
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
    "Canonical close substep used by the shared post-merge finalizer for /implement Phase E and /quickfix Q7. Verifies the issue's linked PR is merged (merged_at non-null AND state=MERGED) before running `gh issue close`; refuses otherwise. For a requirement-backed run the PR body uses a non-closing `Refs #<n>` reference so GitHub cannot auto-close ahead of validation, and closing an OPEN issue additionally requires a trusted `gc:final-report` marker for THAT PR — proof that merged requirement-state validation succeeded (issue #1541); it refuses with close_requirement_state_unverified otherwise. Requirement-free runs keep `Closes #<n>`, which GitHub honors only when the PR merges into the default branch: that merge reaches the idempotent already_closed no-op, while a PR merged into the integration branch leaves the issue open and the close requires the lane's gc:final-report marker for that PR (issue #1601). Idempotent — re-running on an already-closed issue returns ok with already_closed=true. Once the issue is closed, on either path, it drops the `in-progress` pickup label as a best-effort step that never changes the close outcome or the envelope; a refused or failed close removes nothing, because an issue left open is still in progress (issue #1686). pr_number is optional; when omitted the tool resolves the merged PR for the issue via the GitHub timeline. The escape hatch is NOT a caller field: a repo-write human authorizes a close without the validated marker by commenting `gc-authorize-merge-state-override pr=<n> <reason>` on the issue, which the tool verifies server-side (author permission) and which is itself the durable record of the bypass. This tool performs ONLY linked-PR resolution, merge-state verification, the requirement-state marker gate, and idempotent issue closure — it does not list open issues, rank next-work candidates, or return any recommendation field (ADR-089 §5).",
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
      publication_mode: z.enum(["automatic", "deferred"]).optional(),
    },
    async ({ repo_path, base_branch, uncommitted, pr_number, issue_number, override_cap, override_reason, override_phase_gate, override_phase_reason, async: asyncMode, publication_mode }) => {
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
          publicationMode: publication_mode ?? "automatic",
        };
        if (asyncMode) {
          return ok(JSON.stringify(startAsyncJob(
            "codex_review",
            (signal) => runCodexReviewWithPublication({ ...params, signal }),
          ), null, 2));
        }
        return ok(JSON.stringify(await runCodexReviewWithPublication(params), null, 2));
      } catch (e) { return err(e); }
    },
  );

}
