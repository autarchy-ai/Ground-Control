# Local Incus coding sandbox

Issue #1643 adds a local, disposable VM boundary for coding sessions. It is
separate from Ground Control's MCP service and does not add a dashboard, daemon,
database, scheduler, host mount, credential gateway, or a public Incus API.

## Install and configure

Run the privileged setup deliberately from a reviewed checkout:

```sh
sudo bash tools/incus_sandbox/setup.sh install
```

Upgrade an existing installation in place before using dirty-work migration or
repository-scoped task variables. This replaces only the reviewed programs and
upgrades a v1–v3 root policy to `gc.incus-sandbox/v4`; it keeps guests,
allocations, storage, network policy, and sessions:

```sh
grndctl sandbox setup upgrade
```

A host without a checkout runs the same programs from the installed package:

```sh
grndctl sandbox setup install
```

`grndctl sandbox` is an unprivileged front end. For setup and template commands
it prints the privileged command before running it under `sudo`; lifecycle
verbs reach only the fixed root helpers that setup's sudo rule names.
`grndctl sandbox path` shows the directory holding the programs so you can read
them first.

Use `--dry-run` to inspect its fixed resource actions. The installer only
creates `gc-sandbox` project/profile/pool/bridge resources, a dedicated nftables
table, and root-owned helper/config/event paths. Where another host firewall
already drops forwarded traffic by default, which Docker and libvirt both do,
setup also adds an accept for the `gcbr0` bridge alone in that chain, covering
guest-initiated traffic and its return path; without it the guest has no network
at all. Docker recreates its chains when it restarts, and the host address set
goes stale when host addresses change, so reapply that state afterwards:

```sh
sudo bash tools/incus_sandbox/setup.sh refresh
```

`refresh` reapplies only the firewall table, its address sets, and the bridge
forwarding rules. Install refuses to run twice; roll back first to reinstall. Its pool is a dedicated 64 GiB
loop-backed Btrfs volume; the host filesystem is neither repartitioned nor
reformatted. Setup refuses an already exposed Incus HTTPS management API or a
quota probe that cannot demonstrate a size limit. It does not flush firewall
rules, alter Docker or libvirt resources, expose
the Incus API, or add a user to `incus-admin`.

Before setup, replace the all-zero `images:` fingerprint in
`/etc/gc-incus-sandbox/config.json` with a verified, pinned Incus image
fingerprint, for example `images:<64-hex-fingerprint>`. The template must
contain `tmux`, `python3`, Git, GitHub CLI, Node.js with npm, and a `sandbox` user, but no
credentials, host mounts, forwarded sockets, or session history. It may run a
guest-local Docker daemon, but must never receive the host Docker socket or
context. Keep the file root-owned and mode `0600`. Setup writes the current host IPv4 address set into
its nftables table; run `setup.sh refresh` after an address change so new starts
are not rejected as stale. Traffic to a host address is dropped whether or not
that address is in the recorded set.

## Get the guest template

The published template lives in the GitHub Container Registry, and fetching it
is the ordinary path:

```sh
grndctl sandbox image
```

That pulls `ghcr.io/autarchy-ai/gc-sandbox-template:latest`, checks the
downloaded artifact against the digest its manifest names, imports it for the
`gc-sandbox` project as `gc-sandbox-template`, and prints the fingerprint to
pin. Pass a reference to fetch a different tag. The template contains Git,
Node.js with npm, `python3`, `tmux`, the GitHub CLI and the `sandbox` user, and
no credential.

The artifact's digest is also the fingerprint Incus gives the imported image, so
a pull first asks Incus for that fingerprint. When the template is already
imported, it downloads nothing and prints the same value to pin. A pull sends no
credential: a private or missing package fails with a message naming it rather
than a stack trace.

### Build one instead

Build locally when you need another base, another architecture, or a template
you compiled yourself:

```sh
grndctl sandbox build-image images:almalinux/10/cloud
```

The build resolves that reference to exactly one virtual-machine image for this
architecture and refuses an ambiguous one, launches a throwaway guest from the
resolved fingerprint, installs Git, Node.js with npm, `python3`, `tmux` and a
checksum-verified GitHub CLI, creates the `sandbox` user, publishes the result
as `gc-sandbox-template`, and deletes the guest. It prints the template
fingerprint to pin:

```json
  "image": "local:<64-hex-fingerprint>"
```

Put that in `/etc/gc-incus-sandbox/config.json` and create guests again; they
start from the template instead of a bare base image. Rebuilding refuses to
replace the existing alias, so remove it first with
`sudo incus image alias delete gc-sandbox-template --project gc-sandbox`.

Only reference forms Incus can launch are accepted: `images:<fingerprint>` for
an upstream image and `local:<fingerprint>` for a template that was pulled or
built here. The build pins its own tooling, so a rebuild produces the same guest
surface until `build_image.py` changes.

### Publish a template

Publishing is a maintainer step. It exports the local template and stores it in
the registry as one OCI artifact; the credential is read from standard input, so
it never reaches argv, the environment, or a file:

```sh
gh auth token | grndctl sandbox push-image \
  ghcr.io/autarchy-ai/gc-sandbox-template:latest <template-fingerprint>
```

The token needs the `write:packages` scope
(`gh auth refresh -h github.com -s write:packages`). A public package needs no
credential to pull.

## Ordinary use

Ground Control has one command. Every sandbox verb is a `grndctl sandbox`
subcommand; `grndctl sandbox --help` lists them. Upgrading an installation
removes the standalone `gc-incus-sandbox` command earlier versions installed.
The only supported lifecycle verbs are:

```sh
grndctl sandbox create agent-1
grndctl sandbox attach agent-1
grndctl sandbox status agent-1
grndctl sandbox diagnose agent-1
grndctl sandbox stop agent-1
grndctl sandbox start agent-1
grndctl sandbox delete agent-1 --confirm agent-1
grndctl sandbox list
```

`attach` joins the explicit `gc-task` session created by `task-start`; it never
creates a session or restores a previous task environment. Detaching the host
terminal leaves that task session running. The CLI accepts no arbitrary command,
profile, device, image, mount, or network arguments, and it never retries a
requested guest operation on the host.

The sandbox provider is Incus, which is also the default. A different provider
is chosen by name, either per command with a leading switch or for the operator
in `~/.config/grndctl/config.json` (under `$XDG_CONFIG_HOME` when set):

```sh
grndctl sandbox --provider incus list
```

```json
{"sandbox": {"provider": "incus"}}
```

The switch wins over the file. The provider set is closed and ships with the
package: a name outside it is refused before anything runs, and configuration
never names a program or path. Incus is the only provider today.

Each VM starts with 2 vCPU, 4 GiB RAM, and a 16 GiB root disk. Creation and
start also reserve host-owned aggregate CPU, memory, disk, image/snapshot, and
log allowance. Missing, stale, or insufficient memory, disk, or network-policy
facts deny admission instead of reporting a healthy zero.

## Private-repository work in a guest

Create a VM, then prepare a guest checkout from a committed source. The
repository directory and revision are read only by the unprivileged client.
The root-side endpoint receives a bounded packet over standard input, never a
host path, command, mount, credential, or Docker endpoint. It uses fixed Git
argv with hooks, global/system configuration, prompts, credential helpers, and
fsmonitor disabled. Repository code and hooks do not run on the host.

For an unpublished **committed** revision, use the bundle form. It transfers Git
objects only and materializes the same resolved commit in the guest, and it
needs no guest credentials:

```sh
grndctl sandbox create agent-1
grndctl sandbox prepare agent-1 bundle "$PWD" HEAD
grndctl sandbox task-start agent-1
grndctl sandbox attach agent-1
```

A bundle carries no remote, so the guest checkout has no `origin`. Add the one
you intend to publish through after authenticating in the guest:

```sh
git -C ~/workspace remote add origin https://github.com/OWNER/REPOSITORY.git
```

For a published commit, use the guest-clone form. The guest clones directly and
checks out the resolved immutable commit:

```sh
grndctl sandbox prepare agent-1 clone "$PWD" HEAD
```

The guest, not the host, reads that repository. For a private repository,
complete the guest GitHub credential steps below first; a guest without a
credential cannot clone it, and the host never lends its own.

Preparing the same commit again is safe: an existing guest checkout at that
commit is kept and the remaining steps rerun, so a preparation interrupted by a
missing credential or a failed install is finished by repeating the command. A
guest checkout at a different commit is refused rather than replaced; remove
`~/workspace` in the guest to prepare another source there.

Dirty working-tree migration uses the same packet and guest-bootstrap boundary;
see [Move an existing coding task into a VM](incus-sandbox-migration.md). Two guests receive separate
checkouts, `.git` directories, homes, runtime state, credentials, and Docker
daemons. Preparation materializes the source and points guest-local global
installs at the sandbox user's own prefix; it installs no tooling, and it does
not copy a host home, Codex cache, credential store, SSH agent, runtime socket,
or Docker context. Run installs, hooks, tests, reviewers, and builds in the
attached guest.

## Repository-scoped task variables

This feature is opt-in per repository. Installation and upgrade leave
`task_environment.repositories` empty; Ground Control does not configure any
repository or value for every user.

A repository that needs task variables commits `.gc-sandbox-env.json` at its
root. The identity is the normalized GitHub `owner/repository`, and every entry
contains exactly one non-secret literal or logical secret reference:

```json
{
  "schema": "gc.incus-sandbox.task-environment/v1",
  "repository": "example/service",
  "variables": [
    {"name": "DEPLOY_REGION", "literal": "eu-central-1"},
    {"name": "SERVICE_TOKEN", "secret_ref": "service-token"}
  ]
}
```

The parser is closed and bounded. It rejects unknown fields, duplicate names or
aliases, ambiguous sources, NULs, unsafe names such as `PATH`, `LD_*`, `GIT_*`,
`SSH_*`, `CODEX_*`, `GH_TOKEN`, and `GITHUB_TOKEN`, and a repository identity
that differs from the sanitized Git origin. Secret values and provider paths
never belong in this file.

The host operator separately adds only the intended repository and aliases to
the root-owned `/etc/gc-incus-sandbox/config.json` v3 or v4 policy:

```json
"task_environment": {
  "max_value_bytes": 16384,
  "repositories": {
    "example/service": {
      "service-token": {
        "path": "/etc/gc-incus-sandbox/providers/example-service-token",
        "state": "available"
      }
    }
  }
}
```

Create each provider file as a root-owned, non-symlinked regular file with mode
`0600`. The fixed file provider refuses missing, empty, oversized,
group/world-writable, expired, or revoked entries. The repository cannot name a
path, backend, host environment variable, or alias belonging to another
repository.

Source preparation binds the normalized repository and the exact declaration
digest to the sandbox. Then start and attach to the task explicitly:

```sh
grndctl sandbox prepare agent-1 bundle "$PWD" HEAD
grndctl sandbox task-start agent-1
grndctl sandbox attach agent-1
```

`task-start` rechecks the operator, active sandbox ownership, source binding,
repository identity, declaration digest, and every provider reference. It
resolves all values or starts nothing. Values travel in a bounded stdin frame
to a fixed guest launcher, then through a one-use socket in a private runtime
directory to a transient systemd service with a fresh dynamic uid. They do not enter argv, Incus configuration, source
or migration packet values, images, Git data, handoff files, logs, diagnostics,
or root-owned task state. The service constructs a minimal environment instead
of inheriting host or guest ambient variables; stopping it kills the complete
task cgroup and removes the private runtime directory.

Use `task-restart` to stop the complete task session and resolve every reference
again, or `task-stop` to terminate it without starting another process:

```sh
grndctl sandbox task-restart agent-1
grndctl sandbox task-stop agent-1
```

Replace a provider file atomically to rotate it for the next task process. To
revoke, set its host-policy state to `revoked` and stop the active task; future
starts fail closed. Editing or removing a provider outside that operator path
also blocks the next start, but cannot erase bytes already held by a running
process, so stop that process explicitly. A VM stop or deletion stops the task
first and removes its redacted task state. Starting a VM never resurrects a
task; run `task-start` again, which re-resolves current values.

`status` and `diagnose` show only task state plus configured variable names,
literal/secret source kind, and closed availability. They omit literal values,
secret aliases, provider paths and revisions, lengths, hashes, and child/provider
output. GitHub publication credentials remain on the broker path; reusable
GitHub credentials are deliberately rejected here.

Guest output stays in the guest. When preparation reports a guest failure, or
the template is missing a prerequisite, read the reason in the guest:

```sh
grndctl sandbox attach agent-1
cat ~/.gc-transfer/bootstrap.log
```

Inside the guest, install the Codex CLI, then authenticate it explicitly with the
account and ChatGPT workspace you intend to use. Ensure an API key is absent
first, then use device login and verify the selected authentication method:

```sh
npm install -g @openai/codex
unset OPENAI_API_KEY CODEX_HOME
codex login --device-auth
codex login status
```

Device login is intended for remote or headless use. It preserves the selected
ChatGPT account and subscription path; an API-key login uses API billing
instead. See [OpenAI's Codex authentication guide](https://developers.openai.com/docs/auth/).

Enter a GitHub fine-grained token manually in the guest's credential flow. Select
only the target repository and the Git/PR/issue permissions needed for the
change. Do not put it in the image, repository files, command arguments, host
environment, or lifecycle logs. Check the authenticated account, selected
repository, and push/PR capability without printing the token. Record its expiry
with the work and revoke it through GitHub when the guest is deleted. A guest
process can read a credential it uses, and repository scope is broader than
branch scope.

```sh
read -rs GH_TOKEN; printf '\n'
printf '%s' "$GH_TOKEN" | gh auth login --hostname github.com --with-token
unset GH_TOKEN
gh auth status --hostname github.com
gh repo view OWNER/REPOSITORY --json nameWithOwner,viewerPermission
git push --dry-run origin HEAD
```

Install Ground Control in the guest as any other host installs it, then install
its skills for the checkout:

```sh
npm install -g grndctl
grndctl install-skills
```

Until the first release publishes `grndctl` to npm, the only guest-local source
is a Ground Control checkout the guest already holds, such as
`npm install -g ./mcp/ground-control` when the prepared repository is Ground
Control itself.

Run `/implement` from the guest checkout. If the scoped credential cannot push
or create a PR, keep the guest branch and its focused-test/review evidence, then
give the operator guest-local publication steps. Do not widen the credential or
retry publication through the host. Treat a failed or unavailable check as that
state, rather than as a successful handoff.

## Command deadlines

Every Incus call the root helpers make has a finite deadline. The helpers hold
the allocation lock or a per-sandbox lock while they run Incus, so a hung
daemon, transfer, or guest command cannot keep that lock. At the deadline the
helper stops the call's whole process tree, first with `SIGTERM` and then with
`SIGKILL`, and releases the lock only after that tree is gone. If a process
survives `SIGKILL`, the call fails with a cleanup error rather than succeeding. When `sudo`
relays `SIGTERM`, `SIGINT`, or `SIGHUP` to a helper waiting on a call, the helper
reaps the tree in the same way before exiting.

Each call belongs to one operation class. The defaults, in seconds:

| Class | Default | Calls |
|---|---|---|
| `query` | 60 | status queries, `list`, host address reads, agent probes |
| `lifecycle` | 300 | `start`, `stop`, `delete`, limit settings |
| `launch` | 1800 | `launch`, template provisioning and publication, image import and export |
| `transfer` | 1800 | the guest source transfer and bootstrap |
| `task` | 120 | task session start and stop |

A v4 policy may override any class in `deadline_seconds`, for example
`"deadline_seconds": {"launch": 3600}`. Each value must be a positive integer
of at most 14400 seconds, and an unknown class fails validation. There is no
unlimited value. No command-line argument, packet, task frame, or repository
declaration can choose a deadline. `attach` is the one call without a deadline:
it is the operator's own terminal session, it holds no lock, and it ends when
the operator detaches.

A timeout is a failure with the lifecycle error code `command_timeout`:

- **Create:** a launch that times out may still produce an instance, because the
  daemon can finish it. The helper tries to delete the instance. If it cannot
  prove the instance is gone, it keeps the reservation, so capacity is never
  freed under a VM that may exist. `grndctl sandbox delete NAME --confirm NAME`
  reconciles the reservation, and it succeeds when the instance never
  materialized.
- **Stop and delete:** the allocation stays active and nothing is forgotten, so
  retry after the daemon recovers.
- **Transfer:** the previous source binding is already cleared, so a task
  cannot start against a partially prepared source. The command names the
  guest log to read.
- **Task start:** the redacted task record is written before the start is sent.
  After a failed start, the helper sends one bounded task stop. It removes the
  record only when that stop is confirmed. Until then the sandbox counts as
  running a task: its source cannot be replaced, and a VM stop or delete first
  stops the task. `grndctl sandbox task-stop NAME` clears the record.

## Boundary and lifecycle evidence

With two disposable VMs running, run the harmless probes as root:

```sh
sudo python3 tools/incus_sandbox/probe.py agent-1 10.74.0.1 agent-2
```

The probe reads the sibling guest's own address, then requires guest access to
the metadata address, the host bridge address, the private bridge canary, that
sibling, and an external IPv6 canary to fail. It exits non-zero when any of them
answers or when the probe itself cannot run, and it uses no secrets or host
checkout data. Also create, prepare, task-start, attach, task-stop, start the VM,
and confirm no task was resurrected. A bounded resource exercise should be performed
on a disposable VM only, while observing that the host remains responsive.

Lifecycle events, including a transfer outcome without packet contents, are stored in the root-owned,
rotation-bounded `/var/log/gc-incus-sandbox/lifecycle.jsonl`. They contain only
the version, time, duration, opaque operation IDs, sandbox ID, closed action and
outcome, stable error code, and resource facts. They deliberately omit child
output, terminal contents, raw argv, prompts, code, diffs, environment values,
and credentials. `status` and `diagnose` expose `unavailable` or `stale` facts
as such; they do not transform absence into zero use or a healthy VM.

## Roll back

Stop and delete every `gc-sandbox` VM, then run:

```sh
sudo bash tools/incus_sandbox/setup.sh rollback
```

Rollback refuses while an owned VM is running. It removes only resources named
by this sandbox setup and leaves unrelated Incus projects, pools, bridges,
nftables tables, Docker, libvirt, storage, and host services intact.

Deleting one guest is a separate, deliberately confirming action. Stop it,
inspect its private migration result and Git state, then repeat the exact name:

```sh
grndctl sandbox stop agent-1
grndctl sandbox delete agent-1 --confirm agent-1
```

Disconnects, timeouts, failed imports, and failed verification never delete a
guest. Migration does not authorize deletion of the original checkout or
revocation of credentials.
