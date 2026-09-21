import { createHash } from "node:crypto";
import { readPriorCodexReviewPrePushCycleCount, postCodexReviewFindingsComment, postCodexReviewPrePushCycleMarker } from "./codex-verify-cap.js";
import { detectSensitiveBodyContent } from "./grc-legacy-compat-2.js";
import { readGitIdentity } from "./grc-legacy-compat-4.js";
import { resolveAuthorizedIssueRepository, issueRepositoryNotAuthorized } from "./authorized-issue-repository.js";
import { prepareDecisionRecordBody, runPostDecisionRecord } from "./decision-records.js";
import { acquireReviewPublicationLock } from "./filesystem-lease.js";
import { _statusForReviewerAction, normalizeReviewCycleNextAction, summarizeReviewFindings } from "./knowledge-capture.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX } from "./repo-vocabulary.js";
import { readTrustedReviewPublicationProgress } from "./review-publication-evidence.js";
import { buildReviewPublicationMarkerAttributes } from "./review-publication-markers.js";
import { postStationReobservation } from "./station-observation-records.js";
import { verifyReviewWontfixAuthorizations } from "./review-wontfix-authorization.js";
import { publishReviewStationFailure } from "./review-failure-publication.js";
import {
  captureReviewRevision,
  readReviewResult,
  validateSanitizedReviewPublication,
  writeReviewResult,
} from "./review-result-artifacts.js";

function fail(error, message, nextAction = null) {
  return { ok: false, error, message, ...(nextAction ? { next_action: nextAction } : {}) };
}

function provenance(record, sanitizedDigest) {
  const publicationId = createHash("sha256").update([
    record.original_digest,
    record.revision.digest,
    sanitizedDigest,
    record.repository_id,
    record.issue_number,
    record.expected_cycle,
    // The delivery identity is part of the publication's identity, so a marker
    // cannot be reused under a different tree (issue #1679).
    record.revision.candidate_tree_oid,
  ].join(":"), "utf8").digest("hex");
  return {
    publication_id: publicationId,
    original_digest: record.original_digest,
    revision_digest: record.revision.digest,
    sanitized_digest: sanitizedDigest,
    candidate_tree_oid: record.revision.candidate_tree_oid,
    findings_count: record.findings.length,
  };
}

export function buildSanitizedReviewFindingsRecord(record, sanitized, proof) {
  const lines = [
    `<!-- gc:review-publication stage="findings" reviewer="codex" issue="${record.issue_number}" cycle="${record.expected_cycle}" ${buildReviewPublicationMarkerAttributes(proof)} -->`,
    "",
    `**gc_codex_review** — sanitized deferred publication for issue #${record.issue_number}, cycle ${record.expected_cycle} of ${record.cap}`,
    `**Reviewed revision:** \`${record.revision.digest}\``,
    "",
    "## Architectural read",
    "",
    sanitized.architectural_read,
    "",
    `**Verdict:** \`${sanitized.verdict}\``,
    ...(sanitized.notes.length > 0
      ? ["", "## Notes", "", ...sanitized.notes.map((note) => `- ${note.text}`)] : []),
    "",
    "## Findings",
    "",
  ];
  if (sanitized.findings.length === 0) lines.push("- (none)");
  for (const finding of sanitized.findings) {
    lines.push(
      `### ${finding.id} — ${finding.title}`,
      "",
      `- Classification: \`${finding.classification}\``,
      `- Decision: \`${finding.decision}\``,
      ...(finding.location ? [`- Location: \`${finding.location}\``] : []),
      `- Rationale: ${finding.rationale}`,
      "",
    );
  }
  return lines.join("\n");
}

async function defaultPublishFindings({ repository, record, body }) {
  const response = await postCodexReviewFindingsComment({
    repoRoot: repository.repoRoot,
    owner: repository.owner,
    name: repository.name,
    issueNumber: record.issue_number,
    body,
  });
  return { id: response?.id ?? null, url: response?.html_url ?? null };
}

async function defaultPublishCycle({ repository, record, proof }) {
  await postCodexReviewPrePushCycleMarker(
    repository.repoRoot,
    repository.owner,
    repository.name,
    record.issue_number,
    record.branch,
    record.expected_cycle,
    {
      hardCap: record.cap,
      publication: proof,
    },
  );
  return { id: null, url: null };
}

async function defaultPublishReobservation({ repository, record, findingsRecord }) {
  const stationObservation = record.terminal?.station_observation ?? null;
  if (stationObservation == null) return null;
  const response = await postStationReobservation({
    repoRoot: repository.repoRoot,
    owner: repository.owner,
    name: repository.name,
    issueNumber: record.issue_number,
    recordUrl: findingsRecord?.url ?? null,
    stationObservation,
  });
  if (response?.ok !== true) {
    return fail(
      "review_publication_reobservation_failed",
      response?.message ?? "The prior station-observation obligation could not be resolved.",
      "retry_review_publication",
    );
  }
  return { id: null, url: response.url ?? null };
}

async function defaultPublishDecision({ repository, record, sanitized, proof, workspaceAuthorizationResolver }) {
  return runPostDecisionRecord({
    repoPath: repository.repoRoot,
    issueNumber: record.issue_number,
    reviewStartedAt: record.created_at,
    cycle: record.expected_cycle,
    reviewer: "codex",
    verdict: sanitized.verdict,
    notes: sanitized.notes,
    architectural_read: sanitized.architectural_read,
    findings: sanitized.findings,
    provenance: proof,
  }, { workspaceAuthorizationResolver });
}

function publishedEnvelope(record, alreadyPublished = false) {
  const reviewerAction = record.terminal?.next_action ?? "";
  const status = _statusForReviewerAction(reviewerAction, record.findings.length > 0);
  return {
    ok: true,
    review_handle: record.review_handle,
    result_kind: record.kind,
    publication_status: "published",
    already_published: alreadyPublished,
    reviewer: record.reviewer,
    cycle: record.expected_cycle,
    cap: record.cap,
    status,
    findings_summary: summarizeReviewFindings(record.findings),
    findings_record_url: record.publication_receipt?.findings_record_url ?? null,
    decision_record_url: record.publication_receipt?.decision_record_url ?? null,
    diff_mode: record.terminal?.diff_mode ?? null,
    review_coverage: record.coverage,
    receipt: record.publication_receipt,
    next_action: normalizeReviewCycleNextAction(reviewerAction, status),
  };
}

export async function runGetReviewResult(input, overrides = {}) {
  const resolveRepository = overrides.resolveRepository
    ?? ((repoPath) => resolveAuthorizedIssueRepository(repoPath, overrides.workspaceAuthorizationResolver));
  const repository = await resolveRepository(input?.repoPath);
  if (!repository?.ok) return issueRepositoryNotAuthorized("review_result", repository ?? {}, {});
  const identity = await (overrides.readIdentity ?? readGitIdentity)(repository.repoRoot);
  const result = (overrides.readResult ?? readReviewResult)(identity.gitDir, input?.reviewHandle);
  if (!result.ok) return fail(result.error, "The retained review result could not be read.");
  const record = result.record;
  if (record.repository_id !== `${repository.owner}/${repository.name}`) {
    return fail("review_result_repository_mismatch", "The review handle belongs to a different repository.");
  }
  return {
    ok: true,
    review_handle: record.review_handle,
    result_kind: record.kind,
    issue_number: record.issue_number,
    reviewer: record.reviewer,
    publication_status: record.publication_status,
    expected_cycle: record.expected_cycle,
    cap: record.cap,
    revision: record.revision,
    review_coverage: record.coverage,
    findings: record.findings,
    verdict: record.verdict,
    notes: record.notes,
    architectural_read: record.architectural_read,
    ...(record.terminal?.failure_causes ? { failure_causes: record.terminal.failure_causes } : {}),
    ...(record.kind === "non_verdict" ? { station_attempts: record.terminal.attempts } : {}),
    receipt: record.publication_receipt,
  };
}

// A zero-finding publication authorizes the candidate tree for delivery, and
// that tree stages untracked files while the reviewed diff carries only tracked
// ones. Publishing it while untracked paths went unreviewed would launder
// content no reviewer saw as reviewed, which is worse than the drift the
// binding was meant to catch. Stage everything and review again (issue #1679,
// core-F1). A finding-bearing cycle authorizes no tree, so it is unaffected.
function unreviewedPathsRefusal(current) {
  const unreviewed = current.revision.unreviewed_untracked_paths?.length ?? 0;
  if (current.findings.length > 0 || unreviewed === 0) return null;
  return fail(
    "review_publication_unreviewed_paths_present",
    "This cycle reported no findings, so publishing it would authorize its tree for delivery - and "
    + `${unreviewed} untracked path(s) sit in that tree without `
    + "being part of the reviewed diff. Publish stages them with `git add -A`, so they would ship "
    + "unreviewed. Stage them and review again if they belong to this change; remove or ignore them if "
    + "they do not.",
    "stage_or_remove_the_unreviewed_paths_and_rerun_the_review",
  );
}

// Re-capture the live revision so a stale review cannot be published.
async function recaptureRevision(current, repository, overrides) {
  const captureRevision = overrides.captureRevision ?? captureReviewRevision;
  try {
    return {
      observed: await captureRevision({
        repoRoot: repository.repoRoot,
        baseBranch: current.base_branch,
        uncommitted: true,
      }),
    };
  } catch (error) {
    // A checkout that can execute its own code during staging is a refusal with
    // its own cause, not a generic stage fault (issue #1679, security-F1).
    if (error?.code === "review_checkout_configuration_unsafe") {
      return { result: fail(error.code, error.message, "remove_the_caller_controlled_git_configuration_and_retry") };
    }
    if (error?.code !== "review_revision_changed_during_capture") throw error;
    return { result: fail(error.code, "The review input moved while its publication revision was being captured.", "retry_after_the_tree_is_stable") };
  }
}

async function prepareVerdictPublication(current, input, repository, overrides) {
  const checked = validateSanitizedReviewPublication(current, input.sanitized);
  if (!checked.ok) return { result: checked };
  // Before any GitHub write: a `wontfix` closes a real finding without repairing
  // it, so its authorization is verified against the repository rather than
  // taken from the caller's own string (issue #1679).
  const authorized = await verifyReviewWontfixAuthorizations({
    repoRoot: repository.repoRoot,
    owner: repository.owner,
    name: repository.name,
    issueNumber: current.issue_number,
    reviewStartedAt: current.created_at,
    findings: checked.value.findings,
  }, { readComments: overrides.readComments, resolveTrust: overrides.resolveTrust });
  if (!authorized.ok) return { result: authorized };
  if (current.publication_status === "published") {
    if (current.publication_receipt?.sanitized_digest !== checked.sanitized_digest) {
      return { result: fail("review_publication_retry_conflict", "This review handle was already published with different sanitized content.") };
    }
    return { result: publishedEnvelope(current, true) };
  }
  if (current.publication_status !== "unpublished") {
    return { result: fail("review_result_not_publishable", `Review result status is ${current.publication_status}.`) };
  }
  const unreviewed = unreviewedPathsRefusal(current);
  if (unreviewed) return { result: unreviewed };
  const recaptured = await recaptureRevision(current, repository, overrides);
  if (recaptured.result) return recaptured;
  const { observed } = recaptured;
  if (observed.revision.digest !== current.revision.digest) {
    return { result: fail("review_revision_stale", "The current review input no longer matches the retained reviewed revision.", "rerun_review_on_current_revision") };
  }
  const proof = provenance(current, checked.sanitized_digest);
  const body = buildSanitizedReviewFindingsRecord(current, checked.value, proof);
  const sensitive = detectSensitiveBodyContent(body);
  if (sensitive) return { result: fail("review_publication_body_rejected", sensitive, "redact_and_retry_review_publication") };
  if (Buffer.byteLength(body, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX) {
    return { result: fail("review_publication_body_too_large", "The sanitized publication exceeds GitHub's issue-comment body cap.") };
  }
  const decisionPreflight = prepareDecisionRecordBody({
    issueNumber: current.issue_number,
    cycle: current.expected_cycle,
    reviewer: "codex",
    verdict: checked.value.verdict,
    notes: checked.value.notes,
    architectural_read: checked.value.architectural_read,
    findings: checked.value.findings,
    provenance: proof,
  });
  if (!decisionPreflight.ok) return { result: decisionPreflight };
  return { checked, proof, body };
}

async function readPublicationProgress(current, repository, proof, overrides) {
  const readProgress = overrides.readProgress ?? readTrustedReviewPublicationProgress;
  const progress = await readProgress({
    repoRoot: repository.repoRoot,
    owner: repository.owner,
    name: repository.name,
    issueNumber: current.issue_number,
    cycle: current.expected_cycle,
    proof,
    stationObservation: current.terminal?.station_observation ?? null,
  });
  if (progress?.ok === false) return { result: progress };
  const readPrior = overrides.readPriorCycleCount ?? readPriorCodexReviewPrePushCycleCount;
  const prior = await readPrior(repository.repoRoot, repository.owner, repository.name, current.issue_number);
  const hasPublishedCycle = progress.cycle != null && progress.cycle !== false;
  const requiredPrior = hasPublishedCycle ? current.expected_cycle : current.expected_cycle - 1;
  if (prior !== requiredPrior) {
    return { result: fail("review_publication_cycle_stale", "Another published cycle changed the expected cycle slot.", "rerun_review_for_the_next_cycle") };
  }
  return { progress };
}

async function publishVerdictStages({ current, repository, identity, checked, proof, body, overrides }) {
  const progressRead = await readPublicationProgress(current, repository, proof, overrides);
  if (progressRead.result) return progressRead.result;
  const { progress } = progressRead;
  const publishFindings = overrides.publishFindings ?? defaultPublishFindings;
  const publishReobservation = overrides.publishReobservation ?? defaultPublishReobservation;
  const publishCycle = overrides.publishCycle ?? defaultPublishCycle;
  const publishDecision = overrides.publishDecision ?? defaultPublishDecision;
  const findingsRecord = progress.findings ||
    await publishFindings({ repository, record: current, body, proof });
  const reobservationRecord = current.terminal?.station_observation == null
    ? null
    : progress.reobservation || await publishReobservation({
      repository, record: current, findingsRecord, proof,
    });
  if (reobservationRecord?.ok === false) return reobservationRecord;
  const cycleRecord = progress.cycle ||
    await publishCycle({ repository, record: current, proof });
  const decisionRecord = progress.decision ||
    await publishDecision({
      repository, record: current, sanitized: checked.value, findings: checked.value.findings,
      proof, workspaceAuthorizationResolver: overrides.workspaceAuthorizationResolver,
    });
  if (decisionRecord?.ok === false) return decisionRecord;
  const receipt = {
    ...proof,
    cycle: current.expected_cycle,
    findings_record_url: findingsRecord?.url ?? null,
    findings_record_id: findingsRecord?.id ?? null,
    reobservation_record_url: reobservationRecord?.url ?? null,
    reobservation_record_id: reobservationRecord?.id ?? null,
    cycle_record_url: cycleRecord?.url ?? null,
    cycle_record_id: cycleRecord?.id ?? null,
    decision_record_url: decisionRecord?.comment_url ?? decisionRecord?.url ?? null,
    decision_record_id: decisionRecord?.comment_id ?? decisionRecord?.id ?? null,
  };
  const published = {
    ...current,
    publication_status: "published",
    publication_receipt: receipt,
    updated_at: new Date().toISOString(),
  };
  (overrides.writeResult ?? writeReviewResult)(identity.gitDir, published);
  return publishedEnvelope(published);
}

// Publication is a multi-stage remote operation, so a stage can fail for
// ordinary operational reasons (a GitHub 5xx, a lost connection, a full disk).
// Without this boundary the exception reached the thin MCP handler and became a
// generic fault, losing the retained handle, the publication kind and the retry
// action the caller needs to resume - even though partial remote progress is
// already reconciled by readTrustedReviewPublicationProgress on the next
// attempt (issue #1679). The cause is deliberately not echoed: it can carry
// command output, URLs, artifact paths or reviewer prose.
function publicationStageFailure(input, kind) {
  return {
    ok: false,
    error: "review_publication_stage_failed",
    message: "A publication stage did not complete. The retained review result is unchanged and the publication can be retried.",
    review_handle: input?.reviewHandle ?? null,
    publication_kind: kind,
    next_action: "retry_review_publication",
  };
}

export async function runPublishReviewResult(input, overrides = {}) {
  const kind = input?.publicationKind === "non_verdict" ? "non_verdict" : "verdict";
  try {
    return await publishReviewResultUnderLock(input, overrides);
  } catch {
    return publicationStageFailure(input, kind);
  }
}

async function publishReviewResultUnderLock(input, overrides = {}) {
  const resolveRepository = overrides.resolveRepository
    ?? ((repoPath) => resolveAuthorizedIssueRepository(repoPath, overrides.workspaceAuthorizationResolver));
  const repository = await resolveRepository(input?.repoPath);
  if (!repository?.ok) return issueRepositoryNotAuthorized("review_publication", repository ?? {}, {});
  const readIdentity = overrides.readIdentity ?? readGitIdentity;
  const identity = await readIdentity(repository.repoRoot);
  const readResult = overrides.readResult ?? readReviewResult;
  const firstRead = readResult(identity.gitDir, input?.reviewHandle);
  if (!firstRead.ok) return fail(firstRead.error, "The retained review result could not be read.");
  const record = firstRead.record;
  if (record.repository_id !== `${repository.owner}/${repository.name}`) {
    return fail("review_result_repository_mismatch", "The review handle belongs to a different repository.");
  }
  const acquireLock = overrides.acquireLock ?? acquireReviewPublicationLock;
  let release;
  try {
    release = await acquireLock(identity.gitDir, { issueNumber: record.issue_number, reviewer: record.reviewer });
  } catch {
    return fail("review_publication_locked", "Another publication is already in progress.", "retry_review_publication");
  }
  try {
    const reread = readResult(identity.gitDir, input.reviewHandle);
    if (!reread.ok) return fail(reread.error, "The retained review result could not be reread under the publication lock.");
    const current = reread.record;
    if (current.kind === "non_verdict") {
      if (input.publicationKind !== "non_verdict" || input.sanitized != null) {
        return fail("review_publication_wrong_kind", "Publish this non-verdict with publication_kind=non_verdict and no sanitized reviewer content.");
      }
      return await (overrides.publishFailure ?? publishReviewStationFailure)({
        repository, record: current, gitDir: identity.gitDir,
      }, overrides.failureDependencies);
    }
    if (input.publicationKind === "non_verdict") {
      return fail("review_publication_wrong_kind", "A completed verdict requires sanitized review publication.");
    }
    const prepared = await prepareVerdictPublication(current, input, repository, overrides);
    if (prepared.result) return prepared.result;
    return await publishVerdictStages({ current, repository, identity, ...prepared, overrides });
  } finally {
    if (release) await release();
  }
}
