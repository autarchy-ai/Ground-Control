import { buildReviewCoverageIncompleteEnvelope } from "./api-controls.js";
import { mergeReviewerArchitecturalReads } from "./codex-review.js";
import { readGitIdentity } from "./grc-legacy-compat-4.js";
import { buildAutoFixDecisionFindings } from "./knowledge-capture.js";
import { classifyReviewFailureCauses } from "./review-failure-diagnostics.js";
import {
  captureReviewRevision,
  createReviewResult,
  readReviewResult,
  writeReviewResult,
} from "./review-result-artifacts.js";

export const REVIEW_PUBLICATION_MODES = Object.freeze(["automatic", "deferred"]);

export function validateReviewPublicationMode(mode) {
  return REVIEW_PUBLICATION_MODES.includes(mode)
    ? null
    : {
        ok: false,
        error: "review_publication_mode_invalid",
        message: `publication_mode must be one of: ${REVIEW_PUBLICATION_MODES.join(", ")}`,
      };
}

export function validateReviewPublicationRequest(mode, uncommitted, issueNumber) {
  const invalidMode = validateReviewPublicationMode(mode);
  if (invalidMode) return invalidMode;
  if (mode !== "deferred" || (uncommitted && Number.isInteger(issueNumber) && issueNumber > 0)) return null;
  return {
    ok: false,
    error: "deferred_review_requires_prepush_issue",
    message: "deferred publication currently requires uncommitted=true and a positive issue_number",
  };
}

export async function prepareDeferredReviewRevision(args, overrides) {
  return captureReviewRevision(args, overrides);
}

function normalizedLocalFindings(core, security) {
  return [
    ...(core?.findings ?? []).map((finding, index) => ({
      ...finding,
      id: `core-F${index + 1}`,
      reviewer: "core",
    })),
    ...(security?.findings ?? []).map((finding, index) => ({
      ...finding,
      id: `security-F${index + 1}`,
      reviewer: "security",
    })),
  ];
}

function retainedVerdict(core, security) {
  const verdicts = [core?.envelope?.verdict, security?.envelope?.verdict];
  if (verdicts.includes("don't-ship")) return "don't-ship";
  if (verdicts.includes("ship-with-fixes")) return "ship-with-fixes";
  return "ship";
}

function retainedNotes(core, security) {
  return [
    ...(core?.envelope?.notes ?? []).map((note) => ({ text: `[core] ${note.text}` })),
    ...(security?.envelope?.notes ?? []).map((note) => ({ text: `[security] ${note.text}` })),
  ].slice(0, 2);
}

function inspection(record, terminal) {
  return {
    ok: record.publication_status === "unpublished",
    ...(record.publication_status === "stale"
      ? {
          error: "review_revision_stale",
          message: "The working tree changed while the review was running; this result is retained but cannot be published.",
        }
      : {}),
    ...(record.publication_status === "not_publishable"
      ? {
          error: terminal?.error ?? "review_result_not_publishable",
          message: terminal?.message ?? "The review did not produce a complete publishable result.",
        }
      : {}),
    ...(record.publication_status === "unpublished_failure"
      ? {
          error: "review_station_unobserved",
          message: "The bounded attempts rendered no verdict; publish the retained closed-code station failure.",
        }
      : {}),
    review_handle: record.review_handle,
    result_kind: record.kind,
    publication_status: record.publication_status,
    revision: record.revision,
    review_coverage: record.coverage,
    diff_mode: record.terminal?.diff_mode ?? null,
    findings: record.findings,
    verdict: record.verdict,
    notes: record.notes,
    architectural_read: record.architectural_read,
    ...(record.terminal?.failure_causes ? { failure_causes: record.terminal.failure_causes } : {}),
    ...(record.kind === "non_verdict" ? { station_attempts: record.terminal.attempts } : {}),
    cycle: null,
    expected_cycle: record.expected_cycle,
    cap: record.cap,
    next_action: record.publication_status === "unpublished"
      ? "inspect_sanitize_and_publish_review"
      : record.publication_status === "unpublished_failure"
        ? "publish_non_verdict_failure"
        : terminal?.next_action ?? "repair_and_rerun_review",
  };
}

export async function retainDeferredCodexReview({
  repoRoot,
  repositoryId,
  baseBranch,
  uncommitted,
  ownership,
  initialRevision,
  diffMode,
  reviewCoverage,
  core,
  security,
  terminal,
  stationObservation = null,
}, overrides = {}) {
  const captured = await captureReviewRevision({ repoRoot, baseBranch, uncommitted }, overrides);
  const revisionChanged = captured.revision.digest !== initialRevision.digest;
  const publishable = terminal?.ok === true && reviewCoverage?.complete === true && !revisionChanged;
  const publicationStatus = revisionChanged ? "stale" : publishable ? "unpublished" : "not_publishable";
  const findings = normalizedLocalFindings(core, security);
  const record = createReviewResult({
    repositoryId,
    issueNumber: ownership.issueNumber,
    reviewer: "codex",
    expectedCycle: ownership.cycleNumber,
    cap: ownership.cap,
    branch: ownership.branchName,
    baseBranch,
    revision: initialRevision,
    coverage: reviewCoverage,
    findings,
    verdict: retainedVerdict(core, security),
    notes: retainedNotes(core, security),
    architecturalRead: mergeReviewerArchitecturalReads(core, security) ?? null,
    terminal: {
      ok: terminal?.ok === true,
      error: terminal?.error ?? null,
      message: terminal?.message ?? null,
      next_action: terminal?.next_action ?? null,
      diff_mode: diffMode,
      station_observation: stationObservation,
      ...(publicationStatus === "not_publishable"
        ? { failure_causes: classifyReviewFailureCauses(terminal?.parse_errors) } : {}),
    },
    publicationStatus,
  });
  const identity = await (overrides.readIdentity ?? readGitIdentity)(repoRoot);
  writeReviewResult(identity.gitDir, record);
  return inspection(record, terminal);
}

export function deferredCoverageFailure(args) {
  return buildReviewCoverageIncompleteEnvelope(args);
}

/** Retain only closed attempt facts; no raw engine output can reach the failure publisher. */
export async function retainDeferredStationFailure({ repoRoot, reviewHandle, attempts }, {
  readIdentity = readGitIdentity,
  readResult = readReviewResult,
  writeResult = writeReviewResult,
} = {}) {
  const identity = await readIdentity(repoRoot);
  const retained = readResult(identity.gitDir, reviewHandle);
  if (!retained.ok) return retained;
  const source = retained.record;
  if (source.kind !== "verdict" || source.publication_status !== "not_publishable"
    || !Array.isArray(attempts) || attempts.length < 1
    || attempts.some((attempt) => attempt?.station_result !== "not_evaluable"
      || attempt?.failure_class !== "incomplete_reviewer_coverage")) {
    return { ok: false, error: "review_station_failure_invalid" };
  }
  const closedAttempts = attempts.map((attempt) => ({
    station_id: "codex_review",
    station_result: "not_evaluable",
    failure_class: "incomplete_reviewer_coverage",
    attempt_ordinal: attempt.attempt_ordinal,
  }));
  const failure = createReviewResult({
    kind: "non_verdict",
    repositoryId: source.repository_id,
    issueNumber: source.issue_number,
    reviewer: "codex",
    expectedCycle: source.expected_cycle,
    cap: source.cap,
    branch: source.branch,
    baseBranch: source.base_branch,
    revision: source.revision,
    coverage: source.coverage,
    findings: [],
    notes: [],
    architecturalRead: null,
    terminal: {
      ok: false,
      error: "review_coverage_incomplete",
      next_action: "escalate_unobserved_station_under_hard_external_dependency",
      attempts: closedAttempts,
      failure_causes: source.terminal.failure_causes ?? ["unknown"],
      diff_mode: source.terminal.diff_mode,
    },
    publicationStatus: "unpublished_failure",
  });
  writeResult(identity.gitDir, failure);
  return inspection(failure, failure.terminal);
}

export function buildAutomaticReviewPublication(reviewResult) {
  const findings = buildAutoFixDecisionFindings(reviewResult?.findings ?? []).map((finding) => ({
    id: finding.id,
    title: finding.title,
    classification: finding.classification,
    decision: finding.decision,
    rationale: finding.rationale,
    ...(finding.location ? { location: finding.location } : {}),
    ...(finding.instances ? { instances: finding.instances } : {}),
    ...(reviewResult?.findings?.find((original) => original.id === finding.id)?.structural_blocker
      ? { structural_blocker: true } : {}),
  }));
  const architecturalRead = typeof reviewResult?.architectural_read === "string"
      && reviewResult.architectural_read.trim() !== ""
      ? reviewResult.architectural_read
      : "The review produced no separate architectural read.";
  return {
    verdict: reviewResult.verdict,
    notes: reviewResult.notes ?? [],
    architectural_read: architecturalRead.length <= 20000
      ? architecturalRead : `${architecturalRead.slice(0, 19999)}…`,
    findings,
  };
}
