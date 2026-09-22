---
stage_id: implementation
step: "Step 4.4"
tier: medium
---

# Step 4.4: Test-Driven Development (mandatory, with one narrow carve-out)

Once Step 4 has posted the plan, implement using **TDD**. This is not optional except under the documentation-only carve-out below.

## Four-path selection

Apply the `tdd_path` assigned by the Step 4 plan to every requirement clause
and acceptance criterion. Mixed work applies the paths clause by clause.

| Path | Trigger | Discipline |
|---|---|---|
| **Path A — New requirement or feature** | The issue specifies new behavior or clauses to implement. | Use the mandatory red-green-refactor loop below. The first assertion may be narrow, but it must exercise the new behavior and be observed failing before implementation. |
| **Path B — Bug fix on shipped code** | Existing shipped behavior is broken, regresses, crashes, or returns a wrong result. | Write the regression test against the unmodified buggy tree and observe it fail for the reported defect, not test wiring or an unrelated assertion. Only then apply the fix and observe the test pass. If no meaningful failing test can reproduce the defect, keep investigating; do not apply the fix yet. Commit the test and fix together. |
| **Path C — Reviewer-finding fix** | A Codex, refactor, or SonarCloud finding has `decision: "fix"`. | Apply the canonical fix-locks-itself rule in `_review-loop-rules.md`: executable fixes and runtime-consumed data-contract fixes need proportionate regression evidence in the same review-fix cycle. |
| **Path D — Prose-only or static contract narrowing** | The affected clause changes only static prose such as an ADR, README, skill/workflow guidance, or design note. | The documentation-only carve-out below may apply, but only when every existing prerequisite holds. An executable rename, fixture, policy datum, runtime configuration, schema, or grammar is not Path D merely because its file looks like documentation. |

A bug fix cannot use the documentation-only carve-out. In particular, a
runtime-consumed configuration, schema, grammar, fixture, or policy-data edit
still needs a test against its parser or consumer even when the edited path has
a documentation-like extension.

**Documentation-only carve-out.** Skip the red-green loop only when ALL of the following hold:

- The entire planned diff is documentation: ADR, README, skill / workflow prose, design notes, or other static text (`CHANGELOG.md` is Release Please's, not a feature-PR doc path - see `docs/DEVELOPMENT_WORKFLOW.md § Release model`). A single function, helper, schema field, config knob, behavior change, or other executable line in the diff disqualifies the entire carve-out - the full TDD loop applies, and any documentation in the same diff rides along on the back of the executable behavior's tests rather than triggering a separate carve-out path.
- Every clause of every in-scope requirement AND every acceptance criterion in the issue body is already protected by a **structural gate** - a policy check (for example, a rule in the repo's configured policy command), schema validator, lint rule, verifier script, structural invariant test, or equivalent automated check that fires on real regression. Reviewer judgment alone (codex review, code review) is not a structural gate; it is a process gate. If you cannot name a structural gate for a clause, the carve-out does NOT apply to that clause; revert to the mandatory loop and write a real test, even if the only behavior you are testing is "the structural invariant exists." If the structural gate is genuinely missing and adding one is in scope, add it (it is the "real fix" path) before declaring the carve-out.
- The plan (Step 4) explicitly declared the carve-out and named the structural gate that protects each clause/criterion.
- A second comment on the issue thread re-states the carve-out and the named structural gate, so the durable record is unambiguous (per ADR-029). One issue comment per `/implement` run is fine; bullets per clause are encouraged.
- A substring or snapshot test against the changed prose ("ADR-007 contains 'AIOPS-ACC-003'") does NOT count as a structural gate. If the only test you can write is one that asserts the doc says what it says, add a real structural gate as part of this work. Do not remove a real clause or criterion merely to avoid implementing its gate; unresolved ambiguity or unexpectedly material expansion uses the durable escalation path and remains an open obligation.
- **Re-validate the carve-out against the actual diff at the end of implementation.** The carve-out is checked against the *planned* diff at Step 4 and the *actual* diff at Step 4.5 (clause-by-clause verification) and again before publishing. The pre-publish re-validation is a two-check sweep: (a) every changed path must be in the documentation set (`*.md`, ADRs, notes, docs, README, skills prose), and (b) every diff hunk's *content* must be free of executable behavior (no embedded code, no schema/grammar/policy data consumed by a runtime parser, no runnable fixtures). The path check alone is not enough - a doc file can carry executable behavior. If either check fails for any clause, the carve-out is invalidated retroactively for that clause; revert to the mandatory red-green loop for the executable portion AND for any clause whose structural gate was only a "no executable behavior" claim. The plan-time declaration is provisional; the actual diff is what counts.

If the carve-out applies, jump to Step 4.5; the loop below does not apply.

For all other diffs, the loop is mandatory:

1. **Write the failing test first.** For each clause of each in-scope requirement AND each acceptance criterion in the issue body, write a unit test that exercises the new behavior. Run the test and confirm it fails for the right reason (missing code, not a typo / wiring issue). A test you never saw fail is not a test - it's a guess.
2. **Write the focused production code to make the test pass.** Avoid speculative abstraction and unrelated preference cleanups. This focus rule never authorizes walking past a real defect, failing check, security concern, broken workflow, or material quality problem discovered during the run; record it as an execution obligation, repair it in the current work, and verify the repair.
3. **Refactor with the test green.** Clean up duplication, extract helpers, rename for clarity - but only with the safety net of green tests. Re-run the test after each refactor.
4. **Repeat per clause / acceptance criterion / edge case.** Do not write a batch of production code first and then "fill in tests" afterwards - that is not TDD, it is post-hoc test-shaped coverage and fails to drive the design.
5. **Edge cases and failure modes get tests too.** Validation errors, boundary inputs, conflict states, not-found paths, status transitions. If a behavior matters enough to ship, it matters enough for a red-green cycle.
   - **Security-enforcing behavior gets a behavioral test.** When the diff adds or materially changes production logic that enforces a protection (authentication, authorization, tenant/project isolation, input validation or sanitization, access restriction, secret handling, audit integrity), it ships with a test that drives the protected behavior through its boundary and asserts the enforcement effect, so it goes red if the enforcement is removed, bypassed, or materially weakened. A test that only asserts existence or configuration — that a rule, annotation, row, link, or status is present, that a snapshot contains an identifier, or that a mock was called — provides false assurance. Ask: if I removed the enforcement, would this test still pass? Use the narrowest layer that genuinely exercises the boundary; an existing controller slice test is fine.
6. **Integration / framework-specific test layers**: same loop. Write the failing test before the production code that satisfies it. Repository-policy rules from `cfg.rules.plan_rules_content` (for example, framework-specific test requirements, migration policies) are TDD targets, not afterthoughts.
7. **If you discover during TDD that the plan is wrong**, revise it and continue. Update the plan on the issue thread. Pause only when the revision requires one of the documented judgment/authority classes; record the underlying problem as an open execution obligation with a concrete decision request.

## Versioned artifact releases

When the change generates a capture for a family declared under
`cfg.release_families` (versioned evidence, snapshots, or another monotonic
release artifact), reserve its identity **before** generating the capture
(ADR-097, GC-O017):

1. From the issue branch, call `gc_release_identity` with `action="reserve"`,
   `repo_path`, `issue_number`, `family`, and an `idempotency_key` that names
   this capture deterministically (for example `capture-1`). Never use a
   timestamp, process id, or commit SHA; a retry or a restarted run must reuse
   the same key.
2. Write the capture only to the returned `reservation.paths`, and use the
   returned `reservation.version` wherever the release names itself. Never
   derive "next" from the checkout, and never renumber a capture by hand after a
   base merge.
3. If the run will not ship the capture, call `action="abandon"` from the same
   issue branch with the same key and a `reason` code. The identity is burned,
   not reissued.
4. After the pull request merges, call `action="publish"` with the same key so
   the log records the merged artifact's revision and blob.

A `release_identity_issue_record_failed` or `release_identity_write_undecided`
result is recovered by retrying with the same key; it never allocates another
identity. Reservation does not replace or relax the completion, review, CI,
SonarCloud, or merge gates for the capture itself.

All tests around touched code must stay green at every step. If any test fails,
fix the root cause; provenance or apparent unrelatedness is diagnostic context,
not a reason to leave it broken.

Verify each cycle with the targeted test command, not with the hook chain.
Do not run `pre-commit` by hand to check the working tree, and do not commit
between cycles. The Step 7 `publish` action stages the change, runs the single
mandatory pre-publish hook boundary, and makes the commit behind its
sensitive-path screening and commit-message validation. A local commit made
before `publish` skips both (issue #899).

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "tests_added": [ "<file:lines>" ],
    "production_files_changed": [ "<file>" ],
    "carveout_taken": false,
    "summary": "<one paragraph: what was implemented and how>"
  }
}
```

Do NOT return raw diff content. The orchestrator and downstream steps compute the diff themselves from `git`.
