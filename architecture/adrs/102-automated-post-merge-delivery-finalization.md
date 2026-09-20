# ADR-102: Automated Post-Merge Delivery Finalization

- **Status:** Accepted
- **Date:** 2026-09-20
- **Issue:** #1671
- **Requirement:** GC-O007
- **Supersedes:** none
- **Amends:** ADR-021, ADR-029, ADR-100

## Context

Phase E is already deterministic. `gc_implement_mechanical action="finalize"` verifies the
linked pull request merged, verifies every in-scope requirement at the immutable merge
revision, posts the final report, and closes the issue, and it reaches none of those
conclusions by reasoning. What it lacked was a caller. Until now the only way to invoke it
was to re-enter the workflow with a model or agent session after the merge, so a delivered
issue stayed open until somebody remembered to finish it. #1644 is the worked example.

That is also a poor fit for how the workflow is meant to end. ADR-029 gives `/implement`
exactly one synchronous human touchpoint, PR merge, and the agent has nothing left to decide
after Phase D: every value the final report renders is known when readiness is recorded. The
agent was being kept alive, or resurrected, purely to carry data across the merge.

Two properties make an automated caller safe to add. Phase E is validation-only since #1541,
making no repository edits, and the finalizer already fails closed on every gate. So an
automated executor needs no new authority. It needs the completion payload, proof that the
payload belongs to the delivery that merged, and a trustworthy way to say "this validated
report is mine" at the close gate.

## Decision

### The agent records a trusted handoff at Phase D and may then terminate

Readiness writes two durable records (ADR-029 keeps the issue thread as the workflow's
record):

- an **issue-thread delivery-readiness record**, carrying the exact tool-shaped completion
  input, a digest over it, and the pull-request head OID whose required hosted checks
  readiness verified. It is the authority.
- a **pull-request-thread pointer**, naming the issue and the readiness record. It is
  discovery only: a merge event carries a pull-request number, and scanning a repository for
  a matching issue comment is neither cheap nor deterministic.

The envelope is explicitly versioned and carries a closed `lane` discriminator. An unknown
version or lane fails closed rather than being treated as `/implement`. The payload is
validated at record time by the same gate the final report uses, so a payload that could
never produce a report is refused while an agent is still present to repair it.

`readiness` is lane-discriminated, like `bootstrap` and `finalize` (ADR-100). `/quickfix`
records the same neutral handoff and gains no `/implement` requirement or review gates; it
still has no pre-merge report of its own.

### A merged-pull-request GitHub Actions job is the executor

`.github/workflows/ground-control-phase-e.yml` runs on `pull_request: [closed]`, guarded on
`merged == true`, plus `workflow_dispatch` for maintainer repair. It is a trigger and a
transport: it holds no `gh` logic, no marker parser, and no completion reconstruction. It
passes the event's pull-request number to `grndctl finalize-merged-pr` and nothing else.

Its shape is a security boundary, pinned two-sidedly by
`tools/policy/phase_e_automation.py`: never `pull_request_target`; never the pull-request
head, because the checkout is pinned to the event's immutable `merge_commit_sha` with
`persist-credentials: false`; `issues: write` as its only write permission; and every
external action pinned to a commit SHA. It runs no tests, no policy suite, and no review, and
it waits for no other post-merge job.

The library function behind it re-fetches live pull-request state rather than trusting the
event payload, resolves the issue only through the trusted pointer, and requires the
readiness record to bind to the merged head. A pull request with no pointer is a successful
no-op: most merged pull requests are not Ground Control deliveries.

### Automation authorship is verified, not asserted

`gc_close_issue_after_merge` closes an OPEN issue only on a **trusted** `gc:final-report`
marker, and trust is repository write permission on the author. `github-actions[bot]` is a
GitHub App identity that the collaborator endpoint reports as `permission: "none"`, so an
automated finalizer would validate correctly and then be unable to close.

The trust resolver gains a second, distinct class, `isRepositoryAutomation`, alongside the
unchanged `isTrusted`. Only the final-report marker gate consults it. Execution-obligation
`wontfix` authorization and the merged-state override still require a repo-write human, and
the delivery-readiness record, the thing that authorizes automated finalization, is
deliberately not writable by automation, so the loop cannot close on itself.

The class is verified. Alongside the unchanged `gc:final-report` marker, the finalizer writes
a separate `gc:finalizer-run` marker naming its `GITHUB_RUN_ID`, and the gate accepts it only
when that run resolves through the Actions API to this repository's pinned finalizer workflow
and is bound to this pull request, or is a `workflow_dispatch` run, which only a repo-write
user can start. A forged run id fails the lookup, and a workflow that merely echoes
attacker-controlled text cannot produce a finalizer run bound to the pull request that text
names. Fork pull requests receive a read-only token and cannot post as the identity at all.

### Replay is safe, and failure is never a close path

Final-report publication became idempotent: an existing trusted marker for this exact issue
and pull request is a success, not a second report. Close was already idempotent. A retried
job, a lost response after a successful POST, and an agent re-run therefore all converge on
one record.

A refusal that is bound to a known issue writes one bounded, scrubbed,
idempotently keyed `gc:delivery-finalization-failed` record naming the pull request, the
readiness record, a stable error code, and the repair. It then leaves the issue **open** and
fails the job. An identical replay reuses that record.

### It ships with the product

Automated finalization arrives with `grndctl`, not only in this repository: `grndctl init`
installs the workflow pinned to the exact installed version, never a moving tag, and
`grndctl doctor` reports it missing or drifted. Ground Control's own copy runs the checkout's
server instead, so a change to the finalizer is exercised by the delivery that makes it.

## Consequences

- An agent may be terminated permanently once Phase D readiness is recorded. Re-invoking
  `/implement` after a merge remains supported and is now the fallback, not the path.
- ADR-029's single human touchpoint becomes the literal end of human and agent involvement:
  merge, and the workflow finishes itself.
- A post-readiness push invalidates the handoff by design. The head binding means readiness
  must be re-recorded before merge, which is the same rule that already governs readiness
  against a changed head; the alternative is a final report describing a tree that never
  merged.
- The workflow path is now load-bearing in two places. Renaming it without the trust anchor
  would silently stop every automated close, which is why the policy check ties them.
- A workflow only processes events once it exists on the branch the event resolves its
  definition from, so the first delivery after this lands may still need a manual finalizer
  run. That is a deployment bootstrap, not a standing fallback.

## Non-Goals

No database, queue, poller, daemon, or Temporal workflow. No agent re-entry, no generated
post-merge prose, no post-merge requirement-file edits, no automatic pull-request merge, no
recursive retry loop, and no change to any Phase D or Phase E quality gate. Phase E stays
validation-only and repository-read-only.

## Design Vocabulary That Applies

- **Tool registration**: `gc_finalize_merged_pr` is a `zod` schema plus a thin handler over
  the same library function the CLI calls.
- **Requirement file reader**: merged requirement state is still read from
  `requirement-files.js` at the immutable merge revision (ADR-093).
- **Issue-thread record**: the readiness record, the pointer, the final report, and the
  failure record are all server-owned `gh api` argv posts (ADR-027, ADR-029).
- **Boundary contract**: the workflow launches the transport; the server remains the owner
  of every privileged `gh`/`git` side effect.
