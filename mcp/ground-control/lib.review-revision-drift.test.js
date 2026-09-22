// Issue #1694: a stale review names what moved. A base-only move used to be
// reported as a working-tree change, and publication compared the digest alone,
// so a candidate-tree change slipped past it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewRevision,
  createReviewResult,
  describeReviewRevisionDrift,
  readReviewResult,
  retainDeferredCodexReview,
} from "./lib.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "d".repeat(40);

function revision(overrides = {}) {
  return buildReviewRevision({ headOid: HEAD, baseOid: BASE, candidateTreeOid: TREE,
    diffText: "diff", manifest: "manifest", ...overrides });
}

describe("describeReviewRevisionDrift (#1694)", () => {
  it("returns null for an unchanged revision", () => {
    assert.equal(describeReviewRevisionDrift(revision(), revision()), null);
  });

  it("names each kind of movement", () => {
    const cases = [
      [{ headOid: "c".repeat(40) }, "head_moved"],
      [{ candidateTreeOid: "e".repeat(40) }, "candidate_changed"],
      [{ baseOid: "f".repeat(40) }, "base_moved"],
      [{ diffText: "other diff" }, "review_input_changed"],
    ];
    for (const [change, cause] of cases) {
      const drift = describeReviewRevisionDrift(revision(), revision(change));
      assert.equal(drift?.cause, cause, JSON.stringify(change));
      assert.equal(typeof drift.message, "string");
    }
    const base = describeReviewRevisionDrift(revision(), revision({ baseOid: "f".repeat(40) }));
    assert.match(base.message, /base/);
    assert.doesNotMatch(base.message, /working tree/);
  });
});

describe("retainDeferredCodexReview staleness (#1694)", () => {
  async function retain(observed) {
    const gitDir = mkdtempSync(join(tmpdir(), "gc-drift-gitdir-"));
    try {
      const initial = revision();
      const result = await retainDeferredCodexReview({
        repoRoot: "/repo", repositoryId: "fake/repo", baseBranch: "dev", uncommitted: true,
        ownership: { issueNumber: 1694, cycleNumber: 1, cap: 1, branchName: "1694-review-diff" },
        initialRevision: initial, diffMode: "inline",
        reviewCoverage: { complete: true }, core: { findings: [] }, security: { findings: [] },
        terminal: { ok: true, next_action: "proceed_clean" },
      }, {
        commandRunner: async () => ({ stdout: `${observed.headOid ?? HEAD}\n` }),
        computeDiff: async () => ({ diffText: "diff", manifest: "manifest", baseRefDescriptor: "dev",
          baseOid: observed.baseOid ?? BASE, unreviewedUntrackedPaths: [], trackedSymlinks: [] }),
        captureCandidateTree: async () => observed.candidateTreeOid ?? TREE,
        assertCheckoutConfiguration: async () => {},
        readIdentity: async () => ({ gitDir }),
      });
      const stored = readReviewResult(gitDir, result.review_handle);
      return { result, stored };
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  }

  it("reports base drift as base drift, unpublished and cycle-neutral", async () => {
    const { result, stored } = await retain({ baseOid: "f".repeat(40) });
    assert.equal(result.ok, false);
    assert.equal(result.error, "review_revision_stale");
    assert.equal(result.stale_cause, "base_moved");
    assert.doesNotMatch(result.message, /working tree/);
    assert.equal(result.next_action, "rerun_review_on_current_revision");
    assert.equal(result.publication_status, "stale");
    assert.equal(result.cycle, null);
    assert.equal(stored.ok, true);
    assert.equal(stored.record.terminal.stale_cause, "base_moved");
  });

  it("treats a candidate-tree change as stale even when the digest matches", async () => {
    const { result } = await retain({ candidateTreeOid: "e".repeat(40) });
    assert.equal(result.publication_status, "stale");
    assert.equal(result.stale_cause, "candidate_changed");
  });

  it("stays publishable when nothing moved", async () => {
    const { result } = await retain({});
    assert.equal(result.ok, true);
    assert.equal(result.publication_status, "unpublished");
  });
});

describe("retained stale cause validation (#1694)", () => {
  const record = (status, staleCause) => createReviewResult({
    repositoryId: "fake/repo", issueNumber: 1694, reviewer: "codex", expectedCycle: 1, cap: 1,
    branch: "1694-review-diff", baseBranch: "dev", revision: revision(),
    coverage: { complete: true }, findings: [], verdict: "ship", notes: [],
    terminal: { ok: true, stale_cause: staleCause }, publicationStatus: status,
  });

  it("accepts a known cause on a stale record only", () => {
    assert.equal(record("stale", "base_moved").terminal.stale_cause, "base_moved");
    assert.throws(() => record("stale", "working_tree"), /review_result_failure_invalid/);
    assert.throws(() => record("unpublished", "base_moved"), /review_result_failure_invalid/);
  });
});
