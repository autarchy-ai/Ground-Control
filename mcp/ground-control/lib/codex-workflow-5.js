// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { realpathSync } from "node:fs";
import { TEST_QUALITY_REVIEW_DEFAULT_MODEL, TEST_QUALITY_REVIEW_TIMEOUT_MS } from "./ci-watcher.js";
import { assertImplementSyncCheckout, fetchImplementBase, isImplementAncestor, readImplementGitOid, readImplementTreeOid, readRemoteImplementBranchSha } from "./codex-workflow-2.js";
import { extractInScopeRequirementUids } from "./issue-requirements-scope.js";
import { validateExistingSynchronizedImplementPr, validateImplementBranchName, validateImplementPrTitle } from "./codex-workflow.js";
import { runGetIssueThread } from "./issue-thread.js";
import { detectSensitiveBodyContent, extractGhErrorMessage } from "./grc-legacy-compat-2.js";
import { assertSafeImplementCheckoutConfiguration, authorizeImplementRepoRoot, ensureGitRepo, resolveMcpLaunchWorkspaceAuthorization } from "./grc-legacy-compat-4.js";
import { ghRestJson, listPullRequestsForHead } from "./github-rest.js";
import { readTrustedImplementSyncRecord } from "./knowledge-capture.js";
import { getRepoGroundControlContext } from "./repo-vocabulary-2.js";
import { rejectReservedMarkerSequence } from "./repo-vocabulary.js";
import { checkPrBodyShape, execFile, execFileWithInput, reviewEngineEnv } from "./runtime-primitives.js";
import { TEST_QUALITY_REVIEW_FINDINGS_SCHEMA } from "./test-quality-prompt.js";
import { ReviewerCapConfigError } from "./test-quality-runner.js";

function validateSynchronizedImplementPrInput(input) {
  if (
    input == null
    || !Number.isInteger(input.issueNumber)
    || input.issueNumber <= 0
    || typeof input.recordId !== "string"
    || !/^[0-9a-f]{32}$/.test(input.recordId)
  ) {
    return {
      ok: false,
      error: "implement_pr_input_invalid",
      message: "issueNumber and a synchronization record ID are required",
    };
  }
  const branchValidation = validateImplementBranchName(input.branchName, input.issueNumber);
  if (!branchValidation.ok) return branchValidation;
  if (typeof input.body !== "string" || !checkPrBodyShape(input.body).ok) {
    return {
      ok: false,
      error: "implement_pr_body_invalid",
      message: "body must satisfy the canonical Ground Control PR-body shape",
    };
  }
  const bodyError = detectSensitiveBodyContent(input.body)
    ?? rejectReservedMarkerSequence(input.body, "body");
  if (bodyError) {
    return { ok: false, error: "implement_pr_body_rejected", message: bodyError };
  }
  return { ok: true };
}

async function findExistingSynchronizedImplementPr({
  repoRoot,
  repoAuthorization,
  baseBranch,
  input,
  localSha,
  commandRunner,
}) {
  const repoSlug = `${repoAuthorization.owner}/${repoAuthorization.name}`;
  try {
    // REST, not `gh pr list`: the GraphQL budget is shared by every agent on the token and runs out
    // while REST still answers (issue #1584). The repository stays pinned by the path and the
    // identity check below; `head` is owner-qualified, as the REST filter requires.
    const existing = await listPullRequestsForHead(
      repoRoot, repoAuthorization.owner, repoAuthorization.name, input.branchName,
      { execFile: commandRunner },
    );
    if (!Array.isArray(existing) || existing.length > 1) {
      return {
        ok: false,
        error: "implement_pr_existing_ambiguous",
        message: "The synchronized feature branch must have at most one open pull request",
        next_action: "inspect_the_existing_prs_without_bypassing_the_sync_gate",
      };
    }
    if (existing.length === 0) return { ok: true, candidate: null, repoSlug };
    const validation = validateExistingSynchronizedImplementPr(existing[0], {
      owner: repoAuthorization.owner,
      name: repoAuthorization.name,
      baseBranch,
      branchName: input.branchName,
      featureSha: localSha,
      title: input.title,
      body: input.body,
    });
    if (!validation.ok) return validation;
    return { ok: true, candidate: existing[0], repoSlug };
  } catch (error) {
    return {
      ok: false,
      error: "implement_pr_existing_lookup_failed",
      message: extractGhErrorMessage(error),
      next_action: "repair_the_repository_scoped_pr_lookup_and_retry",
    };
  }
}

async function validateImplementSynchronization({
  repoRoot,
  repoAuthorization,
  baseBranch,
  input,
  commandRunner,
  syncRecordReader,
}) {
  await assertSafeImplementCheckoutConfiguration(repoRoot);
  const checkout = await assertImplementSyncCheckout({
    repoRoot,
    issueNumber: input.issueNumber,
    branchName: input.branchName,
    commandRunner,
  });
  if (!checkout.ok) return checkout;
  const trusted = await syncRecordReader(
    repoRoot,
    repoAuthorization.owner,
    repoAuthorization.name,
    input.issueNumber,
    input.recordId,
  );
  if (!trusted.ok) {
    return { ...trusted, next_action: "return_to_the_synchronization_boundary" };
  }
  const record = trusted.record;
  if (
    record.issueNumber !== input.issueNumber
    || record.branchName !== input.branchName
    || record.baseBranch !== baseBranch
    || record.remoteRef !== `refs/remotes/origin/${baseBranch}`
  ) {
    return {
      ok: false,
      error: "implement_pr_sync_record_identity_mismatch",
      message: "The synchronization record does not belong to this issue, branch, or configured base",
      next_action: "return_to_the_synchronization_boundary",
    };
  }
  const { fetchedBaseSha } = await fetchImplementBase(repoRoot, baseBranch, commandRunner);
  const localSha = await readImplementGitOid(repoRoot, "HEAD", commandRunner);
  const localTreeSha = await readImplementTreeOid(repoRoot, "HEAD", commandRunner);
  const remoteSha = await readRemoteImplementBranchSha(repoRoot, input.branchName, commandRunner);
  const current = fetchedBaseSha === record.fetchedBaseSha
    && localSha === record.resultingFeatureSha
    && localTreeSha === record.verifiedTreeSha
    && remoteSha === record.resultingFeatureSha
    && await isImplementAncestor(
      repoRoot,
      record.fetchedBaseSha,
      record.resultingFeatureSha,
      commandRunner,
    );
  if (!current) {
    return {
      ok: false,
      error: "implement_pr_sync_stale",
      message: "The base or feature branch changed after synchronization",
      next_action: "return_to_the_synchronization_boundary",
    };
  }
  return { ok: true, record, fetchedBaseSha, localSha };
}

async function createSynchronizedImplementPr({
  repoRoot,
  repoAuthorization,
  repoSlug,
  baseBranch,
  input,
  record,
  fetchedBaseSha,
  localSha,
  commandRunner,
}) {
  const created = await ghRestJson(
    repoRoot,
    `/repos/${repoAuthorization.owner}/${repoAuthorization.name}/pulls`,
    {
      method: "POST",
      fields: { base: baseBranch, head: input.branchName, title: input.title, body: input.body },
      execFile: commandRunner,
    },
  );
  const prUrl = typeof created?.html_url === "string" ? created.html_url : "";
  const expectedUrlPrefix =
    `https://github.com/${repoAuthorization.owner}/${repoAuthorization.name}/pull/`.toLowerCase();
  if (!prUrl.toLowerCase().startsWith(expectedUrlPrefix)) {
    return {
      ok: false,
      error: "implement_pr_created_repository_mismatch",
      message: "GitHub returned a PR outside the authorized repository",
      next_action: "inspect_the_repository_scoped_pr_write",
    };
  }
  return {
    ok: true,
    already_exists: false,
    pr_number: Number.isInteger(created?.number) ? created.number : null,
    pr_url: prUrl,
    synchronization_record_id: record.recordId,
    fetched_base_sha: fetchedBaseSha,
    feature_sha: localSha,
  };
}

// GitHub auto-close keywords, per its "closing issues via keywords" docs. Case-
// insensitive, immediately preceding the issue reference. A requirement-backed issue
// must not carry any of these for its own number in the PR body (issue #1541).
function bodyAutoClosesIssue(body, issueNumber) {
  if (typeof body !== "string") return false;
  return new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]+#${issueNumber}\b`, "i").test(body);
}

// The PR body's issue reference is bound to the AUTHORITATIVE issue scope — the issue's
// Requirements section — not to a caller hint. A requirement-backed issue must use a
// non-closing reference (`Refs #n`) so GitHub cannot auto-close it at merge ahead of
// Phase E's merged-requirement-state validation (issue #1541 review).
async function assertPrBodyClosingKeywordBoundToIssueScope(input, issueThreadReader) {
  let scope = [];
  try {
    const thread = await issueThreadReader({ repoPath: input.repoPath, issueNumber: input.issueNumber });
    if (thread?.ok) scope = extractInScopeRequirementUids(thread.body ?? "");
  } catch {
    // Authoritative scope must be readable to bind the keyword; fail closed below.
    return {
      ok: false,
      error: "implement_pr_issue_scope_unresolved",
      message: `could not read issue #${input.issueNumber}'s Requirements section to bind the PR-body issue reference`,
      next_action: "repair_issue_access_and_retry",
    };
  }
  if (scope.length > 0 && bodyAutoClosesIssue(input.body, input.issueNumber)) {
    return {
      ok: false,
      error: "implement_pr_auto_close_forbidden",
      message:
        `issue #${input.issueNumber} is requirement-backed (${scope.length} in-scope UID(s)), so the PR body must use a ` +
        `non-closing reference (Refs #${input.issueNumber}); a closing keyword would let GitHub auto-close the issue at ` +
        "merge ahead of Phase E merged-requirement-state validation (issue #1541)",
      next_action: "render_the_pr_body_with_a_non_closing_reference_and_retry",
    };
  }
  return { ok: true };
}
export async function runCreateSynchronizedImplementPr(input, {
  workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
  commandRunner = execFile,
  contextResolver = getRepoGroundControlContext,
  syncRecordReader = readTrustedImplementSyncRecord,
  issueThreadReader = (args) => runGetIssueThread(args, { workspaceAuthorizationResolver }),
} = {}) {
  const inputValidation = validateSynchronizedImplementPrInput(input);
  if (!inputValidation.ok) return inputValidation;
  let repoRoot;
  let context;
  try {
    repoRoot = realpathSync(await ensureGitRepo(input.repoPath));
    context = await contextResolver(repoRoot);
  } catch (error) {
    return { ok: false, error: "implement_pr_context_failed", message: error.message };
  }
  if (context?.status !== "ok") {
    return {
      ok: false,
      error: "implement_pr_context_invalid",
      message: "The repository Ground Control context is invalid",
      next_action: "repair_ground_control_configuration_and_retry",
    };
  }
  const repoAuthorization = await authorizeImplementRepoRoot(
    repoRoot,
    workspaceAuthorizationResolver,
  );
  if (!repoAuthorization.ok) return repoAuthorization;
  const baseBranch = context?.workflow?.base_branch ?? "dev";
  const titleValidation = validateImplementPrTitle(input.title, context?.workflow?.pr_title);
  if (!titleValidation.ok) {
    return {
      ok: false,
      error: "implement_pr_title_invalid",
      message: titleValidation.message,
      next_action: "reshape_the_title_and_retry",
    };
  }
  const closingBinding = await assertPrBodyClosingKeywordBoundToIssueScope(input, issueThreadReader);
  if (!closingBinding.ok) return closingBinding;
  try {
    const synchronization = await validateImplementSynchronization({
      repoRoot,
      repoAuthorization,
      baseBranch,
      input,
      commandRunner,
      syncRecordReader,
    });
    if (!synchronization.ok) return synchronization;
    const { record, fetchedBaseSha, localSha } = synchronization;
    const existingLookup = await findExistingSynchronizedImplementPr({
      repoRoot,
      repoAuthorization,
      baseBranch,
      input,
      localSha,
      commandRunner,
    });
    if (!existingLookup.ok) return existingLookup;
    if (existingLookup.candidate) {
      return {
        ok: true,
        already_exists: true,
        pr_number: existingLookup.candidate.number,
        pr_url: existingLookup.candidate.url,
        synchronization_record_id: record.recordId,
      };
    }
    const { repoSlug } = existingLookup;
    return await createSynchronizedImplementPr({
      repoRoot,
      repoAuthorization,
      repoSlug,
      baseBranch,
      input,
      record,
      fetchedBaseSha,
      localSha,
      commandRunner,
    });
  } catch (error) {
    return {
      ok: false,
      error: "implement_pr_create_failed",
      message: extractGhErrorMessage(error),
      next_action: "repair_the_refused_condition_and_retry_without_bypassing_the_sync_gate",
    };
  }
}
export async function resolveReviewerPrePushCap(repoPath, blockName, moduleDefault) {
  let ctx;
  try {
    ctx = await getRepoGroundControlContext(repoPath);
  } catch {
    // Hard IO / fs error reading the file — soft-fall back. This branch
    // covers cases like the repo path going away mid-run; it does NOT cover
    // schema validation failures, which surface as a structured `status:
    // "invalid_ground_control_yaml"` return rather than a thrown error.
    return moduleDefault;
  }
  // Legitimate absence — no cfg file or schema-clean cfg with no override
  // for this block / key. Use the module default.
  if (!ctx || ctx.status === "missing_ground_control_yaml") return moduleDefault;
  // Cfg is present but failed schema validation. The validator in
  // normalizeReviewerConfig rejects out-of-bounds / non-integer / unknown
  // keys; surfacing the error here preserves that strictness for the
  // resolver path. A silent fall-back would mask a mistyped knob.
  if (ctx.status === "invalid_ground_control_yaml") {
    throw new ReviewerCapConfigError(blockName, ctx.errors);
  }
  const block = ctx?.workflow?.[blockName];
  if (block && typeof block.pre_push_cap === "number" && Number.isInteger(block.pre_push_cap)) {
    return block.pre_push_cap;
  }
  return moduleDefault;
}
export async function runSingleClaudeTestQualityReview({
  repoRoot,
  prompt,
  model = TEST_QUALITY_REVIEW_DEFAULT_MODEL,
  schema = TEST_QUALITY_REVIEW_FINDINGS_SCHEMA,
  timeoutMs = TEST_QUALITY_REVIEW_TIMEOUT_MS,
  signal = undefined,
}) {
  const args = [
    "--print",
    "--model",
    model,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--add-dir",
    repoRoot,
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "Read Glob Grep",
  ];
  const childEnv = reviewEngineEnv();
  const { stdout } = await execFileWithInput("claude", args, {
    input: prompt,
    cwd: repoRoot,
    env: childEnv,
    maxBuffer: 10 * 1024 * 1024,
    timeoutMs,
    signal,
  });
  return stdout;
}
