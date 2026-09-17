---
stage_id: transition_reconcile
step: "Step 16"
tier: medium
---

# Step 16: Reconcile Traceability in the Requirement Files

**This step runs BEFORE publish, as part of the delivery diff (issue #1541, superseding the #963 post-merge ordering).** Traceability lives in repo-local requirement files, so — like the Step 15 status transition — reconciling after merge would not land on the target branch without a second PR. Reconcile now, after Step 15 and before publish, so the `## Traceability` edits are reviewed in and merged by the delivery pull request. Post-merge Phase E does not edit these files; it verifies them at the immutable merge revision (Step 17 `phase="post_merge"`).

Requirements are repo-local files (ADR-093, issue #1500): traceability lives in the `## Traceability` section of `docs/requirements/<UID>/requirement.md` as bullets of the form ``- <LINK_TYPE> → <ARTIFACT_TYPE> `<identifier>` (optional title)`` — for example ``- IMPLEMENTS → CODE `src/foo.js``` or ``- TESTS → TEST `src/test/foo.test.js```. There is no backend — reconciliation is **editing those sections** and committing the edits on this run's branch, reviewed in the diff like any change.

**No deferral, here or anywhere downstream (ADR-029).** Reconciliation, the final report (Step 17, `phase="post_merge"`), and any issue comment you post from here on must not contain deferral-disposition language — "out of scope for this PR", "follow-up issue to track X", "addressed in a subsequent PR", "deferred to a later iteration", "TBD later". A finding or a piece of work is either fixed in this PR, recorded `wontfix` with explicit user authorization, or recorded `not-applicable` with rationale. If reconciliation surfaces missing implementation for a requirement, that is a STOP-and-escalate, not a "noted as a follow-up". The `.claude/hooks/block-defer-language.py` PreToolUse hook will block a `gh issue comment` / `gh pr edit` carrying that language; do not work around it — re-route to fix-or-escalate.

**Reconciliation is not the same as "record entries for the in-scope requirements".** Even runs with zero in-scope requirements (pure bug fixes, refactors, maintenance) must reconcile, because the diff may have touched files already recorded against OTHER requirements.

1. **Compute the touched file set.** Run `git diff --name-status <base-ref>...HEAD`. Cache the full list.

   Resolve `<base-ref>` using the configured base branch (`{cfg.workflow.base_branch|default dev}`) in this order:
   1. `origin/{cfg.workflow.base_branch|default dev}` (verify with `git rev-parse --verify`).
   2. `{cfg.workflow.base_branch|default dev}` (local, verify with `git rev-parse --verify`).
   3. `origin/main` (fallback for repos that don't use `dev`).
   4. `main` (fallback).
   5. If none resolve, run `git fetch origin {cfg.workflow.base_branch|default dev}` and retry. If the fetch fails, STOP and surface a clear error.

2. **Process deleted and renamed files first.**
   For every deleted file `path`:
   - Scan every `docs/requirements/*/requirement.md` `## Traceability` section for a bullet whose identifier is `path` (CODE or TEST artifact).
   - For each match: if behavior moved to a new file (rename or split), update the bullet's identifier to the new path. If behavior was removed entirely and the requirement no longer has any implementation entry, STOP — ripping out the only implementation of a requirement is a user decision.
   For every renamed file `old_path → new_path`:
   - Update the matching bullet's identifier from `old_path` to `new_path`.

3. **Process modified files.**
   For every modified file `path`:
   - Find any `## Traceability` bullet naming `path` (CODE, or TEST for test files).
   - For each: still satisfies the linked requirement? → leave alone. Behavior moved? → update the identifier. Behavior now spans more files? → add bullets.
   - Inspect for behaviors that satisfy under-recorded requirements and add entries. Bound by plausible subject area; don't compare every requirement to every file.

4. **Process added files.**
   For every added file `path`:
   - Determine which requirement(s) it satisfies. Add an IMPLEMENTS (production) or TESTS (test-file) bullet to that requirement's `## Traceability` section. Incidental files (helpers, fixtures, generated) may have no entry — that's fine.

5. **Ensure every in-scope requirement has coverage appropriate to its nature.**

   **Mode A — the diff ships the work.** For each UID in `in_scope_requirements[]`:
   - **IMPLEMENTS coverage is required** against the artifact(s) of record. Every materially-implemented in-scope requirement must have at least one IMPLEMENTS bullet pointing at the file(s) that satisfy its clauses — in the diff (Step 15 case in-diff), pre-dating the diff (Step 15 case pre-existing), or both. The shape of "implementation" depends on the requirement: code → production file; documentation → ADR/SCHEMA/docs file; configuration → config file; workflow → workflow file / hook script. When the diff adds documentation that defines the requirement's contract, record it IMPLEMENTS too; pure-housekeeping entries need no bullet.
   - **Backfill onto pre-existing artifacts when the diff finalizes the requirement.** If Step 15 classified the requirement as case pre-existing, the *backfill targets* are already cached, partitioned by intended link type. Add IMPLEMENTS bullets for each candidate in the IMPLEMENTS partition and TESTS bullets for each in the TESTS partition. Never record an IMPLEMENTS bullet onto a candidate classified as a TEST. Do not invent a "diff-only" IMPLEMENTS bullet onto an ADR or documentation note as a substitute for recording the actual implementing code.
   - **TESTS coverage is conditional.** Add a TESTS bullet when the diff introduces or touches an automated test that verifies the requirement, OR when discovery's TESTS partition contains a pre-existing test that verifies it. TESTS is NOT required for documentation / configuration / structural-invariant requirements with no executable behavior.
   - **Do not fabricate entries.** If a requirement has testable behavior and no test was added or discovered, go back to Step 4.4.
   - **Never record an entry to a requirement the file does not satisfy** just to satisfy this step. Surface the mismatch to the user instead.
   - **Forward-looking requirements** get DOCUMENTS bullets, not IMPLEMENTS, and stay DRAFT.

   **Backfill rules (apply to Mode A case pre-existing and to Mode B below).**
   - Reuse the discovery procedure documented in Step 15 (subject-area-bounded `git ls-files` / `git grep` against named subsystems/file roots, then read each candidate and the requirement file's `## Traceability` section). Do NOT compare every requirement to every file.
   - Existing entries for files that still satisfy the requirement remain valid. Do not churn them merely because the current PR touched a nearby document.
   - If backfill discovers no implementing file anywhere in the repo, STOP — either the requirement should be demoted (DEPRECATED) or implementation is missing. Surface to the user.

   **Mode B — Step 4 concluded the work is already complete.** The diff is empty; forcing an IMPLEMENTS bullet onto a non-existent diff file would be wrong. Instead:
   - **Accept existing IMPLEMENTS coverage.** If the requirement already has IMPLEMENTS bullets pointing at files that exist and still satisfy it, that coverage is complete. Do NOT fabricate new entries.
   - **Backfill only when nothing is recorded.** If the requirement has zero IMPLEMENTS bullets, locate the implementing file(s) per the *Backfill rules* and add the bullet(s).
   - **TESTS rules from Mode A still apply.**

6. **Reconcile the issue → requirement entries.**
   - **Add missing entries.** For each UID in `in_scope_requirements[]`, ensure its `## Traceability` section has a `GITHUB_ISSUE` bullet with identifier `<issue-number>`. Use `IMPLEMENTS` for materially-implemented requirements (matches `gc_create_github_issue`'s auto-record convention), `DOCUMENTS` for forward-looking ones. **Never** use `TESTS` — an issue is not an executable test.
   - **Remove stale entries.** Scan for `GITHUB_ISSUE` bullets naming `<issue-number>` in requirement files whose UID is NOT in `in_scope_requirements[]`, and remove them.
   - A bullet that already exists is simply left in place — re-recording is a no-op.
   - Note: `gc_create_github_issue` seeds an `IMPLEMENTS` issue→requirement bullet during UID-first runs. For a forward-looking in-scope requirement this PR does not deliver, change that bullet to `DOCUMENTS` before this step exits.

Reconciliation is idempotent: running it on an already-correct branch is a no-op. When it produces edits, commit those requirement-file edits on this run's branch as part of the delivery diff — they are frontmatter / `## Traceability` documentation edits, gated by pre-commit plus the doc guardrails in `cfg.workflow.policy_command`, not by the implementation completion / test suite. When it produces **no** edits — traceability is already complete and consistent — there is nothing to commit; never fabricate a placeholder edit to create a diff (issue #1543). Proceed to the required reviews, then publish; the merged files are verified in Phase E (Step 17 `phase="post_merge"`).

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "links_added": [ "<UID> ← <path> (<link_type>)" ],
    "links_updated": [ "<UID> ← <old_path> → <new_path>" ],
    "links_deleted": [ "<UID> ← <path>" ],
    "notes": "<optional one-line note>"
  }
}
```
