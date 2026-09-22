// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { EXECUTION_OBLIGATION_ID_RE, buildExecutionObligationAuthorizationMarker, isExactWontfixAuthorizationCommand, parseIssueCommentUrl } from "./codex-workflow.js";
import { extractGhErrorMessage, validateFinding } from "./grc-legacy-compat-2.js";
import { readIssueCommentsWithAuthors, resolveExecutionObligationTrust } from "./grc-legacy-compat-3.js";
import { authorizeImplementRepoRoot, ensureGitRepo, resolveMcpLaunchWorkspaceAuthorization } from "./grc-legacy-compat-4.js";
import { CODEX_REVIEW_TAIL_RE, REVIEW_NOTE_TEXT_MAX, checkVerdictBlockingConsistency, truncateReviewProse } from "./grc-legacy-compat.js";
import { REVIEW_NOTES_MAX, REVIEW_VERDICTS } from "./codex-review-prompt.js";
import { execFile } from "./runtime-primitives.js";

// Prompt construction moved to codex-review-prompt.js (#1557, 500-line limit);
// re-exported here so every existing importer of this module is unchanged.
export {
  REVIEW_NOTES_MAX,
  REVIEW_VERDICTS,
  buildCodexReviewCorePrompt,
  buildCodexSecurityReviewPrompt,
  buildPrincipalEngineerRubric,
  buildVocabularySection,
} from "./codex-review-prompt.js";

export function parseCodexReviewEnvelopeTail(stdout, repoRoot) {
  if (typeof stdout !== "string") {
    throw new Error("Codex review output was not a string");
  }
  const match = stdout.match(CODEX_REVIEW_TAIL_RE);
  if (!match) {
    throw new Error(
      "Codex review did not emit a ===REVIEW===…===END=== block. The prompt requires this structured tail for machine parsing.",
    );
  }
  const inner = match[1];
  let parsed;
  try {
    parsed = JSON.parse(inner);
  } catch (err) {
    throw new Error(`Codex review REVIEW block was not valid JSON: ${err.message}`);
  }
  const envelope = validateReviewEnvelope(parsed, repoRoot);
  // Strip the tail block (and any trailing whitespace) from the body so the
  // caller can log/echo `body` without duplicating the machine-readable
  // section. The match index gives us exactly where the block starts.
  const body = stdout.slice(0, stdout.indexOf(match[0])).replace(/\s+$/, "");
  return { envelope, body };
}
export function parseCodexReviewFindingsTail(stdout, repoRoot) {
  const { envelope, body } = parseCodexReviewEnvelopeTail(stdout, repoRoot);
  return { findings: envelope.blocking, body, envelope };
}
export function validateReviewEnvelope(raw, repoRoot) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Codex review envelope must be a JSON object; got ${Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }
  if (typeof raw.architectural_read !== "string" || raw.architectural_read.trim() === "") {
    throw new Error(
      "Codex review envelope is missing required field 'architectural_read' (must be a non-empty string written before any findings)",
    );
  }
  if (!REVIEW_VERDICTS.includes(raw.verdict)) {
    throw new Error(
      `Codex review envelope has invalid 'verdict' (must be one of: ${REVIEW_VERDICTS.join(", ")}, got ${JSON.stringify(raw.verdict)})`,
    );
  }
  if (!Array.isArray(raw.blocking)) {
    throw new Error("Codex review envelope is missing required field 'blocking' (must be an array, may be empty)");
  }
  const blocking = raw.blocking.map((entry, idx) => validateFinding(entry, idx, repoRoot));
  // notes is optional; treat absent as empty.
  let notes = [];
  if (raw.notes != null) {
    if (!Array.isArray(raw.notes)) {
      throw new Error("Codex review envelope 'notes' must be an array when set");
    }
    if (raw.notes.length > REVIEW_NOTES_MAX) {
      throw new Error(
        `Codex review envelope 'notes' exceeds the workflow cap of ${REVIEW_NOTES_MAX} (got ${raw.notes.length}). The cap forces ranking; omit lower-value notes.`,
      );
    }
    notes = raw.notes.map((entry, idx) => {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`notes[${idx}] must be an object {text}`);
      }
      if (typeof entry.text !== "string" || entry.text.trim() === "") {
        throw new Error(`notes[${idx}].text must be a non-empty string`);
      }
      return { text: truncateReviewProse(entry.text, REVIEW_NOTE_TEXT_MAX) };
    });
  }
  // Verdict / blocking consistency rules — shared with the decision-record
  // and other verdict-envelope parsers (#931 codex cycle-1 F1).
  const errs = checkVerdictBlockingConsistency({
    verdict: raw.verdict,
    blocking,
    blockingHasStructural: (f) => f.classification === "class" || f.structural_blocker === true,
  });
  if (errs.length) throw new Error(errs[0]);
  return {
    verdict: raw.verdict,
    architectural_read: raw.architectural_read.trim(),
    blocking,
    notes,
  };
}
export async function runAuthorizeExecutionObligationWontfix(input, {
  workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
} = {}) {
  if (
    input == null
    || !Number.isInteger(input.issueNumber)
    || input.issueNumber <= 0
    || typeof input.obligationId !== "string"
    || !EXECUTION_OBLIGATION_ID_RE.test(input.obligationId)
  ) {
    return {
      ok: false,
      error: "execution_obligation_authorization_input_invalid",
      message: "issueNumber and a valid obligationId are required",
    };
  }
  const sourceReference = parseIssueCommentUrl(input.authorizationSourceUrl);
  if (sourceReference == null) {
    return {
      ok: false,
      error: "execution_obligation_authorization_input_invalid",
      message: "authorizationSourceUrl must be a durable GitHub issue-comment URL",
    };
  }
  const repoRoot = await ensureGitRepo(input.repoPath);
  const repoAuthorization = await authorizeImplementRepoRoot(
    repoRoot,
    workspaceAuthorizationResolver,
  );
  if (!repoAuthorization.ok) return repoAuthorization;
  const { owner, name } = repoAuthorization;
  if (
    sourceReference.owner.toLowerCase() !== owner.toLowerCase()
    || sourceReference.name.toLowerCase() !== name.toLowerCase()
    || sourceReference.issueNumber !== input.issueNumber
  ) {
    return {
      ok: false,
      error: "execution_obligation_authorization_unverifiable",
      message: "The authorization source must reference this repository and issue",
    };
  }
  const comments = await readIssueCommentsWithAuthors(
    repoRoot,
    owner,
    name,
    input.issueNumber,
  );
  const trust = await resolveExecutionObligationTrust(
    repoRoot,
    owner,
    name,
    comments,
  );
  const source = comments.find((comment) => comment.id === sourceReference.commentId);
  if (
    source == null
    || !trust.isTrusted(source)
    || !isExactWontfixAuthorizationCommand(source.body, input.obligationId)
  ) {
    return {
      ok: false,
      error: "execution_obligation_authorization_unverifiable",
      message:
        `The source must be an exact '/ground-control authorize-wontfix ${input.obligationId}' command from a repository writer`,
    };
  }
  const marker = buildExecutionObligationAuthorizationMarker({
    issueNumber: input.issueNumber,
    obligationId: input.obligationId,
    sourceCommentId: source.id,
  });
  const body = [
    marker,
    "",
    `Authorized wontfix for execution obligation ${input.obligationId}.`,
    "",
    `Source: ${input.authorizationSourceUrl}`,
  ].join("\n");
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
      authorization_comment_url: response?.html_url ?? null,
      authorization_comment_id: response?.id ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      error: "execution_obligation_authorization_post_failed",
      message: extractGhErrorMessage(error),
    };
  }
}
