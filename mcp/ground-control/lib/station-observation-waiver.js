// Explicit user waiver of an unobserved review station (issue #1578).
//
// A station that never rendered a verdict leaves a `station_observation` obligation that blocks
// completion. When a repository writer decides the run may continue without that verdict, this is
// the one path that records it: the writer's exact command is the authority, and this server —
// the identity replay trusts for station records — posts the audit record that binds it to the
// named obligations. The record states that no verdict was produced; it never reports the review
// as completed, clean, or passed, and it dispositions no finding.

import { EXECUTION_OBLIGATION_ID_RE, parseIssueCommentUrl } from "./codex-workflow.js";
import {
  STATION_WAIVER_DISPOSITION,
  buildExecutionObligationV2Marker,
  buildStationWaiverCommand,
  parseStationWaiverCommand,
} from "./execution-obligation-v2.js";
import { detectSensitiveBodyContent, extractGhErrorMessage } from "./grc-legacy-compat-2.js";
import {
  getAuthenticatedGitHubLogin,
  readIssueCommentsWithAuthors,
  resolveExecutionObligationTrust,
} from "./grc-legacy-compat-3.js";
import {
  authorizeImplementRepoRoot,
  ensureGitRepo,
  readTrustedExecutionObligationState,
  resolveMcpLaunchWorkspaceAuthorization,
} from "./grc-legacy-compat-4.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX } from "./repo-vocabulary.js";
import { REVIEW_STATION_IDS } from "./review-reattempt.js";
import { execFile } from "./runtime-primitives.js";

export const STATION_WAIVER_MAX_OBLIGATIONS = 10;

function refuse(error, message, extra = {}) {
  return { ok: false, error, message, ...extra };
}

function validateWaiverInput(input) {
  const ids = input?.obligationIds;
  if (
    input == null
    || !Number.isSafeInteger(input.issueNumber)
    || input.issueNumber <= 0
    || !REVIEW_STATION_IDS.includes(input.stationId)
    || !Array.isArray(ids)
    || ids.length === 0
    || ids.length > STATION_WAIVER_MAX_OBLIGATIONS
    || new Set(ids).size !== ids.length
    || !ids.every((id) => typeof id === "string" && EXECUTION_OBLIGATION_ID_RE.test(id))
  ) {
    return refuse(
      "station_waiver_input_invalid",
      `issueNumber, a registered stationId (${REVIEW_STATION_IDS.join(", ")}), and 1-` +
      `${STATION_WAIVER_MAX_OBLIGATIONS} distinct valid obligationIds are required`,
    );
  }
  if (parseIssueCommentUrl(input.authorizationSourceUrl) == null) {
    return refuse(
      "station_waiver_input_invalid",
      "authorizationSourceUrl must be a durable GitHub issue-comment URL",
    );
  }
  return null;
}

/**
 * Check every named obligation against the trusted ledger.
 *
 * Returns the ids still to waive, or a refusal. An id already waived by this same command is a
 * replay and needs nothing; any other state — absent, a problem obligation, another station, or
 * closed some other way — is outside what the command can authorize.
 */
function classifyTargets(state, input, sourceCommentId) {
  const toWaive = [];
  for (const id of input.obligationIds) {
    const obligation = state.obligations.find((o) => o.obligation_id === id);
    const isStationTarget = obligation?.kind === "station_observation"
      && obligation.station === input.stationId;
    if (isStationTarget && obligation.status === "open") {
      toWaive.push(obligation);
      continue;
    }
    const alreadyWaived = isStationTarget
      && obligation.disposition === STATION_WAIVER_DISPOSITION
      && obligation.resolution?.authorization_comment_id === sourceCommentId;
    if (!alreadyWaived) {
      return refuse(
        "station_waiver_obligation_not_open",
        `'${id}' is not an open ${input.stationId} station-observation obligation on this issue`,
        { obligation_id: id },
      );
    }
  }
  return { toWaive };
}

function buildWaiverBody({ issueNumber, stationId, obligations, source }) {
  const markers = obligations.map((o) => buildExecutionObligationV2Marker({
    issueNumber,
    obligationId: o.obligation_id,
    event: "resolved",
    kind: "station_observation",
    stationId,
    logicalCycle: o.cycle,
    disposition: STATION_WAIVER_DISPOSITION,
    authorizationCommentId: source.id,
  }));
  return [
    ...markers,
    "",
    `## Station observation — \`${stationId}\` — Waived`,
    "",
    "**Disposition:** waived  ",
    "**Verdict:** none. This station rendered no verdict for the obligations below; it did not",
    "complete and is not reported as clean or passed.  ",
    `**Authorized by:** \`${source.authorLogin}\` — ${source.url}  `,
    "",
    ...obligations.map((o) => `- \`${o.obligation_id}\` (cycle ${o.cycle})`),
    "",
    "The waiver authorizes continuing without this observation. It dispositions no finding, and",
    "CI, SonarCloud, and every other gate still apply.",
  ].join("\n");
}

async function postWaiver(repoRoot, owner, name, issueNumber, body) {
  const sensitive = detectSensitiveBodyContent(body);
  if (sensitive) return refuse("station_waiver_body_rejected", sensitive);
  if (Buffer.byteLength(body, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return refuse("station_waiver_body_too_large", "Waiver record exceeds the issue-comment cap");
  }
  try {
    const { stdout } = await execFile(
      "gh",
      ["api", "--method", "POST", `/repos/${owner}/${name}/issues/${issueNumber}/comments`, "-f", `body=${body}`],
      { cwd: repoRoot },
    );
    const response = JSON.parse(stdout);
    return { ok: true, url: response?.html_url ?? null, id: response?.id ?? null };
  } catch (error) {
    return refuse("station_waiver_post_failed", extractGhErrorMessage(error), {
      next_action: "retry_after_resolving_gh_failure",
    });
  }
}

export async function runWaiveStationObservation(input, {
  workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
} = {}) {
  const invalid = validateWaiverInput(input);
  if (invalid) return invalid;
  const repoRoot = await ensureGitRepo(input.repoPath);
  const repoAuthorization = await authorizeImplementRepoRoot(repoRoot, workspaceAuthorizationResolver);
  if (!repoAuthorization.ok) return repoAuthorization;
  const { owner, name } = repoAuthorization;
  const sourceRef = parseIssueCommentUrl(input.authorizationSourceUrl);
  if (
    sourceRef.owner.toLowerCase() !== owner.toLowerCase()
    || sourceRef.name.toLowerCase() !== name.toLowerCase()
    || sourceRef.issueNumber !== input.issueNumber
  ) {
    return refuse("station_waiver_authorization_unverifiable", "The waiver source must be a comment on this repository's issue");
  }
  const comments = await readIssueCommentsWithAuthors(repoRoot, owner, name, input.issueNumber);
  const trust = await resolveExecutionObligationTrust(repoRoot, owner, name, comments);
  const source = comments.find((c) => c.id === sourceRef.commentId);
  const command = source == null ? null : parseStationWaiverCommand(source.body);
  if (
    source == null
    || !trust.isTrusted(source)
    || command?.station !== input.stationId
    || !input.obligationIds.every((id) => command.obligation_ids.includes(id))
  ) {
    return refuse(
      "station_waiver_authorization_unverifiable",
      `The source must be an exact '${buildStationWaiverCommand({ stationId: input.stationId, obligationIds: input.obligationIds })}' ` +
      "command from a user with write access to this repository",
    );
  }
  // Replay only believes a waiver record posted by this server's own identity.
  if ((await getAuthenticatedGitHubLogin(repoRoot)) == null) {
    return refuse("station_waiver_identity_unavailable", "The MCP posting identity could not be resolved");
  }
  const before = await readTrustedExecutionObligationState(repoRoot, owner, name, input.issueNumber);
  if (!before.ok) return before;
  const targets = classifyTargets(before, input, source.id);
  if (!targets.toWaive) return targets;
  const summary = { issue_number: input.issueNumber, station_id: input.stationId, source_comment_url: input.authorizationSourceUrl };
  if (targets.toWaive.length === 0) {
    return { ok: true, ...summary, already_recorded: true, waived_obligation_ids: input.obligationIds };
  }
  const posted = await postWaiver(repoRoot, owner, name, input.issueNumber, buildWaiverBody({
    issueNumber: input.issueNumber,
    stationId: input.stationId,
    obligations: targets.toWaive,
    source: { id: source.id, authorLogin: source.authorLogin, url: input.authorizationSourceUrl },
  }));
  if (!posted.ok) return posted;
  // Success is what replay believes, not that a POST returned: read the ledger back.
  const after = await readTrustedExecutionObligationState(repoRoot, owner, name, input.issueNumber);
  const stillOpen = after.ok
    ? input.obligationIds.filter((id) => after.open_obligation_ids.includes(id))
    : input.obligationIds;
  if (stillOpen.length > 0) {
    return refuse(
      "station_waiver_not_verified",
      `The waiver record posted but replay still reports open: ${stillOpen.join(", ")}`,
      { waiver_comment_url: posted.url, open_obligation_ids: stillOpen },
    );
  }
  return {
    ok: true,
    ...summary,
    already_recorded: false,
    waived_obligation_ids: input.obligationIds,
    waiver_comment_url: posted.url,
    waiver_comment_id: posted.id,
  };
}
