# Issue Requirements-Section Writer Preflight

Issue: #1569
Requirement: none (the delivery is an extension of GC-O007's existing workflow
contract, not a new product aggregate)

This note records architecture guardrails for the MCP operation that changes an
existing GitHub issue's in-scope requirement UID list. It is guidance only: it
does not register the tool, edit an issue, or change workflow scope.

## Authority And Public Contract

- Expose one repository-bound MCP tool, `gc_update_issue_requirements`, with an
  explicit `operation` of `add` or `remove` and a bounded, non-empty
  `requirement_uids` array. `add` is monotonic: it unions the requested UIDs
  with the parsed current scope and can never remove one. `remove` subtracts
  only the named UIDs. Do not expose an implicit replace/set mode whose routine
  use can silently narrow a run.
- The issue body's first parser-recognized `##` through `#### Requirements`
  section remains the only scope authority. The tool changes that input; it
  does not change `extractInScopeRequirementUids`, accept caller-supplied body
  text, post a comment, create a marker, or establish another scope store.
- The issue thread remains the durable workflow record under ADR-029. Scope
  input in the issue body is intentionally mutable; plans, findings, decisions,
  readiness, and final reports remain append-only comments. The delivery should
  add this distinction as a short ADR-029 amendment rather than define a new
  record type.
- This gate fits GC-O007's gated-loop contract. Reconcile the new tool and
  workflow guidance to GC-O007 during planning/traceability; a dedicated
  requirement would duplicate the existing umbrella contract. Do not weaken a
  gate or invoke agent-side `gh` to bootstrap this requirement-free run.

## One Parser And One Section Transformer

`extractInScopeRequirementUids` is used by bootstrap, requested-UID
authorization, completion, and scope resolution. The writer must not reproduce
its heading, boundary, bullet, wrapper, deduplication, or UID-recognition rules.
Move those cohesive pure helpers from the full
`mcp/ground-control/lib/codex-workflow-2.js` module into one scope module and
re-export the existing function for compatibility. The same module owns the
pure transformation used by the writer.

The transformation has these invariants:

- It targets exactly the first Requirements section the current extractor
  targets and stops at the same heading boundary. A later duplicate heading is
  preserved and is not treated as a second authority.
- Existing scope-bearing bullet lines are replaced by one canonical bullet per
  resulting UID. Non-scope prose in that section is preserved; every byte
  before the section and from the following section onward is preserved.
- It operates on source offsets, not `split` plus `join`, so it does not
  normalize CRLF/LF endings, trailing newlines, heading spelling/case, or any
  section that follows Requirements. When the section is absent, it appends one
  canonical `## Requirements` section using a deterministic separator.
- A semantic no-op is detected from the parsed current and intended UID arrays
  before canonicalization. Re-adding the current set or re-removing an absent
  UID performs no PATCH and leaves the complete body and its hash unchanged,
  even if the existing section uses older formatting or contains prose.
- Before any write, run `extractInScopeRequirementUids` over the candidate body
  and require its ordered result to equal the intended ordered result. This is
  the executable round-trip invariant, not a parallel parser assertion.

Preserve existing UID order, append genuinely new UIDs in caller order, and
preserve the remaining order on removal. Reject duplicate caller entries rather
than silently assigning them new semantics.

## Repository, Requirement, And GitHub Boundaries

- Validate `repo_path`, then reuse `ensureGitRepo`, the immutable MCP launch
  authorization, and `authorizeImplementRepoRoot` before any file or GitHub
  access. Use the authorized `owner` and `name` as the destination. An optional
  `repo` is only a `GITHUB_REPO_RE`-validated, case-insensitive assertion
  against that identity; it can never select another repository. A mismatch is
  refused before the first `gh` call.
- Reuse `EXACT_REQUIREMENT_UID_RE` and its 50-character bounded-scalar contract
  in both the Zod schema and direct library validation. Keep structured UID
  validation, repository-local identity resolution, and Markdown recognition
  separate: `isRequirementUidToken` remains the free-prose recognizer, not the
  tool input schema or existence check.
- Extend the canonical `requirement-files.js` boundary with a strict
  working-tree identity result. It must validate the exact UID path, path
  containment/regular-file status, parse the existing frontmatter once, and
  expose the raw `id` so the caller can require `id === directory UID`.
  `readRequirementByUid`'s compatibility fallback (`id || uid`) must not make a
  missing or mismatched id pass this write gate. Do not add a second YAML or
  requirement parser in the writer.
- Validate every UID that will remain in the candidate section before the
  PATCH; validate every addition even on a semantic no-op. An explicit removal
  may clean up a stale, no-longer-resolvable current UID because that UID is not
  written back. Any unresolved or identity-mismatched UID remaining in the
  result refuses the whole operation with no partial edit.
- Fetch the live issue body through fixed `gh api` argv only after repository
  authorization. Update through `PATCH /repos/{authorized owner}/{authorized
  name}/issues/{issue}` with only the `body` field, then validate the returned
  body with the same extractor. Reject an API object that is a pull request or
  whose number/body shape does not describe the requested issue.
- Never accept a raw issue body, repository URL, token, command fragment, path,
  or content hash as write authority from the caller. GitHub authentication
  remains the MCP host's existing `gh` credential; no token is put in the tool
  schema, environment additions, result, log, or process argv.

## Public-Text Safety, Errors, And Observability

Validate the complete would-be issue body, not only generated UID bullets,
before PATCH. Reuse `rejectReservedMarkerSequence`,
`detectSensitiveBodyContent`, and `GITHUB_ISSUE_COMMENT_BODY_MAX` (the existing
65,535-byte public-text cap). A refusal must occur before mutation. Do not apply
the final-report deferral-language rule to an issue premise; it is not one of
this writer's content controls and issue prose may legitimately discuss prior
deferrals.

Expected failures use the repository's stable `{ok:false, error, message,
next_action}` result style. Zod rejects malformed transport shapes; the library
repeats the canonical runtime checks for direct callers. Catch GitHub and file
failures inside the library and return bounded diagnostics. Never return or log
the issue body, requirement prose/frontmatter, PATCH argv, raw stdout/stderr,
or an exception string that can contain the body argument. Unexpected handler
faults alone flow through `tools/respond.js`.

The existing `installToolTelemetry` wrapper automatically records one closed
event containing tool name, stable outcome, duration, project, and timestamp.
It must continue to receive no arguments, UIDs, body, or response content. No
new logger, marker, metric, telemetry schema, or local audit file is needed.

## Reliability And Cache Coherence

- Compute and validate the entire candidate before PATCH. Return a bounded
  success result such as the issue number, operation, changed/no-op flag, and
  resulting UIDs; never echo the complete body.
- `runGetIssueThread` has a process-local content-addressed cache keyed by
  repository and issue. A successful body update must invalidate that exact
  entry (and an uncertain PATCH failure should fail closed by invalidating it)
  so bootstrap or completion cannot accept the pre-edit hash as unchanged.
  Add targeted invalidation at the cache owner; do not reach into its private
  map or create a second cache.
- GitHub documents conditional requests for reads, but does not support them
  for unsafe methods unless an endpoint explicitly opts in; the issue-update
  endpoint does not expose such a precondition. Therefore a local mutex or
  caller hash must not be described as protection from concurrent human/API
  writers. Use one fresh GET immediately before transformation, PATCH only the
  body field, verify the returned body, and keep the read/PATCH adapter
  injectable so a future conditional API can add compare-and-swap without
  changing parser or tool semantics.
- No-op success never invokes PATCH. A write response that does not round-trip
  to the intended set returns a distinct failure and invalidates the issue
  cache; do not attempt a compensating overwrite that could erase a later edit.

GitHub's relevant API limitation is documented in its
[REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
and the body-only endpoint is the standard
[Update an issue](https://docs.github.com/en/rest/issues/issues#update-an-issue)
operation.

## Whole-Repository Surfaces

The delivery intersects:

- `mcp/ground-control/tools/query.js`, `lib.js`, and `server-runtime.js` for the
  thin Zod registration and published tool inventory;
- the shared scope parser currently in `lib/codex-workflow-2.js`, the new
  cohesive scope transformer module, `lib/requirement-files.js`,
  `lib/issue-thread.js`, and the existing repository identity, public-text,
  UID, command, and response helpers;
- Node unit/contract tests for the pure transformer, strict requirement
  identity, repository authorization, exact argv, security refusals,
  idempotence, cache invalidation, and the live registered schema;
- `skills/implement/steps/step-01-issue-branch-resolution.md` and
  `step-04-planning.md`, with the existing skill-to-registration contract test
  and the existing implement workflow policy check extended rather than a new
  policy subsystem;
- `mcp/ground-control/README.md`, `docs/DEVELOPMENT_WORKFLOW.md`, and a concise
  ADR-029 amendment distinguishing mutable body scope from durable comments;
- `mcp/ground-control/package.json` plus its lockfile: adding a public tool is a
  MINOR server-surface bump under the documented compatibility policy.

No `.ground-control.yaml`, `.env`, environment inventory, deployment, backend,
database, frontend, REST controller/DTO/service/repository, or Graphify surface
is involved.

## Gotchas And Anti-Patterns

- Do not add an exact-replace mode, let `add` narrow scope, or treat an empty
  caller list as permission to clear the section.
- Do not validate only requested additions while writing an unresolved UID
  already present in the final set, and do not validate existence with the
  extractor's presentation regex.
- Do not duplicate the Requirements heading parser, YAML/frontmatter parser,
  repo assertion regex, public-text scrubs, body cap, response envelope, or
  GitHub client.
- Do not rebuild the whole Markdown body from lines, normalize unrelated bytes,
  discard Requirements prose, edit a second Requirements heading, or trust a
  successful HTTP status without parser round-trip verification.
- Do not forget issue-thread cache invalidation after mutation or uncertain
  mutation outcome.
- Do not weaken `completion_scope_mismatch`, requested-UID authorization,
  merged-state verification, review, CI, Sonar, or traceability rules. This tool
  supplies their missing input; it is not a bypass.
- Do not post a comment/marker for a body edit, add local persistence, add a
  configuration knob, log body content, pass a token explicitly, or invoke
  `gh`, `git`, or `curl` from a skill/agent sandbox.
- Do not claim race-free compare-and-swap where GitHub supplies none. A local
  lock cannot serialize human edits or other GitHub clients.

## Non-Goals

- No change to scope derivation, UID syntax, requirement lifecycle or
  traceability semantics, issue creation, completion, or close behavior.
- No generic issue editor, arbitrary Markdown-section editor, requirement-file
  writer, cross-repository operation, bulk issue migration, or automatic
  requirement allocation.
- No new exception hierarchy, persistence abstraction, workflow engine,
  comment marker, audit event, configuration field, credential, or service.
- No implementation of issue #1569 in this note.

## Design Vocabulary That Applies

- **Patterns:** Tool registration; Requirement file reader; Issue-thread record
  (comments stay durable records, while the body section is scope input).
- **Canonical helpers:** argv-based `gh api` posting through the MCP server;
  `mcp/ground-control/lib/requirement-files.js`.
- **Boundary contract:** the MCP server is the only running service and owns
  every privileged GitHub side effect; requirements and ADRs remain repo-local
  reviewed files.
- **Binding ADRs:** ADR-027, ADR-029, and ADR-093.
- **Anti-recommendations:** do not introduce an abstraction below three call
  sites; do not add skill text the MCP/policy surface cannot enforce; reserve
  comments for non-obvious reasons; do not invoke `gh`, `git`, or `curl` from
  agent sandboxes.
