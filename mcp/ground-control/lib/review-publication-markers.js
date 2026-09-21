// v2 adds the two fields that let a gate bind a publication to a delivery: the
// candidate tree the review covered, and how many findings it carried (issue
// #1679). v1 markers stay readable for audit but cannot authorize a delivery,
// because they name no tree.
export const REVIEW_PUBLICATION_MARKER_SCHEMA = "gc.review-publication/v2";
const REVIEW_PUBLICATION_MARKER_SCHEMA_V1 = "gc.review-publication/v1";

const HEX_64_RE = /^[0-9a-f]{64}$/;
const GIT_TREE_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MARKER_RE = /<!--\s*(gc:review-publication|gc:codex-prepush-cycle|gc:decision-record)\s+([^]*?)-->/g;
const ATTR_RE = /([a-z_]+)="((?:\\.|[^"])*)"/g;
const COMMON_PROVENANCE_ATTRIBUTES = ["schema", "publication", "original", "revision", "sanitized", "tree", "findings"];
const STAGE_ATTRIBUTES = {
  findings: new Set(["stage", "reviewer", "issue", "cycle", ...COMMON_PROVENANCE_ATTRIBUTES]),
  cycle: new Set(["issue", "branch", "cycle", "override", "reason", ...COMMON_PROVENANCE_ATTRIBUTES]),
  decision: new Set(["reviewer", "cycle", "issue", ...COMMON_PROVENANCE_ATTRIBUTES]),
};

function parseAttributes(source) {
  const attributes = {};
  let cursor = 0;
  for (const match of source.matchAll(ATTR_RE)) {
    if (source.slice(cursor, match.index).trim() !== "") return null;
    if (Object.hasOwn(attributes, match[1])) return null;
    attributes[match[1]] = match[2];
    cursor = match.index + match[0].length;
  }
  if (source.slice(cursor).trim() !== "") return null;
  return attributes;
}

export function buildReviewPublicationMarkerAttributes(proof) {
  return [
    `schema="${REVIEW_PUBLICATION_MARKER_SCHEMA}"`,
    `publication="${proof.publication_id}"`,
    `original="${proof.original_digest}"`,
    `revision="${proof.revision_digest}"`,
    `sanitized="${proof.sanitized_digest}"`,
    `tree="${proof.candidate_tree_oid}"`,
    `findings="${proof.findings_count}"`,
  ].join(" ");
}

function markerSchemaVersion(schema) {
  if (schema === REVIEW_PUBLICATION_MARKER_SCHEMA) return 2;
  if (schema === REVIEW_PUBLICATION_MARKER_SCHEMA_V1) return 1;
  return null;
}

function canonicalStage(name, attributes, body) {
  if (name === "gc:review-publication" && attributes.stage === "findings"
    && attributes.reviewer === "codex"
    && body.includes("**gc_codex_review** — sanitized deferred publication")) return "findings";
  if (name === "gc:codex-prepush-cycle"
    && body.includes("_gc_codex_review pre-push cycle")) return "cycle";
  if (name === "gc:decision-record" && attributes.reviewer === "codex"
    && body.includes("## Review decision record — codex cycle")) return "decision";
  return null;
}

export function parseReviewPublicationMarkers(body) {
  if (typeof body !== "string") return [];
  const parsed = [];
  for (const match of body.matchAll(MARKER_RE)) {
    const attributes = parseAttributes(match[2]);
    if (attributes == null) {
      if (match[2].includes(REVIEW_PUBLICATION_MARKER_SCHEMA)
        || match[2].includes(REVIEW_PUBLICATION_MARKER_SCHEMA_V1)) parsed.push({ stage: null, malformed: true });
      continue;
    }
    const version = markerSchemaVersion(attributes?.schema);
    if (version == null) continue;
    const stage = canonicalStage(match[1], attributes, body);
    const issue = Number(attributes.issue);
    const cycle = Number(attributes.cycle);
    const findingsCount = Number(attributes.findings);
    const valid = stage != null
      && Object.keys(attributes).every((name) => STAGE_ATTRIBUTES[stage].has(name))
      && Number.isInteger(issue) && issue > 0
      && Number.isInteger(cycle) && cycle > 0
      && HEX_64_RE.test(attributes.publication ?? "")
      && HEX_64_RE.test(attributes.original ?? "")
      && HEX_64_RE.test(attributes.revision ?? "")
      && HEX_64_RE.test(attributes.sanitized ?? "")
      // v1 carries neither field and must carry neither; v2 requires both.
      && (version === 1
        ? attributes.tree === undefined && attributes.findings === undefined
        : GIT_TREE_OID_RE.test(attributes.tree ?? "")
          && Number.isInteger(findingsCount) && findingsCount >= 0);
    parsed.push(valid ? {
      stage,
      schema_version: version,
      issue_number: issue,
      cycle,
      publication_id: attributes.publication,
      original_digest: attributes.original,
      revision_digest: attributes.revision,
      sanitized_digest: attributes.sanitized,
      candidate_tree_oid: version === 1 ? null : attributes.tree,
      findings_count: version === 1 ? null : findingsCount,
      // Only the cycle stage carries it; it is the branch the review ran on.
      branch: attributes.branch ?? null,
    } : { stage: null, malformed: true });
  }
  return parsed;
}

export function reviewPublicationTupleKey(marker) {
  return [
    marker.issue_number, marker.cycle, marker.publication_id,
    marker.original_digest, marker.revision_digest, marker.sanitized_digest,
    marker.candidate_tree_oid ?? "-", marker.findings_count ?? "-",
  ].join(":");
}

export function markerMatchesReviewPublicationProof(marker, expected) {
  return marker.issue_number === expected.issueNumber
    && marker.cycle === expected.cycle
    && marker.publication_id === expected.proof.publication_id
    && marker.original_digest === expected.proof.original_digest
    && marker.revision_digest === expected.proof.revision_digest
    && marker.sanitized_digest === expected.proof.sanitized_digest
    && marker.candidate_tree_oid === expected.proof.candidate_tree_oid
    && marker.findings_count === expected.proof.findings_count;
}
