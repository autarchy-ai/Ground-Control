# ADR-091: CI Verification Topology

## Status

Accepted

## Date

2026-07-28

## Context

The CI workflow ran its verification jobs as a chain. `policy` gated `build`,
`trivy`, `osv-scanner`, and `mcp-contract`; `build` gated `test`; `test` gated
`integration`, `sonar`, and `verify`. Measured over the 40 most recent
`pull_request` runs, whole-run wall clock had a median of 15.0 minutes and a p95
of 23.9 minutes, and time to first failing check had a median of 4.9 minutes and
a p95 of 21.5 minutes.

Per-job medians showed where the time went. `policy` started at t=0 and took 1.8
minutes. `build` started at +1.9 minutes and took 4.4. `test` started at +6.5 and
took 6.0. `sonar` started at +12.3 and took 7.6, making it both the longest job
and the last to finish.

None of those `needs:` edges carried data. No job downloaded an artifact from a
predecessor. Every Gradle job started from a fresh checkout and rebuilt from
source, so each edge only delayed a job that was already able to run. The
`sonar` job generated its own JaCoCo report through `./gradlew build sonar`, so
its dependency on `test` bought nothing. The `integrationTest` task declares
`shouldRunAfter(tasks.test)`, which orders tasks inside a single Gradle
invocation and says nothing about ordering separate CI jobs.

Branch protection on `main` and `dev` requires eight GitHub Actions contexts
(`build`, `test`, `integration`, `verify`, `sonar`, `policy`, `trivy`,
`osv-scanner`) plus two external app contexts, under `strict: true`. Any change
to the job graph has to preserve every one of those names.

## Decision

**Verification jobs declare no dependencies on each other.** `policy`, `build`,
`test`, `integration`, `verify`, `sonar`, `trivy`, `osv-scanner`, and
`mcp-contract` all start at t=0. Whole-run wall clock becomes the duration of
the slowest single job instead of the sum of the longest chain.

Three edges remain, each for a reason a flat graph cannot express:

- `policy-live` needs `policy`. It is the only job that sees
  `GROUND_CONTROL_API_TOKEN`, it runs on a self-hosted runner, and it is
  restricted to `main`. Sequencing it behind the repo policy gate keeps the
  secret-bearing job downstream of policy verification.
- `docker` needs every verification job. Publishing an image is the one
  irreversible side effect in the workflow.
- `smoke` needs `docker`. It exercises the image `docker` publishes.

**The `docker` gate list is exhaustive rather than transitive.** Before this
decision `docker` named four jobs and inherited the rest through the chain. A
flat graph has no transitivity to inherit, so every gate is written out.
`trivy` and `osv-scanner` join the list; they were never in the old transitive
closure, which allowed an image to be published while a security scan was red.

**Sonar runs only the work that feeds Sonar.** The `sonar` job generates
coverage with `./gradlew test jacocoTestReport` and then analyzes with
`./gradlew sonar -Dsonar.qualitygate.wait=true`. Sonar consumes two inputs,
both declared in `backend/build.gradle.kts`: `sonar.java.binaries` and
`sonar.coverage.jacoco.xmlReportPaths`. No SpotBugs or Checkstyle report path is
wired into the Sonar properties, so assembling the boot jar and re-running
static analysis inside the longest job bought nothing. The `build` job still
runs `./gradlew build -x test` and the `test` job still runs the full
`./gradlew check`, including the 80 percent JaCoCo line-coverage verification.
The two invocations are separate because the `sonar` task has no ordering
relation to the `finalizedBy` JaCoCo report, and analyzing before the report is
written would report zero coverage.

**A `fast-feedback` job reports formatting and compilation errors early, and is
never a merge gate.** It runs
`./gradlew spotlessCheck compileJava compileTestJava -Pquick` with no
dependencies. It stays out of the required-context set: a second required gate
covering a subset of an existing gate is a shadow merge authority, and the
complete suite remains the single authority.

**No test sharding.** `test` is 6.0 minutes and `integration` is 5.5 minutes at
the median, both shorter than `sonar`. Sharding either one cannot reduce wall
clock while another job is longer, and it would require merging shard coverage
back into the single JaCoCo XML that Sonar reads. Re-evaluate when a single test
lane becomes the longest job in the graph.

**No path filtering on required checks.** A workflow-level `paths` filter stops
the workflow from running, so the required context never reports and the pull
request stays blocked. Only a job-level `if` produces the `skipped` conclusion
that satisfies a required check. With eight required contexts under
`strict: true`, the failure mode is a pull request that can never merge. The
additive `fast-feedback` lane delivers early signal without touching
required-check semantics.

**Gradle caching is unchanged.** `gradle/actions/setup-gradle` caches
`caches/build-cache-1` and dependency state, defaults to read-only on
non-default branches, and keys entries by job id. Parallel jobs restore the
`dev` entry for their own job and do not contend on writes. Pre-commit hook
environments are cached separately in the `policy` job, keyed on the hash of
`.pre-commit-config.yaml` so a pinning change always misses the cache.

**Structural invariants are executable.** `tools/tests/test_ci_topology.py`
asserts that every required context has a job, that the baseline matches
`CI_STRICTNESS_REQUIRED_CONTEXTS`, that no verification job declares a
dependency, that the surviving edges match their documented sets exactly, that
`docker` names every job outside `DOCKER_GATE_EXCLUSIONS`, that the fast lane
exists and is not required, and that the `sonar` job keeps its coverage and
quality-gate inputs. These run in `make policy` and in the CI `policy` job.

**The CI gate watches every run for the head commit.** `gc_watch_ci_run`
previously watched whichever workflow run was created most recently on the
branch, which is not reliably the run carrying the required contexts. It now
groups runs by head SHA and reports success only when all of them succeed. The
contract lives in the ADR-027 2026-07-28 amendment. Without it, a readiness
record could attest to a green CI gate on the strength of a five-second title
lint.

## Consequences

Whole-run wall clock is bounded by the slowest job rather than the longest
chain. Compute cost rises: `build` and `test` compile the same sources
concurrently instead of in sequence. That duplication existed before this
decision, since `sonar` already rebuilt everything; the change moves it off the
critical path rather than adding it.

Every future check is a job with no `needs`, and the only edge to maintain is
`docker`'s gate list. Omitting a job from that list would let an image publish
past a red check, so `test_ci_topology.py` derives the expected list from the
workflow's own job set rather than from the required-context set. A required
context is not the same thing as a gate: `mcp-contract` gates the image publish
without being required for merge. A new job must therefore be added to
`docker.needs` or excused in `DOCKER_GATE_EXCLUSIONS` with a reason.
`policy-live` is excused because GitHub skips a job whose `needs` entry was
skipped, so gating the publish on a job that is skipped on every ref but `main`
would stop it publishing at all.

Adding a required context now means three coordinated edits: the job in
`ci.yml`, the context in `CI_STRICTNESS_REQUIRED_CONTEXTS`, and the context in
`.github/branch-protection-baseline.json`. The topology tests fail until all
three agree, which is what makes a phantom required context impossible to leave
behind.

`make ci-timings` reports the same metrics from workflow metadata, so the next
comparison is a measurement rather than a redesign.

## Non-Goals

This decision does not change what CI verifies. No job is renamed, removed, or
made advisory, no severity threshold moves, and no scanner becomes
non-blocking. It does not introduce a second source of CI truth outside GitHub
Actions, a reusable-workflow abstraction, or a new Gradle task. It did not add
frontend verification; the 2026-07-28 amendment below supersedes that non-goal.

## 2026-07-28 amendment: frontend verification lane (issue #1468)

The original decision left `frontend/` unverified. It was compiled only inside
the Docker image build, which runs after merge and runs neither lint nor tests,
so nothing gated a frontend regression. The cost was already visible: eight
Biome errors had accumulated on `dev`, including five
`useExhaustiveDependencies` violations that masked a draft-reset bug.

A `frontend` job now runs Biome lint, the Vitest unit suite, and the production
build. It follows the flat topology this ADR establishes: no `needs`, starting
at t=0, well inside the wall clock that `sonar` bounds. It is a required
context in `CI_STRICTNESS_REQUIRED_CONTEXTS` and in the branch-protection
baseline, and it gates `docker`, so an image cannot publish past a red frontend.

Two constraints are load-bearing and asserted by `tools/tests/test_ci_topology.py`:

- The job id is exactly `frontend`, with no `name:` override and no matrix. A
  matrix would report `frontend (node-22)`, and branch protection would wait
  forever on a context that never arrives.
- The job holds `permissions: contents: read`. It installs PR-controlled
  dependencies and executes npm lifecycle scripts, so it must not inherit the
  workflow-level `packages: write`, `pull-requests: write`, or
  `id-token: write` grants.

The lane exists because the generic topology assertions cannot catch its
removal: deleting the job, the policy constant, and the baseline entry together
leaves them internally consistent. The frontend-specific invariant closes that.

## 2026-09-05 amendment: required-status-context gate restored (issue #650, GC-P030)

The topology assertions this ADR relied on lived in
`tools/tests/test_ci_topology.py`. The #1500 re-platform deleted the `build`,
`frontend`, `integration`, `test`, and `verify` jobs and deleted those tests
along with the CI surface they covered. All five contexts stayed declared in
`.github/branch-protection-baseline.json` and in
`CI_STRICTNESS_REQUIRED_CONTEXTS`, with nothing left to produce them and nothing
left to notice. Applying that baseline would have blocked every pull request on
`main` and `dev`, precisely the failure the 2026-07-28 note above records for
the `mutation` context, recurring because the gate had been deleted with its
subject.

The replacement, `run_ci_required_context_contract` in
`tools/policy/ci_strictness.py`, is deliberately **not** anchored on a CI
topology. It is anchored on two artifacts that survive any topology: the declared
required-context set and the workflow files themselves. It asserts, two-sided,
that the branch-protection baseline matches the declaration in both directions,
that every protected branch keeps `strict: true`, and that every declared context
is produced, for each protected branch, by a job in a pull-request-triggered
workflow that actually runs for that branch. Two details are load-bearing and both
came out of review. GitHub reports a job's `name:` when it sets one, so the gate
resolves the reported check name rather than the `jobs.<id>` key; a name carrying
a `${{ }}` expression expands per matrix leg and so resolves to no single context.
And a `pull_request` trigger filtered to one branch never runs for the other, so
pooling producers across workflows would accept a repository where `main` requires
a check only `dev` can produce. Contexts posted by a
hosted app (`GitGuardian Security Checks`, `SonarCloud Code Analysis`) are exempt
from needing a local producer through an explicit allowlist that is itself
shrink-only: the policy contract must reject every allowlist entry that is no longer
a required context, so an exemption cannot outlive the check it exempts. Unit
tests exercise that refusal; they are evidence for the contract, not its only
enforcement.

A workflow counts as a local producer only when the tracked trigger shape proves
that it will start for pull requests into the protected branch. Workflow-level
`paths` and `paths-ignore` filters therefore cannot satisfy a required context:
an unmatched pull request starts no workflow and leaves that context pending.
Malformed or unsupported trigger/filter shapes are likewise not evidence of a
producer. This is fail-closed producer discovery, not a second GitHub Actions
schema or an attempt to evaluate arbitrary expressions.

This narrows the earlier design in one respect and widens it in another. It drops
the job-dependency, `docker`-gate, and fast-lane assertions, which described a
topology that no longer exists. It gains independence from that topology, so
deleting a job can no longer delete the check that notices. The gate runs in
`bin/policy`, so `make policy` and the CI `policy` job both enforce it. PyYAML is
now installed explicitly in the `policy` and `sonar` jobs rather than arriving
transitively through `pre-commit`, because a gate must not depend on another
tool's dependency graph.

The surviving verification topology after #1500 is four required jobs, none
consuming another's artifact: `policy` (`ci.yml`), `sonar` (`sonarcloud.yml`),
and `trivy` plus `osv-scanner` (`security.yml`).

## 2026-09-11 amendment: live protection reconciled with the baseline (issue #1155, GC-P031)

The required-context gate above compares two artifacts inside this repository:
the declared context set and the workflow files. It says nothing about what
GitHub actually enforces, and those are separate facts that had already diverged.
Live `main` carried `required_status_checks.strict: false` while
`.github/branch-protection-baseline.json` declared `strict: true` and live `dev`
declared `true`, so strictness was neither consistent between the protected
branches nor consistent with the versioned contract. Live `dev` additionally
allowed force pushes, against the documented intent that a force-push to `main`
or `dev` is blocked. No check could notice either, because the offline gate does
not look at live state and nothing else did.

A second, quieter defect sat in the same file. `admin_bypass_allowed` and
`changes_land_via_pull_request` were recorded in the baseline and read by
nothing. That is the same shape of problem as a required context with no
producing job: declared intent that no gate defends.

**The baseline is now the complete declaration of intended protection, and the
correspondence to live state is two-sided.** Each protected branch declares its
required contexts and strictness plus its pull-request, review,
conversation-resolution, force-push, deletion, and admin-bypass policy.
`run_ci_required_context_contract` asserts offline that every branch declares
exactly the fields in `CI_STRICTNESS_PROTECTION_FIELDS`, with the declared types,
and that `changes_land_via_pull_request` is `true`. `compare_protection` in
`tools/ci/check_branch_protection.py` compares every declared field against the
protection GitHub reports, naming branch, field, declared value, and observed
value for each difference. A field in the baseline that the comparison cannot
read fails, and so does a field the comparison knows about that the baseline
omits, so the declaration cannot decay back into decoration.

Coverage closes over the nested review leaves too, not only the top-level
fields. `review_policy` governs `dismiss_stale_reviews`,
`require_code_owner_reviews`, `require_last_push_approval`, and
`required_approving_review_count`; a declaration naming only some of them would be
a partial policy whose unlisted leaves nothing compares, which is the same
decorative failure one level down. `require_last_push_approval` is in scope
precisely because its absence is what a review gate silently loses. Restrictions,
signatures, linear history, branch locking, and fork syncing are deliberately
outside this policy.

Only `changes_land_via_pull_request` is pinned to a value offline. The remaining
booleans are type-checked rather than pinned, because flipping several of them
(enforcing admins, requiring conversation resolution) is a *tightening*, and a
gate that fails a tightening is pointed the wrong way. Value agreement is the
live comparison's job, and the baseline edit that changes an intended value is
itself a reviewed diff. The offline gate also rejects a baseline branch outside
the protected set, because iterating only the protected tuple would walk past it
and its policy would never be compared against anything. It validates the declared
context collection instead of coercing it: `{str(name) for name in ...}` turns a
declared `123` into the context `"123"`, and `or []` turns a malformed mapping into
"no contexts declared." Either one compares equal to something and passes.

**The declaration is loaded once, and the loader validates.**
`tools/policy/branch_protection_baseline.py` holds the protected-branch tuple, the
required-context set, the declared provider bindings, the governed field sets for
every mapping level, and the single loader, which returns a *validated* projection
and raises with every fault rather than the first.
`tools/policy/branch_protection_fields.py` asserts the pinned values,
`tools/policy/ci_strictness.py` keeps the required-context contract, and the live
side reads the same declaration through the same loader:
`tools/ci/branch_protection_compare.py` is the pure comparison and
`tools/ci/check_branch_protection.py` the repository-bound, read-only GitHub
adapter. A loader that only parsed would leave each consumer to interpret the
declaration's types for itself, and they would diverge: Python equality treats JSON
`1` as `True` and `0` as `False`, so an unvalidated `strict: 1` compares equal to a
declared `true` and the live gate reports a clean match for a value whose real
state was never established. Live scalars are typed the same way before comparison,
and a wrongly typed live value is unevaluable rather than a match. The module split
follows the requirement boundary: GC-P030 owns the contexts, GC-P031 owns the rest
of the policy.

**Every mapping level is closed, not just the top one.** Exact-key coverage applies
to the baseline root, the branch set, `required_status_checks`, `review_policy`, and
the bypass-principal collections. Closing only the branch entry would let
`required_status_checks.provider_binding` be added without changing any branch's
top-level keys, and both gates would keep reading only `strict` and `contexts` while
the new declaration sat there enforced by nothing.

**Two of the governed fields are authorization-bearing, and were the reason for
widening the projection.** A required context name is satisfiable by whoever may
post that name: branch protection can bind a required check to one App id, and
without that binding any actor able to publish a commit status or check run can post
a green `policy` on its own commit and satisfy the gate without the workflow
running. `CI_STRICTNESS_CONTEXT_PROVIDERS` therefore declares the App permitted to
satisfy each context, the comparison checks `(context, app_id)` rather than names
alone, an unbound or unexpected provider is drift, and a context named twice with
conflicting bindings is unevaluable. Separately, an actor listed in
`required_pull_request_reviews.bypass_pull_request_allowances` can land changes
without the pull-request boundary while every scalar review setting compares clean,
so the users, teams, and apps collections are declared and compared per branch.
GitHub omits that mapping when nothing is allowed, so an absent mapping reads as
three empty collections. That is the only safe default: assuming the opposite would
report drift on every correctly configured branch and train the operator to ignore
the check. The executable declaration contract must also keep provider-map keys equal
to the required-context set; a unit assertion alone must not be the only thing
preventing an undeclared provider from being treated as acceptable.

**"Could not be determined" is a third outcome, not a flavour of the other two.**
The live check exits 0 on a match, 1 on drift, and 2 when any branch could not be
evaluated. A branch in that third state produces no drift claims at all, because
naming a specific difference requires having read the thing being compared. Each
such branch carries a stable reason key (`live_read_failed` for a credential
without `administration:read`, `live_read_timed_out`, `gh_unavailable`,
`live_response_malformed`, `live_contexts_malformed`,
`live_contexts_inconsistent`) so a caller can branch on the kind of failure
without parsing prose. GitHub reports the required set both as the legacy
`contexts` array and as `checks`; trusting one and ignoring the other would accept
a response whose two views disagree, so when both are present they must agree and
disagreement is not-determinable rather than a match against whichever was read.
An absent `{"enabled": ...}` wrapper likewise reads as unreported rather than as
`false`.

**The live read is bound, not configurable.** The target repository is the
canonical identity from `tools/policy/repo_identity.py` and the host is fixed, so
neither `GH_REPO` nor `GH_HOST` can redirect an administration-capable credential
at a different target. The subprocess runs with `shell=False`, carries a timeout
so a hung read fails the gate rather than holding it open, and passes no token in
argv, so `gh` uses the operator's own stored credential.

**The live comparison is not a merge gate, deliberately.** Reading branch
protection requires repository administration permission, and `administration`
is not a grantable GitHub Actions `permissions:` scope, so the CI `policy` job's
`GITHUB_TOKEN` cannot perform the read. Wiring it into `make policy` would
therefore require skipping silently whenever the read is unauthorized, which is
exactly the "reports green because it never looked" failure `require_scanned`
exists to prevent. It is an explicitly invoked gate, `make
branch-protection-check`, that always enforces when run. The documentation says
plainly that repo policy detects this drift when invoked rather than
continuously.

**The live write path is the narrow endpoint, and this module has none.**
Reconciling `main` used
`PATCH /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks`,
which can express strictness and the context set and nothing else. The
full-document `PUT` is rejected for this purpose: its omitted or mis-serialized
fields can silently reset review, conversation, restriction, force-push,
deletion, or admin policy, and the legacy `repo-setup` snippet nulls
`required_status_checks` that way. The reconciliation captured both branches'
full protection documents before the write and re-read them after, confirming
the only normalized semantic difference was `main`'s `strict`.
`check_branch_protection.py` is read-only by design: a repeatable branch
administration capability would need its own authorization contract through a
repository-bound MCP tool, not a write mode grown onto an operator script.

## 2026-09-11 amendment: surviving gate placement (issue #1303)

The post-#1500 inventory keeps the required `policy`, `sonar`, `trivy`, and
`osv-scanner` jobs and the two hosted-app contexts. It closes two remaining
offline declaration gaps: the external allowlist must be a subset of the
runtime required-context declaration, and the provider map must cover that
declaration exactly. These are production policy checks, not assertions that
exist only in a unit test.

The required `policy` job now runs `pre-commit run --all-files`, making the
tracked hook configuration the single file-hygiene/security inventory instead
of manually duplicating most hook commands in YAML. PR-title CI stays advisory,
but `run_pr_title_contract` rejects vocabulary drift between its Action config
and `.ground-control.yaml`. `run_github_action_pin_contract` rejects floating
external Action references across every workflow. Required producers remain
unfiltered at workflow level, and unsupported or malformed trigger/filter
shapes remain non-producers.

The live protection comparison remains a separate authenticated operator gate:
CI cannot obtain `administration:read`, so treating an unauthorized read as a
green `make policy` result would be fail-open. The repository baseline is intent;
`make branch-protection-check` is evidence about GitHub's live state. The full
inventory, including retired duplicate and backend-era checks, is in
[`docs/architecture/SURVIVING_GATES.md`](../../docs/architecture/SURVIVING_GATES.md).

## Related Issues

Issue #1461, issue #1468, issue #650, issue #1155, issue #1303.

## Related ADRs

ADR-054 owns the documentation-coverage gate that the `policy` job runs.
ADR-063 and GC-P027 own the release model that `docker` and `release-please.yml`
implement.
