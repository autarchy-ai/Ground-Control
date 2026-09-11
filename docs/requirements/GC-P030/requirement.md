---
id: GC-P030
title: "Required Status Contexts Enforced in Repo Policy"
status: ACTIVE
type: CONSTRAINT
priority: SHOULD
wave: 2
created_at: 2026-09-05T00:00:00Z
updated_at: 2026-09-11T00:00:00Z
---

# GC-P030 — Required Status Contexts Enforced in Repo Policy

## Statement

The repository's required status checks shall be declared once in policy, and a
repository-native gate shall enforce the declaration against both the workflows
that produce those contexts and the versioned branch-protection baseline.

(a) Every locally produced required context shall map to a pull-request job, and
every required branch shall have `strict: true`. A required producer workflow
shall not use workflow-level `paths` or `paths-ignore`; malformed trigger or
branch-filter shapes shall fail closed rather than be treated as coverage.

(b) Hosted-application contexts shall bypass the local-producer requirement only
through the explicit external allowlist. At runtime that allowlist shall be a
subset of the required-context declaration, so exemptions can only shrink.

(c) The context-to-provider map shall cover the required-context set exactly:
no required context may lack a provider and no stale provider entry may survive.
The versioned branch-protection baseline shall match the declaration in both
directions.

(d) The policy gate shall run in `make policy` and in the required CI `policy`
job. Applying and reading live GitHub branch protection remains an authenticated
operator check; a local baseline is evidence of intent, not proof of live state.

## Rationale

Issue #650 restored this gate after the #1500 re-platform deleted CI jobs and
their topology tests while stale required contexts remained. Issue #1303 closes
the remaining bypasses: a hosted exemption could drift at runtime, a provider
map could become incomplete, and a path-filtered or malformed producer could be
counted even though some PRs would never receive its context. The check lives in
repository policy so deleting a workflow cannot also delete the check that
notices.

## Traceability

- IMPLEMENTS → ADR `architecture/adrs/091-ci-verification-topology.md` (surviving CI topology and required-context contract)
- IMPLEMENTS → CODE_FILE `tools/policy/ci_strictness.py` (two-sided baseline, producer, allowlist, provider, and trigger checks)
- IMPLEMENTS → CODE_FILE `tools/policy/branch_protection_baseline.py` (single required-context, provider, external, and branch declaration)
- IMPLEMENTS → CODE_FILE `tools/policy/cli.py` (policy gate registration)
- IMPLEMENTS → CONFIG `.github/branch-protection-baseline.json` (versioned strict-protection baseline)
- TESTS → TEST `tools/tests/test_policy_ci_required_contexts.py` (drift, coverage, strictness, provider, allowlist, and path-filter regressions)
- DOCUMENTS → DOCUMENTATION `docs/ci/CI_PIPELINE.md` (required contexts and producers)
- DOCUMENTS → DOCUMENTATION `docs/architecture/SURVIVING_GATES.md` (gate inventory and placement doctrine)
- IMPLEMENTS → GITHUB_ISSUE `1303` (surviving gate inventory and placement reconciliation)
