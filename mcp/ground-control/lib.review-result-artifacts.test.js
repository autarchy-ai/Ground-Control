import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_RESULT_SCHEMA,
  buildReviewRevision,
  captureReviewRevision,
  createReviewResult,
  readReviewResult,
  validateReviewResult,
  validateSanitizedReviewPublication,
  writeReviewResult,
} from "./lib.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function tempGitDir() {
  return mkdtempSync(join(tmpdir(), "gc-review-result-"));
}

function revision(overrides = {}) {
  return buildReviewRevision({
    headOid: HEAD,
    candidateTreeOid: "d".repeat(40),
    baseOid: BASE,
    diffText: "diff --git a/a.js b/a.js\n+const secretName = true;",
    manifest: "1\t0\ta.js",
    unreviewedUntrackedPaths: ["local-notes.txt"],
    ...overrides,
  });
}

function artifact(overrides = {}) {
  return createReviewResult({
    repositoryId: "autarchy-ai/Ground-Control",
    issueNumber: 1632,
    reviewer: "codex",
    expectedCycle: 1,
    cap: 1,
    branch: "1632-separate-review-publication",
    baseBranch: "dev",
    revision: revision(),
    coverage: {
      strategy: "whole-diff",
      chunks_total: 1,
      chunks_completed: 1,
      files_total: 1,
      files_covered: 1,
      complete: true,
    },
    findings: [
      {
        id: "core-F1",
        reviewer: "core",
        path: "a.js",
        line: 1,
        title: "Confidential project name is exposed",
        body: "The Acme codename is present in an operational path.",
        classification: "one-off",
        sweep_evidence: "checked the rest of the diff",
      },
    ],
    verdict: "ship-with-fixes",
    notes: [{ text: "Review the publication boundary." }],
    architecturalRead: "The change needs a publication boundary.",
    terminal: { ok: true, next_action: "fix_findings_then_ask_over_cap_or_proceed" },
    ...overrides,
  });
}

describe("retained review-result artifacts (#1632)", () => {
  it("derives a stable revision digest and changes it for staged text or uncovered paths", () => {
    const first = revision();
    assert.equal(first.head_oid, HEAD);
    assert.equal(first.base_oid, BASE);
    assert.match(first.digest, /^[0-9a-f]{64}$/);
    assert.equal(revision().digest, first.digest);
    assert.notEqual(revision({ diffText: "different" }).digest, first.digest);
    assert.notEqual(revision({ unreviewedUntrackedPaths: ["another.txt"] }).digest, first.digest);
    assert.notEqual(revision({ trackedSymlinks: [{ path: "link", target: "outside", escapes_repo: true }] }).digest, first.digest);
  });

  it("normalizes non-ASCII review paths and rejects invalid revision types", () => {
    const first = revision({
      unreviewedUntrackedPaths: ["z.txt", "ä.txt"],
      trackedSymlinks: ["z-link", "ä-link"],
    });
    const reordered = revision({
      unreviewedUntrackedPaths: ["ä.txt", "z.txt"],
      trackedSymlinks: ["ä-link", "z-link"],
    });
    assert.deepEqual(first.unreviewed_untracked_paths, ["ä.txt", "z.txt"]);
    assert.deepEqual(first.tracked_symlinks, ["ä-link", "z-link"]);
    assert.equal(first.digest, reordered.digest);
    assert.throws(() => revision({ diffText: null }), TypeError);
  });

  it("round-trips a restart-durable result with restrictive directory and file modes", () => {
    const gitDir = tempGitDir();
    try {
      const created = artifact();
      const written = writeReviewResult(gitDir, created);
      assert.equal(written.schema, REVIEW_RESULT_SCHEMA);
      assert.match(written.review_handle, /^rvw_[0-9a-f]{48}$/);
      assert.equal(statSync(join(gitDir, "gc-review-results")).mode & 0o777, 0o700);
      assert.equal(statSync(join(gitDir, "gc-review-results", `${written.review_handle}.json`)).mode & 0o777, 0o600);

      const read = readReviewResult(gitDir, written.review_handle);
      assert.equal(read.ok, true);
      assert.equal(read.record.issue_number, 1632);
      assert.equal(read.record.publication_status, "unpublished");
      assert.equal(read.record.findings[0].body, "The Acme codename is present in an operational path.");
      assert.equal(read.record.verdict, "ship-with-fixes");
      assert.deepEqual(read.record.notes, [{ text: "Review the publication boundary." }]);
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it("fails closed for symlinks, corrupt JSON, unknown schemas, and unknown handles", () => {
    const gitDir = tempGitDir();
    const outside = tempGitDir();
    try {
      const written = writeReviewResult(gitDir, artifact());
      const path = join(gitDir, "gc-review-results", `${written.review_handle}.json`);
      rmSync(path);
      symlinkSync(join(outside, "outside.json"), path);
      assert.equal(readReviewResult(gitDir, written.review_handle).error, "review_result_not_regular_file");

      rmSync(path);
      writeFileSync(path, "{broken", { mode: 0o600 });
      assert.equal(readReviewResult(gitDir, written.review_handle).error, "review_result_unparseable");

      writeFileSync(path, JSON.stringify({ ...written, schema: "gc.review-result/v99" }), { mode: 0o600 });
      assert.equal(readReviewResult(gitDir, written.review_handle).error, "review_result_schema_unknown");
      assert.equal(readReviewResult(gitDir, `rvw_${"f".repeat(48)}`).error, "review_result_not_found");
      assert.ok(readFileSync(path, "utf8").length > 0, "a corrupt artifact is preserved");
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // The handle is a tool argument. Only the exact handle string may name a file,
  // so a value that validates as one string and stringifies as another, or that
  // tries to leave the results directory, never reaches the filesystem.
  it("reads only by an exact handle string that stays inside the results directory", () => {
    const gitDir = tempGitDir();
    try {
      const handle = `rvw_${"f".repeat(48)}`;
      let reads = 0;
      const shifting = { toString: () => (reads++ === 0 ? handle : "../../outside") };
      assert.equal(readReviewResult(gitDir, shifting).error, "review_result_handle_invalid");
      assert.equal(reads, 0, "a non-string handle is refused before it is stringified");
      assert.equal(readReviewResult(gitDir, `../${handle}`).error, "review_result_handle_invalid");
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it("detects edits to the retained original review payload", () => {
    const record = artifact();
    record.findings[0].body = "tampered after retention";
    assert.deepEqual(validateReviewResult(record), {
      ok: false,
      error: "review_result_digest_mismatch",
    });
  });

  it("accepts redacted prose while preserving every finding identity, classification, and verdict", () => {
    const result = validateSanitizedReviewPublication(artifact(), {
      verdict: "ship-with-fixes",
      notes: [{ text: "Publication-safe note." }],
      architectural_read: "A sensitive identifier was removed before publication.",
      findings: [
        {
          id: "core-F1",
          title: "Sensitive identifier in an operational path",
          classification: "one-off",
          decision: "fix",
          rationale: "Replaced the identifier with a neutral label.",
          location: "a.js:1",
        },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.findings[0].decision, "fix");
    assert.doesNotMatch(JSON.stringify(result.value), /Acme/);
    assert.match(result.sanitized_digest, /^[0-9a-f]{64}$/);
  });

  it("rejects omitted, invented, duplicate, reclassified, or undispositioned findings", () => {
    const base = {
      verdict: "ship-with-fixes",
      notes: [{ text: "Sanitized note." }],
      architectural_read: "Sanitized read",
      findings: [{
        id: "core-F1",
        title: "Sanitized title",
        classification: "one-off",
        decision: "fix",
        rationale: "Sanitized rationale",
      }],
    };
    assert.equal(validateSanitizedReviewPublication(artifact(), { ...base, findings: [] }).error, "review_publication_finding_set_mismatch");
    assert.equal(validateSanitizedReviewPublication(artifact(), {
      ...base,
      findings: [...base.findings, { ...base.findings[0], id: "invented" }],
    }).error, "review_publication_finding_set_mismatch");
    assert.equal(validateSanitizedReviewPublication(artifact(), {
      ...base,
      findings: [base.findings[0], base.findings[0]],
    }).error, "review_publication_finding_ids_duplicate");
    assert.equal(validateSanitizedReviewPublication(artifact(), {
      ...base,
      findings: [{ ...base.findings[0], classification: "class", instances: ["a.js:1", "b.js:2"] }],
    }).error, "review_publication_classification_mismatch");
    assert.equal(validateSanitizedReviewPublication(artifact(), {
      ...base,
      findings: [{ ...base.findings[0], decision: undefined }],
    }).error, "review_publication_decision_invalid");
    assert.equal(validateSanitizedReviewPublication(artifact(), {
      ...base,
      findings: [{ ...base.findings[0], decision: "not-applicable" }],
    }).ok, true);
    assert.equal(validateSanitizedReviewPublication(artifact(), {
      ...base,
      architectural_read: '<!-- gc:decision-record reviewer="codex" -->',
    }).error, "review_publication_reserved_marker");
    assert.equal(validateSanitizedReviewPublication(artifact(), {
      ...base,
      findings: [{ ...base.findings[0], hidden_original: "secret" }],
    }).error, "review_publication_finding_unknown_field");
  });

  it("accepts all incumbent disposition choices and retains every verdict value", () => {
    const verdictCases = [
      { verdict: "ship", findings: [], publicFindings: [] },
      { verdict: "ship-with-fixes", findings: artifact().findings,
        publicFindings: [{ id: "core-F1", title: "Sanitized", classification: "one-off",
          decision: "fix", rationale: "Disposition rationale." }] },
      { verdict: "don't-ship", findings: [{ ...artifact().findings[0], structural_blocker: true }],
        publicFindings: [{ id: "core-F1", title: "Sanitized", classification: "one-off",
          structural_blocker: true, decision: "fix", rationale: "Disposition rationale." }] },
    ];
    for (const entry of verdictCases) {
      const record = artifact({ verdict: entry.verdict, findings: entry.findings });
      assert.equal(validateReviewResult(record).ok, true);
      const publication = validateSanitizedReviewPublication(record, {
        verdict: entry.verdict, notes: [{ text: "Sanitized note." }], architectural_read: "Sanitized read",
        findings: entry.publicFindings,
      });
      assert.equal(publication.ok, true, JSON.stringify(publication));
    }
    const record = artifact();
    for (const finding of [
      { decision: "fix" },
      { decision: "not-applicable" },
      { decision: "wontfix", user_authorization: "https://example.test/issues/1632#issuecomment-1" },
    ]) {
      const result = validateSanitizedReviewPublication(record, {
        verdict: record.verdict,
        notes: [{ text: "Sanitized note." }],
        architectural_read: "Sanitized read",
        findings: [{ id: "core-F1", title: "Sanitized", classification: "one-off",
          rationale: "Disposition rationale.", ...finding }],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
  });

  it("fails when refs or diff inputs move during revision capture", async () => {
    const diff = { diffText: "diff", manifest: "manifest", baseRefDescriptor: "origin/dev",
      unreviewedUntrackedPaths: [], trackedSymlinks: [] };
    let headReads = 0;
    const movingRef = async (_command, args) => {
      const ref = args.at(-1);
      if (ref === "HEAD") return { stdout: `${++headReads === 1 ? HEAD : "c".repeat(40)}\n` };
      return { stdout: `${BASE}\n` };
    };
    await assert.rejects(
      captureReviewRevision({ repoRoot: "/repo", baseBranch: "dev", uncommitted: true, reviewDiff: diff }, {
        commandRunner: movingRef, assertCheckoutConfiguration: async () => {},
      }),
      (error) => error.code === "review_revision_changed_during_capture",
    );

    let diffReads = 0;
    const stableRefs = async (_command, args) => ({ stdout: `${args.at(-1) === "HEAD" ? HEAD : BASE}\n` });
    await assert.rejects(
      captureReviewRevision({ repoRoot: "/repo", baseBranch: "dev", uncommitted: true }, {
        commandRunner: stableRefs,
        computeDiff: async () => ({ ...diff, diffText: `diff-${++diffReads}` }),
        assertCheckoutConfiguration: async () => {},
      }),
      (error) => error.code === "review_revision_changed_during_capture",
    );
  });
});
