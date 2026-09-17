---
id: GC-O017
title: "Versioned Artifact-Release Identity Reservation"
status: ACTIVE
type: FUNCTIONAL
priority: SHOULD
wave: 2
created_at: 2026-09-14T00:00:00Z
updated_at: 2026-09-14T00:00:00Z
---

# GC-O017 — Versioned Artifact-Release Identity Reservation

## Statement

A repository that produces versioned evidence or other monotonic release artifacts shall be able to opt in by declaring named release families in `.ground-control.yaml` (`release_families`), each naming its base branch, first allocatable sequence, version template, and derived artifact path templates. The Ground Control MCP server shall expose one repository-bound operation, `gc_release_identity`, that:

(A) Reserve: atomically reserves the next identity for a family against the head of that family's configured base branch, resolved server-side, using only the family definition present in `.ground-control.yaml` at that base revision, and returns the reserved sequence, version, and derived paths. Concurrent reservations for the same repository and family shall receive distinct identities, and the log shall never record a lower sequence after a higher one, including for a caller that read an older sequence floor; distinct families shall not contend. An identity is never recycled, including after abandonment.

(B) Idempotency: re-running a reservation for the same repository, family, issue, and workflow idempotency key shall return the existing reservation — its stored version, paths, base revision, and lifecycle state — rather than allocating another identity, including after a server crash or an unconfirmed write between the claim and its issue-thread record.

(C) Lifecycle: every reservation shall move only from `reserved` to exactly one terminal state, `published` or `abandoned`, recorded durably and atomically so that two conflicting terminal transitions cannot both succeed. Publication shall be recorded only after the server verifies every derived path is a regular file at the family base branch's current head, and shall record that revision and each artifact's blob identity. Abandonment shall record a closed reason code.

(D) Durable record: the reservation log shall link the reservation, repository, base revision, issue, workflow idempotency hash, normalized family definition and its digest, and eventual release artifacts, and every lifecycle event shall also be projected onto the issue thread as a server-rendered record. A log the server cannot fully validate shall refuse allocation rather than be repaired.

(E) Binding: the operation shall act only on the MCP launch workspace's repository, shall accept no caller-supplied repository destination, base revision, version, or artifact path, and shall refuse a reservation whose derived paths already exist at the base revision or whose version or paths are already owned by another reservation in the family. A reservation shall be made only from its issue's branch checked out in the launch workspace, as read by the server, when that branch is bound to the issue by a trusted `/implement` pickup record; a caller-created issue-shaped branch alone shall grant no authority. Abandonment shall require the active branch to match both that trusted association and the branch recorded at reservation, so a caller that knows another run's issue, family, and key cannot reserve for or abandon that run. The server shall never create a log event its own log validation would reject.

The facility shall not create, edit, or validate a project's evidence files and shall not relax completion, policy, review, CI, SonarCloud, or merge gates. The `/implement` guidance shall direct a configured versioned-release producer to reserve its identity before capture generation and to publish or abandon it explicitly.

## Rationale

Issue #1579: two independently valid RAE pull requests generated the same "next" evidence releases from the same integration-branch state, and the collision surfaced only at the required `dev` merge. A checkout lock cannot coordinate separate worktrees, MCP processes, or hosts, and issue comments offer no conditional unique append. GitHub's create-reference API rejects an existing name atomically, which gives a repository-scoped compare-and-swap without adding a database or service; a live check showed a `force: false` reference update does not, so the log uses only creates (ADR-097).

## Traceability

- DOCUMENTS → ADR `architecture/adrs/097-versioned-artifact-release-reservations.md` (ADR-097: versioned artifact-release identity reservation)
- IMPLEMENTS → GITHUB_ISSUE `1579` (Issue #1579 — reserve versioned evidence-release identities for concurrent /implement runs)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/release-identity-config.js` (release_families normalizer, token grammar, rendering, and definition digest)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/ground-control-config.js` (release_families wired into the canonical .ground-control.yaml parser)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/release-identity-ledger.js` (slot-ordered create-only reference log: event codec, validating fold, read-back-decided creates)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/release-identity-github.js` (host-pinned REST adapter: exact references, Git tree walks, bounded blob reads)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/release-identity.js` (reserve, publish, abandon, and status operations)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/release-identity-checkout.js` (launch-checkout path containment and server-read run branch)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/release-identity-records.js` (gc:release-identity issue-thread projection with at-least-once recovery)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/tools/release-identity.js` (thin zod registration of gc_release_identity)
- IMPLEMENTS → CODE_FILE `mcp/ground-control/lib/github-rest.js` (ghRestJson host pinning and call timeout)
- IMPLEMENTS → CODE_FILE `skills/implement/steps/step-04.4-tdd.md` (/implement guidance: reserve before capture generation, publish or abandon explicitly)
- IMPLEMENTS → DOCUMENTATION `docs/DEVELOPMENT_WORKFLOW.md` (Versioned artifact releases workflow reference)
- TESTS → TEST `mcp/ground-control/release-identity.config.test.js` (configuration grammar, bounds, parser integration, rendering, digest)
- TESTS → TEST `mcp/ground-control/release-identity.reserve.test.js` (concurrent allocation, stale floors, separate families, idempotent retry, base advancement, collisions)
- TESTS → TEST `mcp/ground-control/release-identity.lifecycle.test.js` (publish, abandon, conflicting terminal transitions, status)
- TESTS → TEST `mcp/ground-control/release-identity.ledger.test.js` (malformed log and event validation fails closed)
- TESTS → TEST `mcp/ground-control/release-identity.binding.test.js` (repository binding, write surface, symlink containment, gh api transport)
- TESTS → TEST `mcp/ground-control/tool-descriptions.test.js` (published gc_release_identity schema has no caller destination or identity field)
