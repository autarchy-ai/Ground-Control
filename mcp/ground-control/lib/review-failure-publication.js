import { buildStationObservationObligationId, parseExecutionObligationV2Markers } from "./execution-obligation-v2.js";
import { readIssueCommentsWithAuthors, resolveExecutionObligationTrust } from "./grc-legacy-compat-3.js";
import { postStationObservationEscalation, postStationObservationOpened } from "./station-observation-records.js";
import { readPriorCodexReviewPrePushCycleCount } from "./codex-verify-cap.js";
import { captureReviewRevision, describeReviewRevisionDrift, writeReviewResult } from "./review-result-artifacts.js";

function failure(error, message) {
  return { ok: false, error, message, next_action: "retry_review_failure_publication" };
}

function publishedFailure(record, alreadyPublished = false) {
  return {
    ok: true,
    review_handle: record.review_handle,
    publication_status: "published_failure",
    already_published: alreadyPublished,
    cycle: null,
    expected_cycle: record.expected_cycle,
    station_attempts: record.terminal.attempts,
    obligation_id: record.publication_receipt.obligation_id,
    receipt: record.publication_receipt,
    next_action: "escalate_unobserved_station_under_hard_external_dependency",
  };
}

function relevantStationEvents(comments, trust, issueNumber, obligationId, cycle) {
  const matching = [];
  for (const comment of comments) {
    const events = parseExecutionObligationV2Markers(comment.body, issueNumber)
      .filter((event) => event.obligation_id === obligationId
        && event.kind === "station_observation" && event.station === "codex_review"
        && event.cycle === cycle);
    if (events.length > 0 && !trust.isTrusted(comment)) {
      return { ok: false, error: "review_failure_obligation_untrusted" };
    }
    matching.push(...events.map((event) => ({ event, comment })));
  }
  const opened = matching.filter(({ event }) => event.event === "opened");
  const escalated = matching.filter(({ event }) => event.event === "escalated");
  const resolved = matching.filter(({ event }) => event.event === "resolved");
  if (opened.length > 1 || escalated.length > 1 || resolved.length > 0
    || (escalated.length > 0 && opened.length === 0)
    || (opened.length > 0 && escalated.length > 0
      && escalated[0].comment.id <= opened[0].comment.id)) {
    return { ok: false, error: "review_failure_obligation_ambiguous" };
  }
  return { ok: true, opened: opened[0]?.comment ?? null, escalated: escalated[0]?.comment ?? null };
}

/** A non-verdict writes only the existing station-observation marker family, never a review cycle. */
export async function publishReviewStationFailure({ repository, record, gitDir }, {
  captureRevision = captureReviewRevision,
  readPriorCycleCount = readPriorCodexReviewPrePushCycleCount,
  readComments = readIssueCommentsWithAuthors,
  resolveTrust = resolveExecutionObligationTrust,
  postOpened = postStationObservationOpened,
  postEscalation = postStationObservationEscalation,
  writeResult = writeReviewResult,
} = {}) {
  if (record.publication_status === "published_failure") return publishedFailure(record, true);
  if (record.kind !== "non_verdict" || record.publication_status !== "unpublished_failure") {
    return failure("review_failure_result_invalid", "The retained result is not an unpublished non-verdict.");
  }
  let observed;
  try {
    observed = await captureRevision({ repoRoot: repository.repoRoot, baseBranch: record.base_branch, uncommitted: true });
  } catch {
    return failure("review_revision_changed_during_capture", "The review input moved during failure publication.");
  }
  const drift = describeReviewRevisionDrift(record.revision, observed.revision);
  if (drift) {
    return { ...failure("review_revision_stale", drift.message), stale_cause: drift.cause,
      next_action: "rerun_review_on_current_revision" };
  }
  const prior = await readPriorCycleCount(repository.repoRoot, repository.owner, repository.name, record.issue_number);
  if (prior !== record.expected_cycle - 1) {
    return failure("review_publication_cycle_stale", "Another review consumed the expected cycle slot.");
  }
  let comments;
  let trust;
  try {
    comments = await readComments(repository.repoRoot, repository.owner, repository.name, record.issue_number);
    trust = await resolveTrust(repository.repoRoot, repository.owner, repository.name, comments);
  } catch {
    return failure("review_failure_progress_unverifiable", "Station-observation progress could not be verified.");
  }
  const stationId = "codex_review";
  const logicalCycle = record.expected_cycle;
  const obligationId = buildStationObservationObligationId({ stationId, logicalCycle });
  const progress = relevantStationEvents(comments, trust, record.issue_number, obligationId, logicalCycle);
  if (!progress.ok) return failure(progress.error, "Trusted station-observation events are ambiguous.");
  const target = { repoRoot: repository.repoRoot, owner: repository.owner, name: repository.name,
    issueNumber: record.issue_number, stationId, logicalCycle };
  let opened = progress.opened == null ? null : { ok: true,
    url: `https://github.com/${repository.owner}/${repository.name}/issues/${record.issue_number}#issuecomment-${progress.opened.id}` };
  if (opened == null) {
    opened = await postOpened({ ...target, failureClass: record.terminal.attempts[0].failure_class,
      attemptOrdinal: record.terminal.attempts[0].attempt_ordinal });
    if (!opened?.ok) return failure("review_failure_open_failed", opened?.message ?? "Station opening failed.");
  }
  let escalated = progress.escalated == null ? null : { ok: true,
    url: `https://github.com/${repository.owner}/${repository.name}/issues/${record.issue_number}#issuecomment-${progress.escalated.id}` };
  if (escalated == null) {
    escalated = await postEscalation({ ...target,
      failureClasses: record.terminal.attempts.map((attempt) => attempt.failure_class),
      attemptCount: record.terminal.attempts.length });
    if (!escalated?.ok) return failure("review_failure_escalation_failed", escalated?.message ?? "Station escalation failed.");
  }
  const published = { ...record, publication_status: "published_failure",
    publication_receipt: { obligation_id: obligationId,
      opened_record_url: opened.url, escalation_record_url: escalated.url,
      cycle: null },
    updated_at: new Date().toISOString() };
  writeResult(gitDir, published);
  return publishedFailure(published);
}
