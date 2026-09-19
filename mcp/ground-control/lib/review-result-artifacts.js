/* eslint-disable security/detect-non-literal-fs-filename -- paths are beneath a canonical gitDir and use validated opaque handles */
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { GIT_OBJECT_ID_RE } from "./codex-workflow.js";
import { validateDecisionRecordInput } from "./decision-records.js";
import { REVIEW_FAILURE_CAUSES } from "./review-failure-diagnostics.js";
import {
  DECISION_RECORD_CLASSIFICATIONS,
  DECISION_RECORD_DECISIONS,
  rejectReservedMarkerSequence,
} from "./repo-vocabulary.js";
export { buildReviewRevision, captureReviewRevision } from "./review-revision.js";

export const REVIEW_RESULT_SCHEMA = "gc.review-result/v1";
export const REVIEW_HANDLE_RE = /^rvw_[0-9a-f]{48}$/;
const REVIEW_RESULT_DIRECTORY = "gc-review-results";
const REVIEW_RESULT_MAX_BYTES = 8 * 1024 * 1024;
const REVIEW_RESULT_KEYS = new Set([
  "schema", "review_handle", "kind", "repository_id", "issue_number", "reviewer",
  "expected_cycle", "cap", "branch", "base_branch", "revision", "coverage",
  "findings", "verdict", "notes", "architectural_read", "terminal", "original_digest",
  "publication_status", "publication_receipt", "created_at", "updated_at",
]);
const SANITIZED_FINDING_KEYS = new Set([
  "id", "title", "classification", "decision", "rationale", "location",
  "user_authorization", "instances", "structural_blocker",
]);

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedFinding(finding, index) {
  const reviewer = typeof finding?.reviewer === "string" && finding.reviewer !== ""
    ? finding.reviewer
    : "codex";
  return {
    id: typeof finding?.id === "string" && finding.id !== ""
      ? finding.id
      : `${reviewer}-F${index + 1}`,
    reviewer,
    path: finding?.path ?? null,
    line: finding?.line ?? null,
    title: finding?.title ?? "(no title)",
    body: finding?.body ?? "",
    classification: finding?.classification === "class" ? "class" : "one-off",
    ...(finding?.structural_blocker === true ? { structural_blocker: true } : {}),
    ...(finding?.category ? { category: finding.category } : {}),
    ...(finding?.sweep_evidence ? { sweep_evidence: finding.sweep_evidence } : {}),
  };
}

function originalReviewPayload(record) {
  return {
    kind: record.kind,
    repository_id: record.repository_id,
    issue_number: record.issue_number,
    reviewer: record.reviewer,
    expected_cycle: record.expected_cycle,
    cap: record.cap,
    branch: record.branch,
    base_branch: record.base_branch,
    revision: record.revision,
    coverage: record.coverage,
    findings: record.findings,
    verdict: record.verdict,
    notes: record.notes,
    architectural_read: record.architectural_read,
    terminal: record.terminal,
  };
}

export function createReviewResult(input, { now = () => new Date().toISOString(), random = randomBytes } = {}) {
  const timestamp = now();
  const findings = (input.findings ?? []).map(normalizedFinding);
  const stable = {
    kind: input.kind ?? "verdict",
    repository_id: input.repositoryId,
    issue_number: input.issueNumber,
    reviewer: input.reviewer,
    expected_cycle: input.expectedCycle,
    cap: input.cap,
    branch: input.branch,
    base_branch: input.baseBranch,
    revision: input.revision,
    coverage: input.coverage,
    findings,
    verdict: input.kind === "non_verdict" ? null
      : input.verdict ?? (findings.length === 0 ? "ship" : "ship-with-fixes"),
    notes: input.notes ?? [],
    architectural_read: input.architecturalRead ?? null,
    terminal: input.terminal,
  };
  const record = {
    schema: REVIEW_RESULT_SCHEMA,
    review_handle: `rvw_${random(24).toString("hex")}`,
    ...stable,
    original_digest: digestJson(stable),
    publication_status: input.publicationStatus ?? "unpublished",
    publication_receipt: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const validation = validateReviewResult(record);
  if (!validation.ok) {
    const error = new Error(`refusing to create an invalid review result: ${validation.error}`);
    error.code = validation.error;
    throw error;
  }
  return record;
}

function validBoundedString(value, max = 65535, nullable = false) {
  return (nullable && value === null)
    || (typeof value === "string" && value.length > 0 && value.length <= max);
}

function validateRevision(revision) {
  return revision != null
    && GIT_OBJECT_ID_RE.test(String(revision.head_oid))
    && GIT_OBJECT_ID_RE.test(String(revision.base_oid))
    && /^[0-9a-f]{64}$/.test(String(revision.digest))
    && Array.isArray(revision.unreviewed_untracked_paths)
    && revision.unreviewed_untracked_paths.every((path) => validBoundedString(path, 4096))
    && Array.isArray(revision.tracked_symlinks)
    && revision.tracked_symlinks.every((entry) => validBoundedString(entry, 8192));
}

function validateFinding(finding) {
  if (finding == null || typeof finding !== "object" || Array.isArray(finding)) return false;
  if (!validBoundedString(finding.id, 200) || !validBoundedString(finding.reviewer, 32)) return false;
  if (!validBoundedString(finding.title, 200) || typeof finding.body !== "string" || finding.body.length > 65535) return false;
  if (!DECISION_RECORD_CLASSIFICATIONS.includes(finding.classification)) return false;
  if (finding.path !== null && !validBoundedString(finding.path, 4096)) return false;
  if (finding.line !== null && (!Number.isInteger(finding.line) || finding.line <= 0)) return false;
  return true;
}

export function validateReviewResult(record) {
  if (record == null || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, error: "review_result_shape_invalid" };
  }
  if (record.schema !== REVIEW_RESULT_SCHEMA) return { ok: false, error: "review_result_schema_unknown" };
  if (Object.keys(record).some((key) => !REVIEW_RESULT_KEYS.has(key))) {
    return { ok: false, error: "review_result_unknown_field" };
  }
  if (!REVIEW_HANDLE_RE.test(String(record.review_handle))) return { ok: false, error: "review_result_handle_invalid" };
  const scalarShape = validBoundedString(record.repository_id, 300)
    && Number.isInteger(record.issue_number) && record.issue_number > 0
    && record.reviewer === "codex"
    && Number.isInteger(record.expected_cycle) && record.expected_cycle > 0
    && Number.isInteger(record.cap) && record.cap > 0
    && validBoundedString(record.branch, 200)
    && validBoundedString(record.base_branch, 200)
    && /^[0-9a-f]{64}$/.test(String(record.original_digest))
    && ["unpublished", "published", "stale", "not_publishable",
      "unpublished_failure", "published_failure"].includes(record.publication_status)
    && validBoundedString(record.created_at, 100)
    && validBoundedString(record.updated_at, 100);
  if (!scalarShape || !validateRevision(record.revision)) return { ok: false, error: "review_result_shape_invalid" };
  if (digestJson(originalReviewPayload(record)) !== record.original_digest) {
    return { ok: false, error: "review_result_digest_mismatch" };
  }
  if (!Array.isArray(record.findings) || record.findings.length > 500 || !record.findings.every(validateFinding)) {
    return { ok: false, error: "review_result_findings_invalid" };
  }
  if (!["verdict", "non_verdict"].includes(record.kind)
    || (record.kind === "verdict" && !["ship", "ship-with-fixes", "don't-ship"].includes(record.verdict))
    || (record.kind === "non_verdict" && record.verdict !== null)
    || !Array.isArray(record.notes) || record.notes.length > 2
    || record.notes.some((note) => note == null || typeof note !== "object"
      || !validBoundedString(note.text, 4000))) {
    return { ok: false, error: "review_result_semantics_invalid" };
  }
  if (new Set(record.findings.map((finding) => finding.id)).size !== record.findings.length) {
    return { ok: false, error: "review_result_finding_ids_duplicate" };
  }
  if (record.coverage == null || typeof record.coverage !== "object" || record.terminal == null || typeof record.terminal !== "object") {
    return { ok: false, error: "review_result_shape_invalid" };
  }
  const failureCauses = record.terminal.failure_causes;
  if (failureCauses !== undefined && (!Array.isArray(failureCauses)
    || failureCauses.length < 1 || failureCauses.length > REVIEW_FAILURE_CAUSES.length
    || new Set(failureCauses).size !== failureCauses.length
    || failureCauses.some((cause) => !REVIEW_FAILURE_CAUSES.includes(cause)))) {
    return { ok: false, error: "review_result_failure_invalid" };
  }
  if (record.kind === "non_verdict") {
    const attempts = record.terminal.attempts;
    if (!["unpublished_failure", "published_failure", "stale"].includes(record.publication_status)
      || record.terminal.error !== "review_coverage_incomplete"
      || record.coverage.complete !== false
      || record.findings.length > 0 || record.notes.length > 0
      || !Array.isArray(attempts) || attempts.length < 1 || attempts.length > 3
      || attempts.some((attempt, index) => attempt == null
        || attempt.station_id !== "codex_review"
        || attempt.station_result !== "not_evaluable"
        || attempt.failure_class !== "incomplete_reviewer_coverage"
        || attempt.attempt_ordinal !== index + 1)) {
      return { ok: false, error: "review_result_failure_invalid" };
    }
  } else if (["unpublished_failure", "published_failure"].includes(record.publication_status)) {
    return { ok: false, error: "review_result_failure_invalid" };
  }
  if (record.architectural_read !== null && typeof record.architectural_read !== "string") {
    return { ok: false, error: "review_result_shape_invalid" };
  }
  if (["published", "published_failure"].includes(record.publication_status)
    && (record.publication_receipt == null || typeof record.publication_receipt !== "object")) {
    return { ok: false, error: "review_result_receipt_missing" };
  }
  return { ok: true, record };
}

function reviewResultDirectory(gitDir) {
  if (typeof gitDir !== "string" || !isAbsolute(gitDir)) throw new Error("gitDir must be absolute");
  const canonical = realpathSync(gitDir);
  const directory = join(canonical, REVIEW_RESULT_DIRECTORY);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error("review result directory is unsafe"), { code: "review_result_directory_unsafe" });
  chmodSync(directory, 0o700);
  return directory;
}

function recordPath(gitDir, handle) {
  if (!REVIEW_HANDLE_RE.test(String(handle))) throw Object.assign(new Error("invalid review handle"), { code: "review_result_handle_invalid" });
  return join(reviewResultDirectory(gitDir), `${handle}.json`);
}

function assertRegularTarget(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error("review result is not a regular file"), { code: "review_result_not_regular_file" });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}

export function writeReviewResult(gitDir, record) {
  const validation = validateReviewResult(record);
  if (!validation.ok) throw Object.assign(new Error(validation.error), { code: validation.error });
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > REVIEW_RESULT_MAX_BYTES) {
    throw Object.assign(new Error("review_result_too_large"), { code: "review_result_too_large" });
  }
  const directory = reviewResultDirectory(gitDir);
  const path = recordPath(gitDir, record.review_handle);
  assertRegularTarget(path);
  const tmp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("review result temporary path is not a regular file");
    writeSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return record;
}

export function readReviewResult(gitDir, handle) {
  let path;
  try { path = recordPath(gitDir, handle); } catch (error) {
    return { ok: false, error: error.code ?? "review_result_handle_invalid" };
  }
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    return { ok: false, error: error.code === "ENOENT" ? "review_result_not_found" : "review_result_unreadable" };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, error: "review_result_not_regular_file" };
  if (stat.size > REVIEW_RESULT_MAX_BYTES) return { ok: false, error: "review_result_too_large" };
  let fd;
  let parsed;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { ok: false, error: "review_result_not_regular_file" };
    if (opened.size > REVIEW_RESULT_MAX_BYTES) return { ok: false, error: "review_result_too_large" };
    parsed = JSON.parse(readFileSync(fd, "utf8"));
  } catch (error) {
    if (error.code === "ELOOP") return { ok: false, error: "review_result_not_regular_file" };
    return { ok: false, error: "review_result_unparseable" };
  } finally {
    if (fd != null) closeSync(fd);
  }
  return validateReviewResult(parsed);
}

function publicationFailure(error, message) {
  return { ok: false, error, message };
}

export function validateSanitizedReviewPublication(record, input) {
  const validRecord = validateReviewResult(record);
  if (!validRecord.ok) return publicationFailure(validRecord.error, "retained review result is invalid");
  if (record.kind !== "verdict") {
    return publicationFailure("review_publication_wrong_kind", "non-verdict attempts require the station-failure publication path");
  }
  if (input == null || typeof input !== "object" || !Array.isArray(input.findings)) {
    return publicationFailure("review_publication_input_invalid", "findings must be an array");
  }
  if (Object.keys(input).some((key) => !["verdict", "notes", "architectural_read", "findings"].includes(key))) {
    return publicationFailure("review_publication_input_unknown_field", "publication input contains an unknown field");
  }
  if (!validBoundedString(input.architectural_read, 20000)) {
    return publicationFailure("review_publication_architectural_read_invalid", "architectural_read must be bounded non-empty text");
  }
  if (input.verdict !== record.verdict) {
    return publicationFailure("review_publication_verdict_mismatch", "the retained verdict must be published unchanged");
  }
  if (!Array.isArray(input.notes) || input.notes.length > 2
    || input.notes.some((note) => note == null || typeof note !== "object"
      || Object.keys(note).some((key) => key !== "text") || !validBoundedString(note.text, 4000))) {
    return publicationFailure("review_publication_notes_invalid", "notes must contain at most two bounded {text} entries");
  }
  if (input.notes.length !== record.notes.length) {
    return publicationFailure("review_publication_notes_mismatch", "every retained reviewer note must have one sanitized public note");
  }
  const architecturalMarker = rejectReservedMarkerSequence(input.architectural_read, "architectural_read");
  if (architecturalMarker) return publicationFailure("review_publication_reserved_marker", architecturalMarker);
  for (const [index, note] of input.notes.entries()) {
    const marker = rejectReservedMarkerSequence(note.text, `notes.${index}.text`);
    if (marker) return publicationFailure("review_publication_reserved_marker", marker);
  }
  const ids = input.findings.map((finding) => finding?.id);
  if (new Set(ids).size !== ids.length) return publicationFailure("review_publication_finding_ids_duplicate", "finding ids must be unique");
  const originals = new Map(record.findings.map((finding) => [finding.id, finding]));
  if (ids.length !== originals.size || ids.some((id) => !originals.has(id))) {
    return publicationFailure("review_publication_finding_set_mismatch", "sanitized findings must map every retained finding exactly once");
  }
  for (const finding of input.findings) {
    if (finding == null || typeof finding !== "object"
      || Object.keys(finding).some((key) => !SANITIZED_FINDING_KEYS.has(key))) {
      return publicationFailure("review_publication_finding_unknown_field", "a sanitized finding contains an unknown field");
    }
    const original = originals.get(finding.id);
    if (finding.classification !== original.classification) {
      return publicationFailure("review_publication_classification_mismatch", `classification changed for ${finding.id}`);
    }
    if (!DECISION_RECORD_DECISIONS.includes(finding.decision)) {
      return publicationFailure("review_publication_decision_invalid", `decision is invalid for ${finding.id}`);
    }
    if (Boolean(finding.structural_blocker) !== Boolean(original.structural_blocker)) {
      return publicationFailure("review_publication_structural_mismatch", `structural blocker changed for ${finding.id}`);
    }
    if (!validBoundedString(finding.title, 200) || !validBoundedString(finding.rationale, 4000)) {
      return publicationFailure("review_publication_prose_invalid", `sanitized prose is invalid for ${finding.id}`);
    }
    if (finding.location != null && !validBoundedString(finding.location, 4096)) {
      return publicationFailure("review_publication_location_invalid", `location is invalid for ${finding.id}`);
    }
    if (finding.decision === "wontfix" && !validBoundedString(finding.user_authorization, 2000)) {
      return publicationFailure("review_publication_wontfix_unauthorized", `wontfix lacks authorization for ${finding.id}`);
    }
    if (finding.classification === "class" && (!Array.isArray(finding.instances)
      || finding.instances.length < 2 || finding.instances.length > 500
      || finding.instances.some((instance) => !validBoundedString(instance, 4096)))) {
      return publicationFailure("review_publication_instances_invalid", `class finding lacks instances for ${finding.id}`);
    }
    for (const [name, value] of Object.entries(finding)) {
      if (typeof value === "string") {
        const marker = rejectReservedMarkerSequence(value, `findings.${finding.id}.${name}`);
        if (marker) return publicationFailure("review_publication_reserved_marker", marker);
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          const marker = rejectReservedMarkerSequence(entry, `findings.${finding.id}.${name}`);
          if (marker) return publicationFailure("review_publication_reserved_marker", marker);
        }
      }
    }
  }
  const value = {
    verdict: input.verdict,
    notes: input.notes.map((note) => ({ text: note.text.trim() })),
    architectural_read: input.architectural_read.trim(),
    findings: input.findings.map((finding) => ({ ...finding })),
  };
  const decisionValidation = validateDecisionRecordInput({
    issueNumber: record.issue_number,
    cycle: record.expected_cycle,
    reviewer: "codex",
    verdict: value.verdict,
    notes: value.notes,
    architectural_read: value.architectural_read,
    findings: value.findings,
  });
  if (!decisionValidation.ok) {
    return publicationFailure("review_publication_decision_invalid", decisionValidation.errors.join("; "));
  }
  return { ok: true, value, sanitized_digest: digestJson(value) };
}
