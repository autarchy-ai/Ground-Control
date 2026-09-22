// Trusted pre-merge delivery handoff records (issue #1671).
//
// Phase D records everything Phase E needs, so the agent can terminate at a ready pull
// request and the merge event alone can finish the workflow. Two records are written:
//
//   * the ISSUE-thread readiness record — the authority. It carries the exact normalized
//     completion payload the finalizer replays, bound to one issue, one pull request, and
//     the pull-request head OID whose required hosted checks readiness verified.
//   * the PR-thread pointer — discovery only. A merge event carries a pull-request number,
//     and scanning a repository for a matching issue comment is neither cheap nor
//     deterministic. Pull-request title, body, labels, branch name, and closing keywords
//     confer no authority; the pointer only says which issue to go read.
//
// The payload is serialized with every hyphen rewritten to its Unicode escape form. JSON
// parses that escape back to a hyphen, so the record stays readable while an HTML-comment
// terminator is unrepresentable inside it — a payload can never break out of its marker.

import { createHash } from "node:crypto";
import { detectSensitiveBodyContent, extractGhErrorMessage } from "./grc-legacy-compat-2.js";
import { readIssueCommentsWithAuthors, resolveExecutionObligationTrust } from "./grc-legacy-compat-3.js";
import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { mapCompletion } from "./completion-mapping.js";
import { validateFinalReportInput } from "./plan-posting.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX } from "./repo-vocabulary.js";
import { execFile } from "./runtime-primitives.js";

export const DELIVERY_READINESS_VERSION = 1;
export const DELIVERY_LANES = Object.freeze(["implement", "quickfix"]);
// Bounded before parsing, so a hostile or corrupted comment cannot make the executor
// parse an unbounded string. Well under the 65,535-byte comment ceiling, which the
// rendered record as a whole must also respect.
export const DELIVERY_PAYLOAD_MAX = 48000;

const FULL_GIT_OID_RE = /^[0-9a-f]{40}$/;
const READINESS_RE = /<!--\s*gc:delivery-readiness\s+([^\n]*?)\s*\n([\s\S]*?)\n\s*-->/g;
const POINTER_RE = /<!--\s*gc:delivery-pointer\s+([^\n>]*?)\s*-->/g;
const ATTRIBUTE_RE = /([a-z]+)="([^"]*)"/g;

function attributes(text) {
  const out = {};
  for (const [, key, value] of text.matchAll(ATTRIBUTE_RE)) out[key] = value;
  return out;
}

function asInt(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function encodeDeliveryPayload(payload) {
  return JSON.stringify(payload).replaceAll("-", String.raw`\u002d`);
}

export function buildDeliveryReadinessRecord({ issueNumber, prNumber, lane, headSha, payload }) {
  const payloadText = encodeDeliveryPayload(payload);
  const digest = createHash("sha256").update(payloadText, "utf8").digest("hex");
  return [
    `**Delivery readiness recorded** — Phase E finalizes issue #${issueNumber} automatically when PR #${prNumber} merges.`,
    "",
    `<!-- gc:delivery-readiness version="${DELIVERY_READINESS_VERSION}" issue="${issueNumber}" `
      + `pr="${prNumber}" lane="${lane}" head="${headSha}" digest="${digest}"`,
    payloadText,
    "-->",
  ].join("\n");
}

export function buildDeliveryPointerRecord({ issueNumber, prNumber, recordCommentId }) {
  return [
    `**Ground Control delivery** — this pull request delivers issue #${issueNumber}; Phase E runs on merge.`,
    "",
    `<!-- gc:delivery-pointer issue="${issueNumber}" pr="${prNumber}" record="${recordCommentId}" -->`,
  ].join("\n");
}

export function parseDeliveryReadinessMarkers(body) {
  if (typeof body !== "string") return [];
  const found = [];
  for (const [, attrText, payloadText] of body.matchAll(READINESS_RE)) {
    const attrs = attributes(attrText);
    found.push({
      version: asInt(attrs.version),
      issue: asInt(attrs.issue),
      pr: asInt(attrs.pr),
      lane: attrs.lane ?? null,
      head: attrs.head ?? null,
      digest: attrs.digest ?? null,
      payloadText,
    });
  }
  return found;
}

export function parseDeliveryPointerMarkers(body) {
  if (typeof body !== "string") return [];
  const found = [];
  for (const [, attrText] of body.matchAll(POINTER_RE)) {
    const attrs = attributes(attrText);
    found.push({ issue: asInt(attrs.issue), pr: asInt(attrs.pr), record: asInt(attrs.record) });
  }
  return found;
}

function refusal(error, message) {
  return { ok: false, error, message };
}

// Every readiness marker on the thread that names this exact issue and pull request.
// Comments larger than GitHub can store are not parsed at all.
function collectReadinessMarkers(comments, issueNumber, prNumber) {
  const found = [];
  for (const comment of comments) {
    if (typeof comment.body !== "string" || comment.body.length > GITHUB_ISSUE_COMMENT_BODY_MAX) continue;
    for (const marker of parseDeliveryReadinessMarkers(comment.body)) {
      if (marker.issue === issueNumber && marker.pr === prNumber) found.push({ comment, marker });
    }
  }
  return found;
}

// Decode one marker into its payload, or null when the record is not self-consistent.
// Bounds come before parsing on purpose.
function decodeRecord(marker) {
  if (typeof marker.payloadText !== "string" || marker.payloadText.length > DELIVERY_PAYLOAD_MAX) return null;
  if (typeof marker.digest !== "string" || !/^[0-9a-f]{64}$/.test(marker.digest)) return null;
  const digest = createHash("sha256").update(marker.payloadText, "utf8").digest("hex");
  if (digest !== marker.digest) return null;
  if (typeof marker.head !== "string" || !FULL_GIT_OID_RE.test(marker.head)) return null;
  if (!DELIVERY_LANES.includes(marker.lane)) return null;
  let payload;
  try {
    payload = JSON.parse(marker.payloadText);
  } catch {
    return null;
  }
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return { ...marker, payload };
}

/**
 * The trusted readiness record for one merged pull request, or a structured refusal.
 *
 * Trust is repository write permission on the comment author — the same resolver every
 * other durable workflow record uses. The repository's own automation identity is
 * deliberately NOT accepted here: this record is what authorizes automated finalization,
 * so letting automation write it would close the loop on itself.
 */
export async function readTrustedDeliveryReadiness(
  { repoRoot, owner, name, issueNumber, prNumber, headSha },
  { readComments = readIssueCommentsWithAuthors, resolveTrust = resolveExecutionObligationTrust } = {},
) {
  let comments;
  try {
    comments = await readComments(repoRoot, owner, name, issueNumber);
  } catch (error) {
    return refusal("delivery_readiness_unreadable", extractGhErrorMessage(error));
  }
  const matching = collectReadinessMarkers(comments, issueNumber, prNumber);
  if (matching.length === 0) {
    return refusal(
      "delivery_readiness_missing",
      `no delivery-readiness record binds issue #${issueNumber} to PR #${prNumber}`,
    );
  }
  const trust = await resolveTrust(repoRoot, owner, name, comments);
  const trusted = matching.filter(({ comment }) => trust.isTrusted(comment));
  if (trusted.length === 0) {
    return refusal(
      "delivery_readiness_untrusted",
      `every delivery-readiness record for PR #${prNumber} was authored outside the repository's write set`,
    );
  }
  const supported = trusted.filter(({ marker }) => marker.version === DELIVERY_READINESS_VERSION);
  if (supported.length === 0) {
    return refusal(
      "delivery_readiness_version_unsupported",
      `delivery-readiness envelope version is not ${DELIVERY_READINESS_VERSION}; refusing to guess its shape`,
    );
  }
  const decoded = supported
    .map(({ comment, marker }) => ({ commentId: comment.id, record: decodeRecord(marker) }))
    .filter((entry) => entry.record !== null);
  if (decoded.length === 0) {
    return refusal(
      "delivery_readiness_corrupt",
      `no delivery-readiness record for PR #${prNumber} passed its digest, bound, and shape checks`,
    );
  }
  const atHead = decoded.filter(({ record }) => record.head === headSha);
  if (atHead.length === 0) {
    return refusal(
      "delivery_readiness_head_mismatch",
      `delivery-readiness for PR #${prNumber} was recorded against a different head than the merged one`,
    );
  }
  const digests = new Set(atHead.map(({ record }) => record.digest));
  if (digests.size > 1) {
    return refusal(
      "delivery_readiness_conflicting",
      `PR #${prNumber} carries ${digests.size} disagreeing delivery-readiness records for its merged head`,
    );
  }
  const chosen = atHead.at(-1);
  return { ok: true, record: { ...chosen.record, commentId: chosen.commentId } };
}

/** The trusted issue pointer for a merged pull request, or a structured refusal. */
export async function readTrustedDeliveryPointer(
  { repoRoot, owner, name, prNumber },
  { readComments = readIssueCommentsWithAuthors, resolveTrust = resolveExecutionObligationTrust } = {},
) {
  let comments;
  try {
    comments = await readComments(repoRoot, owner, name, prNumber);
  } catch (error) {
    return refusal("delivery_pointer_unreadable", extractGhErrorMessage(error));
  }
  const matching = [];
  for (const comment of comments) {
    for (const marker of parseDeliveryPointerMarkers(comment.body)) {
      if (marker.pr === prNumber && marker.issue != null) matching.push({ comment, marker });
    }
  }
  if (matching.length === 0) {
    return refusal("delivery_pointer_missing", `PR #${prNumber} carries no Ground Control delivery pointer`);
  }
  const trust = await resolveTrust(repoRoot, owner, name, comments);
  const trusted = matching.filter(({ comment }) => trust.isTrusted(comment));
  if (trusted.length === 0) {
    return refusal(
      "delivery_pointer_untrusted",
      `every delivery pointer on PR #${prNumber} was authored outside the repository's write set`,
    );
  }
  const issues = new Set(trusted.map(({ marker }) => marker.issue));
  if (issues.size > 1) {
    return refusal(
      "delivery_pointer_conflicting",
      `PR #${prNumber} points at ${issues.size} different issues; refusing to choose one`,
    );
  }
  return { ok: true, pointer: trusted.at(-1).marker };
}

async function postComment(repoRoot, owner, name, number, body) {
  const { stdout } = await execFile(
    "gh",
    ["api", "--method", "POST", `/repos/${owner}/${name}/issues/${number}/comments`, "-f", `body=${body}`],
    { cwd: repoRoot },
  );
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Write the Phase D handoff: the authoritative issue record, then the discovery pointer.
 *
 * The payload is validated by the same gate the final report uses, so a payload that
 * could never produce a final report is refused now rather than after the merge, when no
 * agent is left to repair it.
 */
export async function runRecordDeliveryReadiness(
  { repoPath, issueNumber, prNumber, lane = "implement", headSha, payload },
  { workspaceAuthorizationResolver = undefined } = {},
) {
  if (!DELIVERY_LANES.includes(lane)) {
    return refusal("delivery_readiness_lane_invalid", `lane must be one of ${DELIVERY_LANES.join(", ")}`);
  }
  if (typeof headSha !== "string" || !FULL_GIT_OID_RE.test(headSha)) {
    return refusal("delivery_readiness_head_invalid", "headSha must be the pull request's full 40-character head OID");
  }
  // Validate exactly what gets stored, through the same mapping the finalizer will apply
  // on replay: a payload that could never produce a final report is refused now, while an
  // agent is still here to repair it, rather than after the merge when none is.
  const validation = validateFinalReportInput(
    mapCompletion({ repoPath, issueNumber, prNumber, lane, completion: payload }, "pre_merge"),
  );
  if (!validation.ok) {
    return refusal("delivery_readiness_payload_invalid", validation.errors.join("; "));
  }
  const body = buildDeliveryReadinessRecord({ issueNumber, prNumber, lane, headSha, payload });
  if (body.length > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return refusal("delivery_readiness_payload_too_large", "the rendered readiness record exceeds GitHub's comment size limit");
  }
  const sensitive = detectSensitiveBodyContent(body);
  if (sensitive) return refusal("delivery_readiness_sensitive_content", sensitive);

  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    return issueRepositoryNotAuthorized("delivery_readiness", repository, { issue_number: issueNumber });
  }
  const { repoRoot, owner, name } = repository;
  let recordComment;
  try {
    recordComment = await postComment(repoRoot, owner, name, issueNumber, body);
  } catch (error) {
    return refusal("delivery_readiness_post_failed", extractGhErrorMessage(error));
  }
  const recordCommentId = recordComment && Number.isInteger(recordComment.id) ? recordComment.id : null;
  try {
    await postComment(
      repoRoot,
      owner,
      name,
      prNumber,
      buildDeliveryPointerRecord({ issueNumber, prNumber, recordCommentId }),
    );
  } catch (error) {
    return refusal("delivery_pointer_post_failed", extractGhErrorMessage(error));
  }
  return {
    ok: true,
    issue_number: issueNumber,
    pr_number: prNumber,
    lane,
    head_sha: headSha,
    record_comment_id: recordCommentId,
    record_comment_url: recordComment?.html_url ?? null,
  };
}
