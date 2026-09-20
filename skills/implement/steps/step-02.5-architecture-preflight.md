---
stage_id: architecture_preflight
step: "Step 2.5"
tier: low
---

# Step 2.5: Run Codex Architecture Preflight

When the repo declares `architecture.vocabulary` in `.ground-control.yaml` (per #931), preflight reads that block and emits a "Design Vocabulary That Applies" section in its binding note - the subset of patterns / canonical helpers / boundary contract / binding ADRs / anti-recommendations the proposed work plausibly touches. The pre-push reviewers (Steps 6.5 and 6.6) consume the same vocabulary so their `architectural_read` anchors on the repo's dialect. When the block is absent, preflight runs with workflow-level defaults and the reviewers fall back to general principal-engineer judgment. Nothing in the workflow tools hardcodes any single repo's vocabulary.

Preflight MUST cover every in-scope requirement, not just the first one. The preflight tool loads exactly one requirement payload per call, so grouped issues that carry multiple UIDs need one call per UID - otherwise codex never sees the statements, rationale, or existing traceability for every requirement after the first, and the returned guardrails will be incomplete.

1. Reuse the absolute repository root from Step 1.
2. **Determine the preflight call set.**
   - If `in_scope_requirements[]` is non-empty, run the call below **once per UID in the list**. Each call preflights a single requirement.
   - If `in_scope_requirements[]` is empty (requirement-free bug/refactor/maintenance run), run the call exactly once with `issue_number` alone and omit `requirement_uid`.
3. For each call in the set, call the `gc_codex_architecture_preflight` MCP tool with:
   - `issue_number`: the issue number from Step 1 (always supplied - it is the authoritative anchor for preflight in both UID-first and issue-first runs)
   - `repo_path`: absolute path from Step 1
   - `project`: `cfg.project`
   - `requirement_uid`: the UID being preflighted in this call (omit entirely on requirement-free runs).
   - `async`: `true` - preflight runs codex against the whole repo and legitimately takes minutes. With `async=true` the tool returns `{ok:true, status:"running", job_id}` immediately; await it with `gc_codex_job` (`action="await"`, `job_id=<job_id>`), which holds that one call until `status:"done"`, then read the preflight result from the response's `result` field. Do not poll on a fixed cadence - each tick is a full-context model turn that learns nothing (issue #1669). A bounded wait that expires returns the ordinary running envelope while preflight continues; await again. A `job_not_found` result means the job expired or the MCP server restarted - re-run the call. This keeps the multi-minute preflight from tripping the MCP client tool-call timeout (issue #937).
4. After every call in the set has returned (awaited to `status:"done"`), read any ADRs, design notes, or workflow guidance that Codex created or updated. Multiple calls may touch overlapping files - that is fine; treat the union of all guardrails as binding.
5. Treat the returned guardrails, cross-cutting concerns, and non-goals as binding unless they are clearly wrong.
6. Do NOT revert or ignore Codex-added design guidance just because implementation looks possible without it.

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "preflight_notes": [ "<path to each created/updated design note>" ],
    "binding_guardrails_summary": "<one-paragraph summary of the binding guardrails>",
    "preflight_marker_present": true
  }
}
```

Do NOT echo verbatim Codex output to the parent - the design notes themselves are the durable record. The summary is a short prose hint; the agent that runs Step 4 reads the actual notes.
