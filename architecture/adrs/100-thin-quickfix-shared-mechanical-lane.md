# ADR-100: Keep quickfix as a thin lane over shared mechanical modules

- **Status:** Accepted
- **Date:** 2026-09-17
- **Issue:** #1637
- **Requirement:** GC-O007
- **Supersedes:** The quickfix-specific orchestration and close sequencing in
  ADR-029 and ADR-036

## Context

`/quickfix` was introduced as the lower-ceremony path for a small,
requirement-free change. Its instructions later accumulated an independent
bootstrap, publication, base-synchronization, CI watch, Sonar watch, review,
report, and close sequence. That duplicated the mechanical work already
composed by `/implement`, gave agents multiple ways to invoke the same gate,
and made a supposedly short path nearly as long as the full workflow.

The duplicated path also expanded work discovered during a quickfix into new
issues and pull requests, repeated local and hosted verification, allowed
multiple Sonar repair loops, and split completion into a pre-merge final report
followed by a separate post-merge close. These behaviors worked against the
lane's purpose: deliver one bounded fix, preserve the repository's mechanical
safety controls, and return merge authority to the maintainer.

Secret scanning is not optional ceremony. The pre-commit boundary is the last
local barrier before material enters the repository or remote branch and must
remain inside the shared publication action.

## Decision

`/quickfix` is a thin policy lane over `gc_implement_mechanical`. The composite
tool accepts `lane: "quickfix"` and owns four boundaries:

1. `bootstrap` reads the issue before branch mutation, rejects any issue with a
   requirement UID in its authoritative `## Requirements` section, prepares the
   issue branch, and records a quickfix pickup.
2. `publish` stages only the requested change, applies sensitive-path checks,
   runs the configured pre-commit command including secret scanning, commits,
   pushes, and synchronizes the integration branch once.
3. `monitor` observes CI and Sonar together for the published head.
4. `finalize` runs only after the user merges. It verifies the merge and empty
   requirement scope, posts the slim trusted final record, and closes the issue
   idempotently.

Quickfix does not call the lower-level synchronization, CI watch, Sonar watch,
final-report, or close tools as separate workflow steps. Requirement
reconciliation and pre-merge readiness remain `/implement` behavior and reject
the quickfix lane.

AI review is off by default. `--review` permits exactly one Codex review cycle.
The agent fixes or explicitly dispositions its findings, records the result as
accepted at the cap, and continues without requiring a clean verdict or asking
for another cycle. Test-quality review is not part of quickfix.

Local verification is limited to targeted tests for the change. Hosted CI owns
the broad completion and policy suites. Quickfix may automatically repair and
reanalyze Sonar once; a second failure is returned to the maintainer instead of
starting another loop. A defect caused by the change or directly blocking it is
fixed in the same branch. An unrelated concern is reported with evidence and
does not recursively create another issue, pull request, or implementation run.

GitGuardian remains user-owned. The agent reports only the hosted check's name,
status, and URL, and does not inspect or remediate the finding.

Repository policy constrains the quickfix instruction to the shared action
tokens, retained secret-scanning language, retired ceremony exclusions, and a
200-line maximum. This prevents the thin lane from silently growing a second
orchestrator again.

## Consequences

- Quickfix has one implementation path and four shared mechanical calls instead
  of duplicated per-tool choreography.
- Branch safety, pre-commit secret scanning, synchronization, hosted checks,
  merge ownership, and merge-gated closure remain enforced.
- Requirement-backed work fails before branch mutation and must use
  `/implement`.
- Review and Sonar effort are predictably bounded; a clean AI-review verdict is
  not a prerequisite for publication.
- Final reporting and closure become one post-merge action, removing an
  otherwise unactionable pre-merge record.
- New shared behavior must preserve both lane semantics. Implement-only gates
  must continue to fail closed when invoked with `lane: "quickfix"`.
