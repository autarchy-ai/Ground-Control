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
table, and root-owned helper/config/event paths. Its pool is a dedicated 64 GiB
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
its nftables table; rerun setup after an address change so new starts are not
rejected as stale.

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

For a published commit, use the guest-clone form. The guest clones directly and
checks out the resolved immutable commit:

```sh
gc-incus-sandbox create agent-1
gc-incus-sandbox prepare agent-1 clone "$PWD" HEAD
gc-incus-sandbox attach agent-1
```

For an unpublished **committed** revision, use the bundle form. It transfers Git
objects only and materializes the same resolved commit in the guest:

```sh
gc-incus-sandbox prepare agent-1 bundle "$PWD" HEAD
gc-incus-sandbox attach agent-1
```

Dirty working-tree migration is unsupported. Two guests receive separate
checkouts, `.git` directories, homes, runtime state, credentials, and Docker
daemons. The guest bootstrap installs `grndctl` and Codex into the sandbox
user's local prefix; it does not copy a host home, Codex cache, credential store,
SSH agent, runtime socket, or Docker context. Run installs, hooks, tests,
reviewers, and builds in the attached guest.

Inside the guest, authenticate Codex explicitly with the account and ChatGPT
workspace you intend to use. Ensure an API key is absent first, then use device
login and verify the selected authentication method:

```sh
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

The probe expects guest access to the metadata address, host bridge address,
private bridge canary, and IPv6 loopback canary to fail. It uses no secrets or
host checkout data. Also create, attach, stop, start, and attach again to prove
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
