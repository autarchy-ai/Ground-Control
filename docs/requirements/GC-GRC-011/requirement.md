---
id: GC-GRC-011
title: "In-Loop Control Implementation with Efficacy Tests"
status: DEPRECATED
type: FUNCTIONAL
priority: MUST
wave: 7
created_at: 2026-06-12T07:26:00.419299Z
updated_at: 2026-07-11T23:43:44.555584Z
---

# GC-GRC-011 — In-Loop Control Implementation with Efficacy Tests

## Statement

A control identified for a change shall be implemented within that change.

(a) Each implemented control shall carry CODE links to its implementing artifacts in the project graph.

(b) Each implemented control shall carry automated tests that fail if the control is removed or bypassed — efficacy tests, not existence tests — linked to the control in the graph.

(c) A control's status shall transition to IMPLEMENTED/OPERATIONAL only when both (a) and (b) are satisfied.

(d) Where a control cannot be implemented in the change (for example, organizational or infrastructure controls), the gap shall be dispositioned per GC-GRC-015, never silently passed.

## Rationale

A control row in a database protects nothing. Secure-by-design means the mitigation ships with the feature and a test guards it against regression — the same red-green discipline the workflow already applies to functional behavior, extended to security behavior.

## Traceability

- DOCUMENTS → GITHUB_ISSUE `1124` (Issue #1124: GC-GRC-011 in-loop control implementation with efficacy tests)

## Historical traceability

Links below name artifacts that are not in the tree, almost all of them removed by the
#1500 re-platform. They are kept for provenance and sit outside the parsed
`## Traceability` section, so no tool reads them as live evidence. Do not infer current
implementation from them.

- IMPLEMENTS → CODE_FILE `backend/src/main/java/com/keplerops/groundcontrol/domain/controls/service/ControlService.java` (ControlService.transitionStatus in-loop evidence gate (clauses a/b/c/d))
- IMPLEMENTS → CODE_FILE `backend/src/main/java/com/keplerops/groundcontrol/domain/controls/repository/ControlLinkRepository.java` (ControlLinkRepository.existsByControlIdAndTargetTypeAndLinkType (CODE/IMPLEMENTS evidence primitive))
- TESTS → TEST `backend/src/test/java/com/keplerops/groundcontrol/unit/domain/ControlServiceTest.java` (ControlServiceTest.ImplementationEvidenceGate: efficacy tests (red if the guard is removed))
- TESTS → TEST `backend/src/test/java/com/keplerops/groundcontrol/integration/ControlImplementationEvidenceGateIntegrationTest.java` (End-to-end efficacy test on a real control (REST+service+DB): 409 until CODE+efficacy evidence exist)
