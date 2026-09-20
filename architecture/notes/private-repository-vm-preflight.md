# Private-Repository Guest Workflow Preflight

Issue: #1644

Requirement: none

This note records the boundaries for completing one private-repository change
inside an ADR-101 Incus guest. It is design guidance, not an implementation
plan.

## Decisions

### The guest, not the host, owns the development checkout and execution

ADR-101's fixed lifecycle helper remains the only host-to-Incus authority. Do
not turn `attach`, a new lifecycle verb, or the sudo rule into arbitrary guest
command execution. The operator uses the guest-resident terminal; cloning,
checkout, package installation, hook activation, Ground Control installation,
Codex review, tests, and any Docker build all run there.

The guest checkout is a distinct clone with its own working tree, `.git`, home,
Git configuration, credential store, runtime directories, and Docker daemon.
It must not mount or forward a host checkout, host home, `.git` directory,
credential helper/store, SSH or agent socket, `XDG_RUNTIME_DIR`, or Docker
socket/context. A guest Docker daemon is permitted; a host daemon or
`DOCKER_HOST` endpoint is not. Two guests for the same repository are separate
clones and cannot share or mutate checkout state.

The one source-selection seam is an immutable source commit plus a closed
transfer kind: a guest-side authenticated clone for an already published
revision, or a repository-object bundle for an unpublished committed revision.
Both paths must resolve and record the same commit identity before checkout.
Do not create different "clean" and "unpublished" workflow engines, accept a
host path/mount as a transfer option, or support dirty-worktree transfer; the
latter is explicitly #1645.

When a host creates the committed-object bundle, it must use the existing
sanitized Git-environment pattern: fixed Git argv, system/global config
disabled, hooks and fsmonitor disabled, interactive credentials disabled, and
no repository command, hook, filter, or host credential helper. It transfers
objects only. Any checkout-time repository behavior consequently happens in the
guest. The transfer boundary must never fall back to running a guest-supplied
command on the host.

### Credentials are deliberately guest-local and separately scoped

The operator performs `codex login --device-auth` in the guest after ensuring
the guest process has no `OPENAI_API_KEY`; `codex login status` confirms the
active method. This selects the operator's ChatGPT account/workspace and its
subscription billing explicitly. Do not copy a host Codex cache, `CODEX_HOME`,
keyring entry, environment, or credential file. The guest's Codex credential
storage is private to that guest home and must be removed with the guest.

The current GitHub exception is a manually supplied, guest-local,
fine-grained token selected for exactly the target repository. It is entered by
the operator through a guest-local credential flow, never in argv, image,
repository file, event, terminal capture, or host environment. Before workflow
use, guest-local checks must verify the authenticated account, selected
repository, and only the permissions needed for Git/PR/issue operations without
printing the token. Operator documentation must record the token's configured
expiry and a revocation step, and must state plainly that a guest process can
read its credential and repository scope is broader than branch scope. A broad
personal or organization token is not an acceptable substitute.

Ground Control runs as a new guest-local MCP process rooted at the guest
checkout. Its existing launch-directory `.env` authority and repository-binding
checks apply there; the host MCP process, its `.env`, sockets, and GitHub
credentials are never a guest fallback. Keep `GH_TOKEN`/Git credentials out of
the server's Codex-child allowlist: `codexEngineEnv` already provides the
minimum Codex environment, and its allowlist must not be widened to make a
guest workflow convenient.

### Workflow evidence and publication remain honest

The guest runs the ordinary `/implement` lifecycle, including targeted tests
and independent review. Its MCP server retains the normal Issue-thread record
and PR rendering/creation paths; there is no agent-side `gh`, `git`, or curl
publication shortcut and no host-side fallback. Bounded lifecycle telemetry
continues to use ADR-101's allowlisted event shape and must omit private source,
prompts, child output, credential material, Git remote URLs, and token scope
details.

Publication permission is a separate, explicitly observed capability. If the
repository-scoped token cannot push or create a PR, implementation must not
widen credentials or claim publication succeeded. Leave the guest branch and
its focused-test/review evidence intact, report the failed/unknown check state
without raw output, and give the operator guest-local publication steps. Do not
export private source or credentials to the host merely to make the handoff
look automatic.

## Canonical Incumbents And Cross-Cutting Boundaries

- **VM authority and isolation:** ADR-101, `tools/incus_sandbox/client.mjs`,
  `helper.py`, `config.py`, `gc-incus-sandbox.nft`, and
  `docs/operations/incus-sandbox.md`. Reuse their closed action/name grammar,
  root-owned configuration validation, argv construction, network denial,
  per-guest allocation ownership, and bounded event/status schemas.
- **Safe host Git mechanics:** `sanitizedImplementGitEnvironment` in
  `mcp/ground-control/lib/codex-workflow.js` is the incumbent hook/credential
  suppression pattern. A bundle-only transfer may specialize its minimum
  environment, but must not create another Git safety policy or inherit the
  host environment wholesale.
- **Guest Ground Control configuration:** `mcp/ground-control/index.js` and
  `lib/server-env.js` own launch-directory `.env` loading; `.ground-control.yaml`
  remains non-secret workflow configuration read through
  `gc_get_repo_ground_control_context`. Do not put a token, path to a token, or
  VM policy in it.
- **Guest Codex process environment:** `codexEngineEnv` in
  `mcp/ground-control/lib/codex-engine-env.js` is the sole Codex-child
  allowlist. It must retain its minimal surface and no-host-credential rule.
- **Workflow and records:** the `/implement` skill, `gc_implement_mechanical`,
  `gc_render_pr_body`, `gc_create_synchronized_implement_pr`, and ADR-029's
  issue-thread record remain authoritative. The guest run is an ordinary
  requirement-free run, not a new VM workflow lane or record type.
- **Errors and diagnostics:** reuse the existing stable failure envelopes,
  sensitive-content scrubbers, bounded Codex output, and ADR-101
  `gc.incus-sandbox.event/v1` allowlist. Credential validation may expose a
  capability result and recovery action, never a token, raw headers, full
  environment, private repository content, remote URL, or child transcript.

## Security And Validation Guardrails

| Layer | Required control |
| --- | --- |
| Host lifecycle input | Keep `client.mjs`/`helper.py` closed action and sandbox-name validation; no arbitrary command, mount, device, profile, image, or file-path input. |
| Host configuration and OS exposure | Keep root-owned non-symlink `gc.incus-sandbox/v1` validation, the restricted project/profile, firewall deny rules, and no host sockets or mounts. Guest Docker is local-only. |
| Source transfer | Validate a resolved immutable commit and closed transfer kind; host Git runs with the existing sanitized configuration and fixed argv, never repository hooks/code or credentials. |
| Guest credentials | Direct guest device login for Codex with API-key variables absent; manually entered, repository-selected GitHub credential validated without value disclosure. No credentials in images, tracked config, process argv, logs, or host environment. |
| MCP/config | Start a separate guest-local server from the guest checkout and reuse strict config parsing, launch-root environment binding, tool schemas, repository authorization, and thin tool handlers. |
| Error/observability | Preserve bounded/scrubbed envelopes and ADR-101's allowlisted local events. Unknown, denied, or failed capability/check states remain explicit rather than being converted to success. |

## Boundary Evidence Required

Automated tests should prove the closed inputs and scrubbed failures; the final
operator run must also retain bounded evidence that a real private repository
was handled in the guest. In particular, prove clean and unpublished committed
sources select the expected immutable commit, a synthetic host hook/repository
command cannot run during transfer, and two guests cannot observe or mutate
each other's checkout. Assert no host mount, runtime socket, Docker endpoint,
or inherited credential is present in the guest; assert guest Docker uses its
own daemon. Exercise Codex's guest-local ChatGPT/device-login status without an
API-key environment variable, and test that a denied push/PR capability yields
an honest guest-local handoff rather than a host or broader-credential retry.
Secret canaries belong only in tests and must be absent from events, errors,
logs, issue records, image artifacts, and command arguments.

## Non-Goals And Anti-Patterns

- No dirty-worktree migration (#1645), credential broker (#1646), dashboard,
  remote session protocol, VM MCP tool, host daemon, generic executor, or
  general credential-store abstraction.
- No host execution of guest/repository commands; no host checkout or home
  sharing; no host Docker socket; no copied Codex cache; no ambient-environment
  inheritance.
- No broad GitHub token, token rotation automation, token in a VM image, or
  claim that repository-scoped access limits branch access.
- No duplicate lifecycle schema, error hierarchy, Docker wrapper, Git transfer
  framework, workflow lane, issue marker, or parallel credential/config parser.
- No automatic publication fallback. Failed checks, incomplete review results,
  denied publication, and unsupported guest prerequisites are reported as such.

## Design Vocabulary That Applies

- **Tool registration:** any existing MCP interaction remains a Zod schema plus
  thin handler delegating to a library function; this work does not create a VM
  MCP control surface.
- **Issue-thread record:** retain the existing `gh api` argv-based MCP posting
  path for workflow decisions and final reporting; VM state is never posted as
  a workflow record.
- **Canonical helper:** reuse `gh api` argv-based posting in
  `mcp/ground-control/lib.js`; privileged GitHub side effects remain inside the
  guest-local MCP server, not an agent sandbox or the host VM helper.
- **Boundary contract:** the MCP server is the only running Ground Control
  service and owns privileged Git/GitHub side effects. The Incus helper stays a
  separate fixed-command host boundary and acquires none of those powers.
- **ADR-027:** `.ground-control.yaml` and
  `gc_get_repo_ground_control_context` remain the agent-neutral context
  contract; VM policy and credentials are not added to it.
- **ADR-029:** the GitHub issue thread remains the durable workflow record, not
  a store for guest state, credentials, or private diagnostic output.
- **ADR-031:** Codex returns structured findings while the guest-local MCP
  server performs GitHub writes.
- **Anti-recommendations:** do not add an abstraction below three call sites;
  do not rely on prompt text for enforcement; do not add obvious comments; and
  do not invoke `gh`, `git`, or `curl` from Codex/Claude sandboxes.
