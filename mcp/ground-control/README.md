# Ground Control MCP Server

The MCP server that backs Ground Control's `/implement`, `/quickfix`,
`/integrate`, and `/review` workflow lanes over repo-local files. It is the only
running Ground Control service: there is no backend, no database, and no
frontend (issue #1500). Requirements and ADRs are files in the consuming repo
(`docs/requirements/<UID>/requirement.md`, `architecture/adrs/*.md`) that the
agent reads and edits directly, reviewed in the pull request like any other
change (ADR-093).

The server exists to own the side effects an agent must not own. Every
privileged `gh` and `git` call runs here, argv-based, inside the repository the
server was launched against - never from a codex or Claude sandbox (ADR-027).
The GitHub issue thread is the durable workflow record (ADR-029), and the
structured record tools are the only writers to it.

## Server version and client compatibility

The server advertises `name: ground-control` and a version in the MCP
`initialize` handshake. The version comes from
`mcp/ground-control/package.json`, so a client always reads the version of the
package it is talking to. `server-version.test.js` spawns the server and
asserts the handshake matches the package, which keeps the two from drifting.

This version covers the published tool surface: tool names, input schemas, and
result envelopes. It is the `grndctl` npm package version, which Release Please
owns (GC-P027, issue #1587): it is derived from Conventional Commit history, so
the change's commit type sets the bump.

| Change to the tool surface | Conventional Commit | Bump |
| --- | --- | --- |
| Remove or rename a tool, remove or narrow an input field, make an optional input required, or remove a result field or change its type | `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer | MAJOR |
| Add a tool, add an optional input field, or add a result field | `feat:` | MINOR |
| Fix a defect, or reword a description, without changing the contract | `fix:` | PATCH |

Clients read `serverInfo.version` after `initialize` and gate on the major
component: a client written against major version *N* keeps working across
every later minor and patch release of *N*, and needs review before it runs
against *N+1*. The MCP protocol version is negotiated separately by the SDK and
is unrelated to this version.

## Setup

Install and set up repositories with the `grndctl` package; see the
[documentation](../../docs/public/index.md):

```bash
npm install -g grndctl
grndctl install-skills
grndctl init      # in each repository: confirm settings, review changes, then write
grndctl doctor
```

The server always runs from the installed package (`grndctl mcp`), never from a
checkout. To run unreleased code deliberately, `npm link` from `mcp/ground-control`
in a clone.

The server needs no environment variables and no reachable service to start.
Most tools work with none of the variables below set; the ones that need a
credential refuse and name it, so provisioning is a decision you make per
repository rather than an inheritance you get by accident.

For development in a clone, install dependencies with `make ground-control-mcp-install`
(`npm ci` in `mcp/ground-control`). The Codex-backed tools additionally require the Codex CLI
on `PATH`, and the GitHub-writing tools require an authenticated `gh`.

### Optional environment

`<launch directory>/.env` is the **only** source of Ground Control's variables,
whether the server was started by Claude Code, Codex, or anything else. No
machine-level or user-level configuration file is consulted, and no variable
falls back to the ambient environment the launcher passed down. If a variable a
tool needs is absent, that tool does not run: it returns an error naming the
variable and the file, and the operator fixes the `.env` and restarts the server.

The launch directory is a deliberate control, not an incidental default. It is
what lets separate checkouts draw on resources belonging to different projects or
organizations, and what makes it possible to deploy Ground Control into a
single-repo sandbox. A machine-level file assumes there is a machine level, which
is an assumption about deployment topology Ground Control has no business making,
and it silently substitutes a global credential into a repository that
deliberately has none (issue #1562).

Nothing here is required. The server starts, and every tool that needs no
variable works, with the file absent. Each variable below switches on one
optional behavior. `.env.example` is the template, and
`lib/server-env.js` holds the inventory a contract test keeps in agreement with
both the template and the code.

| Variable | Effect when set |
|---|---|
| `GC_CODEX_TIMEOUT_MS` | Per-invocation timeout for Codex-backed tools, within the bounds in `lib/model-subprocess.js`. |
| `GC_CODEX_REVIEW_PARALLEL` | Runs the core and security reviewers concurrently when set to `2`. |
| `GC_CODEX_REVIEW_MAX_DIFF_BYTES` | Diff-slice budget for a review cycle (see diff transport below). |
| `GH_VERIFY_FINDING_AUTHORS` | Extra comma-separated GitHub logins `gc_codex_verify_finding` accepts as finding authors, for a service-identity deployment. |
| `GC_KNOWLEDGE_INGEST_ANTHROPIC_API_KEY` | Anthropic key used only by the knowledge-ingest child, so ingestion can bill separately from the review engine. |
| `SONAR_TOKEN` | Lets `gc_watch_sonar_analysis` read the SonarCloud quality gate. Without it the tool returns `sonar_watch_token_missing`, which `/implement` Step 11 treats as an infrastructure blocker for the operator rather than as SonarCloud findings for the agent. |
| `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | Selects the review engine's auth mode. Declare exactly one; with none declared the Step 6.6 review refuses with `test_quality_review_auth_missing` before spawning `claude`. See "Test-quality review engine" in `docs/DEVELOPMENT_WORKFLOW.md`. |
| `CLOUD_ML_REGION`, `GOOGLE_CLOUD_PROJECT`, `ANTHROPIC_VERTEX_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, `AWS_REGION`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `ANTHROPIC_BASE_URL` | Companion values the selected review-engine auth mode needs. |
| `OPENAI_API_KEY`, `CODEX_HOME` | Forwarded to the `codex` child. Neither is required: `codex` authenticates from its own profile directory when no key is declared. |

The Citation MCP server (`mcp/citation`) has its own variables. They reach that
separate process through `.mcp.json` expansion from the MCP client's
environment, not through this file, and are documented in
`mcp/citation/README.md`.

Keep `.env` gitignored and `chmod 600` if you put a token in it. Tokens are read
by the server process and are never returned through a tool result or exposed to
the model. The file is read once at startup, so provisioning or rotating a value
takes effect on the next server start.

## Tool surface

The server registers **34 tools**. They are the `/implement`, `/quickfix`,
`/integrate`, and `/review` workflow mechanics plus the coding-agent/reviewer separation - there is
no entity CRUD surface and no ad-hoc REST escape hatch, because there is no
backend behind them to read. Requirements and ADRs are read and written as repo
files.

The `/integrate` lane's `gc_integration_manager` is registered again. #1506
removed it as dead code after checking for callers in JS and finding none - its
only caller is `skills/integrate/SKILL.md`, which names tools in prose - which
left GC-O011 (ACTIVE, MUST) with no entry point.
`skill-tool-registration-contract.test.js` now asserts that every `gc_*` name in
any skill is a tool this server advertises, so the prose-to-registration boundary
is checked rather than assumed.

Registration lives in `mcp/ground-control/tools/*.js`; each tool is a zod input
schema plus a thin handler delegating to `lib.js`.
The complete keep/delete and placement record is in
[`docs/architecture/SURVIVING_GATES.md`](../../docs/architecture/SURVIVING_GATES.md).

**Repository context and issue entry (`tools/query.js`)**

| Tool | Purpose |
|---|---|
| `gc_get_repo_ground_control_context` | Read and validate the repo's `.ground-control.yaml`; returns workflow commands, routing, docs paths, and inlined plan rules |
| `gc_create_github_issue` | Create a GitHub issue from a repo-local requirement and link it back |
| `gc_update_issue_requirements` | Set the in-scope requirement UID list in an existing issue's `## Requirements` section; `add` unions, `remove` needs a repository writer's authorization comment, nothing else in the body moves |
| `gc_remember` | Capture a knowledge-base entry under the repo's configured knowledge directory |
| `gc_post_implementation_plan` | Post the Step 4 plan to the issue thread; requires the preflight marker |
| `gc_close_issue_after_merge` | Idempotent post-merge issue close, gated on the PR actually being merged |

**Workflow mechanics (`tools/review-cap-disposition.js`)**

| Tool | Purpose |
|---|---|
| `gc_implement_mechanical` | Run a shared deterministic phase - `bootstrap`, `publish`, `monitor`, `readiness`, or `finalize`; `lane: quickfix` reuses the compatible phases while rejecting requirement scope and implement-only readiness. The two long actions accept `async` + `idempotency_key` and return a job handle |
| `gc_prepare_implement_branch` | Same-checkout branch preparation for an issue |
| `gc_mark_implement_issue_picked_up` | Apply the in-progress label and post the pickup comment |
| `gc_synchronize_implement_branch` | Fetch and really merge the integration branch, verify the graph, push, and post the synchronization attestation |
| `gc_create_synchronized_implement_pr` | The only canonical PR-write path; revalidates the attestation, identity, and title immediately before the write |
| `gc_resolve_workflow_route` | Resolve advisory provider/model/tier for a workflow stage (ADR-036); never forces delegation |
| `gc_review_cap_disposition` | Record a review-cap disposition |
| `gc_record_execution_obligation` | Append to the execution-obligation ledger |
| `gc_authorize_execution_obligation_wontfix` | Record the user's authorization to close an obligation unfixed |
| `gc_codex_job` | Poll or cancel any async review, preflight, or mechanical job |

**Station-observation recovery (`tools/station-observation.js`)**

| Tool | Purpose |
|---|---|
| `gc_reconcile_station_observation` | Resolve a stranded `station_observation` obligation as `reobserved` from the station's own findings record and cycle marker already on the thread; accepts no disposition or claim |

**Versioned artifact releases (`tools/release-identity.js`)**

| Tool | Purpose |
|---|---|
| `gc_release_identity` | `reserve` the next identity of a `release_families` family against its base branch head, `publish` it once its artifacts are regular files there, `abandon` it with a reason code, or read `status`. Allocation is a create-only reference under `refs/gc/release-identities/<family>/`; the same issue, family, and `idempotency_key` always replay the stored reservation. No repository, revision, version, or path input (ADR-097) |

**Durable issue-thread records (`tools/post-decision-record.js`)**

| Tool | Purpose |
|---|---|
| `gc_post_decision_record` | Render a review cycle's decision record from structured findings |
| `gc_post_final_report` | Render the trusted final record used inside the shared post-merge finalizer; `lane` selects the `/implement` or slim `/quickfix` shape |
| `gc_assert_completion` | The merge-gated composite completion assertion |
| `gc_render_pr_body` | Compose a PR body that satisfies `check_pr_body`'s policy gates from structured input |
| `gc_get_issue_thread` | Fetch the issue body and comments through a content-addressed cache |
| `gc_watch_ci_run` | Bounded watch of the PR's CI run |
| `gc_watch_sonar_analysis` | Bounded watch of the SonarCloud analysis and quality gate |

All of these filter sensitive content, post under a structured marker family,
and reject deferral language server-side. That server-side scrub is why the
skills post through these tools rather than `gh issue comment`: the PreToolUse
hooks in `.claude/hooks/` are Claude-Code-only, so the tool boundary is the one
enforcement layer every driver shares.

**Reviewers (`tools/query.js`, `tools/post-decision-record.js`)**

| Tool | Purpose |
|---|---|
| `gc_codex_architecture_preflight` | Codex architecture preflight before planning |
| `gc_codex_review` | Codex production-quality review with cycle caps |
| `gc_codex_review_cycle` | Async-only, idempotent pre-push review cycle |
| `gc_codex_verify_finding` | Verify a specific finding is resolved |
| `gc_test_quality_review` | Test-quality review of the changed tests |
| `gc_test_quality_review_cycle` | Async-only, idempotent pre-push test-quality cycle |

**Maintainer PR review lane (`tools/pr-review.js`)**

| Tool | Purpose |
|---|---|
| `gc_get_pr_review_context` | Read-only bounded evidence snapshot of a PR |
| `gc_remediate_pull_request` | Authorization-gated `sync_base` / `publish` |

**Approved-PR integration (`tools/integrate.js`)**

| Tool | Purpose |
|---|---|
| `gc_integration_manager` | `plan` (discover the approval-labeled queue and order it), `prepare` (isolated worktree, rebase onto base, completion gate, CI and SonarCloud watches, `--force-with-lease` push), `status` (read-only lock and last-run state), `release` (idempotent lock release). Every action is bound to the MCP launch checkout and refuses a `repo_path` naming another repository the process can reach. `mode` defaults to `prepare` and never merges; `enqueue` is reserved and refuses at runtime |


## Repo-local configuration

For cross-repo workflow automation, define Ground Control context in a
`.ground-control.yaml` file at the repo root. At minimum it declares
`schema_version: 1` and a `project` identifier; optional sections include
`workflow`, `sonarcloud`, `rules`, `knowledge`, `routing`, plus the
workflow-packaging fields added in ADR-027: `docs.{adr_dir,
architecture_overview, coding_standards, workflow_reference, knowledge_base}`,
`example_paths.{source, test}`, `requirements.uid_examples`, and
`cross_cutting_concerns.description`. The optional `release_families` mapping
opts a repository into `gc_release_identity`; a family is active only once its
definition is on its base branch (ADR-097). A legacy `grc.*` block from a
pre-ADR-089 config is tolerated and ignored - never validated, parsed, or
returned.

The legacy `telemetry` key is accepted for consumer compatibility but ignored;
the backend projection and every emitter were retired by issues #1500 and #1303.

`gc_get_repo_ground_control_context` reads and validates this file and is the
only reader of it (ADR-027); the skills render their prose against the fields it
returns via `{cfg.X|default Y}` placeholders, so one source of truth serves every
Ground-Control-aware repo. `gc_resolve_workflow_route` reads the same config and
resolves `routing.stages.<stage>` to advisory provider/model/tier metadata; it
does not choose an executor or force delegation. See
`docs/DEVELOPMENT_WORKFLOW.md` for the full accepted shape, defaults, allowed
routing values, and validation constraints. `buildSuggestedGroundControlYaml()`
in `lib.js` is only the starter template.

## Maintainer PR review lane (gc_get_pr_review_context, gc_remediate_pull_request)

Two capability-separated tools back the `/review` skill (GC-O015, issue #1535) - a read-only reader and an authorization-gated mutation surface. They are **separate tools by design** so a review-only caller cannot reach a mutation by flipping an action field, and post-merge closure reuses `gc_close_issue_after_merge` rather than adding a close path.

- **`gc_get_pr_review_context`** *(read-only)* - `{repo_path, pr_number, repo?, max_files?, max_patch_bytes?}`. Bound to the immutable MCP launch checkout (it cannot read another repository the process can reach). Returns one bounded evidence snapshot: identity (base/head refs + OIDs, cross-repository flag, merge state), the bounded PR body (premise) read as inert data, the complete changed-file inventory (paginated) with bounded patches and explicit `patch_truncated` / `patch_unavailable_reason` flags, checks bound to the head OID plus `required_contexts` (or `required_contexts_available: false`), `linked_issues[]` distinguishing `closing_reference` from `cross_reference`, review metadata (`review_decision` derived from each reviewer's latest decisive review), unresolved-discussion evidence, and a `completeness` block whose reasons cover every omission. It performs no `git fetch`, no branch switch, no object-database write, and posts nothing. Every read is REST (issue #1586): the GraphQL budget is shared by every agent on the token and drains without warning. The one exception is the unresolved-review-thread summary, which GitHub exposes only over GraphQL; it is optional, and its failure reports `discussions.available: false` (a `review_discussions_unavailable` completeness reason) without failing the snapshot. Closing references come from GitHub's closing keywords in the PR body, so an issue linked only through the PR sidebar is not listed.
- **`gc_remediate_pull_request`** *(authorization-gated)* - `{repo_path, pr_number, action, authorization, reviewed_identity, commit_message?, comment_body?}`, `action ∈ {sync_base, publish}`. Every action requires an explicit `authorization` and the reviewed PR identity, re-validated against the live PR (read over REST) by object id before anything is touched (the `authorization` is the driver's relay of the user's request, not a cryptographic capability; the object-id, same-repo, fast-forward, and gate bindings are the enforced guarantees). Every mutation also requires a trusted-host confirmation: a PR review against the current head whose body contains `gc-review: remediation-approved`, from a write-access account (GitHub binds the review to the head `commit_id`, so it cannot be backdated or reused for a later head). Remediation is same-repository only - a fork PR is refused - and only an open PR is remediable (`pr_remediation_pr_not_open`). `sync_base` verifies the PR base matches the configured integration branch (a mismatch is a consultation stop) then updates a stale branch with a real `git merge --no-ff` (never rebase/reset/force/worktree; conflicts are surfaced for manual resolution). `publish` stages the working tree itself, re-fetches the base immediately before pushing, commits the staged tree, and non-force pushes to the same PR branch bound to the reviewed remote head. `publish` does **not** run the repo's gate commands locally against the contributor tree (a credential-exfiltration surface); verification is the PR's own isolated CI, surfaced by `gc_get_pr_review_context`. When `comment_body` is supplied, `publish` posts at most one scrubbed, neutral PR comment, only after its own successful push. The user still owns merge; the tool never merges, approves, closes, or relabels.

Both tools keep every `gh`/`git` side effect inside the repository-bound MCP server (ADR-027); the skill never runs them. The read-only review creates no issue-thread record (ADR-029 issue #1535 amendment). See `skills/review/SKILL.md` and GC-O015.

## Codex review architecture (privileged side-effect boundary)

Per ADR-027 and issue #793, the codex-backed review tools follow a strict separation of concerns:

- **Codex is the planner / reviewer.** It runs in a `read-only` sandbox with no GitHub credentials and returns structured payloads only. It must never invoke `gh`, `git`, or `curl` to post comments.
- **The MCP server is the GitHub poster.** It validates codex's payloads against the schema below, then performs all GitHub writes (inline review comments, threaded replies, thread-resolution mutations, phase markers, cycle markers) from the host's authenticated `gh`.

`gc_codex_review` consumes a `===FINDINGS===…===END===` JSON tail from each reviewer's stdout. The MCP server validates each finding lexically (path lives inside the repo, line is positive or null, body is non-empty and within GitHub's 65535-char limit) and then POSTs each finding to `/repos/{owner}/{repo}/pulls/{pr}/comments` with the PR's current head SHA. The `[core]` / `[security]` reviewer label is prepended to the comment body by the poster; codex does not include it in the JSON.

Per-finding schema:

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `path` | string | yes | repo-relative, no leading `/`, no `..` segments |
| `line` | integer | yes | positive integer (file-level comments are not yet supported; every finding must anchor to a line in the diff) |
| `title` | string | yes | non-empty, ≤200 characters |
| `body` | string | yes | non-empty, ≤65322 characters (leaves headroom for the poster's `[reviewerLabel] title\n\n` prefix to keep the rendered comment under GitHub's 65535-char limit) |

The tool response carries both findings and write results, including any per-finding POST failures under `post_failures` (so callers can see partial-write conditions without parsing logs) and any per-reviewer parse errors under `parse_errors`.

### Diff transport and review coverage (issue #1414)

The MCP server owns diff retrieval end to end. Two independent facts are reported:

| Field | Meaning |
|-------|---------|
| `diff_mode` | Transport. `inline` when the complete diff fit one prompt; `manifest` when it exceeded `GC_CODEX_REVIEW_MAX_DIFF_BYTES` (default 256 KiB; `0` disables the cap). |
| `review_coverage` | Coverage. `{strategy, chunks_total, chunks_completed, files_total, files_covered, oversized_slices, unreviewed_untracked_paths, complete}`. Counts and paths only, never diff content. `strategy` is `whole-diff`, `file-slices`, or `hunk-slices`. |

Above the cap the server splits the authoritative diff into bounded inline slices and runs **both** reviewers over **every** slice as one logical review cycle. Boundaries are tried in descending order of fidelity: `diff --git` file blocks, then `@@` hunks, then whole lines. A single line larger than the budget is the smallest unit that survives splitting intact, so it is emitted whole and counted in `oversized_slices` rather than truncated; dropped bytes would read as reviewed content nobody saw.

Every fragment is a valid standalone diff. Each slice goes to an independent reviewer process, so a sub-file fragment carries its `diff --git` attribution and, for a line-split hunk, a **recomputed** `@@` header whose old/new starts and counts describe that fragment. Repeating the original header would make every `line` in a finding from a later fragment point at the wrong code. The numstat manifest is still supplied, but as whole-change context only. Slices are not cycles: the per-issue cycle counter, the marker family, and the cap are unchanged no matter how many slices a diff needs.

This replaces the prior behavior, where an over-cap diff became a manifest plus an instruction telling the reviewer to fetch per-file diffs through its own shell tool. Nothing verified that fetch, and reviewers were observed returning a `ship` verdict caveated on the manifest alone, a result indistinguishable at the envelope level from a real clean pass.

Coverage is validated before any GitHub write. If any slice fails to yield a valid reviewer envelope, the tool returns `ok: false` with `error: "review_coverage_incomplete"` and `next_action: "retry_review_after_resolving_coverage_failure"`, having written **no** findings record, decision record, or cycle marker. The attempt therefore does not consume a review cycle and a retry is free. `review_partial_failure` now covers only the case where the review itself completed but publishing it partially failed.

`gc_review_cap_disposition` re-derives `diff_mode` server-side from the post-fix tree with the same selector and carries it in `signals_snapshot`; a sliced or unknown-coverage review scores as slightly higher risk than a fully inlined one. Callers cannot assert either field.

### Untracked files and the consent boundary

An `uncommitted=true` review covers staged and unstaged changes. Untracked file **bodies are never transmitted**, and the prompt says so rather than claiming coverage it does not have.

Untracked content is the one review input the developer never selected: it is simply present in the working directory, and the branch under review controls `.gitignore`. A narrowed ignore rule makes a developer's pre-existing local `.env`, `.pgpass`, or `.dockercfg` visible to `git ls-files --others`, and sending those bodies to the model provider is an egress decision a heuristic cannot authorize. Credential filenames are unbounded, and an opaque token is indistinguishable from ordinary text, so a deny-list is defense in depth at best, never the authorization boundary. `detectSensitiveBodyContent` does not help here either: it guards GitHub publication, which happens long after the prompt is built.

Staging is the repository's existing explicit consent boundary, so it is the one this tool uses. Untracked paths are enumerated only to report the omission: the reviewer-visible manifest carries a **count**, and the caller receives the path list off-prompt in `review_coverage.unreviewed_untracked_paths`. `/implement` Step 6.5 stages with `git add -A` before review, so genuinely new work is reviewed as staged content and nothing is lost in the normal lane.

`gc_codex_verify_finding` and `gc_codex_architecture_preflight` follow the same boundary: codex emits a structured decision (verify) or modifies design docs in-place (preflight); the MCP server posts the threaded reply, resolves the review thread, and writes phase markers from the host.
