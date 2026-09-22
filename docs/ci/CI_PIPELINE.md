# CI pipeline

Reference for the GitHub Actions workflows in `.github/workflows/`. The contract
behind the verification topology is
[ADR-091](../../architecture/adrs/091-ci-verification-topology.md).

Ground Control is the MCP server for the `/implement` workflow over repo-local
files (issue #1500). There is no backend, database, or frontend, so there is no
compile lane, no Testcontainers lane, no coverage-producing Gradle build, and no
image publish. The verification surface is the MCP `node --test` suite, the
repo-native policy checks, Vale prose linting, SonarCloud, and two dependency and
secret scanners.

## Verification jobs

Every verification job starts at t=0 and none consumes another job's artifact, so
whole-run wall clock is the duration of the slowest job. Each job id below is the
required-status-check context name.

| Job | Workflow | Required | What it verifies | Reproduce locally |
|---|---|---|---|---|
| `policy` | `ci.yml` | yes | `pre-commit run --all-files`, the Python policy tool tests, the MCP `node --test` suite, MCP ESLint, `bin/policy`, and Vale on changed docs | `make policy`, `make mcp-test`, and `pre-commit run --all-files` |
| `sonar` | `sonarcloud.yml` | yes | JavaScript coverage through `c8`, Python coverage through `coverage.py`, SonarCloud analysis, the hosted quality gate, and the zero-open-issues gate | `npx c8 --reporter=lcovonly npm test` in `mcp/ground-control`, then `python3 tools/sonar/assert_no_new_issues.py --project-key autarchy-ai_Ground-Control` with `SONAR_TOKEN` set |
| `trivy` | `security.yml` | yes | Filesystem scan for CRITICAL and HIGH vulnerabilities and for secrets, failing the job on any fixable finding | `trivy fs --scanners vuln,secret --severity CRITICAL,HIGH --ignore-unfixed .` |
| `osv-scanner` | `security.yml` | yes | Known vulnerabilities in the Node and Python dependency manifests, configured by `osv-scanner.toml` | `osv-scanner scan source --recursive --config=osv-scanner.toml .` |

Two further required contexts are produced outside this repository's workflow
files: `SonarCloud Code Analysis`, posted by the SonarQube scan action with the
quality-gate result, and `GitGuardian Security Checks`, posted by the GitGuardian
app. `.github/branch-protection-baseline.json` records the required set for
`main` and `dev` with strict status checks and admin bypass retained.

GitGuardian findings are user-owned. Agents must not investigate, remediate,
dismiss, suppress, bypass, or work around them; access the GitGuardian
dashboard; handle suspected secret values; rotate credentials; rewrite history;
or change code, configuration, and allowlists in response. Agents may report
only the GitHub check name, status, and check URL, then wait for the user to
resolve the finding. After the user reports resolution, an agent may re-read the
GitHub check status and continue when it passes.

That baseline is enforced, not just documented. `run_ci_required_context_contract`
in `tools/policy/ci_strictness.py` (GC-P030, ADR-091) checks it two ways on every
`make policy` and CI `policy` run: every context in
`CI_STRICTNESS_REQUIRED_CONTEXTS` must be produced by a job in a
pull-request-triggered workflow **that runs for that protected branch**, and the
baseline's context set must match that declaration exactly in both directions.
The branch half matters because a `pull_request` trigger filtered to one branch
never runs for the other, so a check can exist and still never report on `main`.
Workflow-level `paths`/`paths-ignore` and malformed trigger or branch-filter
shapes cannot prove production and fail closed. The two hosted-app contexts above
are the only exemptions from needing a local producer; at runtime that allowlist
must remain a subset of the required set, and the context-to-provider map must
cover the required set exactly.
Adding or removing a required check therefore means editing the declaration, the
baseline, and the workflow together; the gate fails until they agree.

That gate is offline: it compares files in this repository. The baseline also
declares what GitHub should enforce, and `make branch-protection-check`
(`tools/ci/check_branch_protection.py`, GC-P031) is what compares the two. It
reads each protected branch's live protection and reports every difference by
branch, field, declared value, and observed value, covering required contexts and
strictness plus the pull-request, review, conversation-resolution, force-push,
deletion, and admin-bypass policy. Two of those are authorization-bearing. Each
required context is compared with the App bound to it, because an unbound required
check can be satisfied by any actor able to post a status with that name, without
the workflow running. And `review_policy` covers
`bypass_pull_request_allowances` alongside `dismiss_stale_reviews`,
`require_code_owner_reviews`, `require_last_push_approval`, and
`required_approving_review_count`, because a principal in that allowance can land
changes without the pull-request boundary while every scalar still matches.

The correspondence is two-sided and closes over every mapping level (the baseline
root, the branch set, the status checks, the review policy, and the bypass
collections): a field the baseline declares that the comparison cannot read fails,
and so does a field the comparison knows about that the baseline omits, so a
declared setting cannot become decoration. The baseline is read through one
validating loader, so neither gate can compare a value whose declared type was
never checked.

It exits 0 on a match, 1 on drift, and **2 when any branch could not be
evaluated**, most often a credential without `administration:read`. A branch in
that third state is reported separately and produces no drift findings, because
naming a specific difference requires having read what is being compared.

Run it after any branch-protection change. It detects drift **when invoked**, not
continuously: reading branch protection needs repository administration
permission, and `administration` is not a grantable GitHub Actions `permissions:`
scope, so the CI `policy` job's token cannot perform the read. Wiring it into
`make policy` would mean skipping silently whenever that read is unauthorized,
which is the "passed because it never looked" failure mode the policy layer's
scan floor exists to prevent, so it is a separate target that always enforces
when run. The check is read-only; reconciling live protection is a
repository-admin action on GitHub's narrow
`PATCH .../protection/required_status_checks` endpoint or in the GitHub UI, never
a full-document `PUT`, whose omitted fields can silently reset review,
conversation, restriction, force-push, deletion, or admin policy.

The `policy` job fetches PR comments in a token-bearing step and then runs
PR-head policy code without `GH_TOKEN`, passing `--pr-comments-json` and
`--pr-number` so the gate can read the PR-thread marker without exposing a token
to code from the pull request head. On push events it runs `bin/policy
--skip-pr-body` instead, because there is no PR body to check.

Vale runs only on pull requests. A push event has no base ref to diff against,
and a document reaches `main` only through a pull request, so the on-PR pass is
the authoritative prose gate.

Required checks are not path-filtered. A workflow-level `paths` filter stops the
workflow from running, so a required context never reports and the pull request
stays blocked forever. ADR-091 carries the full reasoning.

## Release and repository workflows

These are not verification gates and are not in the required-context set.

| Workflow | Trigger | What it does |
|---|---|---|
| `pr-title.yml` | pull request to `main` or `dev` | Reports early Conventional Commit title feedback with a single type, optional scope, and lowercase-leading subject. It is advisory; `bin/policy` rejects drift from `.ground-control.yaml`, and the MCP PR-creation boundary enforces the title. |
| `release-please.yml` | push to `main` | Maintains the `chore(main): release X.Y.Z` pull request, regenerates `CHANGELOG.md` from Conventional Commit history, and cuts the tag and GitHub Release when that pull request merges. There is no image to publish. |
| `sync-main-to-dev.yml` | after a release lands on `main` | Opens or updates the `main` to `dev` PR only from the `main` ref, only for the automation-owned branch/PR whose stored head OID matches, and with an exact force-with-lease. A human merges it. |

See [the surviving gate inventory](../architecture/SURVIVING_GATES.md) for the
complete keep/delete/placement record, including hooks and MCP tool boundaries.

## Measuring

`make ci-timings` reports median and p95 for whole-run wall clock and time to
first failing check, plus per-job duration and start offset, from the GitHub
Actions API. A job whose median start offset is far from zero is waiting on
something.

```
make ci-timings
python3 tools/ci/measure_ci_timings.py --limit 40 --event pull_request --json
python3 tools/ci/measure_ci_timings.py --branch <branch> --limit 10
```

Pass `--branch` when measuring a topology change before it reaches `dev`.
Without it the sample mixes the branch under test with historical runs of the
topology it replaces, which understates the difference.
