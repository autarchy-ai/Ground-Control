---
stage_id: pr_body
step: "Step 9"
tier: low
---

# Step 9: Create PR

1. **Render the PR body via `gc_render_pr_body`** (per ADR-036). Pass:
   - `repo_path`, `issue_number`
   - `change_class`: `doc-only` if the diff is entirely documentation per Step 4.5's acceptance mapping and the pre-publish path/content sweep; `source+migration` if the diff includes a database migration; otherwise `source`.
   - `requirement_uids`: the in-scope UIDs from Step 1.
   - `adr_refs`: the ADR identifiers this PR touches (for example, `ADR-036`, `ADR-021 (amended)`); pass an empty array to render "No ADR required."
   - `summary`: one paragraph. Update length follows the canonical succinctness rule in `skills/implement/steps/_review-loop-rules.md`.
   - `changes`: array of bullet strings describing each change.
   - `traceability`: `{ implements: [...], tests: [...] }` strings - typically `<UID> ← <file path>` shape; the tool emits the IMPLEMENTS / TESTS markers `check_pr_body` requires.
   - `changelog_mode` (optional): pass `"release-please"` when the repo ships a `release-please-config.json` at its root (GC-P027, issue #1399) - Release Please owns `CHANGELOG.md`, so no per-PR fragment is required or accepted; **omit `changelog_fragment` entirely** in this mode. Default (or `"fragments"`) preserves the legacy per-PR `changelog.d/` fragment requirement for repos that have not adopted Release Please.
   - `changelog_fragment`: path under `changelog.d/` (required for `source` / `source+migration` when `changelog_mode` is `fragments` or omitted; omit for `doc-only` and for `changelog_mode: "release-please"`).
   - `test_notes` (optional): extra prose under the Test Plan section.
   - `dev_start_gate` (optional): full Markdown `## Dev-Start Gate` section when the repo's PR template or metadata policy requires it. Reuse the plan's gate fields, adjusted to describe the PR diff.

   - `lane` / `pre_push_reviews` (optional): leave both unset. They default to `implement` / `completed`, which is the accurate attestation for this lane - Steps 6.5 and 6.6 run both pre-push reviewers before this step. `/implement` may not pass `pre_push_reviews: "not_run"`; the renderer refuses that combination rather than let a mandatory gate be attested away (issue #1551).

   - `documentation_outcome` (optional): `{ outcome, rationale? }` where `outcome` ∈ `updated`, `verified_unchanged`, `not_updated_authorized`. Required when the diff touches a documented surface (per ADR-054's surface classes in `mcp/ground-control/lib/doc-coverage.js`). `not_updated_authorized` requires a non-empty `rationale`.

   The tool returns `{ ok, body, byte_length }`. Use `body` as the PR description.

   **No-requirements runs** (`in_scope_requirements[]` is empty - typical for bug fixes, refactors, dependency bumps): the renderer emits `- (none - bug/refactor/maintenance run; see Traceability section below)` in the Requirement UIDs section. The whole-body UID check (`PR_REQUIREMENT_RE`) still needs SOME UID-shaped token in the body - for these runs, satisfy it by passing at least one ADR reference in `adr_refs`. ADR identifiers like `ADR-021` / `ADR-029` / `ADR-036` match the UID regex. Use `ADR-021` ("Gated Agentic Development Loop") as the foundational default for any `/implement`-driven PR, since every `/implement` run is gated by ADR-021 - that's not fabricated traceability, it's an honest acknowledgment of the workflow contract that produced the PR.

2. **Shape the PR title before PR creation.** The repository-bound creation
   tool validates the same configured rules before any GitHub write.

   - **Rule 1 - single conventional-commit type with optional scope.** Title must match `<type>(<optional-scope>): <subject>`, with an optional Conventional Commits breaking-change `!` before the colon (`feat!: ...`, `feat(api)!: ...`; issue #1593). Compound type prefixes like `security/docs:` or `fix/refactor:` are rejected outright. For bundled PRs that ship multiple change classes, pick the dominant type (typically `security:` for security/initial-release bundles, even when docs/refactor changes ride along) and describe the rest in the subject. The canonical allow-list, when the repo does not declare its own (see configuration knob below), is: `security`, `added`, `changed`, `deprecated`, `removed`, `fixed`, `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`, `perf`, `revert`.
   - **Rule 2 - subject starts lowercase** (matches `^[a-z].*$`). Project or acronym names that conventionally appear uppercase (`NGFW`, `GCP`, `AWS`, `MCP`) must be reshaped so the **first character of the subject is lowercase**. Either lowercase the leading word (`ngfw doc cleanup`), relocate it inside a path prefix (`mcp/ngfw doc cleanup` - slash-prefixed paths read as lowercase), or front the sentence with a verb (`harden mcp/ngfw secret handling`).
   - **Configuration knob (per repo).** When `.ground-control.yaml` declares a `workflow.pr_title` block, consume it; otherwise fall back to the canonical defaults above.
     ```yaml
     workflow:
       pr_title:
         types: [security, added, changed, deprecated, removed, fixed,
                 feat, fix, chore, docs, refactor, test, ci, build, perf, revert]
         subject_pattern: "^[a-z].*$"
         require_scope: false
     ```
   - **Failure handling.** If the title fails either rule, reshape it and re-validate locally. Do NOT push to GitHub and let the lint workflow report it - that costs a full CI cycle for a one-line edit.

3. Call `gc_create_synchronized_implement_pr` with `repo_path`,
   `issue_number`, `branch_name`, the `synchronization_record_id` from Step
   8.5, the validated `title`, and the rendered `body`.
   - The tool re-fetches the configured integration branch immediately before
     the GitHub write.
   - It re-reads the trusted synchronization record and requires the current
     base SHA, local feature SHA, and remote feature SHA to match it exactly.
   - On a missing/stale/mismatched record, follow `next_action` back to Step
     8.5. Never bypass the refusal with direct CLI PR creation.
   - If a PR already exists for the branch, the tool returns its number and URL
     without creating another one.

4. Note the PR number and URL. Under Related Issues the renderer emits a
   **non-closing `Refs #<issue-number>` for a requirement-backed run** (non-empty
   `requirement_uids`) so GitHub does not auto-close the issue at merge ahead of
   Phase E's merged-requirement-state validation; the validated
   `gc_close_issue_after_merge` (Step 20) is the sole closer. For a
   requirement-free run it emits `Closes #<issue-number>` (issue #1541), which GitHub
   honors only when the PR merges into the repository's default branch; a PR on
   the integration branch leaves the issue open, and Step 20 closes it either way
   (issue #1601). The GitHub UI cross-link is wired automatically in both cases.

## Return contract

```json
{
  "status": "ok",
  "cached_for_next_step": {
    "pr_number": <int>,
    "pr_url": "<URL>",
    "change_class": "doc-only" | "source" | "source+migration"
  }
}
```
