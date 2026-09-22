// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { dedupFindings } from "./api-controls.js";
import { validateExecutionObligationInput } from "./codex-review.js";
import { parseIssueCommentUrl, validateImplementBranchName } from "./codex-workflow.js";
import { detectSensitiveBodyContent, extractGhErrorMessage } from "./grc-legacy-compat-2.js";
import { buildExecutionObligationBody, hasVerifiedStructuredWontfixAuthorization, readIssueCommentsWithAuthors, resolveExecutionObligationTrust } from "./grc-legacy-compat-3.js";
import { authorizeImplementRepoRoot, ensureGitRepo, readTrustedExecutionObligationState, resolveMcpLaunchWorkspaceAuthorization, runSingleCodexReview } from "./grc-legacy-compat-4.js";
import { REVIEW_NOTES_MAX, parseCodexReviewFindingsTail } from "./grc-legacy-compat-5.js";
import { IMPLEMENT_IN_PROGRESS_LABEL } from "./constants.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX, rejectReservedMarkerSequence } from "./repo-vocabulary.js";
import { execFile, formatCommandFailure } from "./runtime-primitives.js";

export async function runMarkImplementIssuePickedUp(input, {
  workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
  now = () => new Date(),
} = {}) {
  if (
    input == null
    || !Number.isInteger(input.issueNumber)
    || input.issueNumber <= 0
    || typeof input.driver !== "string"
    || !/^[a-z0-9._-]{1,40}$/i.test(input.driver)
    || (input.lane != null && input.lane !== "implement" && input.lane !== "quickfix")
  ) {
    return {
      ok: false,
      error: "implement_pickup_input_invalid",
      message: "issueNumber and a simple 1-40 character driver identifier are required",
    };
  }
  const branchValidation = validateImplementBranchName(input.branchName, input.issueNumber);
  if (!branchValidation.ok) return branchValidation;
  const lane = input.lane === "quickfix" ? "quickfix" : "implement";
  const repoRoot = await ensureGitRepo(input.repoPath);
  const repoAuthorization = await authorizeImplementRepoRoot(
    repoRoot,
    workspaceAuthorizationResolver,
  );
  if (!repoAuthorization.ok) return repoAuthorization;
  const { owner, name } = repoAuthorization;
  const labelPath = `/repos/${owner}/${name}/labels/${IMPLEMENT_IN_PROGRESS_LABEL}`;
  try {
    await execFile("gh", ["api", "--method", "GET", labelPath], { cwd: repoRoot });
  } catch (error) {
    const message = extractGhErrorMessage(error);
    if (!/\b404\b|not found/i.test(message)) {
      return { ok: false, error: "implement_pickup_label_read_failed", message };
    }
    try {
      await execFile(
        "gh",
        [
          "api",
          "--method",
          "POST",
          `/repos/${owner}/${name}/labels`,
          "-f",
          `name=${IMPLEMENT_IN_PROGRESS_LABEL}`,
          "-f",
          "color=FBCA04",
          "-f",
          "description=An agent is actively working this issue through Ground Control",
        ],
        { cwd: repoRoot },
      );
    } catch (createError) {
      return {
        ok: false,
        error: "implement_pickup_label_create_failed",
        message: extractGhErrorMessage(createError),
      };
    }
  }
  try {
    await execFile(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `/repos/${owner}/${name}/issues/${input.issueNumber}/labels`,
        "-f",
        `labels[]=${IMPLEMENT_IN_PROGRESS_LABEL}`,
      ],
      { cwd: repoRoot },
    );
  } catch (error) {
    return {
      ok: false,
      error: "implement_pickup_label_apply_failed",
      message: extractGhErrorMessage(error),
    };
  }
  const body =
    `🛠️ Picked up by /${lane} - driver ${input.driver}, branch ` +
    `\`${input.branchName}\`, ${now().toISOString()}.`;
  try {
    const { stdout } = await execFile(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `/repos/${owner}/${name}/issues/${input.issueNumber}/comments`,
        "-f",
        `body=${body}`,
      ],
      { cwd: repoRoot },
    );
    const response = JSON.parse(stdout);
    return {
      ok: true,
      issue_number: input.issueNumber,
      branch: input.branchName,
      label: IMPLEMENT_IN_PROGRESS_LABEL,
      comment_url: response?.html_url ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      error: "implement_pickup_comment_failed",
      message: extractGhErrorMessage(error),
    };
  }
}
export async function runRecordExecutionObligation(input, {
  workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
} = {}) {
  const validation = validateExecutionObligationInput(input);
  if (!validation.ok) {
    return {
      ok: false,
      error: "execution_obligation_input_invalid",
      message: validation.errors.join("; "),
      issue_number: input?.issueNumber ?? null,
    };
  }
  const callerText = [
    input.observedState,
    input.impact,
    input.obligation,
    input.decisionRequest,
    input.correctiveAction,
    input.userAuthorization,
    ...(input.evidence || []),
    ...(input.verification || []),
  ].filter((value) => typeof value === "string");
  for (const [index, value] of callerText.entries()) {
    const markerError = rejectReservedMarkerSequence(value, `caller_text[${index}]`);
    if (markerError) {
      return {
        ok: false,
        error: "execution_obligation_reserved_marker",
        message: markerError,
        issue_number: input.issueNumber,
      };
    }
  }
  const body = buildExecutionObligationBody(input);
  const sensitiveError = detectSensitiveBodyContent(body);
  if (sensitiveError) {
    return {
      ok: false,
      error: "execution_obligation_body_rejected",
      message: sensitiveError,
      issue_number: input.issueNumber,
    };
  }
  if (Buffer.byteLength(body, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return {
      ok: false,
      error: "execution_obligation_body_too_large",
      message: "Rendered execution-obligation record exceeds GitHub's issue-comment body limit",
      issue_number: input.issueNumber,
    };
  }
  const repoRoot = await ensureGitRepo(input.repoPath);
  const repoAuthorization = await authorizeImplementRepoRoot(
    repoRoot,
    workspaceAuthorizationResolver,
  );
  if (!repoAuthorization.ok) {
    return {
      ...repoAuthorization,
      error: repoAuthorization.error === "implement_repo_not_authorized"
        ? "execution_obligation_repo_not_authorized"
        : repoAuthorization.error,
      issue_number: input.issueNumber,
    };
  }
  const { owner, name } = repoAuthorization;
  if (input.event === "resolved" && input.disposition === "wontfix") {
    const authorizationReference = parseIssueCommentUrl(input.userAuthorization);
    if (
      authorizationReference == null
      || authorizationReference.owner.toLowerCase() !== owner.toLowerCase()
      || authorizationReference.name.toLowerCase() !== name.toLowerCase()
      || authorizationReference.issueNumber !== input.issueNumber
    ) {
      return {
        ok: false,
        error: "execution_obligation_authorization_unverifiable",
        message: "The wontfix authorization URL must reference this repository and issue",
        issue_number: input.issueNumber,
      };
    }
    const comments = await readIssueCommentsWithAuthors(
      repoRoot, owner, name, input.issueNumber,
    );
    const trust = await resolveExecutionObligationTrust(
      repoRoot,
      owner,
      name,
      comments,
    );
    const authorization = comments.find(
      (comment) => comment.id === authorizationReference.commentId,
    );
    if (
      authorization == null
      || !hasVerifiedStructuredWontfixAuthorization(
        authorization,
        comments,
        trust,
        input.issueNumber,
        input.obligationId,
      )
    ) {
      return {
        ok: false,
        error: "execution_obligation_authorization_unverifiable",
        message:
          "The referenced comment is not a structured wontfix authorization backed by an exact permission-checked source command",
        issue_number: input.issueNumber,
      };
    }
  }
  const state = await readTrustedExecutionObligationState(
    repoRoot, owner, name, input.issueNumber,
  );
  if (!state.ok) return { ...state, issue_number: input.issueNumber };
  const isOpen = state.open_obligation_ids.includes(input.obligationId);
  if (input.event === "opened" && isOpen) {
    return {
      ok: true,
      issue_number: input.issueNumber,
      obligation_id: input.obligationId,
      event: input.event,
      already_recorded: true,
    };
  }
  if (input.event !== "opened" && !isOpen) {
    return {
      ok: false,
      error: "execution_obligation_not_open",
      message: `Execution obligation '${input.obligationId}' is not open`,
      issue_number: input.issueNumber,
    };
  }
  try {
    const { stdout } = await execFile(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `/repos/${owner}/${name}/issues/${input.issueNumber}/comments`,
        "-f",
        `body=${body}`,
      ],
      { cwd: repoRoot },
    );
    const response = JSON.parse(stdout);
    return {
      ok: true,
      issue_number: input.issueNumber,
      obligation_id: input.obligationId,
      event: input.event,
      disposition: input.disposition ?? null,
      comment_url: response?.html_url ?? null,
      comment_id: response?.id ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      error: "execution_obligation_post_failed",
      message: extractGhErrorMessage(error),
      issue_number: input.issueNumber,
      next_action: "retry_after_resolving_gh_failure",
    };
  }
}
export function aggregateReviewSlices(sliceResults) {
  const results = Array.isArray(sliceResults) ? sliceResults : [];
  const total = results.length;
  const bodies = [];
  const reads = [];
  const blocking = [];
  const notes = [];
  let completed = 0;
  let sawDontShip = false;

  results.forEach((result, idx) => {
    const body = typeof result?.body === "string" ? result.body : "";
    if (body.trim() !== "") {
      bodies.push(total > 1 ? `### Slice ${idx + 1}/${total}\n\n${body.trim()}` : body);
    }
    const env = result?.envelope;
    if (!env || typeof env !== "object") return;
    completed += 1;
    const read = typeof env.architectural_read === "string" ? env.architectural_read.trim() : "";
    if (read !== "") reads.push(total > 1 ? `**Slice ${idx + 1}/${total}:** ${read}` : read);
    if (Array.isArray(env.blocking)) blocking.push(...env.blocking);
    if (Array.isArray(env.notes)) notes.push(...env.notes);
    if (env.verdict === "don't-ship") sawDontShip = true;
  });

  const body = bodies.join("\n\n");
  if (completed === 0) {
    return { envelope: null, findings: [], body, slices_total: total, slices_completed: 0 };
  }

  const merged = dedupFindings(blocking);
  const hasStructural = merged.some(
    (f) => f?.classification === "class" || f?.structural_blocker === true,
  );
  let verdict = "ship-with-fixes";
  if (merged.length === 0) verdict = "ship";
  else if (sawDontShip && hasStructural) verdict = "don't-ship";

  return {
    envelope: {
      verdict,
      architectural_read: reads.join("\n\n"),
      blocking: merged,
      notes: notes.slice(0, REVIEW_NOTES_MAX),
    },
    findings: merged,
    body,
    slices_total: total,
    slices_completed: completed,
  };
}
function parseSliceTailSafely(stdout, repoRoot, reviewer, slice, parseErrors) {
  try {
    return parseCodexReviewFindingsTail(stdout, repoRoot);
  } catch (error) {
    parseErrors.push({
      reviewer,
      ...(slice ? { slice: `${slice.index}/${slice.total}` } : {}),
      error: error.message,
    });
    return { findings: [], body: stdout, envelope: null };
  }
}
export async function runReviewerOverSlices({
  repoRoot,
  reviewerLabel,
  buildPrompt,
  promptArgs,
  slicePlan,
  parseErrors,
  signal,
}) {
  const total = slicePlan.slices.length;
  const sliceResults = [];
  for (let index = 0; index < total; index += 1) {
    const slice = total > 1 ? { index: index + 1, total } : null;
    const prompt = buildPrompt({ ...promptArgs, diffText: slicePlan.slices[index], slice });
    let stdout;
    try {
      stdout = await runSingleCodexReview({ repoRoot, prompt, signal });
    } catch (error) {
      // A slice engine failure is a coverage failure, not an exception: it must
      // reach the caller as the same structured no-write, no-cycle-consumed
      // envelope an unparseable reviewer tail produces. Throwing here escaped
      // that contract entirely (issue #1414 codex cycle 1, F2). Stop launching
      // further slices for this reviewer — coverage is already incomplete, so
      // the remaining codex runs would only burn time.
      parseErrors.push({
        reviewer: reviewerLabel,
        ...(slice ? { slice: `${slice.index}/${slice.total}` } : {}),
        error: `codex execution failed: ${formatCommandFailure("codex", error)}`,
      });
      break;
    }
    sliceResults.push(parseSliceTailSafely(stdout, repoRoot, reviewerLabel, slice, parseErrors));
  }
  // Slices never reached (an early break) stay absent, so slices_completed
  // reports fewer than chunks_total and the coverage gate fails closed.
  return aggregateReviewSlices(sliceResults);
}
