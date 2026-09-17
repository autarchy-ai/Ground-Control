---
stage_id: transition_reconcile
step: "Step 15"
tier: medium
---

# Step 15: Transition In-Scope Requirements to ACTIVE

**This step runs BEFORE publish, as part of the delivery diff (issue #1541, superseding the #963 post-merge ordering).** Because requirements are repo-local files, an edit made after the PR merges does not land on the target branch without a second PR. So the requirement `status:` transition is made now — alongside the implementation, in Phase B before publish — and is reviewed in, and becomes authoritative through, the delivery pull request. Post-merge Phase E performs **no** requirement-file mutation; it only *verifies* the merged state (Step 17 `phase="post_merge"`). Pre-merge readiness (Step 17 `phase="pre_merge"`) names this state as *proposed*, not authoritative. (The `work_already_complete` branch from Step 4 also enters here: if the requirement files need any change, that change still requires a reviewed PR — do not edit-and-commit outside one.)

Requirements are repo-local files (ADR-093, issue #1500): each in-scope requirement is `docs/requirements/<UID>/requirement.md` with a `status:` field in its YAML frontmatter. There is no backend — transitioning a requirement is a **frontmatter edit** committed on this run's branch and reviewed in the diff like any other change. Semantically, moving a requirement from DRAFT to ACTIVE is the point at which the team commits to its statement: once real code exists pointing at it AND that code has merged, the requirement is no longer a proposal, it is a contract.

For each UID in `in_scope_requirements[]`:
- **First, classify the requirement against the actual diff:**
  - **Materially implemented (case in-diff)** — the diff itself contains the artifacts-of-record that satisfy the requirement's clauses (production code, tests, schema/migration files, configuration files, ADRs, workflow definitions, skill prose, or any other deliverable the requirement statement specifies).
  - **Materially implemented (case pre-existing)** — the diff finalizes/documents the requirement (for example, an ADR clarification or workflow note marking it complete) while the structural implementation already exists in pre-existing files shipped under a sibling requirement. The test is "does this PR ship the requirement," not "is the implementing code in this diff." For this case, **before transitioning**, use the discovery procedure below to identify the pre-existing artifact(s) of record. If discovery finds zero implementing files, the classification is wrong: STOP, surface to the user (forward-looking, missing implementation, or misidentified), and do NOT transition.
  - **Forward-looking** — the diff documents or references the requirement but does not ship it. Record a `DOCUMENTS` entry in Step 16 instead of `IMPLEMENTS`, and leave the status DRAFT. Surface this decision as a comment on the issue. Skip the rest of this loop for that UID.

- **Pre-existing artifact discovery procedure (case pre-existing only).** This MUST run before the ACTIVE transition for the case-pre-existing path, so a requirement never gets promoted-without-coverage:
  1. Read the requirement statement (the `## Statement` section of the file) and identify the named subsystems, file roots, modules, or component identifiers it references (for example, "the Identity Center bootstrap module," "the state-boundary verifier").
  2. Run `git ls-files` filtered to those roots, plus `git grep -l` (NOT `grep -r`) against the requirement's distinctive identifiers (UID, named module, distinctive function names) bounded to the subject-area paths. Use `git`-aware tools so the candidate set only contains tracked files — `grep -r` would also walk untracked / generated / `.gitignore`'d / build / `node_modules` paths. Do NOT scan the whole repo.
  3. **Validate each candidate file against the requirement statement** by reading it and confirming the file actually satisfies the clause(s) you mapped it to. The candidate list is a superset; the agent's read of file content against the requirement is what proves satisfaction. Discard candidates that do not.
  4. **For each surviving candidate**, classify it by intended link type and read the requirement file's existing `## Traceability` section to learn what it is already recorded against (dedupe / preservation, NOT validation):
     - Production code, configuration files, ADR/design docs, workflow files → IMPLEMENTS, artifact type `CODE` / `CONFIG` / `ADR` / `DOCUMENTATION` as appropriate.
     - Automated tests that verify the requirement → TESTS, artifact type `TEST`.
     - Existing entries that still hold remain valid; do not churn them.
  5. Cache the surviving candidate set as the *backfill targets*, partitioned by intended link type (IMPLEMENTS targets vs TESTS targets) — Step 16 records these in the requirement file's `## Traceability` section and never records an IMPLEMENTS entry onto a candidate classified as a TEST.
  6. If the IMPLEMENTS partition is empty after a bounded, validated search, the case-pre-existing classification fails (see above).

- **Only after classification (and, for case pre-existing, after discovery succeeded)**, transition the materially-implemented requirements:
  - Edit `docs/requirements/<UID>/requirement.md`: change the frontmatter `status:` from `DRAFT` to `ACTIVE`.
  - If the requirement was already `ACTIVE`, skip it.
  - If the requirement was in any other state (`DEPRECATED`, `ARCHIVED`), STOP and surface the anomaly to the user — transitioning out of those states is a user decision.

If `in_scope_requirements[]` is empty, this step is a no-op. Proceed to Step 16 anyway — reconciliation still runs to catch drift on other requirements whose files this diff touched.

A no-op transition — an empty scope, or an in-scope requirement that is already ACTIVE — produces **no** edit and therefore nothing to commit. Never fabricate a `status:` edit just to create a diff (issue #1543).

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "transitions": [
      { "uid": "<UID>", "from": "DRAFT", "to": "ACTIVE" }
    ],
    "forward_looking": [ "<UID>" ],
    "backfill_targets": {
      "<UID>": { "implements": [ "<path>" ], "tests": [ "<path>" ] }
    }
  }
}
```
