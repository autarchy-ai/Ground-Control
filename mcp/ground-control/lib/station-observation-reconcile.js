// Trusted recovery for a stranded station-observation obligation (issue #1582).
//
// The IO half of the recovery whose binding rules live in station-observation-evidence.js. It is
// the only emitter of `reobserved` besides the cycle wrapper, and it adds no authority of its own:
// it writes the resolution only when the durable thread already proves — through records the
// trusted MCP posting identity wrote — that the obligation's station rendered a verdict for the
// obligation's logical cycle after the obligation opened. The resolution it posts is the same
// marker replay already verifies; nothing about completion trust changes.

import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { EXECUTION_OBLIGATION_ID_RE, parseIssueCommentUrl } from "./codex-workflow.js";
import { buildStationObservationObligationId, parseExecutionObligationV2Markers } from "./execution-obligation-v2.js";
import { getAuthenticatedGitHubLogin, readIssueCommentsWithAuthors } from "./grc-legacy-compat-3.js";
import { readGitIdentity, readTrustedExecutionObligationState } from "./grc-legacy-compat-4.js";
import { acquireStationObservationReconcileLock } from "./filesystem-lease.js";
import { findStationObservationEvidence, hasTrustedReobservation } from "./station-observation-evidence.js";
import { postStationReobservation } from "./station-observation-records.js";

const ERROR_PREFIX = "station_observation_reconcile";

const DEFAULT_DEPS = Object.freeze({
  readComments: readIssueCommentsWithAuthors,
  readTrustedLogin: getAuthenticatedGitHubLogin,
  readObligationState: readTrustedExecutionObligationState,
  postReobservation: postStationReobservation,
  acquireLock: async (repoRoot, key) => acquireStationObservationReconcileLock((await readGitIdentity(repoRoot)).gitDir, key),
});

/** Bound on `findings_record_url`, shared by the tool schema and the direct-call validator. */
export const STATION_OBSERVATION_RECORD_URL_MAX = 800;

function commentUrl(owner, name, issueNumber, commentId) {
  return `https://github.com/${owner}/${name}/issues/${issueNumber}#issuecomment-${commentId}`;
}

function refusal(error, message, fields = {}) {
  return { ok: false, error: `${ERROR_PREFIX}_${error}`, message, ...fields };
}

function inputError({ issueNumber, obligationId, findingsRecordUrl }) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return "issue_number must be a positive integer";
  if (typeof obligationId !== "string" || !EXECUTION_OBLIGATION_ID_RE.test(obligationId)) {
    return "obligation_id must match the execution-obligation id rules";
  }
  if (typeof findingsRecordUrl !== "string" || findingsRecordUrl.length > STATION_OBSERVATION_RECORD_URL_MAX
    || parseIssueCommentUrl(findingsRecordUrl) == null) {
    return "findings_record_url must be a GitHub issue-comment URL";
  }
  return null;
}

function sameRepository(reference, owner, name, issueNumber) {
  return reference.owner.toLowerCase() === owner.toLowerCase()
    && reference.name.toLowerCase() === name.toLowerCase()
    && reference.issueNumber === issueNumber;
}

async function readThread(deps, { repoRoot, owner, name }, issueNumber) {
  try {
    const comments = await deps.readComments(repoRoot, owner, name, issueNumber);
    const trustedLogin = await deps.readTrustedLogin(repoRoot);
    const state = await deps.readObligationState(repoRoot, owner, name, issueNumber, comments);
    return { ok: true, comments, trustedLogin, state };
  } catch {
    // Stable text only: gh stderr is command output, which never enters a tool envelope here.
    return refusal("thread_unavailable", "could not read the issue thread or the MCP identity", {
      issue_number: issueNumber, next_action: "retry_after_resolving_gh_failure",
    });
  }
}

/**
 * The station and cycle a closed obligation id was opened for, from its `opened` events.
 * Needed to recognize an idempotent repeat once the obligation is no longer in the open set. Not
 * author-filtered: this runs only after the trusted-ledger read vouched for every marker's author.
 */
function openedIdentity(comments, issueNumber, obligationId) {
  const opened = (comments || [])
    .flatMap((comment) => parseExecutionObligationV2Markers(comment.body, issueNumber))
    .filter((event) => event.obligation_id === obligationId && event.event === "opened");
  return opened.at(-1) ?? null;
}

function alreadyRecorded({ comments, trustedLogin }, issueNumber, obligationId, recordId) {
  const identity = openedIdentity(comments, issueNumber, obligationId);
  return identity != null && hasTrustedReobservation({
    comments, issueNumber, obligationId, station: identity.station, cycle: identity.cycle, recordId, trustedLogin,
  });
}

/**
 * Whether a replayed open obligation is one this action can reconcile: a v2 station observation
 * whose id is the deterministic id for its station and logical cycle. The action and the completion
 * diagnostic share this predicate so completion never names a candidate the action must refuse.
 */
function isReconcilableStationObservation(obligation) {
  return obligation?.kind === "station_observation"
    && obligation.schema_version === 2
    && obligation.obligation_id === buildStationObservationObligationId({
      stationId: obligation.station, logicalCycle: obligation.cycle,
    });
}

/** The open v2 station observation `obligationId` selects, or the refusal explaining why none does. */
function selectObligation(thread, issueNumber, obligationId, recordId) {
  const obligation = (thread.state.open_obligations ?? []).find((o) => o.obligation_id === obligationId);
  if (obligation == null) {
    if (alreadyRecorded(thread, issueNumber, obligationId, recordId)) {
      return { done: { ok: true, issue_number: issueNumber, obligation_id: obligationId, already_recorded: true } };
    }
    return { done: refusal("not_open", `Execution obligation '${obligationId}' is not open`, { issue_number: issueNumber }) };
  }
  if (!isReconcilableStationObservation(obligation)) {
    return {
      done: refusal(
        "not_station_observation",
        `'${obligationId}' is not a station-observation obligation; resolve it with gc_record_execution_obligation`,
        { issue_number: issueNumber },
      ),
    };
  }
  return { obligation };
}

/**
 * Resolve an open station-observation obligation against an existing, validated verdict record.
 *
 * Idempotent: a repeat after a successful post, or after a lost response, finds the trusted
 * resolution bound to the same record and returns `already_recorded: true` without writing.
 */
export async function runReconcileStationObservation(input, {
  workspaceAuthorizationResolver = undefined,
  deps: overrides = {},
} = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const invalid = inputError(input ?? {});
  if (invalid) return refusal("input_invalid", invalid, { issue_number: input?.issueNumber ?? null });
  const { repoPath, issueNumber, obligationId, findingsRecordUrl } = input;

  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    return issueRepositoryNotAuthorized(ERROR_PREFIX, repository, { issue_number: issueNumber });
  }
  const { owner, name } = repository;
  const reference = parseIssueCommentUrl(findingsRecordUrl);
  if (!sameRepository(reference, owner, name, issueNumber)) {
    return refusal(
      "evidence_unverified",
      "findings_record_url must reference a comment on this repository's issue",
      { issue_number: issueNumber, reason: "record_outside_issue" },
    );
  }

  let release;
  try {
    release = await deps.acquireLock(repository.repoRoot, { issueNumber, obligationId });
  } catch (error) {
    const contended = error?.code === "ELOCKED";
    return refusal(
      contended ? "lock_contended" : "lock_unavailable",
      contended
        ? `another reconciliation of '${obligationId}' is in progress`
        : "the reconciliation lease could not be acquired",
      { issue_number: issueNumber, next_action: "retry_after_the_in_flight_reconciliation_completes" },
    );
  }
  try {
    return await reconcileUnderLease({ deps, repository, issueNumber, obligationId, recordId: reference.commentId });
  } finally {
    await release();
  }
}

// Read, decide, post, and verify as one serialized critical section: without the lease, two calls
// for the same obligation could each observe it open and each append a resolution.
async function reconcileUnderLease({ deps, repository, issueNumber, obligationId, recordId }) {
  const { owner, name } = repository;
  const thread = await readThread(deps, repository, issueNumber);
  if (!thread.ok) return thread;
  if (!thread.state.ok) return { ...thread.state, issue_number: issueNumber };
  const selected = selectObligation(thread, issueNumber, obligationId, recordId);
  if (selected.done) return selected.done;
  const { obligation } = selected;

  const evidence = findStationObservationEvidence({
    comments: thread.comments, issueNumber, obligation, trustedLogin: thread.trustedLogin, recordId: recordId,
  });
  if (!evidence.ok) {
    return refusal(
      "evidence_unverified",
      `the referenced comment does not prove a ${obligation.station} verdict for logical cycle ` +
      `${obligation.cycle} after '${obligationId}' opened (${evidence.reason})`,
      { issue_number: issueNumber, reason: evidence.reason },
    );
  }

  const recordUrl = commentUrl(owner, name, issueNumber, evidence.record.id);
  const posted = await deps.postReobservation({
    repoRoot: repository.repoRoot, owner, name, issueNumber, recordUrl,
    stationObservation: { obligationId, stationId: obligation.station, logicalCycle: obligation.cycle },
    source: "reconciliation",
  });
  if (!posted.ok) {
    return refusal("post_failed", "the reobserved resolution could not be posted to the issue thread", {
      issue_number: issueNumber, next_action: "retry_after_resolving_gh_failure",
    });
  }

  // Replay, not the post response, is the authority: confirm the ledger now treats it as closed.
  const after = await readThread(deps, repository, issueNumber);
  const closed = after.ok && after.state.ok && !after.state.open_obligation_ids.includes(obligationId);
  if (!closed) {
    return refusal(
      "unverified_after_post",
      `the resolution for '${obligationId}' was posted but the trusted ledger does not show it closed`,
      { issue_number: issueNumber, comment_url: posted.url, next_action: "retry_to_confirm_resolution" },
    );
  }
  return {
    ok: true,
    issue_number: issueNumber,
    obligation_id: obligationId,
    station: obligation.station,
    logical_cycle: obligation.cycle,
    observation_record_url: recordUrl,
    cycle_marker_url: commentUrl(owner, name, issueNumber, evidence.cycleMarker.id),
    comment_url: posted.url,
    already_recorded: false,
  };
}

/**
 * Open station observations the thread already proves were re-observed, for completion diagnostics.
 *
 * Diagnostic only: it never writes and never changes whether completion refuses. Any read failure
 * yields no candidates, leaving the refusal as it was.
 */
export async function findRecoverableStationObservations({
  repoRoot, owner, name, issueNumber, openObligations, deps: overrides = {},
}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const candidates = (openObligations ?? []).filter(isReconcilableStationObservation);
  if (candidates.length === 0) return [];
  try {
    const comments = await deps.readComments(repoRoot, owner, name, issueNumber);
    const trustedLogin = await deps.readTrustedLogin(repoRoot);
    return candidates.flatMap((obligation) => {
      const evidence = findStationObservationEvidence({ comments, issueNumber, obligation, trustedLogin });
      return evidence.ok
        ? [{
          obligation_id: obligation.obligation_id,
          station: obligation.station,
          logical_cycle: obligation.cycle,
          findings_record_url: commentUrl(owner, name, issueNumber, evidence.record.id),
        }]
        : [];
    });
  } catch {
    return [];
  }
}
