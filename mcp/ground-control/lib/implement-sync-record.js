// The durable synchronization record: the issue-thread attestation binding a
// delivery to the base it was synchronized against and, since issue #1679, to the
// review that authorized it.
//
// Split out of codex-workflow.js when the v2 binding attributes pushed that module
// past the repo's 500-line limit (docs/CODING_STANDARDS.md, Sonar S104). Build,
// parse and the vocabulary both sides share are one concern and read better whole.

import { randomBytes } from "node:crypto";
import { GIT_OBJECT_ID_RE, validateImplementBranchName } from "./codex-workflow.js";
import { isSafeGitRefName } from "./repo-context.js";

// v2 makes this record the bridge from review to delivery (issue #1679): besides
// the heads and trees it always carried, it names the trusted review publication
// it was bound against, that review's revision digest, the settled tree the
// delivery work produced, and the lane derived from the run's own pickup record.
// A v1 record no longer parses, so an in-flight run re-synchronizes rather than
// being accepted on evidence that binds nothing.
export const IMPLEMENT_BASE_SYNC_SCHEMA = "gc.implement.remote-base-sync/v2";
// Historical records stay readable so one on an issue's thread cannot stop that
// issue from re-synchronizing; they are simply not authorization (issue #1679).
export const IMPLEMENT_BASE_SYNC_SCHEMA_V1 = "gc.implement.remote-base-sync/v1";
// `-` is the absent-publication sentinel: the /quickfix lane runs no mandatory
// review, so it has no publication to name.
export const IMPLEMENT_BASE_SYNC_NO_PUBLICATION = "-";
export const IMPLEMENT_BASE_SYNC_ACTIONS = Object.freeze(["start", "complete"]);
export const IMPLEMENT_BASE_SYNC_OUTCOMES = Object.freeze([
  "already_current",
  "merged_clean",
  "merged_conflicts_resolved",
]);
const IMPLEMENT_BASE_SYNC_MARKER_PREFIX = "<!-- gc:implement-base-sync";

export function newImplementSyncRecordId() {
  return randomBytes(16).toString("hex");
}

export function buildImplementBaseSyncMarker(record) {
  return [
    IMPLEMENT_BASE_SYNC_MARKER_PREFIX,
    `schema="${IMPLEMENT_BASE_SYNC_SCHEMA}"`,
    `record="${record.recordId}"`,
    `issue="${record.issueNumber}"`,
    `branch="${record.branchName}"`,
    `base="${record.baseBranch}"`,
    `source="${record.remoteRef}"`,
    `pre="${record.preSyncSha}"`,
    `fetched="${record.fetchedBaseSha}"`,
    `outcome="${record.outcome}"`,
    `result="${record.resultingFeatureSha}"`,
    `verified="${record.verifiedTreeSha}"`,
    `settled="${record.settledTreeSha}"`,
    `review="${record.reviewPublicationId}"`,
    `revision="${record.reviewRevisionDigest}"`,
    `lane="${record.lane}"`,
    "-->",
  ].join(" ");
}
const RUN_LANE_VALUES = new Set(["implement", "quickfix"]);
function isSyncPublicationField(value) {
  return value === IMPLEMENT_BASE_SYNC_NO_PUBLICATION || /^[0-9a-f]{64}$/.test(value ?? "");
}
function baseSyncSchemaVersion(schema) {
  if (schema === IMPLEMENT_BASE_SYNC_SCHEMA) return 2;
  if (schema === IMPLEMENT_BASE_SYNC_SCHEMA_V1) return 1;
  return null;
}

function readMarkerAttributes(text) {
  const attrs = {};
  for (const [, key, value] of text.matchAll(/([a-z]+)="([^"]*)"/g)) attrs[key] = value;
  return attrs;
}

function commonSyncFieldsValid(attrs, schemaVersion, issueNumber) {
  return schemaVersion != null
    && Number.parseInt(attrs.issue ?? "", 10) === issueNumber
    && /^[0-9a-f]{32}$/.test(attrs.record ?? "")
    && validateImplementBranchName(attrs.branch, issueNumber).ok === true
    && isSafeGitRefName(attrs.base)
    && attrs.source === `refs/remotes/origin/${attrs.base}`
    && IMPLEMENT_BASE_SYNC_OUTCOMES.includes(attrs.outcome)
    && ["pre", "fetched", "result", "verified"].every((key) => GIT_OBJECT_ID_RE.test(attrs[key] ?? ""));
}

// v1 carries none of the binding attributes and must carry none; v2 requires
// all of them. A well-formed v1 record stays `valid` so it does not poison a
// read of the whole thread - it simply cannot authorize a delivery, which the
// reader enforces when it selects one (issue #1679, core-F4).
function bindingSyncFieldsValid(attrs, schemaVersion) {
  if (schemaVersion === 1) return ["settled", "review", "revision", "lane"].every((key) => attrs[key] === undefined);
  return GIT_OBJECT_ID_RE.test(attrs.settled ?? "")
    && isSyncPublicationField(attrs.review)
    && isSyncPublicationField(attrs.revision)
    && RUN_LANE_VALUES.has(attrs.lane);
}

// The record a marker's attributes describe, or null when they do not validate.
function parseImplementBaseSyncMarker(attributeText, issueNumber) {
  const attrs = readMarkerAttributes(attributeText);
  const schemaVersion = baseSyncSchemaVersion(attrs.schema);
  if (!commonSyncFieldsValid(attrs, schemaVersion, issueNumber) || !bindingSyncFieldsValid(attrs, schemaVersion)) {
    return null;
  }
  return {
    valid: true,
    schemaVersion,
    recordId: attrs.record,
    issueNumber,
    branchName: attrs.branch,
    baseBranch: attrs.base,
    remoteRef: attrs.source,
    preSyncSha: attrs.pre,
    fetchedBaseSha: attrs.fetched,
    outcome: attrs.outcome,
    resultingFeatureSha: attrs.result,
    verifiedTreeSha: attrs.verified,
    ...(schemaVersion === 1 ? {} : {
      settledTreeSha: attrs.settled,
      reviewPublicationId: attrs.review,
      reviewRevisionDigest: attrs.revision,
      lane: attrs.lane,
    }),
  };
}

export function parseImplementBaseSyncMarkers(commentBodies, issueNumber) {
  const markerRe = /<!--\s*gc:implement-base-sync\s+([^>]*?)-->/g;
  return (Array.isArray(commentBodies) ? commentBodies : [])
    .filter((body) => typeof body === "string")
    .flatMap((body) => [...body.matchAll(markerRe)])
    .map((match) => parseImplementBaseSyncMarker(match[1], issueNumber) ?? { valid: false, raw: match[0] });
}

/**
 * The newest binding-bearing record for a branch among trusted `{comment, record}`
 * entries, or null. Comment ids increase with time, so the highest id is newest.
 *
 * With `before`, the selection ends just ahead of that record when it is already
 * on the thread. A synchronization's settlement is carried from the record that
 * preceded it, so a completion retried after its own record was posted must see
 * the same predecessor the first attempt saw, not the record it just wrote
 * (issue #1679).
 */
export function selectLatestSyncRecord(entries, branchName, { before = null } = {}) {
  const candidates = (entries ?? [])
    .filter(({ record }) => record.schemaVersion === 2 && record.branchName === branchName)
    .sort((left, right) => (left.comment.id ?? 0) - (right.comment.id ?? 0));
  const own = before == null ? -1 : candidates.findIndex(({ record }) => record.recordId === before);
  return (own === -1 ? candidates : candidates.slice(0, own)).at(-1) ?? null;
}
