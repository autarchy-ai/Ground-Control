// One parsed-marker + trust helper for the `gc:final-report` record (issue #1671).
//
// The marker is proof that post-merge requirement-state validation succeeded, and two
// places need that answer: publication, which must not post a second report for a delivery
// already reported, and close, which must not close an issue the validation never cleared.
// They used to disagree in kind — publication did not check at all, close did a substring
// scan — so both now read through here.
//
// The marker is bound to THIS pull request, not just the issue: a stale final report from
// an earlier linked pull request must not authorize a later close (issue #1541 review).
//
// `gc:final-report` itself is unchanged, down to the byte; `buildFinalReportMarker` in
// doc-coverage.js still owns its shape. When the deterministic finalizer is the author it
// adds a SEPARATE `gc:finalizer-run` marker beside it, because "a validated report exists"
// and "this run produced it" are two different facts, and only the second needs verifying.

import { isRepositoryAutomationAuthor, verifyFinalizerRunProvenance } from "./automation-provenance.js";
import { readIssueCommentsWithAuthors, resolveExecutionObligationTrust } from "./grc-legacy-compat-3.js";
import { ghRestJson } from "./github-rest.js";

const FINAL_REPORT_RE = /<!--\s*gc:final-report\s+([^\n>]*?)\s*-->/g;
const FINALIZER_RUN_RE = /<!--\s*gc:finalizer-run\s+([^\n>]*?)\s*-->/g;
const ATTRIBUTE_RE = /([a-z]+)="([^"]*)"/g;

function positiveInt(raw) {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function attributes(text) {
  const out = {};
  for (const [, key, value] of text.matchAll(ATTRIBUTE_RE)) out[key] = value;
  return out;
}

/** The provenance line the deterministic finalizer adds, as zero or one body lines. */
export function buildFinalizerRunMarker({ prNumber, runId }) {
  if (!Number.isInteger(runId) || runId <= 0) return [];
  return [`<!-- gc:finalizer-run pr="${prNumber}" id="${runId}" -->`];
}

export function parseFinalReportMarkers(body) {
  if (typeof body !== "string") return [];
  return [...body.matchAll(FINAL_REPORT_RE)].map(([, attrText]) => {
    const attrs = attributes(attrText);
    return { issue: positiveInt(attrs.issue), pr: positiveInt(attrs.pr) };
  });
}

export function parseFinalizerRunMarkers(body) {
  if (typeof body !== "string") return [];
  return [...body.matchAll(FINALIZER_RUN_RE)].map(([, attrText]) => {
    const attrs = attributes(attrText);
    return { pr: positiveInt(attrs.pr), id: positiveInt(attrs.id) };
  });
}

/**
 * The trusted final-report marker for one issue + pull request, if any.
 *
 * Trust is repository write permission on the author, exactly as before. The repository's
 * own verified finalizer run is the one added class, and it is deliberately scoped to this
 * marker: it does not satisfy `wontfix` authorization or the merged-state override, both of
 * which still require a repo-write human.
 *
 * @returns {Promise<{found: boolean, commentId: number|null, viaAutomation: boolean}>}
 */
export async function findTrustedFinalReportMarker(
  { repoRoot, owner, name, issueNumber, prNumber },
  {
    readComments = readIssueCommentsWithAuthors,
    resolveTrust = resolveExecutionObligationTrust,
    ghJson = ghRestJson,
  } = {},
) {
  const none = { found: false, commentId: null, viaAutomation: false };
  let comments;
  try {
    comments = await readComments(repoRoot, owner, name, issueNumber);
  } catch {
    return none;
  }
  const matching = comments.filter((comment) =>
    parseFinalReportMarkers(comment.body).some((m) => m.issue === issueNumber && m.pr === prNumber));
  if (matching.length === 0) return none;

  const trust = await resolveTrust(repoRoot, owner, name, comments);
  const human = matching.find((comment) => trust.isTrusted(comment));
  if (human) return { found: true, commentId: human.id ?? null, viaAutomation: false };

  const isAutomation = typeof trust.isRepositoryAutomation === "function"
    ? (comment) => trust.isRepositoryAutomation(comment)
    : isRepositoryAutomationAuthor;
  for (const comment of matching.filter(isAutomation)) {
    // The provenance must name THIS pull request on the same comment, so a run id copied
    // from another delivery's report cannot vouch for this one.
    const run = parseFinalizerRunMarkers(comment.body).find((m) => m.pr === prNumber);
    const verified = await verifyFinalizerRunProvenance(
      { repoRoot, owner, name, prNumber, runId: run?.id ?? null },
      { ghJson },
    );
    if (verified) return { found: true, commentId: comment.id ?? null, viaAutomation: true };
  }
  return none;
}
