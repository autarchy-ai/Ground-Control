# Local Incus coding sandbox

Issue #1643 adds a local, disposable VM boundary for coding sessions. It is
separate from Ground Control's MCP service and does not add a dashboard, daemon,
database, scheduler, host mount, credential gateway, or a public Incus API.

## Install and configure

Run the privileged setup deliberately from a reviewed checkout:

```sh
sudo bash tools/incus_sandbox/setup.sh install
```

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

## Ordinary use

The only supported lifecycle verbs are:

```sh
gc-incus-sandbox create agent-1
gc-incus-sandbox attach agent-1
gc-incus-sandbox status agent-1
gc-incus-sandbox diagnose agent-1
gc-incus-sandbox stop agent-1
gc-incus-sandbox start agent-1
gc-incus-sandbox delete agent-1
gc-incus-sandbox list
```

`attach` runs `tmux new-session -A -s coding` inside the guest. Detaching the
host terminal leaves that guest session running. The CLI accepts no command,
profile, device, image, mount, or network arguments, and it never retries a
requested guest operation on the host.

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
gc-incus-sandbox create agent-1
gc-incus-sandbox prepare agent-1 bundle "$PWD" HEAD
gc-incus-sandbox attach agent-1
```

A bundle carries no remote, so the guest checkout has no `origin`. Add the one
you intend to publish through after authenticating in the guest:

```sh
git -C ~/workspace remote add origin https://github.com/OWNER/REPOSITORY.git
```

For a published commit, use the guest-clone form. The guest clones directly and
checks out the resolved immutable commit:

```sh
gc-incus-sandbox prepare agent-1 clone "$PWD" HEAD
```

The guest, not the host, reads that repository. For a private repository,
complete the guest GitHub credential steps below first; a guest without a
credential cannot clone it, and the host never lends its own.

Preparing the same commit again is safe: an existing guest checkout at that
commit is kept and the remaining steps rerun, so a preparation interrupted by a
missing credential or a failed install is finished by repeating the command. A
guest checkout at a different commit is refused rather than replaced; remove
`~/workspace` in the guest to prepare another source there.

Dirty working-tree migration is unsupported. Two guests receive separate
checkouts, `.git` directories, homes, runtime state, credentials, and Docker
daemons. Preparation materializes the source and points guest-local global
installs at the sandbox user's own prefix; it installs no tooling, and it does
not copy a host home, Codex cache, credential store, SSH agent, runtime socket,
or Docker context. Run installs, hooks, tests, reviewers, and builds in the
attached guest.

Guest output stays in the guest. When preparation reports a guest failure, or
the template is missing a prerequisite, read the reason in the guest:

```sh
gc-incus-sandbox attach agent-1
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

## Boundary and lifecycle evidence

With two disposable VMs running, run the harmless probes as root:

```sh
sudo python3 tools/incus_sandbox/probe.py agent-1 10.74.0.1 agent-2
```

The probe reads the sibling guest's own address, then requires guest access to
the metadata address, the host bridge address, the private bridge canary, that
sibling, and an external IPv6 canary to fail. It exits non-zero when any of them
answers or when the probe itself cannot run, and it uses no secrets or host
checkout data. Also create, attach, stop, start, and attach again to prove
the guest tmux session behavior. A bounded resource exercise should be performed
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
