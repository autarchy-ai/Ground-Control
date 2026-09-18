# ADR-099: Bound Codex review without requiring a clean verdict and retire test-quality review

- **Status:** Accepted
- **Date:** 2026-09-17
- **Issue:** [#1633](https://github.com/autarchy-ai/Ground-Control/issues/1633)
- **Requirement:** GC-O007
- **Supersedes:** the test-quality portions of ADR-029 and ADR-031

## Context

The `/implement` workflow historically ran two pre-push AI review loops: the
Codex production-readiness review at Step 6.5 and a Claude-based test-quality
review at Step 6.6. Both used a configurable per-issue cycle cap and asked the
user whether to authorize another cycle after the cap.

Two mismatches developed between that mechanism and its operating intent.

First, the Codex cap exists to prevent open-ended reviewer loops. A completed
cycle can find real problems; the agent fixes those problems and verifies the
repairs. The cap then asks whether another discovery pass is worth its cost. It
was never intended to require a later `ship` verdict before publication. The
tool messages mentioned “ship as-is,” but the skill described only `clean` as
an advancing state and described `capped` as terminal. Agents therefore
resisted a maintainer instruction to decline another cycle and continue.

Second, the separate test-quality reviewer has not produced enough additional
value to justify another model invocation, another durable-record family,
another cap decision, more authentication requirements, and a second source of
review churn. Its useful engineering rules already belong in implementation
practice and repository tests. Keeping the MCP tools as an optional or legacy
surface would preserve the maintenance cost and invite agents to keep calling
them.

## Decision

1. **The Codex cap limits iterations, not delivery.** Every real finding from a
   completed cycle is still fixed or explicitly dispositioned and executable
   repairs still receive proportionate regression evidence. At the last in-cap
   cycle, the agent fixes and verifies the findings, then asks whether to spend
   one additional review cycle. If the user declines or says to proceed, the
   review band resolves as `accepted_at_cap` and Phase C begins. A clean
   terminal Codex verdict is not required.

2. **The action vocabulary names both valid choices.** The last-in-cap action
   is `fix_findings_then_ask_over_cap_or_proceed`; a call made after the cap
   returns `ask_over_cap_or_proceed`. Neither action is an unresolved defect
   gate. Authorization is required only for the extra cycle, not for stopping
   review. The optional automated disposition mechanism is Codex-only and its
   `proceed` result has the same meaning.

3. **The test-quality reviewer is removed, not deprecated.** Delete
   `gc_test_quality_review`, `gc_test_quality_review_cycle`, their runners,
   prompt/schema/parser, retry and station-observation variants, configuration
   keys, route stage, workflow step, policy contract, tests, and documentation.
   Step 6.6 becomes an intentional tombstone. No compatibility alias or
   optional invocation remains.

4. **The workflow attests only what it runs.** PR bodies name the pre-push
   Codex review rather than claiming both code and test-quality review. Phase B
   proceeds directly from Step 6.5 to Step 7. CI, SonarCloud, repository policy,
   targeted tests, and human PR review remain independent gates.

5. **Test design remains an implementation responsibility.** Removing the
   reviewer does not weaken TDD, security-boundary regression tests, or the
   fix-locks-itself rule. Those are authored and checked through the normal
   implementation, targeted-test, CI, and human-review surfaces instead of a
   dedicated model judge.

## Consequences

### Positive

- Maintainer decisions at the Codex cap have one unambiguous control-flow
  result: declining another pass advances the workflow.
- Review cost is bounded without converting reviewer silence into delivery
  authority or a clean verdict into a mandatory token.
- One model runtime, authentication path, MCP surface, durable marker family,
  configuration block, and policy contract are removed.
- PR attestations match the work the workflow actually performs.

### Negative

- There is no separate model dedicated to detecting false-assurance tests.
  Codex, targeted verification, CI, SonarCloud, and human review must cover
  test-quality defects that escape implementation discipline.
- Consumers that called the removed test-quality MCP tools must stop; there is
  deliberately no compatibility period.

### Risks

- An agent could misread `accepted_at_cap` as permission to ignore known
  findings. The canonical rules prevent this by requiring every completed-cycle
  finding to be fixed or explicitly dispositioned before the cap question.
- Stale installed skills could still mention Step 6.6. Skill installation and
  version updates must replace those copies with this repository's canonical
  workflow.

## Related decisions

- ADR-021: Gated Agentic Development Loop
- ADR-027: Agent-Neutral Implement Workflow Packaging
- ADR-029: Issue-Thread Gate Model
- ADR-031: Severity Rubric and Stopping Model for Pre-Push Codex Review
- ADR-036: Per-Step Model Routing and Durable-Record Tool Surfaces
