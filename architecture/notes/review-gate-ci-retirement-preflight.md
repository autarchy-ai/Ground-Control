# Review Gate, CI Head Binding, and Retirement Contract Preflight

Issue #1679 verifies review claims against the current repository. This note is
architecture guidance only. It does not implement the gate, watcher, workflow,
documentation, or test changes.

## Verified Contract Gaps

All eleven reported claims reproduce on current `dev`:

- trusted review-publication evidence parses `revision_digest` but drops it
  before synchronized PR creation and both completion phases consume the
  evidence;
- the quickfix review waiver is selected by a caller `lane` value plus empty
  requirement scope, not by trusted lane provenance;
- review-result and decision-record validation accept any non-empty
  `user_authorization` for `wontfix`;
- the credential-source exception includes shell scripts such as
  `credentials.sh` and `credentials.bash` before `git add -A`;
- the integration-manager CI adapter maps every non-ok head-bound watch result
  to an allowed `skipped` conclusion;
- the CI watcher stops discovering runs as soon as the first run for the head
  appears;
- the CI tool and library accept abbreviated SHAs although GitHub run
  `headSha` values are compared exactly;
- explicit retained-result publication lets stage exceptions escape the
  structured retry contract;
- live workflow surfaces still require the retired test-quality reviewer;
- the review-cap question is a synchronous stop that conflicts with the
  sole-human-touchpoint contract; and
- the four behavioral tests of `run_documentation_coverage_check` were removed
  while the gate remained live.

Historical references are not defects merely because they name a retired
component. The retirement defect is confined to normative ADR text, executable
policy inventory, templates, environment guidance, and runnable skills that
still present the component as live.

## Architecture Decisions

### Keep review, settlement, and delivery identities distinct

A review revision proves what the reviewers received. A settled post-review
tree proves where finding repairs and self-verification ended. A delivered head
proves what was pushed after the integration branch was synchronized. They are
different concepts and must not share one field or be compared as if a review
digest were a commit SHA.

Extend the existing review revision with a canonical candidate-tree object ID
covering exactly what the shared publish action would stage, including new
non-ignored files, deletions, modes, and symlink blobs. Produce it through a
temporary Git index under the sanitized implement Git environment; do not
mutate the real index or expose file contents. The existing revision digest
continues to bind the review inputs. A versioned publication marker carries
both identities. Older markers remain audit-readable but cannot authorize a
new delivery when they lack the candidate-tree identity.

Derive the review diff and manifest from that same temporary index. The current
uncommitted-diff path sends only staged and unstaged tracked diffs, records
untracked path names without their contents, and can still call coverage
complete even though the later publisher stages those files. A tree hash would
detect later drift but would not make unseen content reviewed. One snapshot
definition must therefore own candidate tree, diff, manifest, and coverage.
Run the incumbent sensitive-path predicate before transmitting that snapshot;
the content scanner remains at the pre-commit boundary.

ADR-099 deliberately permits finding-driven edits after the last discovery
cycle, so the gate must not claim that Codex reviewed the final tree when a
published cycle contained findings. Preserve that policy explicitly:

- a zero-finding publication may settle only when the current candidate tree
  still equals the reviewed candidate tree;
- a finding-bearing publication may settle after every finding has a valid
  disposition and the existing fix/self-verification contract is satisfied;
  the settlement records the resulting candidate tree without calling it the
  reviewed tree; and
- no later tree may satisfy PR creation or completion unless the trusted
  synchronization/readiness chain binds it to that settlement.

Use the existing remote-base synchronization record as the bridge to delivery,
not a second local state store. Its next schema version should carry the
trusted review publication identity, review revision digest, settled tree,
lane, pre-sync head, and resulting head. The synchronized PR gate verifies the
settled tree against the pre-sync commit tree and retains its existing checks
that the current local/remote/resulting head and verified tree equal the
synchronization record. Readiness and post-merge completion re-read the same
trusted chain for the PR's current head. PR body text, caller summaries, branch
names, and retained local review files are never authority.

This closes stale clean-review reuse without silently changing ADR-099 into a
clean-terminal-verdict requirement. Requiring every final head to equal the
initial review revision would be a different architecture decision and would
reintroduce another mandatory review after each repair.

### Derive lane from trusted workflow state

The quickfix carve-out is a property of a run, not an MCP argument. Make the
existing lane-specific pickup a versioned issue-thread record bound to issue,
branch, and lane, and verify its trusted author using the incumbent issue
comment trust resolver. Carry the derived lane through the trusted
synchronization record and delivery-readiness record.

Authority-sensitive consumers derive the lane from those records. A public
`lane` input may remain as a compatibility assertion, but it must match the
derived lane and can never grant a waiver. Apply this once at each privileged
entry point that relaxes behavior for quickfix: synchronized PR creation,
readiness/final-report publication, and post-merge completion/finalization.
Pure renderers may continue using a caller lane to choose display text because
their output grants no authority.

Requirement scope remains an independent constraint: a trusted quickfix lane
with any requirement UID still fails. Do not use empty scope as proof that the
run is quickfix.

### Verify `wontfix` authorization at the repository boundary

Reuse `parseIssueCommentUrl`, launch-workspace repository authorization,
paginated issue-comment reads, and `resolveExecutionObligationTrust`. A review
finding's authorization must reference this repository and issue, name the
exact publication/cycle/finding identity in a closed command shape, and come
from a user with effective repository write permission. Verify all referenced
authorizations before the first publication write and revalidate them when
trusted publication evidence is replayed.

Do not overload an execution-obligation ID or accept a quote, arbitrary URL,
non-empty string, author association, or marker-shaped caller prose as proof.
The finding and execution-obligation domains may share the low-level comment
URL and repository-permission verifier; they keep separate record grammars.

### Keep sensitive-path and secret-content controls separate

`isSensitivePublishPath` remains the single pre-staging filename gate over
tracked, staged, and untracked paths. Narrow the credential source-module
exception so shell and command-script extensions are not exempt: a
`credentials.sh`-style file is commonly a credential artifact or loader, not
an ordinary source module. Keep the explicit source-extension allowlist rather
than broadening the regular expression or adding a second path scanner.

The path gate does not replace the configured pre-commit secret scanner, and
the secret scanner does not make an unsafe basename acceptable. Preserve
NUL-delimited path reads and refusal before `git add -A`. GitGuardian remains
user-owned; this work must not inspect, suppress, or remediate its findings.

### Keep CI head binding fail closed through adapters

The integration adapter must preserve a non-ok CI watcher result as a blocked
result with its stable reason and bound `head_sha`; it must never translate an
identity, lookup, authorization, or no-run refusal into `skipped`. GC-O011
requires CI observation, so an explicit CI `skipped` conclusion is not
readiness either. Sonar's separately configured absence rule remains separate
and must not be generalized into a CI exception.

Keep the run-registration window open after the first run appears. Re-list by
the bound full head SHA on every poll until the existing registration deadline,
union newly discovered run IDs, and report success only after discovery closes
and every discovered run is terminal-success. A failure may still return early.
The registration wait remains part of the total timeout.

Define the GitHub head-SHA predicate once and use it in both the Zod tool schema
and direct library validation. GitHub CI identity requires the full provider
SHA; an abbreviated Git revision accepted by local Git is not the same type.
Keep this provider-specific predicate separate from the repository's generic
40/64-character Git object-ID predicate so a future GitHub object-format change
has one explicit seam.

### Keep publication failures inside the retry envelope

`runPublishReviewResult` is the semantic boundary for automatic and explicit
publication. Expected failures from progress reads, findings, re-observation,
cycle, decision, and local receipt stages return the same bounded
`{ok:false,error,message,review_handle,publication_kind,next_action}` contract.
The existing publication lease is always released, and partial remote progress
remains retryable through `readTrustedReviewPublicationProgress`.

Do not expose raw exception messages, command output, publication bodies,
retained artifact paths, or original reviewer prose. Do not create a second
exception hierarchy in the MCP registration; the thin handler remains a final
unexpected-fault boundary.

### Complete retirement as a live-contract sweep

ADR-099 is authoritative: the dedicated test-quality reviewer, tool, config,
skill, and gate are removed. Update or retire every live surface that still
requires it, including the obsolete `.claude/skills/ship/SKILL.md` parallel
workflow, `.github/PULL_REQUEST_TEMPLATE.md`, `.env.example`, Step 4.4's live
reviewer list, `docs/architecture/SURVIVING_GATES.md`, and the normative bodies
of ADR-021, ADR-029, ADR-031, and ADR-036. Keep historical amendments only when
they are clearly labeled as superseded provenance and cannot be read as current
instructions.

> **Not adopted.** The maintainer decided the opposite of the paragraph below:
> the review-cap question stays, and ADR-029, ADR-021 and GC-O007 were amended to
> count it as a bounded exception-path pause rather than a second scheduled gate.
> ADR-099's cap question is unchanged. The paragraph is kept as a record of what
> the preflight recommended.

The cap contract follows ADR-029's sole synchronous human touchpoint. After all
known findings are fixed or validly dispositioned and self-verified, reaching
the cap advances as `accepted_at_cap`; the workflow does not stop to ask a
second human question. A previously supplied, verified authorization may permit
an extra cycle, but the canonical lane does not wait for one. The optional
auto-disposition surface must not preserve `escalate_to_human` as a hidden
synchronous gate.

### Restore behavior tests at the owning policy module

Restore focused tests for the four live
`run_documentation_coverage_check` behaviors named by GC-O010: classified
surface with outcome, classified surface without outcome, docs-only diff, and
unavailable PR body. Keep them beside the focused
`tools/policy/documentation_coverage.py` owner. The existing anchor tests cover
catalogue path integrity and are complementary, not replacements.

## Cross-Cutting Layers and Canonical Incumbents

- **Tool schemas:** strict Zod registrations remain thin adapters. Semantic
  invariants also run in the library because direct callers and injected tests
  bypass Zod.
- **Repository authority:** reuse `resolveAuthorizedIssueRepository`,
  `authorizeImplementRepoRoot`, and launch-workspace identity before every
  credentialed read or write.
- **Issue-thread persistence:** extend the existing review-publication,
  synchronization, pickup, and readiness codecs/readers. Preserve malformed,
  duplicate, ambiguous, out-of-order, and untrusted fail-closed behavior. Do
  not parse display prose independently in each consumer.
- **Git identity:** reuse sanitized implement Git execution, safe-checkout
  validation, full object-ID checks, synchronization ancestry, local/remote
  equality, and verified-tree checks. A temporary candidate-tree index must
  not run hooks, credential helpers, external filters, or caller-selected
  commands.
- **Public-content safety:** reserved-marker rejection,
  `detectSensitiveBodyContent`, GitHub byte caps, and argv-based `gh api`
  posting remain mandatory for every new or extended issue-thread record.
- **Error and observability contract:** stable bounded refusal envelopes are
  the observable API. Logs and envelopes contain identifiers and closed reason
  codes, never credentials, environment values, raw CI logs, diffs, file
  contents, or reviewer originals.
- **Configuration:** no new `.ground-control.yaml` or environment knob is
  needed for these corrections. Existing cap, integration-manager, CI timeout,
  and review-disposition config continues through the canonical parser and
  `gc_get_repo_ground_control_context` contract.

## Extensibility Guardrails

- The reusable seam is one trusted workflow-evidence reader that returns lane,
  review proof, settlement tree, synchronization identity, and delivery head;
  PR creation and both completion phases consume it instead of growing three
  policy copies.
- CI run discovery remains injectable through the existing `resolveRuns` seam;
  adding another workflow for the same head must require no watcher code change.
- GitHub head identity has one provider-specific full-SHA validator; generic
  repository object IDs retain their existing SHA-1/SHA-256 validator.
- Sensitive credential-module exemptions remain a closed data allowlist so a
  future language addition changes one reviewed set and its table-driven tests.
- Retirement policy distinguishes live contracts from historical provenance;
  future reviewer retirement must update the same live-surface inventory
  without rewriting history.

## Non-Goals and Anti-Patterns

- Do not add a backend, database, DTO/repository layer, Git notes, local
  authority file, or driver-owned workflow state.
- Do not make PR body review attestations, `reviews[]`, branch names, labels,
  caller lane values, or cached MCP results authoritative.
- Do not compare a SHA-256 review digest directly with a Git commit/tree SHA or
  call a settled repair tree a reviewed revision.
- Do not solve stale evidence by requiring an unbounded clean review verdict;
  that reverses ADR-099 and needs a separate decision.
- Do not duplicate marker parsing, trust resolution, path screening, SHA
  validation, CI outcome mapping, or publication error normalization at each
  call site.
- Do not treat CI inability-to-observe as absence of CI, or map unknown/error
  outcomes to success-like `skipped`.
- Do not retain live test-quality requirements under the label of historical
  compatibility, and do not delete clearly historical provenance merely to
  make a text search empty.
- Do not broaden this issue into changes to CI job topology, Sonar policy,
  reviewer prompts, model routing, branch protection, or requirement storage.
