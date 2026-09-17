# ADR-098: Connect an optional dashboard through pinned native agent harnesses

- **Status:** Accepted
- **Date:** 2026-09-17
- **Issue:** #1607
- **Requirement:** none
- **Supersedes:** none

## Context

Operators need one place to notice and steer Claude Code and Codex sessions without
giving up provider subscriptions, named local profiles, manual model and effort
selection, or direct terminal and VS Code use. Ground Control itself is not that
place. It is an MCP server over repository-local requirements and ADRs; it has no
backend, database, web console, session controller, or telemetry plane.

The retired console and orchestration program cannot be used as dormant
infrastructure. ADR-081 is historical, ADR-089 retired the composed product and
console, and `docs/architecture/SURVIVING_GATES.md` prohibits projecting gate
results into another authority. Issue #1575's attention-inbox exploration also
established the important negative result: a dashboard cannot infer trustworthy
agent or workflow state by scraping terminal panes, process lists, hooks, or log
text. Observation is partial, and an observer must not become a controller merely
because it can see output.

The decision therefore has to preserve four independent owners:

1. Claude Code and Codex own their authentication, sessions, approvals, models,
   effort controls, and native histories.
2. The operator owns each machine, checkout, account profile, and dashboard
   deployment.
3. The separately launched Ground Control MCP server for each checkout owns that
   checkout's privileged Git/GitHub workflow side effects and gates.
4. The GitHub issue thread and merged repository files remain the durable workflow
   and specification records. A dashboard cache is never either record.

### Candidate evaluation

The comparison is against the operating requirements, not a preferred hosting
topology.

| Candidate | Deployment and harness fit | Decision |
|---|---|---|
| Yep Anywhere | MIT-licensed; local server and browser UI; direct, VPN, reverse-proxy, or end-to-end encrypted relay access; official Claude Agent SDK and Codex App Server integrations; provider-managed subscription auth; native session discovery/resume; model, Codex effort, approvals, and capability negotiation | **Adopt at a pinned release and adapt only the deployment boundary.** It is the smallest evaluated surface that already satisfies both harnesses. |
| Paseo | Apache-2.0 local daemon, clients, relay, and native CLI wrappers; strong host/relay security model and multiple deployment modes | Reject for this decision because its daemon primarily owns sessions it launches and adds a broader orchestration/plugin surface than the required inbox and steering boundary. It remains a fallback candidate, not a prerequisite. |
| Provider first-party remote controls | Strongest provider support and subscription preservation; Claude supports terminal/VS Code continuity, while Codex exposes App Server and first-party remote-control surfaces | Retain as an operator fallback. Two provider-specific UIs do not deliver one dashboard or a common host/session identity. |
| Direct custom Claude SDK plus Codex App Server client | Official harness contracts and full control over policy | Reject as duplicate integration work. It would recreate session readers, capability negotiation, streaming, approvals, reconnects, and protocol-version tracking that the selected project already owns. |
| ACP or another cross-provider protocol | One nominal adapter surface | Reject as the primary path. Neither selected harness needs ACP here, and a least-common-denominator protocol loses provider-specific session, approval, diff, model, and effort semantics. |
| PTY/tmux pane capture, hooks, transcript tailing, or process discovery | Can appear local and simple and can see sessions started elsewhere | Reject. Screen text is not a session protocol, `send-keys` is not acknowledged message delivery, process environments expose secrets, and liveness or workflow state inferred from these sources is untrustworthy. |
| Central remote agent service | Easy centralized UI and storage | Reject as the default because it moves code, credentials, and execution away from the operator's existing host and subscription profiles. A remote host may run the same local connector, but the dashboard service does not become the agent runtime. |

The excluded product from issue #1574 is not evaluated, selected, installed,
forked, integrated, or made an implementation dependency.

### Pinned compatibility evidence

The adopted baseline is **Yep Anywhere v0.8.0**, tag commit
`03b96b9c40054f639edcdec5dfb869309d7179d9`. Its release records compatibility
through **Codex CLI 0.151.0**, **Claude Code 2.1.251**, and
**`@anthropic-ai/claude-agent-sdk` 0.3.251**. The committed package metadata
records the same compatibility markers.

This pin is evidence, not a floating range. At preflight time this host has Codex
0.154.0 and Claude Code 2.1.274; newer installation is not proof that v0.8.0 has
validated it. Dashboard-managed launches must use the pinned harness binary or
pass a later, explicitly recorded compatibility qualification before the pin is
advanced. Direct native sessions may continue using a newer operator installation;
the dashboard reports those sessions as observation-only or unavailable when the
adapter cannot safely control their version.

The upstream contracts supporting the choice are:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) is
  OpenAI's first-class, bidirectional, UI-oriented integration surface. It owns
  thread persistence, configuration, authentication, approvals, model discovery,
  and generated protocol schemas.
- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
  provide structured streaming, native session identity, resume, and fork
  semantics. Anthropic's current
  [subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  confirms that Agent SDK and `claude -p` usage remain eligible for subscription
  usage at the date of this decision.
- [Yep Anywhere provider documentation](https://yepanywhere.com/docs/providers)
  records stable Claude Code and Codex support, provider-owned authentication,
  subscription use, native session discovery, and capability-gated model and
  effort controls.

## Decision

### Adopt the dashboard, not a new Ground Control service

Use the pinned Yep Anywhere server and browser client as an **optional operator
dashboard**. Do not vendor or fork it into this repository. The operator or the
operator's infrastructure team owns its installation, availability, upgrades,
storage, transport, and retention. The upstream project owns its provider
adapters. Ground Control owns no dashboard SLA and coding never depends on the
dashboard being reachable.

Adapt the deployment with a narrow **session-only profile**:

- enable only the Claude Code and Codex providers;
- permit session catalog, transcript observation, explicit message delivery,
  native approvals, and provider-reported model/effort selection;
- disable dashboard-owned shell/terminal execution, provider installation or
  update, worktree creation, Git mutation, GitHub mutation, commit, push, merge,
  and automatic approval;
- bind a host-local server to loopback by default; use a private network or an
  authenticated TLS endpoint for direct remote access, or an explicitly enabled
  end-to-end encrypted relay; and
- refuse startup or expose the affected capability as unavailable if the pinned
  deployment cannot enforce this profile. A hidden button is not enforcement;
  server-side route/capability denial is required.

The dashboard sends operator-authored messages to native harness sessions. It
does not issue Ground Control workflow commands itself, interpret `/implement`
state, or call GitHub. An agent receiving a workflow instruction continues to
use the checkout's already configured Ground Control MCP server. Each checkout
keeps its own MCP process, launch-directory `.env`, repository authorization,
and GitHub/gate authority.

### Versioned connection contract

The deployment boundary is `gc.agent-connection/v1`. This is a small profile
and normalized event contract around the adopted server's existing provider and
capability surfaces, not a third agent protocol and not a replacement for the
upstream Claude or Codex schemas.

The machine-readable contract is
[`architecture/contracts/gc.agent-connection.v1.schema.json`](../contracts/gc.agent-connection.v1.schema.json).
Its closed identity, capability, completeness, and delivery-result vocabularies
are the v1 wire authority. This ADR owns their meaning; later additive fields or
capabilities require a version-compatibility decision, and breaking changes use
a new contract version rather than broadening v1 in place.

Every connection advertises:

- `schema`, `connector_version`, `harness`, and exact `harness_version`;
- opaque `machine_id`, `checkout_id`, `account_profile_id`, and
  `native_session_id` values;
- a capability map keyed by `observe`, `resume`, `send_message`, `approve`,
  `select_model`, and `select_effort`, so one connection cannot advertise
  contradictory states for the same capability; and
- `egress_mode`, selected transport, and the data classes allowed to leave the
  host.

`machine_id` is installation-scoped. `checkout_id` is derived locally from the
canonical checkout realpath plus repository identity and distinguishes linked
worktrees; only an opaque identifier and optional operator label leave the host
by default. `account_profile_id` is an operator-chosen alias bound to exactly one
native profile directory. It is not an email address, provider account id, token,
or credential fingerprint. The four identity dimensions are never collapsed
into a display name or native session id.

An observation carries a per-session sequence, capture time, provider event kind,
explicit per-event egress mode, bounded structured attention metadata, source
(`live_protocol` or `native_history`), and completeness (`complete`, `partial`,
or `unknown`). Transcript text is valid only in `transcript` or `workspace`
mode; bounded workspace content is valid only in `workspace` mode. A message
carries a caller message id, target session identity, bounded UTF-8 text, and one
delivery result:
`accepted_by_harness`, `rejected`, `unsupported`, `session_unavailable`, or
`unknown_after_disconnect`. "Accepted" never means that the model processed the
message or that a requested action succeeded.

The capability map is the v1 extensibility seam. New harness adapters normalize
provider events into the closed v1 metadata, transcript, and workspace fields
while preserving identity, delivery outcomes, and absence semantics. New wire
payload variants require a later contract version. A client makes no request
when a capability is absent. Do not broaden an old capability meaning,
manufacture parity, or flatten provider approvals and effort controls into
misleading common values.

### Observation and failure rules

Observation is allowed only through the provider's supported structured protocol
or native history reader used by the pinned adapter. The connector must not read
terminal panes, keystrokes, shell history, `/proc/*/environ`, provider credential
stores, debug logs, or Ground Control's issue-thread markers to synthesize agent
state. It must not attach a second writer to an active native session unless the
provider contract explicitly supports concurrent clients.

Provider events may describe conversation and tool activity. They are not proof
that tests passed, a Git write occurred, a requirement changed, or an
`/implement` gate cleared. The authoritative source for those facts remains the
owning process, repository, CI system, or issue-thread record.

Collection, normalization, storage, relay, or rendering failure is fail-open for
coding and fail-closed for the missing dashboard capability. The agent session
continues; the dashboard marks the observation partial, unknown, or unavailable
and does not guess. Message delivery failure returns a delivery outcome and tells
the operator to use the native surface. It never falls back to terminal input,
shell execution, a different provider, or API-billed credentials.
Delivery results carry only the closed outcome code; native error text and
human-readable diagnostics remain local and are never serialized into v1.

### Authentication, profiles, and command boundary

Authentication remains a manual provider operation in the native CLI. The
dashboard never logs in on the operator's behalf, reads or copies OAuth material,
accepts an API key, or converts subscription access to API billing.

Each named dashboard profile binds one `CLAUDE_CONFIG_DIR` or `CODEX_HOME` before
the server starts. In subscription-only mode, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, provider/base-URL overrides, and cloud
provider selectors are rejected, not forwarded. This is stricter than choosing
one value by precedence: a conflicting billing route is a startup error with
variable names only. Preserve only the OS state needed to run the child and the
selected profile root. Reuse the allowlist and conflict-stripping design already
embodied by `codexEngineEnv`, `reviewEngineEnv`, and `server-env.js`; do not add a
second dotenv parser or read Ground Control's launch `.env` for dashboard auth.

Executable paths, model, effort, permission mode, checkout, and profile are
separate validated fields. Commands use argv arrays with no shell expansion.
Secrets, relay passwords, bearer tokens, and session credentials travel through
permission-restricted files, standard input, keychain/native stores, or protocol
handshakes, never process arguments. Manual model and effort choices are passed
only when the native capability advertises them; no default silently replaces an
operator choice.

### Service, storage, and data-flow boundaries

The host-local dashboard server owns only its UI metadata, connection state,
notification state, and disposable indexes/caches. Provider-native session
history remains the conversation source. Ground Control repository files and the
GitHub issue thread remain workflow sources. No record is dual-written between
these stores.

The local data directory must be on a permission-restricted local filesystem,
not a shared home or repository checkout. It may contain transcript-derived
metadata and is therefore sensitive. Retention and deletion are operator policy;
removing the cache does not remove provider-native history, and removing native
history is not a dashboard operation.

Data flow is:

```text
browser -> authenticated dashboard server -> native harness -> checkout + MCP
        <- normalized capability/events  <- native protocol/history
```

For loopback use, nothing leaves the host except the provider and GitHub traffic
the native agent and MCP server already perform. For private-network or reverse-
proxy use, permitted dashboard payloads leave the host for that authenticated
client. For relay use, the same payloads traverse the explicitly selected
end-to-end encrypted relay. `egress_mode` is explicit:

- `metadata`: opaque identity, capability, liveness, and bounded attention state;
- `transcript`: metadata plus prompts, responses, tool summaries, approvals,
  diffs, and selected attachments; or
- `workspace`: transcript plus explicitly requested file content.

`metadata` is the default. A mode is a maximum, not an instruction to collect
everything. Credentials, raw environment variables, Ground Control `.env`
content, secret files, and unrestricted filesystem content never leave the host.
The relay or optional remote dashboard is transport/display, not a durable
workflow or audit service.

Every observation repeats its egress mode and is schema-discriminated at that
ceiling. The receiver also binds the event to the active connection identity and
rejects a mode that differs from the negotiated connection state. Reconnect
establishes new connection state before later observations are accepted.

### Deployment modes

The same boundary supports multiple modes without choosing topology as product
identity:

| Mode | Supported shape |
|---|---|
| Local | Server and browser on one host over loopback. Default and smallest trust boundary. |
| Private remote | Server stays with the agent host; browser connects over VPN/private network. |
| Self-hosted public | Server stays with the agent host or controlled remote agent host; an authenticated TLS reverse proxy exposes it. |
| Hybrid relay | Host makes an outbound connection to an explicitly enabled end-to-end encrypted relay; browser connects through it. |
| Multiple hosts | One independently identified connector per host/profile; aggregation uses only the v1 connection contract. |
| Provider cloud agent | Not supported by this decision unless a future adapter can preserve the identity, profile, checkout, egress, and Ground Control binding contracts. |

The operator owns every deployed dashboard server and optional relay choice. A
third-party hosted relay owns transport availability only. No central Ground
Control service is introduced.

### Security and validation layers

An implementation must pass every layer below rather than merely matching the
dashboard's local coding style:

1. **Release and harness pin:** exact dashboard and harness versions are checked
   before control is enabled; mismatch becomes an unavailable capability.
2. **Profile and billing gate:** one validated native profile root; subscription-
   only mode rejects all alternate billing/provider environment selectors.
3. **Checkout gate:** canonical realpath containment and an operator allowlist
   precede session observation or launch. Symlink escape and an unrecognized
   worktree refuse.
4. **Connection shape:** one strict `gc.agent-connection/v1` validator owns
   bounds, enums, identity fields, capability absence, and unknown-key policy.
   Transport DTOs reuse it rather than duplicating validation.
5. **Transport and browser boundary:** loopback by default; authenticated TLS or
   explicit end-to-end encrypted relay otherwise; origin, CSRF, session expiry,
   reconnect, replay, and rate limits are enforced server-side.
6. **Message and approval boundary:** bounded typed input targets one complete
   session identity and goes through the native protocol. Provider approval and
   sandbox policy remain authoritative; automatic approval is disabled.
7. **Ground Control boundary:** the dashboard has no GitHub token, Ground Control
   `.env`, MCP mutation proxy, or Git/GitHub write route. The checkout's MCP
   server independently revalidates every privileged operation.
8. **OS exposure boundary:** no secret in argv, URLs, logs, errors, browser
   storage, or process listings; least-privilege file modes and child environment
   allowlists apply.
9. **Error envelope:** stable bounded codes distinguish unsupported, invalid,
   unauthorized, disconnected, and unknown outcomes without returning raw
   transcript fragments, command output, paths, environment values, or secrets.
10. **Observability:** log bounded opaque ids, versions, capability, counts,
    timing, and outcome only. Raw prompts, responses, tool output, diffs, and
    credentials require an explicit local diagnostic mode and never enter Ground
    Control records.

### Fallback and upgrade rule

If the pinned dashboard, its session-only enforcement, a harness adapter, or a
transport fails qualification, do not substitute a custom controller during the
delivery issue. Disable the affected adapter or the dashboard and continue with
native Claude Code/Codex in the terminal, VS Code, tmux, or the provider's
first-party remote-control surface. Ground Control continues normally because it
has no dependency on observation.

Advancing any of the three compatibility pins requires recorded fixtures for
session discovery, new and resumed turns, explicit message acknowledgement,
approval refusal, model/effort selection where supported, subscription-only
billing resolution, profile isolation, disconnect/reconnect, and native-session
continuation after dashboard shutdown. Schema generation or upstream release
notes alone are not end-to-end qualification.

## Consequences

### Positive

- The dashboard can ship without recreating two rapidly changing harness clients.
- Subscription auth, native sessions, profiles, approvals, and direct interfaces
  remain provider-owned.
- Local, private remote, self-hosted, relay, and multi-host deployment share one
  identity and capability boundary.
- Dashboard failure cannot block coding or weaken a Ground Control gate.

### Negative

- The selected dashboard is an external dependency whose compatible harness
  versions may lag current native releases.
- Session-only enforcement may require a small deployment adapter or upstream
  contribution; if it cannot be enforced server-side, the dashboard remains
  disabled.
- Transcript and workspace modes expose sensitive development data to the chosen
  client path and require explicit operator acceptance and retention policy.
- One UI does not make Claude and Codex capabilities identical; absent controls
  remain visibly absent.

### Risks and mitigations

| Risk | Guardrail |
|---|---|
| Silent API billing | Reject API-key, alternate-provider, and base-URL selectors in subscription-only profiles; native login remains manual. |
| Dashboard becomes a second workflow controller | Session-only server enforcement; no Git/GitHub/Ground Control mutation routes; issue thread stays authoritative. |
| Stale adapter corrupts or misreads a session | Exact pins, provider capability gates, native identity, no concurrent writer without provider support, and qualification fixtures before upgrades. |
| Observation is mistaken for gate evidence | Partial/unknown completeness and explicit source; no inferred test, Git, requirement, or workflow status. |
| Remote compromise becomes host code execution | Loopback default, authenticated encrypted transport, server-side route denial, no terminal/shell, checkout allowlist, and provider approvals. |
| Credentials or source leak through diagnostics | Minimal child env, no secret argv, bounded redacted errors/logs, explicit egress mode, local diagnostics off by default. |
| A dashboard cache becomes a new system of record | Cache-only storage with deletability; native provider history, Git, and issue thread keep their existing authority. |

## Non-Goals

- Rebuilding or restoring the retired Ground Control console, GRC product,
  Temporal controller, workflow-run store, or telemetry plane.
- Turning Ground Control MCP into a dashboard backend, agent gateway, auth proxy,
  session repository, or relay.
- Supervising arbitrary shell/tmux processes, scraping terminal output, or
  guaranteeing observation of every native session.
- Replacing provider approvals, sandboxes, subscriptions, model catalogs,
  histories, or first-party remote controls.
- Giving a dashboard authority to commit, push, merge, post to GitHub, clear a
  gate, or claim workflow completion.
- Selecting a permanent hosting vendor or requiring code, transcripts, or
  credentials to leave an agent host.
- Making rejected alternatives implementation prerequisites.

## Affected ADRs

- **ADR-017, ADR-030, and ADR-081:** historical web/deployment/console decisions
  remain superseded or retired; this optional dashboard does not reactivate them.
- **ADR-027:** `.ground-control.yaml` and the MCP server remain the agent-neutral
  workflow and privileged-side-effect boundary. Dashboard configuration is not
  added to that file.
- **ADR-029:** the issue thread remains the durable workflow record; dashboard
  observations and cache records are not markers or gate evidence.
- **ADR-036:** provider routing remains advisory workflow configuration; a
  dashboard model selector controls only a native session and restores no
  telemetry surface.
- **ADR-089:** the retired GRC product and console remain retired. The optional
  operator dashboard has no GRC routes, composition, or authority.
- **ADR-090:** the superseded production-line measurement model remains
  historical. Dashboard observations are not restored measurement emitters,
  station results, or a second workflow evidence plane.
- **ADR-093 and ADR-094:** repository files remain specification authority and
  optional indexes remain non-authoritative; no requirement/session database or
  graph projection is introduced.
