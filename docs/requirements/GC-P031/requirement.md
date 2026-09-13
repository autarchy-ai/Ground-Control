---
id: GC-P031
title: "Live Branch Protection Reconciled With the Versioned Baseline"
status: ACTIVE
type: CONSTRAINT
priority: SHOULD
wave: 2
created_at: 2026-09-11T00:00:00Z
updated_at: 2026-09-11T00:00:00Z
---

# GC-P031 — Live Branch Protection Reconciled With the Versioned Baseline

## Statement

The branch-protection baseline shall declare the repository's complete intended
protection policy for every protected branch — required status contexts with the
application permitted to satisfy each one, strictness, and the pull-request,
review, conversation-resolution, force-push, deletion, and admin-bypass policy,
including the principals allowed to bypass a required pull request — and every
declared field shall be compared against the live protection GitHub reports for
that branch by a repo-native check. The declaration shall be loaded through a
single validating projection that both the offline gate and the live comparison
read, so neither can compare a value whose declared type was never checked. The comparison shall name the branch, the field, the declared value, and
the observed value for each difference, and shall report a branch it could not
evaluate as a distinct non-clean outcome rather than as either a match or a
difference — claiming a specific difference requires having read what is being
compared. It shall not coerce a malformed live or declared value into a
comparable one, and where GitHub reports the required context set two ways it
shall treat disagreement between them as not determinable. Every field declared in the
baseline shall be covered by that comparison, and every field the comparison
knows about shall be declared in the baseline, so the correspondence is
two-sided and a declared field cannot become decorative. The repo-native offline
gate shall additionally assert that each protected branch declares every such
field with the expected type, that the baseline declares no branch outside the
protected set, and that changes land through a pull request. The live read shall
be bound to the canonical repository and host rather than to ambient
configuration, and shall be bounded in time.

## Rationale

Issue #1155. GC-P030 made the required-context declaration real against the jobs
that produce those checks, but it is anchored on two files in the repository and
says nothing about the settings GitHub actually enforces. The two are separate
facts, and they had already diverged: live `main` carried
`required_status_checks.strict: false` while the baseline declared `strict: true`
and live `dev` carried `true`, so strictness was neither consistent between
branches nor consistent with the versioned contract, and no check could notice
because none of them looked at live state. Live `dev` likewise allowed force
pushes, against the documented intent that a force-push to `main` or `dev` is
blocked.

Two of the gaps this closes are specifically authorization-bearing. A required
context name is satisfiable by whoever may post that name, so a required check
with no App binding can be satisfied by any actor able to publish a commit status
without the workflow ever running; the binding is part of the contract. And an
actor listed in `bypass_pull_request_allowances` can land changes without the
pull-request boundary while every scalar review setting still compares clean, so
comparing only scalars would attest a boundary that is not enforced.

The third failure this closes is the decorative declaration.
`admin_bypass_allowed` and `changes_land_via_pull_request` were recorded in the
baseline and read by nothing, so they documented an intent that no gate
defended — the same shape of problem as a required context with no producing job,
and the reason the correspondence here is specified as two-sided and shrink-only
rather than as a one-way read.

Reading branch protection requires repository administration permission, which
is not a grantable GitHub Actions `permissions:` scope, so the comparison cannot
run on the CI job's own token. It is therefore an explicitly invoked gate that
always enforces when run, rather than a merge gate that would have to skip
silently when the read is unauthorized — a check that reports clean because it
never looked is the failure mode `require_scanned` exists to prevent.

## Traceability

- IMPLEMENTS → ADR `architecture/adrs/091-ci-verification-topology.md` (ADR-091: CI verification topology, amended for live-vs-versioned reconciliation)
- IMPLEMENTS → CODE_FILE `tools/ci/branch_protection_compare.py` (the live-vs-versioned comparison, drift report, and three-valued outcome)
- IMPLEMENTS → CODE_FILE `tools/ci/branch_protection_readers.py` (reads each declared fact out of GitHub's protection response without coercing it)
- IMPLEMENTS → CODE_FILE `tools/ci/check_branch_protection.py` (the repository-bound, read-only GitHub adapter and CLI)
- IMPLEMENTS → CODE_FILE `tools/policy/ci_strictness.py` (baseline shape, context-collection validation, and the unexpected-branch assertion)
- IMPLEMENTS → CODE_FILE `tools/policy/branch_protection_baseline.py` (the declaration, its schema, and the single validating loader both halves read)
- IMPLEMENTS → CODE_FILE `tools/policy/branch_protection_fields.py` (the pinned-value policy: strict checks and pull-request-only landings)
- IMPLEMENTS → CONFIG `.github/branch-protection-baseline.json` (the complete versioned protection declaration)
- IMPLEMENTS → CONFIG `Makefile` (the `branch-protection-check` target)
- TESTS → TEST `tools/tests/test_ci_branch_protection.py` (field and context drift both directions, malformed and unreadable live protection, the three-valued outcome, per-toggle section binding, shrink-only field coverage)
- TESTS → TEST `tools/tests/test_ci_branch_protection_security.py` (bypass-allowance drift, required-check provider binding, and the repository-bound live read)
- TESTS → TEST `tools/tests/test_policy_ci_required_contexts.py` (offline protection-field assertions)
- DOCUMENTS → DOCUMENTATION `docs/ci/CI_PIPELINE.md` (live reconciliation and its permission constraint)
- DOCUMENTS → DOCUMENTATION `docs/DEVELOPMENT_WORKFLOW.md` (repo-native policy layer)
- IMPLEMENTS → GITHUB_ISSUE `1155` (Reconcile live branch protection with the slim CI topology)
