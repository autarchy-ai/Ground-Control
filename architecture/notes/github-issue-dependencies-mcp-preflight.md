# GitHub Issue Dependencies MCP Preflight

Issue: #1673
Requirement: none

This note records the architecture guardrails for reading and changing GitHub
issue dependencies through the Ground Control MCP server. It is guidance only:
it does not register a tool or change an issue relationship.

## Public Contract And Domain Boundary

- Expose one action-discriminated workflow tool, `gc_issue_dependency`, with
  `action=read|add|remove`. `repo_path` and a positive
  `blocked_issue_number` apply to every action; a positive
  `blocking_issue_number` is required for `add` and `remove` and rejected for
  `read`. An optional `repo` is an `owner/repo` assertion only.
- Keep the public identity in GitHub issue-number vocabulary. The repository is
  derived from the checkout, so callers never supply GitHub's database id. The
  library resolves the blocking number to the issue's numeric REST `id`, uses
  that id as the typed `issue_id` POST field and as the DELETE path id, and
  never conflates either with `issue.number` or the GraphQL `node_id`.
- Both mutation operands are resolved under the same authorized repository.
  A mismatched `repo` assertion is the named cross-repository refusal; do not
  add a second destination, issue URL, or owner/repo-qualified blocker input.
  Read results should still identify each returned issue by repository plus
  number so an externally created cross-repository relationship is not
  rendered ambiguously.
- `read` returns both `blocked_by` and `blocking` arrays. Normalize each issue
  to a small stable view such as repository, number, title, state, and URL; do
  not return bodies, users, labels, raw REST payloads, or the transport-only
  database id. No dependencies is successful and returns two empty arrays.
- Mutations report the terminal relationship state and an outcome that does
  not overclaim authorship: `changed`, `already_satisfied`, or `reconciled`.
  The last means a failed or indeterminate write was followed by a fresh read
  proving the requested state. Do not call that case `changed=false` when this
  process cannot know which concurrent writer established the state.

This relationship is GitHub-native operational metadata. It is not a
requirement-DAG edge, sub-issue relation, issue-thread comment, Ground Control
marker, or new persistence entity. ADR-029 remains unchanged: plans,
decisions, and final reports stay in the issue thread, while dependency state
stays in GitHub's dependency API.

## Repository And Transport Authority

- Reuse `resolveAuthorizedIssueRepository`, which composes `ensureGitRepo`,
  the immutable MCP launch-workspace authorization, and checkout-derived
  `getOwnerRepo(..., {allowGhFallback:false})`. Use the returned owner and name
  in every REST path. Validate the optional `repo` case-insensitively against
  that identity before the first GitHub call.
- Reuse `ghRestJson` in `lib/github-rest.js`; do not add direct `gh` calls to a
  skill, handler, or parallel client. Pin calls with `--hostname github.com`,
  because checkout identity accepts only github.com while ambient `GH_HOST`
  is outside the repository authorization decision. Apply a bounded timeout.
- Extend the existing REST adapter with a narrowly named typed-field option
  that emits `gh api -F`, without changing the current string `fields` / `-f`
  behavior. The add request must contain `-F issue_id=<numeric REST id>`:
  `-f` stringifies the id and GitHub rejects it. Do not expose field mode,
  method, endpoint, headers, hostname, or API version as tool inputs.
- Use fixed argv with validated numeric path segments. Repository identity is
  server-derived, so no caller string is interpolated into a command or host.
  The `gh` credential remains in the host's existing credential mechanism;
  it is never accepted by the schema, placed in argv, logged, or returned.
- Paginate both dependency lists (`per_page=100` plus the existing
  `--paginate --slurp` path). Accuracy must not depend on GitHub's default
  first page. Validate that list responses are arrays and that issue records
  contain valid number, id, repository identity, and URL fields before using
  or returning them.

The canonical endpoint semantics are documented by GitHub's
[issue-dependencies REST API](https://docs.github.com/en/rest/issues/issue-dependencies):
POST takes `issue_id`, DELETE takes that same blocking issue id in the path,
and the two list directions are separate endpoints.

## Validation, Refusals, And Idempotency

- The MCP Zod shape is the protocol gate: closed action enum, positive integer
  issue numbers, and the shared `GITHUB_REPO_RE` for `repo`. Repeat the semantic
  checks in the library because its exported function is unit-tested and may be
  called without the MCP layer. Action-specific required/forbidden fields stay
  in the handler-side/library validation pattern required by ADR-035; do not
  publish a top-level discriminated union that the current SDK renders as an
  empty schema.
- Reject self-dependency before any GitHub call. For mutation actions, resolve
  and validate both the blocked and blocking issues before deciding that the
  relationship is already satisfied. This preserves both contracts: removing
  an existing but unrelated blocker is a no-op, while naming an issue that does
  not exist is a named refusal rather than a misleading no-op.
- Validate an issue lookup against the requested number and authorized
  repository, and require a positive numeric REST `id`. A pull-request-shaped
  record or malformed/mismatched payload must not become write authority.
- Expected failures return the established
  `{ok:false,error,message,next_action}` envelope with stable names for invalid
  action/arguments, unauthorized or mismatched repository, self-dependency,
  blocked issue missing, blocking issue missing, forbidden access, malformed
  GitHub response, rejected relationship, and unavailable GitHub transport.
  Do not introduce a new exception hierarchy. Unexpected faults alone reach
  `tools/respond.js`.
- Keep diagnostics bounded and content-free. Do not return raw `gh` argv,
  stdout/stderr, stack traces, issue bodies, or entire API error objects.
  GitHub's 404 may also hide an inaccessible private resource, so the message
  may say "not found or not accessible" while retaining a role-specific stable
  error code.
- Idempotency is a state invariant, not a blind status-code mapping. Read the
  current `blocked_by` set before writing. If it already has the requested add
  state or lacks the requested remove state, return `already_satisfied` without
  a mutation. After a failed or indeterminate POST/DELETE, read again: return
  `reconciled` only when the intended state now holds; otherwise return the
  classified refusal. Never blanket-treat 422 as duplicate-add success or 404
  as duplicate-remove success, because those statuses also cover invalid,
  unauthorized, missing, and rejected relationships.
- Do not add a local mutex or idempotency-key store. Neither can serialize
  GitHub UI users or other API clients. Fresh state checks plus post-failure
  reconciliation provide replay safety at the actual persistence boundary.

## Canonical Incumbents And Whole-Repository Surfaces

- `mcp/ground-control/tools/query.js` is the thin-registration example. Keep
  the new registration similarly limited to Zod shape, argument mapping, and
  `ok` / `err`; the behavior belongs in one cohesive `lib/` module.
- `mcp/ground-control/lib/authorized-issue-repository.js` owns launch-workspace
  and repository authorization. `lib/github-rest.js` owns REST-over-`gh api`,
  pagination, host pinning, timeouts, and typed/raw argv field construction.
  `lib/runtime-primitives.js` owns `GITHUB_REPO_RE` and fixed `execFile`.
- `mcp/ground-control/tools/respond.js` remains the MCP success/error renderer,
  and `mcp/ground-control/lib.js` remains the public barrel used by tool
  registrations. Do not create a second response DTO library or GitHub error
  hierarchy.
- `mcp/ground-control/server-runtime.js` owns registration and its documented
  tool inventory. `mcp/ground-control/README.md` owns the live catalog and
  public compatibility statement. Adding this public tool is a MINOR surface
  change under that statement, but Release Please owns package versions and
  `CHANGELOG.md`; implementation must not hand-edit either.
- Focused `mcp/ground-control/lib.*.test.js` tests should inject the REST or
  `execFile` seam and assert exact argv, typed id use, pagination, normalization,
  every named refusal, no-call validation, all three idempotent outcomes, and
  empty reads. A live `listTools()` contract test should cover the published
  action schema and required field descriptions. CI owns the full MCP suite.
- No `.ground-control.yaml` field, server environment variable, secret file,
  requirement file, issue-thread cache entry, workflow skill, policy check,
  backend, database, frontend, Graphify index, or operating-system service is
  added or changed for this feature.

## Security And Observability Layers

1. The MCP schema rejects malformed transport input before filesystem or
   process access; the pure library validator provides the same guard for
   direct callers.
2. Repository authorization binds `repo_path` to the MCP launch checkout,
   revalidates its Git identity and origin, derives owner/name without
   `GH_REPO`, and treats `repo` only as an assertion.
3. The command boundary uses `execFile` argv, a fixed `gh api` operation,
   fixed `github.com` host, server-derived REST paths, numeric ids, and `-F`
   only for the typed numeric body field. No shell or caller-selected command,
   URL, method, headers, host, or credential crosses it.
4. GitHub applies the host credential's repository Issues read/write
   permissions and dependency semantics. The library validates the returned
   repository and issue identities before a response becomes write authority.
5. Expected errors become stable, actionable, bounded structured results;
   unexpected errors use the existing MCP error envelope. The tool returns
   normalized state only, with no raw command or API payload.
6. There is no new logging or telemetry stream. The structured tool result is
   the observability surface; GitHub is the persistence surface. No caller text
   is published, so public-text secret scanners and marker/body-size validators
   are not applicable and must not be copied into this path.

## Extensibility Seam

The extension seam is the dependency library's action dispatcher plus a small
repository-bound API adapter that reads an issue, lists each direction, adds by
typed REST id, and removes by REST id. A future supported mutation can add an
action without changing repository authorization, issue normalization, error
mapping, or transport. A future “which issues are unblocked?” work-selection
query is a separate aggregate over dependency reads; do not turn this tool into
a generic issue graph, arbitrary REST proxy, or requirement-DAG service now.

Keep relationship direction explicit in names (`blocked_issue_number` versus
`blocking_issue_number`) rather than introducing a generic source/target edge.
That vocabulary prevents the most likely extension bug: reversing the endpoint
while still producing a syntactically valid relationship.

## Gotchas And Anti-Patterns

- Do not send the blocking issue number, `node_id`, or a stringified id as
  POST `issue_id`; resolve and send the numeric REST `id` with `-F`.
- Do not reverse the relationship: POST and DELETE are always rooted at the
  blocked issue's `/dependencies/blocked_by` collection.
- Do not infer idempotent success from an HTTP status without confirming the
  terminal relationship state, and do not claim which writer changed state
  after ambiguous reconciliation.
- Do not truncate dependency reads to the first page, represent “none” as an
  error/null, or compare issue numbers without repository identity.
- Do not use `GH_REPO`, an ambient `GH_HOST`, a caller-supplied repository URL,
  or an unpinned checkout. Do not call `gh`, `git`, or `curl` from an agent or
  skill.
- Do not duplicate `GITHUB_REPO_RE`, repository authorization, REST argv
  construction, response rendering, or error classes. Do not broaden
  `ghRestJson` into caller-controlled headers/methods just to add typed fields.
- Do not post a marker/comment, edit issue prose, derive requirement ordering,
  update sub-issues, add a local cache/database/file, or make dependency state a
  completion/merge gate in this issue.
- Do not add generic graph, edge, repository, service, controller, or DTO
  abstractions for one GitHub relationship family. The normalized public view
  and narrow API adapter are sufficient.

## Non-Goals

- No cross-repository dependency mutation, bulk update, cycle detection,
  transitive traversal, topological sorting, next-issue recommendation, or
  automatic enforcement in `/implement`.
- No change to the requirements DAG, issue body, issue-thread durable records,
  sub-issue semantics, labels, project boards, close behavior, or Phase E.
- No new configuration, credential flow, authorization hierarchy, exception
  hierarchy, persistence layer, logger, telemetry record, or workflow engine.
- No general-purpose GitHub REST tool and no implementation of issue #1673 in
  this note.

## Design Vocabulary That Applies

- **Patterns:** Tool registration; Issue-thread record only as a boundary to
  keep separate (dependency metadata does not create a comment record).
- **Canonical helpers:** argv-based `gh api` through the MCP server.
- **Boundary contract:** the MCP server is the only running service and owns
  every privileged GitHub side effect; requirements and ADRs remain repo-local
  files and are not a persistence target for dependency state.
- **Binding ADRs:** ADR-027 and ADR-029.
- **Anti-recommendations:** do not introduce an abstraction below three call
  sites; do not add skill prose the MCP tools cannot enforce; reserve comments
  for non-obvious reasons; do not invoke `gh`, `git`, or `curl` from agent
  sandboxes.
