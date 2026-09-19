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
table, and root-owned helper/config/event paths. It refuses an already exposed
Incus HTTPS management API, a pool filesystem without project quotas, or a
quota probe that cannot demonstrate a size limit. It does not repartition or
format storage, flush firewall rules, alter Docker or libvirt resources, expose
the Incus API, or add a user to `incus-admin`.

Before ordinary use, replace the all-zero digest in
`/etc/gc-incus-sandbox/config.json` with a verified, pinned local Incus image
fingerprint. The template must contain `tmux` and a `sandbox` user, but no
credentials, host mounts, forwarded sockets, or session history. Keep the file
root-owned and mode `0600`. Setup writes the current host IPv4 address set into
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

Lifecycle events are stored in the root-owned,
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
