// Ground Control MCP shared library — barrel.
//
// The implementation lives in ./lib/*, split from a single 20,634-line module (issue #1355)
// that violated the repo's 500-LOC limit (docs/CODING_STANDARDS.md, Sonar S104). The split is
// behaviour-neutral: every name lib.js exported before is still exported here, so index.js and
// every existing test keep importing from one place.
//
// Star re-exports rather than an explicit list: an 800-line hand-maintained export block is its
// own maintenance burden and rots the first time someone adds a function and forgets it. A
// module exports a name only when it was public before the split or a sibling needs it, so this
// does not widen the surface to every internal helper.
//
// Add new code to the ./lib module that owns the concern; no edit here is required.

export * from "./lib/grc-legacy-compat.js";
export * from "./lib/grc-legacy-compat-2.js";
export * from "./lib/api-controls.js";
export * from "./lib/repo-context.js";
export * from "./lib/constants.js";
export * from "./lib/codex-workflow.js";
export * from "./lib/codex-review.js";
export * from "./lib/review-cap-disposition.js";
export * from "./lib/repo-vocabulary.js";
export * from "./lib/command-failure-diagnostics.js";
export * from "./lib/runtime-primitives.js";
export * from "./lib/grc-legacy-compat-3.js";
export * from "./lib/grc-legacy-compat-4.js";
export * from "./lib/issue-requirements-scope.js";
export * from "./lib/issue-requirements-writer.js";
export * from "./lib/codex-workflow-2.js";
export * from "./lib/knowledge-capture.js";
export * from "./lib/knowledge-inbox.js";
export * from "./lib/verification-attestation.js";
export * from "./lib/verification-gates.js";
export * from "./lib/doc-coverage.js";
export * from "./lib/ci-watcher.js";
export * from "./lib/grc-legacy-compat-5.js";
export * from "./lib/grc-legacy-compat-6.js";
export * from "./lib/issue-thread.js";
export * from "./lib/test-quality-runner.js";
export * from "./lib/api-requirements.js";
export * from "./lib/test-quality-prompt.js";
export * from "./lib/codex-verify-cap.js";
export * from "./lib/repo-context-2.js";
export * from "./lib/field-mapping.js";
export * from "./lib/close-issue.js";
export * from "./lib/async-job-registry.js";
export * from "./lib/review-cycle-transport.js";
export * from "./lib/sonar-watcher.js";
export * from "./lib/governance-enums.js";
export * from "./lib/codex-workflow-3.js";
export * from "./lib/ground-control-config.js";
export * from "./lib/repo-vocabulary-2.js";
export * from "./lib/review-cap-disposition-2.js";
export * from "./lib/plan-posting.js";
export * from "./lib/doc-coverage-2.js";
export * from "./lib/codex-workflow-4.js";
export * from "./lib/filesystem-lease.js";
export * from "./lib/implement-recovery-journal.js";
export * from "./lib/implement-publish-recovery.js";
export * from "./lib/codex-workflow-5.js";
export * from "./lib/test-quality-runner-2.js";
export * from "./lib/codex-review-runner.js";
export * from "./lib/pr-body.js";
export * from "./lib/assert-traceability.js";
export * from "./lib/assert-completion.js";
export * from "./lib/decision-records.js";
export * from "./lib/review-reattempt.js";
export * from "./lib/execution-obligation-v2.js";
export * from "./lib/station-observation-records.js";
export * from "./lib/station-observation-seam.js";
export * from "./lib/station-observation-evidence.js";
export * from "./lib/station-observation-reconcile.js";
export * from "./lib/review-cycle-seam.js";
export * from "./lib/codex-verify.js";
// Maintainer PR-review lane (issue #1535): read-only context + authorized remediation.
export * from "./lib/pr-review-shared.js";
export * from "./lib/pr-review-confirm.js";
export * from "./lib/pr-review-context.js";
export * from "./lib/pr-review-remediate.js";
