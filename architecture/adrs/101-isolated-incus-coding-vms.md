# ADR-101: Isolated Incus VMs for local coding sessions

- **Status:** Accepted
- **Date:** 2026-09-19
- **Issue:** #1643
- **Requirement:** none
- **Supersedes:** none

## Context

Ground Control has no backend, database, console, scheduler, or host-control
service. The next usable slice is a primary-host command that creates a
disposable QEMU/KVM Incus VM and attaches an interactive, guest-resident tmux
session. It must isolate the guest from host files, host credentials, sibling
guests, host services, and host resource exhaustion without changing existing
storage layouts or host workloads.

This is not an extension of the retired GRC product in ADR-089. It also is not
an agent dashboard or session controller under ADR-098. The terminal is a local
operator interface to one VM; Ground Control remains an independent MCP server
over repository files and GitHub workflow records.

Incus local-socket access is full daemon authority, including host-device and
filesystem attachment. Ordinary sandbox use therefore cannot be granted
`incus-admin` membership or a direct Incus client configuration. The Incus
security documentation is explicit on this boundary. The same documentation
also makes a managed bridge insufficient as a guest egress policy by itself.

## Decision

### A daemonless, two-authority command boundary

Ship a small Node.js ES-module client and a root-owned, fixed-command admin
helper installed by a separate privileged setup action. The client has only the
named VM lifecycle operations `create`, `list`, `attach`, `stop`, `start`,
`delete`, `status`, and `diagnose`; it validates a bounded sandbox name and
uses argv arrays, never a shell or caller-provided command string. `attach`
opens tmux inside the named guest through the helper. It never runs the requested
coding command on the host as a fallback.

The helper is the sole caller of Incus. It validates every operation against a
root-owned, strict configuration and constructs fixed Incus argv itself. Its
sudo rule may name only that helper, not `incus`, a shell, an editor, a script
directory, or arbitrary arguments. Its configuration and executable must be
root-owned, non-symlinked, and non-writable by the ordinary user. The setup
path keeps `core.https_address` unset and does not grant the user daemon-socket
access. This is a command boundary, not a new daemon, API, plugin framework, or
MCP tool.

The setup creates a dedicated restricted Incus project, profile, managed bridge,
and storage pool only after preflight proves the selected backend's quota
semantics. The helper rejects profiles, device overrides, raw QEMU settings,
mounts, proxy devices, GPU/PCI/USB devices, snapshots/backups, and image-source
changes. Guest templates contain no host mounts, host-home or checkout mounts,
SSH-agent or runtime sockets, credentials, or session histories. The guest
must not receive the Incus socket or guest API authority.

### Private-repository guest handoff

The supported private-repository path adds a closed preparation command beside
the lifecycle client. Its unprivileged side resolves an immutable commit using
fixed Git argv with system/global configuration, hooks, fsmonitor, prompts, and
credential helpers disabled. It sends a bounded source packet through a
separate root-owned endpoint. That endpoint takes no host path, arbitrary guest
command, mount, credential, or Docker endpoint: it pushes only the packet and
a host-owned guest bootstrap program through fixed Incus argv.

Published commits use a guest-side HTTPS clone and then detached checkout of
the resolved commit. An unpublished committed revision uses a Git object bundle
and the same detached checkout. Dirty worktrees remain unsupported. Checkout,
tool installation, hooks, tests, reviewers, builds, Docker use, and publication
run in the guest. Every guest owns its checkout, Git metadata, home, runtime
state, credentials, and Docker daemon; host homes, checkouts, credential stores,
runtime sockets, and Docker contexts are never copied or forwarded.

Codex authentication happens directly in the guest with an explicit device
login and no inherited API-key or credential cache. GitHub access is an
operator-supplied, guest-local, fine-grained token for the selected repository.
The guest may read the credential it uses, and repository scope does not limit
access by branch. A token that cannot publish produces a guest-local handoff;
the host never retries with broader credentials or executes guest-supplied
commands.

The image is selected by a pinned immutable identifier and verified manifest,
not a moving alias. A normal interactive coding command must be exercised in a
fresh VM before the image is accepted. Setup records only the exact resources it
created. Rollback removes only those resources and its sandbox-owned firewall
objects, and refuses while an owned VM remains running; it never destroys an
existing Incus project, storage pool, bridge, firewall rule, Docker/libvirt
resource, or unrelated host data.

### Resource admission and storage proof

The host owner, not the repository or caller, controls bounded defaults and
aggregate reservations. The initial per-VM profile is 2 vCPU, 4 GiB RAM, and
16 GiB disk; it is a starting policy, not a claim about tested capacity. Before
every create or start, the helper atomically evaluates configured host reserves,
existing sandbox allocations, image/snapshot/log allocation, and authoritative
free-space and memory observations. It rejects admission on an unknown, stale,
or insufficient observation rather than treating it as zero use.

Incus project limits are the aggregate configured-allocation backstop; each VM
also has explicit CPU, memory, and root-disk settings. The setup must prove the
chosen storage driver enforces the root-disk and aggregate pool limits under an
actual write probe before it permits ordinary use. Setup creates a dedicated,
loop-backed 64 GiB Btrfs pool, then runs that probe. It does not use unbounded
`dir` storage, repartition or reformat existing storage, or infer enforcement
from configuration text.

This is deliberately separate from `gc-test-dispatch`: that dispatcher owns
host-wide CPU admission for verification commands, has a CPU-only ledger, and
is not a sandbox or privilege boundary. Its host-owned configuration, strict
shape checks, lease-minded failure behavior, and bounded local diagnostics are
the applicable precedent, not a VM admission implementation to repurpose.

### Network policy is deny-by-default and dual-stack

The privileged setup adds only sandbox-owned nftables chains and sets; it never
flushes or replaces the host's firewall. The dedicated bridge permits DHCP and
the configured DNS resolver, return traffic, and outbound TCP 443 to public
addresses. It denies guest-to-guest traffic, all unsolicited inbound traffic,
host-management and host-service addresses (including every configured host
address), private/LAN/link-local/loopback/metadata ranges, and every other
destination. IPv6 is disabled for the sandbox bridge and guests and is also
explicitly dropped at the sandbox firewall boundary. Host-address changes make
the policy stale and must block new starts until the helper refreshes and verifies
the bounded host-address set. This policy limits network reachability; it does
not claim to prevent exfiltration through permitted HTTPS.

### Bounded local telemetry and diagnosis

One versioned local event shape is the only lifecycle telemetry contract. It
contains allowlisted fields only: schema version, UTC timestamp, monotonic
duration, event/operation/host/sandbox correlation IDs, lifecycle action and
outcome, stable error code, tool/image version, and bounded assigned or observed
resource facts. It contains no environment, raw argv, prompt, code, diff,
terminal content, message body, credential, or child output. Events are written
outside guest-writable storage to a root-owned directory with bounded size,
rotation, and restricted diagnostic read access. The helper does not mutate a
lifecycle state if it cannot first persist the required audit event; status and
diagnostic collection failures stay explicit `unavailable` or `stale` facts and
cannot be reinterpreted as healthy or zero usage.

`status` and `diagnose` return the same normalized observations: desired and
observed VM state, configured versus observed CPU/RAM/disk, admission headroom,
last transition, and stable failure reason. Every observation carries an
explicit freshness/availability state, so absence never becomes zero. There is
no collector, metrics database, tracing backend, Grafana, or resident monitor.
Diagnostic loss must not grant admission, relax the network policy, or bypass
the root helper's validation.

The event shape's version and closed action/outcome/error-code vocabulary are
the extensibility seam. A later supported lifecycle action or resource dimension
extends that one schema and its parser; it must not create parallel VM logs,
exception families, or status DTOs.

Release evidence includes harmless host, sibling, private-address, public-host-
address, IPv4, and IPv6 canaries; resource-bound and host-responsiveness probes;
stop/start persistence; failed boot and denied-admission event assertions; and
synthetic secret/argv canaries proving the event stream carries none of either.

## Consequences

### Positive

- The first slice is usable from a local terminal while keeping guest work and
  persistence private to the VM.
- Incus remains local-only and its root-equivalent socket is not an ordinary
  coding-agent capability.
- Resource limits, network isolation, and diagnostics are enforced at the host
  boundary instead of by prompt text or guest convention.

### Negative

- Privileged setup is an explicit operator action and setup can refuse a host
  whose existing storage cannot demonstrate quotas safely.
- Guest attachment relies on Incus console/exec mechanics and guest tmux rather
  than SSH-agent forwarding, host mounts, or terminal scraping.

### Risks and guardrails

| Risk | Guardrail |
| --- | --- |
| Direct Incus access becomes host authority | Never add the ordinary user to `incus-admin`; only the fixed-command root helper uses the daemon socket. |
| A configured disk size is not an enforced quota | Require backend-specific write-probe evidence before enabling use; account images, snapshots, and logs in aggregate admission. |
| A default Incus bridge exposes siblings or the host | Own a dedicated bridge and scoped nftables rules; prove IPv4 and IPv6 boundary canaries before release. |
| Telemetry leaks coding material or lies by omission | Use one allowlisted, versioned schema with explicit stale/unavailable states and bounded root-owned retention. |
| UI or workflow authority reappears | Keep the terminal client independent of Ground Control MCP and the optional ADR-098 dashboard; neither can operate VM lifecycle. |

## Non-Goals

- No Ground Control backend, database, web UI, MCP VM tool, persistent scheduler,
  generic runtime/plugin framework, or privileged resident daemon.
- No Temporal, OpenBao, SPIRE, Kubernetes, credential gateway, second host,
  automatic scheduling, agent forwarding, host checkout mount, or host runtime
  socket.
- No storage reformatting, partitioning, global firewall reset, Docker/libvirt
  disruption, public Incus API, general egress-prevention claim, or production
  capacity claim from the inspected host observations.
- No reuse of historical dashboard, console, GRC, or workflow telemetry as a VM
  control plane or source of VM health.
- No dirty-worktree migration, copied Codex credential cache, host GitHub
  credential, host Docker socket, arbitrary transfer path at the root boundary,
  or host-side fallback for a denied guest publication.

## Design Vocabulary That Applies

- **Boundary contract:** the MCP server remains the only Ground Control service
  and owns privileged Git/GitHub side effects. The VM command boundary is local
  host tooling and never acquires those workflow powers.
- **ADR-027:** `.ground-control.yaml` remains the agent-neutral workflow context;
  host sandbox policy and privileged configuration do not become repository
  configuration.
- **ADR-029:** GitHub issue records remain workflow records, not VM state,
  telemetry, or admission storage.
- **ADR-031:** Codex continues to return findings while MCP owns GitHub writes;
  the VM client adds neither a GitHub write path nor a workflow tool.
- **Anti-recommendation:** do not introduce abstractions below three call sites;
  keep the fixed lifecycle boundary small rather than creating a generic runtime
  framework.
- **Anti-recommendation:** do not put unenforceable sandbox claims in skills or
  prompts. Root-owned validation, Incus restrictions, nftables, quotas, and
  tests are the controls.
- **Anti-recommendation:** comments in the new tooling should explain only
  authority, quota, network, or telemetry invariants that are not obvious from
  the code.
