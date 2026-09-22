import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readTrustedReviewPublicationEvidence,
  readTrustedReviewPublicationProgress,
} from "./lib.js";

const proof = {
  publication_id: "a".repeat(64),
  original_digest: "b".repeat(64),
  revision_digest: "c".repeat(64),
  sanitized_digest: "d".repeat(64),
  // Issue #1679: the tuple names the tree it reviewed and how many findings it
  // carried, so a delivery can be bound to it.
  candidate_tree_oid: "1".repeat(40),
  findings_count: 0,
};
const attrs = `schema="gc.review-publication/v2" publication="${proof.publication_id}" original="${proof.original_digest}" revision="${proof.revision_digest}" sanitized="${proof.sanitized_digest}" tree="${proof.candidate_tree_oid}" findings="${proof.findings_count}"`;
const attrsV1 = `schema="gc.review-publication/v1" publication="${proof.publication_id}" original="${proof.original_digest}" revision="${proof.revision_digest}" sanitized="${proof.sanitized_digest}"`;

function publicationComments() {
  return [
    { id: 10, author: "bot", body: `<!-- gc:review-publication stage="findings" reviewer="codex" issue="1632" cycle="1" ${attrs} -->\n\n**gc_codex_review** — sanitized deferred publication` },
    { id: 11, author: "bot", body: `<!-- gc:codex-prepush-cycle issue="1632" branch="x" cycle="1" ${attrs} -->\n\n_gc_codex_review pre-push cycle 1 complete` },
    { id: 12, author: "bot", body: `<!-- gc:decision-record reviewer="codex" cycle="1" issue="1632" ${attrs} -->\n\n## Review decision record — codex cycle 1` },
  ];
}

describe("trusted review-publication evidence (#1632)", () => {
  it("rejects bare or partial decision markers", async () => {
    const comments = [{ id: 2, author: "bot", body: '<!-- gc:decision-record reviewer="codex" cycle="1" issue="1632" -->' }];
    const result = await readTrustedReviewPublicationEvidence({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
    }, { readComments: async () => comments, resolveTrust: async () => ({ isTrusted: () => true }) });
    assert.deepEqual(result, { ok: true, published: false });
  });

  it("accepts exactly one trusted canonical three-stage provenance tuple", async () => {
    const result = await readTrustedReviewPublicationEvidence({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
    }, {
      readComments: async () => publicationComments(),
      resolveTrust: async () => ({ isTrusted: (comment) => comment.author === "bot" }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.published, true);
    assert.equal(result.cycle, 1);
    assert.equal(result.comment_id, 12);
    // The binding fields the PR and completion gates consume (issue #1679).
    assert.equal(result.revision_digest, proof.revision_digest);
    assert.equal(result.candidate_tree_oid, proof.candidate_tree_oid);
    assert.equal(result.findings_count, 0);
    assert.equal(result.branch, "x");
  });

  it("reads a pre-binding tuple for audit but refuses to let it authorize a delivery", async () => {
    const legacy = publicationComments().map((comment) => ({
      ...comment,
      body: comment.body.replace(attrs, attrsV1),
    }));
    const result = await readTrustedReviewPublicationEvidence({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
    }, {
      readComments: async () => legacy,
      resolveTrust: async () => ({ isTrusted: () => true }),
    });
    assert.equal(result.ok, true, "a historical marker is not malformed");
    assert.equal(result.published, false);
    assert.match(result.message, /predates revision binding/);
  });

  it("ignores forged tuples from untrusted authors", async () => {
    const result = await readTrustedReviewPublicationEvidence({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
    }, {
      readComments: async () => publicationComments().map((comment) => ({ ...comment, author: "outsider" })),
      resolveTrust: async () => ({ isTrusted: () => false }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.published, false);
  });

  it("reconstructs ordered publication and reobservation progress from the full tuple", async () => {
    const obligation = "STATION-OBS-CODEX-REVIEW-C1";
    const comments = publicationComments();
    comments.splice(1, 0, { id: 10.5, author: "bot", body: `<!-- gc:execution-obligation schema="gc.implement.execution-obligation/v2" issue="1632" id="${obligation}" event="resolved" kind="station_observation" station="codex_review" cycle="1" disposition="reobserved" observation_record_id="10" -->` });
    const result = await readTrustedReviewPublicationProgress({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
      cycle: 1, proof, stationObservation: { obligationId: obligation },
    }, {
      readComments: async () => comments,
      resolveTrust: async () => ({ isTrusted: () => true }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.findings.id, 10);
    assert.equal(result.reobservation.id, 10.5);
    assert.equal(result.cycle.id, 11);
    assert.equal(result.decision.id, 12);
  });

  it("rejects duplicate and mismatched publication tuples", async () => {
    const duplicate = [...publicationComments(), { ...publicationComments()[2], id: 13 }];
    const duplicated = await readTrustedReviewPublicationEvidence({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
    }, { readComments: async () => duplicate, resolveTrust: async () => ({ isTrusted: () => true }) });
    assert.equal(duplicated.ok, false);
    assert.equal(duplicated.error, "review_publication_evidence_ambiguous");

    const mismatched = publicationComments();
    mismatched[2] = { ...mismatched[2], body: mismatched[2].body.replace(`sanitized="${proof.sanitized_digest}"`, `sanitized="${"e".repeat(64)}"`) };
    const result = await readTrustedReviewPublicationEvidence({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
    }, { readComments: async () => mismatched, resolveTrust: async () => ({ isTrusted: () => true }) });
    assert.equal(result.ok, false);
    assert.equal(result.published, false);
    assert.equal(result.error, "review_publication_progress_inconsistent");
  });

  it("fails closed on malformed versioned markers from a trusted author", async () => {
    const comments = publicationComments();
    comments[0] = { ...comments[0], body: comments[0].body.replace(' stage="findings"', ' unexpected="x" stage="findings"') };
    const result = await readTrustedReviewPublicationEvidence({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
    }, { readComments: async () => comments, resolveTrust: async () => ({ isTrusted: () => true }) });
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_publication_evidence_malformed");
  });

  it("fails closed on a marker of this family whose attributes cannot be parsed", async () => {
    const comments = publicationComments();
    comments[0] = { ...comments[0], body: comments[0].body.replace(' stage="findings"', ' stage="findings" stage="findings"') };
    const result = await readTrustedReviewPublicationEvidence({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
    }, { readComments: async () => comments, resolveTrust: async () => ({ isTrusted: () => true }) });
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_publication_evidence_malformed");
  });

  it("selects the latest complete cycle while allowing earlier published cycles", async () => {
    const earlier = publicationComments();
    const later = publicationComments().map((comment) => ({
      ...comment,
      id: comment.id + 10,
      body: comment.body
        .replaceAll('cycle="1"', 'cycle="2"')
        .replaceAll("cycle 1", "cycle 2")
        .replaceAll(proof.publication_id, "f".repeat(64)),
    }));
    const result = await readTrustedReviewPublicationEvidence({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
    }, { readComments: async () => [...earlier, ...later], resolveTrust: async () => ({ isTrusted: () => true }) });
    assert.equal(result.ok, true);
    assert.equal(result.published, true);
    assert.equal(result.cycle, 2);
    assert.equal(result.comment_id, 22);
  });

  it("does not accept an earlier complete cycle when the latest consumed cycle lacks a decision", async () => {
    const later = publicationComments().slice(0, 2).map((comment) => ({
      ...comment,
      id: comment.id + 10,
      body: comment.body.replaceAll('cycle="1"', 'cycle="2"')
        .replaceAll("cycle 1", "cycle 2")
        .replaceAll(proof.publication_id, "f".repeat(64)),
    }));
    const result = await readTrustedReviewPublicationEvidence({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
    }, { readComments: async () => [...publicationComments(), ...later],
      resolveTrust: async () => ({ isTrusted: () => true }) });
    assert.equal(result.ok, true);
    assert.equal(result.published, false);
  });

  it("rejects conflicting consumed tuples for the same latest cycle", async () => {
    const competing = publicationComments().slice(0, 2).map((comment) => ({
      ...comment,
      id: comment.id + 10,
      body: comment.body.replaceAll(proof.publication_id, "f".repeat(64)),
    }));
    const result = await readTrustedReviewPublicationEvidence({
      repoRoot: "/repo", owner: "fake", name: "repo", issueNumber: 1632,
    }, { readComments: async () => [...publicationComments(), ...competing],
      resolveTrust: async () => ({ isTrusted: () => true }) });
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_publication_evidence_ambiguous");
  });
});
