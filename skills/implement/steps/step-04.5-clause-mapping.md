---
stage_id: clause_mapping
step: "Step 4.5"
tier: medium
---

# Step 4.5: Clause-by-Clause Verification

Before declaring implementation complete, build a mapping from every clause of every in-scope requirement AND every acceptance criterion in the issue body to the specific code (`file:line`) that satisfies it.

1. For each requirement in `in_scope_requirements[]`:
   - Re-read the requirement statement cached in Step 1.
   - Break it into individual clauses.
   - For EACH clause, identify the specific code (`file:line`) that satisfies it.
2. For each acceptance criterion stated in the issue body (or in the issue comments by the user):
   - Identify the specific code (`file:line`) that satisfies it.
3. If `in_scope_requirements[]` is empty AND the issue body has no explicit acceptance criteria, treat the issue title and description as the acceptance contract and verify the change matches.
4. If any clause or criterion is not satisfied, go back and implement it before proceeding.

Present the mapping as a checklist with the requirement UID (or `issue`) as the source label. Use the repo's source/test path conventions:

```
- [ ] GC-X004 clause: "..." → Satisfied by: {cfg.example_paths.source|default <repo source path>}/.../File.java:line
- [ ] GC-X004 clause: "..." → Satisfied by: {cfg.example_paths.test|default <repo test path>}/.../FileTest.java:line
- [ ] GC-X005 clause: "..." → Satisfied by: <other-relevant-path>:line
- [ ] issue acceptance: "..." → Satisfied by: {cfg.docs.adr_dir|default architecture/adrs/}0XX-name.md:line
```

Do not proceed until every clause and criterion is checked off.

Traceability reconciliation (IMPLEMENTS / TESTS links) and the `DRAFT → ACTIVE` status transitions are intentionally NOT done here. They are made by **Steps 15–16 after implementation and before publish**, as requirement-file edits in the delivery diff (issue #1541, superseding the #963 post-merge ordering), so they are reviewed in and become authoritative through the merged PR. A reviewed-but-abandoned PR therefore leaves the target branch's requirement DRAFT and unlinked.

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "clause_mapping": [
      { "uid": "<UID or 'issue'>", "clause": "<short string>", "satisfied_by": "<file:line>" }
    ],
    "unmapped_clauses": []
  }
}
```

If `unmapped_clauses` is non-empty, return `status: "error"` so the orchestrator loops back to Step 4.4.
