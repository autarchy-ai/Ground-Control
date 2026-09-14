// PR-body validation + section-render helpers, extracted from pr-body.js
// (issue #1199 Sonar refactor): each validator returns an error-string array and
// each section renderer returns a line array, so `validatePrBodyInput` and
// `buildPrBody` stay flat (low cognitive complexity) and never call `Array#push`
// in long sequences. Behavior and rendered bytes are unchanged — the pr-body
// tests and the render->check_pr_body compose fixture pin the output.

import { renderDocumentationSection, validateDocumentationOutcome } from "./doc-coverage.js";
import { devStartFieldValue, extractMarkdownHeadingSection, parseDevStartGateFields } from "./grc-legacy-compat.js";
import { DEFAULT_DEV_START_GATE_PLAN_SECTION } from "./repo-context.js";
import { PR_BODY_SUMMARY_MAX, PR_BODY_TEST_NOTES_MAX } from "./repo-vocabulary.js";
import {
  EXACT_REQUIREMENT_UID_RE,
  PR_BODY_CHANGE_CLASSES,
  PR_BODY_LANES,
  PR_BODY_PRE_PUSH_REVIEW_STATES,
  PR_BODY_REVIEWS_OPTIONAL_LANE,
  REQUIREMENT_UID_CONTRACT_DESCRIPTION,
  prBodyGcCheckLines,
} from "./runtime-primitives.js";

// Mirrors tools/policy/checks.py::run_changelog_fragment_check's filename predicate.
const CHANGELOG_FRAGMENT_RE =
  /^changelog\.d\/(?:[A-Za-z0-9._-]+|\+[A-Za-z0-9._-]+)\.(?:security|added|changed|deprecated|removed|fixed)\.md$/;

// The two changelog-mode values recur across scalar validation, changelog
// validation, and the checklist renderer.
const CHANGELOG_MODE_FRAGMENTS = "fragments";
const CHANGELOG_MODE_RELEASE_PLEASE = "release-please";

const byteLength = (value) => Buffer.byteLength(value, "utf8");

// --- validators (each returns an array of error strings) ---

function validateScalars({ changelogMode, issueNumber, changeClass }) {
  const errors = [];
  if (changelogMode !== CHANGELOG_MODE_FRAGMENTS && changelogMode !== CHANGELOG_MODE_RELEASE_PLEASE) {
    errors.push('changelogMode must be "fragments" or "release-please" when set');
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    errors.push("issueNumber must be a positive integer");
  }
  if (!PR_BODY_CHANGE_CLASSES.includes(changeClass)) {
    errors.push(`changeClass must be one of: ${PR_BODY_CHANGE_CLASSES.join(", ")}`);
  }
  return errors;
}

function validateRequirementUids(requirementUids) {
  if (!Array.isArray(requirementUids)) {
    return ["requirementUids must be an array (may be empty for requirement-free runs)"];
  }
  // The renderer takes the same identity corpus as every other structured field
  // (issue #1425): each element must BE one UID, not merely contain one.
  const errors = [];
  requirementUids.forEach((u, i) => {
    if (typeof u !== "string" || !EXACT_REQUIREMENT_UID_RE.test(u)) {
      errors.push(`requirementUids[${i}] must be ${REQUIREMENT_UID_CONTRACT_DESCRIPTION}`);
    }
  });
  return errors;
}

function validateAdrRefs(adrRefs) {
  if (!Array.isArray(adrRefs)) {
    return ["adrRefs must be an array (may be empty; renderer emits 'No ADR required' when empty)"];
  }
  const errors = [];
  adrRefs.forEach((a, i) => {
    if (typeof a !== "string" || a.trim() === "") errors.push(`adrRefs[${i}] must be a non-empty string`);
  });
  return errors;
}

function validateSummary(summary) {
  if (typeof summary !== "string" || summary.trim() === "") {
    return ["summary must be a non-empty string"];
  }
  if (byteLength(summary) > PR_BODY_SUMMARY_MAX) {
    return [
      `summary exceeds the PR-body summary cap of ${PR_BODY_SUMMARY_MAX} bytes (got ${byteLength(summary)}). A PR-body summary is one tight paragraph — restated context and hedging are the usual offenders.`,
    ];
  }
  return [];
}

function validateChanges(changes) {
  if (!Array.isArray(changes)) return ["changes must be an array of bullet strings"];
  const errors = [];
  changes.forEach((c, i) => {
    if (typeof c !== "string" || c.trim() === "") errors.push(`changes[${i}] must be a non-empty string`);
  });
  return errors;
}

function validateTraceability(traceability) {
  if (traceability == null || typeof traceability !== "object" || Array.isArray(traceability)) {
    return ["traceability must be a mapping with 'implements' and 'tests' arrays"];
  }
  return ["implements", "tests"]
    .filter((k) => !Array.isArray(traceability[k]))
    .map((k) => `traceability.${k} must be an array (may be empty)`);
}

function validateChangelog({ changelogMode, changelogFragment, changeClass }) {
  // Release Please repos (#1399 / #1336, GC-P027): Release Please owns
  // CHANGELOG.md, so a per-PR changelog.d fragment is rejected and never required.
  if (changelogMode === CHANGELOG_MODE_RELEASE_PLEASE) {
    return changelogFragment == null
      ? []
      : ["changelogFragment is not accepted when changelogMode is 'release-please' (Release Please owns CHANGELOG.md; there is no changelog.d fragment)"];
  }
  const errors = [];
  if (changelogFragment != null) {
    if (typeof changelogFragment !== "string" || changelogFragment.trim() === "") {
      errors.push("changelogFragment must be a non-empty string when set");
    } else if (!CHANGELOG_FRAGMENT_RE.test(changelogFragment)) {
      errors.push(`changelogFragment must match changelog.d/<issue>.<type>.md or changelog.d/+<slug>.<type>.md where <type> ∈ {security,added,changed,deprecated,removed,fixed}; got: ${changelogFragment}`);
    }
  }
  if ((changeClass === "source" || changeClass === "source+migration") && changelogFragment == null) {
    errors.push(`changeClass='${changeClass}' requires a changelogFragment (path under changelog.d/)`);
  }
  return errors;
}

function validateTestNotes(testNotes) {
  if (testNotes == null) return [];
  if (typeof testNotes !== "string") return ["testNotes must be a string when set"];
  if (byteLength(testNotes) > PR_BODY_TEST_NOTES_MAX) {
    return [
      `testNotes exceeds the PR-body test-notes cap of ${PR_BODY_TEST_NOTES_MAX} bytes (got ${byteLength(testNotes)}). test_notes is run-specific evidence, not a second configuration surface.`,
    ];
  }
  return [];
}

function validateDevStartGate(devStartGate) {
  if (devStartGate == null) return [];
  if (typeof devStartGate !== "string" || devStartGate.trim() === "") {
    return ["devStartGate must be a non-empty Markdown string when set"];
  }
  const section = extractMarkdownHeadingSection(devStartGate, DEFAULT_DEV_START_GATE_PLAN_SECTION);
  if (section == null) {
    return [`devStartGate must include a ## ${DEFAULT_DEV_START_GATE_PLAN_SECTION} section`];
  }
  if (devStartFieldValue(parseDevStartGateFields(section), "Source-bearing") == null) {
    return ["devStartGate must include a Source-bearing field"];
  }
  return [];
}

// Lane + pre-push review state (issue #1551). Both default to the /implement
// shape so every existing caller renders byte-identical output. Claiming the
// reviewers did not run is legal only for the lane whose contract makes them
// optional — an /implement run must never render its way out of a mandatory gate.
function validateLaneAndReviews({ lane, prePushReviews }) {
  const errors = [];
  const resolvedLane = lane == null ? "implement" : lane;
  const resolvedReviews = prePushReviews == null ? "completed" : prePushReviews;
  if (!PR_BODY_LANES.includes(resolvedLane)) {
    errors.push(`lane must be one of: ${PR_BODY_LANES.join(", ")}`);
  }
  if (!PR_BODY_PRE_PUSH_REVIEW_STATES.includes(resolvedReviews)) {
    errors.push(`prePushReviews must be one of: ${PR_BODY_PRE_PUSH_REVIEW_STATES.join(", ")}`);
  }
  if (errors.length === 0 && resolvedReviews === "not_run" && resolvedLane !== PR_BODY_REVIEWS_OPTIONAL_LANE) {
    errors.push(
      `prePushReviews='not_run' requires lane='${PR_BODY_REVIEWS_OPTIONAL_LANE}'; `
      + `lane='${resolvedLane}' runs both pre-push reviewers and must attest that they completed`,
    );
  }
  return errors;
}

function validateDocumentationOutcomeField(documentationOutcome) {
  if (documentationOutcome == null) return [];
  const docResult = validateDocumentationOutcome(documentationOutcome);
  return docResult.ok ? [] : docResult.errors.map((e) => `documentation_outcome: ${e}`);
}

// Aggregate all field validators, preserving the original error ordering.
export function collectPrBodyErrors(input) {
  const { issueNumber, changeClass, requirementUids, adrRefs, summary, changes, traceability, changelogFragment, testNotes } = input;
  const changelogMode = input.changelogMode == null ? CHANGELOG_MODE_FRAGMENTS : input.changelogMode;
  return [
    ...validateScalars({ changelogMode, issueNumber, changeClass }),
    ...validateRequirementUids(requirementUids),
    ...validateAdrRefs(adrRefs),
    ...validateSummary(summary),
    ...validateChanges(changes),
    ...validateTraceability(traceability),
    ...validateChangelog({ changelogMode, changelogFragment, changeClass }),
    ...validateTestNotes(testNotes),
    ...validateDevStartGate(input.devStartGate),
    ...validateDocumentationOutcomeField(input.documentation_outcome),
    ...validateLaneAndReviews(input),
  ];
}

// --- section renderers (each returns an array of lines) ---

const bullets = (items) => items.map((x) => `- ${x}`);

function requirementUidsLines(requirementUids) {
  if (requirementUids.length === 0) {
    // Requirement-free runs render an explicit "(none)" marker, never a synthetic
    // UID placeholder (codex cycle-2 F1); the policy gate reads it structurally.
    return ["- (none — bug/refactor/maintenance run; see Traceability section below)"];
  }
  return requirementUids.map((u) => `- \`${u}\``);
}

function changesLines(changes, changeClass, devStartGate) {
  const lines = changes.length === 0 ? ["- See summary above."] : bullets(changes);
  if (changeClass === "source+migration") {
    // Repo-neutral (issue #1199): name no framework, ORM, or test class.
    lines.push("- **Migration reminder:** this change includes a migration — verify the repo's migration/version references and run its migration checks per the repository's migration policy.");
  }
  if (devStartGate != null && devStartGate.trim() !== "") {
    lines.push("", ...devStartGate.trim().split(/\r?\n/));
  }
  return lines;
}

function testPlanLines(changeClass, testNotes) {
  // Named semantically (issue #1429): completion/policy commands are repo config,
  // so a rendered Make target would be a false claim in a repo that runs else.
  const lines = changeClass === "doc-only"
    ? [
      "- [x] Configured completion command passes",
      "- [x] Configured repository policy command passes (documentation/workflow guardrails)",
      "- Unit tests / integration tests: N/A — docs-only change",
    ]
    : [
      "- [x] Unit tests pass",
      "- [x] Integration tests pass if applicable",
      "- [x] Configured completion command passes",
      "- [x] No coverage regression",
    ];
  if (testNotes && testNotes.trim() !== "") lines.push("", testNotes.trim());
  return lines;
}

function traceabilityLines(traceability) {
  const tImpl = Array.isArray(traceability.implements) ? traceability.implements : [];
  const tTest = Array.isArray(traceability.tests) ? traceability.tests : [];
  return [
    tImpl.length === 0 ? "- IMPLEMENTS: (none — bug/refactor/maintenance run)" : `- IMPLEMENTS: ${tImpl.join(", ")}`,
    tTest.length === 0 ? "- TESTS: (none — documentation/configuration/structural-invariant run)" : `- TESTS: ${tTest.join(", ")}`,
  ];
}

function changelogChecklistLine(changelogMode, changeClass, changelogFragment) {
  if (changelogMode === CHANGELOG_MODE_RELEASE_PLEASE) {
    return "- [x] Changelog: owned by Release Please (generated from the Conventional Commit PR title; no per-PR fragment)";
  }
  if (changeClass === "doc-only") return "- Changelog fragment: N/A — docs-only change";
  return `- [x] Changelog fragment added at \`${changelogFragment}\``;
}

function checklistLines(input) {
  const { changeClass, changelogFragment } = input;
  const changelogMode = input.changelogMode == null ? CHANGELOG_MODE_FRAGMENTS : input.changelogMode;
  // Repo-neutral checklist (issue #1199): universally meaningful workflow evidence
  // only — not Ground Control's Java/domain rules and no hardcoded doc path.
  const lines = [
    "- [x] Code follows the project's coding standards",
    changelogChecklistLine(changelogMode, changeClass, changelogFragment),
    "- [x] Architectural docs updated if stack, package structure, or key behaviors changed",
  ];
  if (input.documentation_outcome != null) {
    lines.push("", ...renderDocumentationSection(input.documentation_outcome));
  }
  return lines;
}

// Assemble the full body as one flat line array (no long push sequences).
export function renderPrBodyLines(input) {
  const { issueNumber, changeClass, requirementUids, adrRefs, summary, changes, traceability, testNotes, devStartGate } = input;
  return [
    "## Summary", "", summary.trim(), "",
    "## Requirement UIDs", "", ...requirementUidsLines(requirementUids), "",
    // Requirement-backed runs use a NON-closing `Refs #n` so GitHub cannot auto-close
    // the issue at merge ahead of the Phase E merged-requirement-state validation; the
    // validated gc_close_issue_after_merge is the only closer. Requirement-free runs
    // keep `Closes #n` (issue #1541), which GitHub honors only on a default-branch
    // merge; on the integration branch the post-merge close step closes it (#1601).
    "## Related Issues", "", `${requirementUids.length > 0 ? "Refs" : "Closes"} #${issueNumber}`, "",
    "## ADR Impact", "", ...(adrRefs.length === 0 ? ["- No ADR required"] : bullets(adrRefs)), "",
    "## Changes", "", ...changesLines(changes, changeClass, devStartGate), "",
    "## Test Plan", "", ...testPlanLines(changeClass, testNotes), "",
    "## Ground Control Checks", "", ...prBodyGcCheckLines(input.prePushReviews), "",
    "## Traceability", "", ...traceabilityLines(traceability), "",
    "## Checklist", "", ...checklistLines(input),
  ];
}
