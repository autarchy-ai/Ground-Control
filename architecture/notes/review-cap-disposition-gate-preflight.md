# Review Cap Disposition Gate Preflight

Issue #1245 adds a bounded review-cap disposition gate for GC-O007. This note
is architecture preflight guidance only. It does not implement the MCP tool,
the config parser, the review-loop wiring, ADR amendments, or workflow prose.

## Architectural Frame

- Preserve GC-O007's contract: one human touchpoint at PR merge, no
  plan-approval gate, no post-push Codex pass driven by `/implement`, no
  deferral, and Phase E post-merge reconciliation unchanged.
- Keep the MCP server as the enforcement boundary. Skills and step files may
  point to the gate, but cap decisions, auto-grant ceilings, marker reads, and
  GitHub writes belong in `mcp/ground-control/lib.js` with thin Zod registration
  in `mcp/ground-control/index.js`.
- Keep the GitHub issue thread as the durable record. The new
  `gc:review-auto-disposition` marker family should be the record of the
  disposition, not local files, telemetry JSONL, git notes, Temporal state, or a
  database row.
- Treat Codex as the sole review-cap disposition target. ADR-099 removed the
  former second reviewer and its compatibility surface.
- Sequence the disposition after last-in-cap findings have been fixed,
  self-verified, and re-staged. The current cycle wrapper returns before those
  fixes exist, so it cannot truthfully judge "fix churn" at that moment. If the
  loop calls a new `gc_review_cap_disposition` tool after fixes, the decision is
  still server-side. If the wrapper owns the call later, it must observe a
  post-fix diff snapshot before deciding.
- Do not let a machine-written `override_reason` become the authorization
  boundary. Auto-grant authority must come from a posted disposition marker
  for the same issue, reviewer, and cap boundary. The next over-cap cycle may
  use `override_cap=true`, but the cycle wrapper must be able to distinguish a
  valid auto-disposition grant from arbitrary agent text.
- The auto-grant ceiling is per issue and reviewer; branch remains audit
  context only. Human `override_cap=true` plus a quoted authorization remains
  the only path beyond the single server-approved auto over-cap cycle.
- With `workflow.review_disposition.enabled` absent or false, existing review
  loop behavior should remain unchanged: last-in-cap findings still return
  `fix_findings_then_ask_over_cap_or_proceed`, and cap-refused calls still return
  `ask_over_cap_or_proceed`.

## Cross-Cutting Concerns to Reuse

- **Config parsing:** extend `emptyWorkflowConfig`,
  `normalizeWorkflowConfig`, `buildSuggestedGroundControlYaml`, and
  `getRepoGroundControlContext` rather than reading `.ground-control.yaml`
  ad hoc. Preserve strict unknown-key rejection and validation-error surfacing.
  The config should be an object block (`workflow.review_disposition`) so
  `enabled`, `max_auto_overrides`, severity weights, thresholds, model, and a
  later `mode` can live under one schema.
- **MCP tool schema:** register the new tool with strict Zod shapes in
  `index.js`: positive issue/cycle/cap ids, bounded reviewer enum, bounded
  rationale strings, bounded arrays/objects, and closed disposition values
  (`proceed`, `one_more_cycle`, `escalate_to_human`). Mirror essential
  validation in pure `lib.js` helpers so unit tests can exercise the contract
  without going through MCP registration.
- **Review loop helpers:** build on `_runReviewCycleShared`,
  `reviewCycleFindings`, `summarizeReviewFindings`,
  `normalizeReviewCycleNextAction`, `buildAutoFixDecisionFindings`, and
  `runPostDecisionRecord`. Do not return verbatim review prose or per-finding
  bodies to the parent loop.
- **Durable comments:** reuse `ensureGitRepo`, `getOwnerRepo`,
  `readIssueCommentBodies`, `postIssueCommentAndReturnUrl`,
  `detectSensitiveBodyContent`, GitHub body-size refusal, reserved-marker
  rejection, and argv-based `gh api` calls. A failed disposition post must
  return a structured post-failed envelope and must not authorize an over-cap
  cycle.
- **Risk signals:** reuse `computeReviewDiff` or a narrow companion helper for
  numstat and changed-file metrics, `classifyChangedSurface` for repo surface
  categories, and `parseGrcScreeningData` for the `security_relevant` signal.
  Missing or malformed GRC screening data should be `unknown`, not silently
  downgraded to low risk.
- **LLM judge path:** if a gray-zone judge is used, follow the
  `runSingleClaudeTestQualityReview` pattern: `claude --print`,
  `--output-format json`, `--json-schema`, prompt on stdin, `--add-dir` to the
  repo, read-only tools, timeout, abort signal, and `ANTHROPIC_API_KEY` stripped
  from the child environment. Unit tests should stub the judge; deterministic
  ceilings and fast paths are what need pinning.
- **Policy and docs sync:** because this touches review-loop workflow
  guardrails and public MCP tool surfaces, expect the implementation PR to
  sync ADR-029, ADR-031, ADR-036 if the cycle-wrapper contract changes,
  ADR-021 amendments if the GC-O007 phase text changes,
  `docs/DEVELOPMENT_WORKFLOW.md`, `docs/WORKFLOW.md`,
  `_review-loop-rules.md`, Step 6.5, Step 6.6, and the `/quickfix --review`
  sibling lane. Edits to `mcp/ground-control/lib.js` or `index.js` also trigger
  the ADR-054 / `docs/DOC_STYLE.md` documentation-coverage sync rule.

## Security and Validation Layers

- **Config layer:** `workflow.review_disposition` must default disabled and
  reject unknown keys, wrong types, out-of-range weights, and out-of-range
  auto-override ceilings. A malformed present config must not fall back to
  defaults as if the repo deliberately disabled the feature.
- **Tool input layer:** Zod and pure validators must reject impossible states:
  cap below one, cycle below one, cycle not at or beyond the cap boundary,
  unsupported reviewer values, unknown disposition values, empty rationale for
  durable records, and caller-supplied "signals" that should be recomputed
  server-side.
- **Issue-thread state layer:** marker parsers must be issue-scoped,
  reviewer-scoped, schema-version tolerant, and resilient to malformed marker
  JSON. They must not key grants by branch. A disposition marker is valid only
  after the findings and decision records for the triggering cycle posted
  successfully.
- **GitHub side-effect layer:** all issue-comment writes go through the MCP
  server's argv-based `gh api` path. Do not add `curl`, a second GitHub client,
  direct skill prose posting, or agent-side GitHub writes for the marker.
- **Secret and marker-injection layer:** all caller-, model-, issue-, and
  prompt-derived text rendered into a disposition record must pass reserved
  `<!-- gc:` rejection, `detectSensitiveBodyContent`, and GitHub byte caps
  before any network call. Do not publish raw prompts, raw diffs, raw env, raw
  stderr, full reviewer transcripts, or tokens.
- **LLM subprocess layer:** prompts go on stdin, not argv. The subprocess env
  must not leak provider keys. The JSON schema is a parse boundary, not a trust
  boundary; deterministic hard ceilings and fast paths override the judge.
- **Error-envelope layer:** expected failures should return stable
  `{ ok:false, error, message, next_action, ... }` envelopes. Avoid thrown
  control flow, stack traces, raw command output, or new exception hierarchies.
- **Backend layer:** no backend REST/controller change is required. If scope
  expands into backend APIs, use Bean Validation, project scoping,
  `GroundControlException` through `GlobalExceptionHandler` / `ErrorResponse`,
  `ActorHolder` audit context, and the api/domain/infrastructure boundary.

## Maintainability and Extensibility

- Keep one disposition engine and one marker parser. Reviewer-specific
  behavior should be data: reviewer enum, cap source, severity weights, and
  surface weights.
- Make `workflow.review_disposition` the extension seam. The first version can
  ship with `enabled: false`, `max_auto_overrides: 1`, and sane weights, but the
  object shape should leave room for `mode: shadow|authoritative`, tuned
  thresholds, and judge model selection without moving the contract.
- Use a schema-versioned marker payload such as
  `gc.implement.review-auto-disposition/v1` so future signal snapshots can add
  fields without breaking parsers.
- Keep signal collection as a pure helper returning a bounded
  `signals_snapshot`. That snapshot is what the marker records and what tests
  assert; the judge prompt should be a consumer, not the place where signals
  are computed.
- If the implementation needs migration/controller risk flags, co-locate the
  JavaScript surface classifier with `classifyChangedSurface` instead of
  scattering copied regexes through prompts, tests, and policy prose. Do not
  parse `tools/policy/checks.py` at runtime.

## Gotchas and Anti-Patterns

- Do not decide before fixes exist. A pre-fix disposition can use original
  finding count, but it cannot use fix churn or fix-induced-regression risk.
- Do not treat `proceed` as "unfixed findings are acceptable." It is valid
  only after the last-in-cap findings were fixed and self-verified.
- Do not allow `one_more_cycle` to silently become cycle three. After one
  auto-granted over-cap cycle, the gate must return `proceed` or
  `escalate_to_human`; anything further requires human authorization.
- Do not let disabled configuration change return envelopes, marker counts, or
  issue comments. Disabled means the existing workflow is preserved.
- Do not duplicate the durable record renderer, sensitive-content filter,
  no-deferral contract, marker-family parser, config reader, or async review
  job machinery.
- Do not turn the LLM judge into the primary policy. It is for gray-zone
  ranking only; deterministic fast paths and hard ceilings remain authoritative.
- Do not add prompt-only rules to `skills/implement/SKILL.md` or per-step files
  that the MCP tools cannot enforce.
- Do not broaden the scope into CI/Sonar drift detection, post-push Codex
  review, requirement reconciliation, or GRC engine changes.

## Non-Goals

- No implementation of `gc_review_cap_disposition` in this note.
- No ADR-029 / ADR-031 amendment in this note; those should land with the
  tool behavior they describe.
- No new backend REST API, frontend UI, database table, Temporal workflow,
  local state store, or git-note counter.
- No change to the configured reviewer cap defaults, the one-human-touchpoint
  model, zero-deferral policy, or Phase E post-merge ordering.
- No new review provider or replacement for Codex.

## Design Vocabulary That Applies

- **Pattern: Derivation-backed GRC engine** - only as an input signal via the
  existing GRC screening record. The implementation should not change the GRC
  engine or derive new risk facts for this gate.
- **Canonical helper: gh api argv-based posting in `mcp/ground-control/lib.js`**
  - all durable disposition records and marker writes must use this boundary.
- **Boundary contract: api/ -> domain/ <- infrastructure/** - not expected to
  be touched. Keep the change in the MCP workflow surface unless a later
  backend API scope is explicitly introduced.
- **Binding ADRs:** ADR-027 (`.ground-control.yaml` and MCP context contract),
  ADR-029 (issue thread durable record and one human touchpoint), ADR-031
  (structured review stopping model), ADR-036 (deterministic durable-record
  tools and async review jobs), ADR-057 / ADR-058 (GRC screening signal and
  derivation-backed GRC target).
- **Anti-recommendations:** do not introduce a new abstraction for fewer than
  three real call sites; do not add prompt text that the MCP tools cannot
  enforce; do not invoke `gh` / `git` / `curl` from agent sandboxes for durable
  workflow side effects; do not add comments that restate obvious code.
