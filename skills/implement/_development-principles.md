# /implement Development Principles

These principles are the execution contract for every `/implement` driver and
delegated step.

1. Perform the requested operation exactly. Reading instructions, inspecting
   state, planning, acknowledging a correction, or reporting partial progress
   is preparation, not a successful terminal result.
2. Incorporate user corrections and resume the active operation in the same
   run unless a documented pause class applies.
3. Treat the canonical checkout where `/implement` was invoked as the starting
   worktree and immutable mutation boundary for the run and every delegated
   step. Agents and delegated agents MUST NOT make repository changes outside
   the starting worktree without explicit user authorization naming the other
   repository or worktree. Do not create, edit, or delete files, change Git
   state, or invoke write-capable repository tools from another checkout.
   Read-only inspection outside the starting worktree is allowed. Create or
   switch the issue branch only in the starting worktree; do not create, select,
   or relocate into another worktree. `/integrate` retains its separately
   invoked isolated-worktree contract, bounded to its documented targets and
   operations.
4. A real defect, regression, failing check, security concern, broken workflow,
   or material quality problem discovered at any step becomes an obligation of
   the current work regardless of where or when it originated. Fix and verify
   it here. A tracking issue may supplement the record but never replaces the
   repair.
5. Pause only for an explicit workflow gate, unresolved ambiguity, a
   significant architecture or security decision, unexpectedly material scope
   expansion, destructive or externally consequential authority, a hard
   external dependency, or an enforced cycle cap. Work size, difficulty,
   elapsed time, context pressure, and inconvenience are not pause classes.
   Escalation preserves the open obligation and asks for a concrete decision.
6. Report observed state, evidence, impact, corrective action, and
   verification. Mention provenance or responsibility only when causality is
   necessary to diagnose or safely repair the problem. Never use blame,
   ownership, pre-existing status, unrelatedness, or scope as a reason not to
   act.
7. `not-applicable` means the reported condition is factually false or does
   not apply to this codebase. It is not a disposition for real work outside
   the initiating diff. `wontfix` requires explicit user authorization.
8. Make local verification proportionate to risk. Batch related edits and,
   during implementation or review-fix loops, run the narrowest tests that
   exercise the changed behavior. Expand breadth for shared or cross-cutting
   boundaries, security-sensitive changes, or evidence of wider risk. Run
   targeted checks as needed. CI owns repository-wide completion and policy suites.
   Do not require local broad suites before publish or after base synchronization.
   Preserve mandatory pre-commit, review, CI, Sonar, and final-report gates.
