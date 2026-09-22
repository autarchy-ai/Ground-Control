import { readIssueCommentsWithAuthors, resolveExecutionObligationTrust } from "./grc-legacy-compat-3.js";
import {
  markerMatchesReviewPublicationProof,
  parseReviewPublicationMarkers,
  reviewPublicationTupleKey,
} from "./review-publication-markers.js";

function trustedComments(comments, trust) {
  return comments.filter((comment) => trust.isTrusted(comment));
}

function commentRecord(comment, owner, name, issueNumber) {
  const id = comment.id ?? null;
  return { id, url: Number.isInteger(id)
    ? `https://github.com/${owner}/${name}/issues/${issueNumber}#issuecomment-${id}` : null };
}

async function readTrustedComments({ repoRoot, owner, name, issueNumber }, { readComments, resolveTrust }) {
  const comments = await readComments(repoRoot, owner, name, issueNumber);
  const trust = await resolveTrust(repoRoot, owner, name, comments);
  return { comments, trusted: trustedComments(comments, trust) };
}

function publicationStages(comments, predicate) {
  const stages = [];
  for (const comment of comments) {
    for (const marker of parseReviewPublicationMarkers(comment.body)) {
      if (marker.malformed || !predicate(marker)) continue;
      stages.push({ marker, comment });
    }
  }
  return stages;
}

function hasMalformedPublicationMarker(comments) {
  return comments.some((comment) => parseReviewPublicationMarkers(comment.body).some((marker) => marker.malformed));
}

function uniqueOrderedStages(stages) {
  const grouped = new Map();
  for (const entry of stages) {
    if (grouped.has(entry.marker.stage)) return { ok: false, error: "review_publication_evidence_ambiguous" };
    grouped.set(entry.marker.stage, entry);
  }
  const findings = grouped.get("findings") ?? null;
  const cycle = grouped.get("cycle") ?? null;
  const decision = grouped.get("decision") ?? null;
  if ((cycle != null && findings == null) || (decision != null && cycle == null)) {
    return { ok: false, error: "review_publication_progress_inconsistent" };
  }
  const ids = [findings, cycle, decision].filter(Boolean).map(({ comment }) => comment.id);
  if (ids.every(Number.isInteger) && ids.some((id, index) => index > 0 && id <= ids[index - 1])) {
    return { ok: false, error: "review_publication_progress_inconsistent" };
  }
  return { ok: true, findings, cycle, decision };
}

export async function readTrustedReviewPublicationProgress(
  { repoRoot, owner, name, issueNumber, cycle, proof, stationObservation = null },
  { readComments = readIssueCommentsWithAuthors, resolveTrust = resolveExecutionObligationTrust } = {},
) {
  let trusted;
  try {
    ({ trusted } = await readTrustedComments(
      { repoRoot, owner, name, issueNumber }, { readComments, resolveTrust },
    ));
  } catch {
    return { ok: false, error: "review_publication_progress_unverifiable",
      message: "Existing publication markers could not be verified before retrying." };
  }
  if (hasMalformedPublicationMarker(trusted)) return { ok: false,
    error: "review_publication_evidence_malformed", message: "A trusted review publication marker is malformed." };
  const stages = publicationStages(trusted, (marker) => markerMatchesReviewPublicationProof(marker, {
    issueNumber, cycle, proof,
  }));
  const ordered = uniqueOrderedStages(stages);
  if (!ordered.ok) return { ...ordered,
    message: "Trusted publication markers are duplicated or do not preserve the required findings/cycle/decision order." };
  const progress = {
    findings: ordered.findings == null ? null : commentRecord(ordered.findings.comment, owner, name, issueNumber),
    reobservation: null,
    cycle: ordered.cycle == null ? null : commentRecord(ordered.cycle.comment, owner, name, issueNumber),
    decision: ordered.decision == null ? null : commentRecord(ordered.decision.comment, owner, name, issueNumber),
  };
  if (stationObservation != null && Number.isInteger(progress.findings?.id)) {
    const obligation = String(stationObservation.obligationId).replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const recordId = progress.findings.id;
    // eslint-disable-next-line security/detect-non-literal-regexp -- obligation is escaped and came from a validated retained artifact
    const marker = new RegExp(
      String.raw`<!--\s*gc:execution-obligation\s+[^>]*id="${obligation}"[^>]*event="resolved"[^>]*disposition="reobserved"[^>]*observation_record_id="${recordId}"[^>]*-->`,
    );
    const matched = trusted.find((comment) => marker.test(comment.body));
    if (matched) progress.reobservation = { id: matched.id ?? null, url: null };
  }
  return { ok: true, ...progress };
}

function groupPublicationTuples(trusted, issueNumber) {
  const all = publicationStages(trusted, (marker) => marker.issue_number === issueNumber);
  const tuples = new Map();
  for (const entry of all) {
    const key = reviewPublicationTupleKey(entry.marker);
    if (!tuples.has(key)) tuples.set(key, []);
    tuples.get(key).push(entry);
  }
  return tuples;
}

function orderedPublicationTuples(tuples) {
  const complete = [];
  let latestConsumedCycle = 0;
  const consumedCycles = new Set();
  for (const stages of tuples.values()) {
    const ordered = uniqueOrderedStages(stages);
    if (!ordered.ok) return { ...ordered, published: false,
      message: "Review publication evidence is duplicated or out of order." };
    if (ordered.cycle != null) {
      const cycle = ordered.cycle.marker.cycle;
      if (consumedCycles.has(cycle)) return { ok: false, published: false,
        error: "review_publication_evidence_ambiguous",
        message: "More than one trusted publication consumed the same review cycle." };
      consumedCycles.add(cycle);
      latestConsumedCycle = Math.max(latestConsumedCycle, ordered.cycle.marker.cycle);
    }
    if (ordered.findings != null && ordered.cycle != null && ordered.decision != null) complete.push(ordered);
  }
  return { ok: true, complete, latestConsumedCycle };
}

function latestPublicationEvidence(tuples) {
  const ordered = orderedPublicationTuples(tuples);
  if (!ordered.ok) return ordered;
  const { complete, latestConsumedCycle } = ordered;
  if (complete.length === 0) return { ok: true, published: false };
  complete.sort((left, right) => right.decision.marker.cycle - left.decision.marker.cycle);
  if (complete.some((entry, index) => index > 0
    && entry.decision.marker.cycle === complete[index - 1].decision.marker.cycle)) {
    return { ok: false, published: false,
      error: "review_publication_evidence_ambiguous",
      message: "More than one complete trusted review publication tuple exists for the same review cycle." };
  }
  const evidence = complete[0];
  if (evidence.decision.marker.cycle !== latestConsumedCycle) {
    return { ok: true, published: false };
  }
  // A v1 tuple names no candidate tree, so nothing ties it to the work being
  // delivered. It stays readable for audit but cannot authorize a delivery; the
  // run publishes a current cycle instead (issue #1679).
  if (evidence.decision.marker.candidate_tree_oid == null) {
    return { ok: true, published: false,
      message: "The latest trusted review publication predates revision binding and cannot authorize a delivery. "
        + "Run and publish a review cycle on the current revision." };
  }
  return { ok: true, published: true, cycle: evidence.decision.marker.cycle,
    comment_id: evidence.decision.comment.id ?? null,
    publication_id: evidence.decision.marker.publication_id,
    // Carried, not dropped: the gates below bind a delivery to what was reviewed.
    revision_digest: evidence.decision.marker.revision_digest,
    candidate_tree_oid: evidence.decision.marker.candidate_tree_oid,
    findings_count: evidence.decision.marker.findings_count,
    // Only the cycle marker records the branch a review ran on.
    branch: evidence.cycle.marker.branch ?? null };
}

export async function readTrustedReviewPublicationEvidence(
  { repoRoot, owner, name, issueNumber },
  { readComments = readIssueCommentsWithAuthors, resolveTrust = resolveExecutionObligationTrust } = {},
) {
  let trusted;
  try {
    ({ trusted } = await readTrustedComments(
      { repoRoot, owner, name, issueNumber }, { readComments, resolveTrust },
    ));
  } catch {
    return { ok: false, error: "review_publication_evidence_unverifiable",
      message: "The issue thread or decision-record author trust could not be verified." };
  }
  if (hasMalformedPublicationMarker(trusted)) return { ok: false, published: false,
    error: "review_publication_evidence_malformed", message: "A trusted review publication marker is malformed." };
  return latestPublicationEvidence(groupPublicationTuples(trusted, issueNumber));
}
