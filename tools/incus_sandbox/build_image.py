#!/usr/bin/python3
"""Build and publish the sandbox guest template from a pinned base image."""

from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

if __package__:
    from .config import SandboxConfig, load_config
    from .owned_process import run_owned
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from config import SandboxConfig, load_config
    from owned_process import run_owned


class BuildError(RuntimeError):
    """The caller requested a template build outside the closed boundary."""


_INCUS = "/usr/bin/incus"
_ALIAS = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
_REMOTE_BASE = re.compile(r"^images:[a-z0-9][a-z0-9/._-]{0,63}$")
_FINGERPRINT = re.compile(r"^[0-9a-f]{64}$")
_CONFIG_PATH = Path("/etc/gc-incus-sandbox/config.json")
_DEFAULT_ALIAS = "gc-sandbox-template"
_AGENT_TIMEOUT_SECONDS = 180
_AGENT_RETRY_SECONDS = 3
# The template's tooling is pinned rather than tracked, so a rebuild produces the
# same guest surface until this file changes.
_GH_VERSION = "2.101.0"
_GH_CHECKSUMS = {
    "amd64": "9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8",
    "arm64": "b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f",
}
_PACKAGES = "git-core nodejs npm python3 tmux tar"
_DEBIAN_PACKAGES = "git nodejs npm python3 tmux tar ca-certificates curl"


def parse_arguments(argv: list[str]) -> tuple[str, str]:
    """Accept only a pinned base image reference and a template alias."""
    if not 1 <= len(argv) <= 2:
        raise BuildError("usage: build-image.py BASE [ALIAS]")
    base, alias = argv[0], argv[1] if len(argv) == 2 else _DEFAULT_ALIAS
    if not _REMOTE_BASE.fullmatch(base) and not _FINGERPRINT.fullmatch(base):
        raise BuildError("base must be an images: reference or a cached fingerprint")
    if not _ALIAS.fullmatch(alias):
        raise BuildError("template alias must use the sandbox name grammar")
    return base, alias


def provision_script() -> str:
    """Return the fixed guest provisioning script for the documented prerequisites."""
    return f"""set -eu
if command -v dnf >/dev/null 2>&1; then
  # Only TCP 443 leaves a sandbox guest, and distribution mirrorlists hand out plain
  # HTTP mirrors, so the template pins the distribution's own HTTPS endpoints.
  sed -i -e 's|^mirrorlist=|#mirrorlist=|' -e 's|^# *baseurl=|baseurl=|' \
    -e 's|^baseurl=http://|baseurl=https://|' /etc/yum.repos.d/*.repo
  dnf -y --setopt=max_parallel_downloads=10 install {_PACKAGES}
  dnf clean all
elif command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  sed -i 's|http://|https://|g' /etc/apt/sources.list 2>/dev/null || true
  sed -i 's|http://|https://|g' /etc/apt/sources.list.d/* 2>/dev/null || true
  apt-get update
  apt-get install -y --no-install-recommends {_DEBIAN_PACKAGES}
  apt-get clean
else
  echo "base image provides neither dnf nor apt-get" >&2
  exit 65
fi
case "$(uname -m)" in
  x86_64) architecture=amd64; checksum={_GH_CHECKSUMS["amd64"]} ;;
  aarch64) architecture=arm64; checksum={_GH_CHECKSUMS["arm64"]} ;;
  *) echo "base image architecture is unsupported" >&2; exit 65 ;;
esac
release="gh_{_GH_VERSION}_linux_${{architecture}}"
curl -fsSL -o "/tmp/${{release}}.tar.gz" \
  "https://github.com/cli/cli/releases/download/v{_GH_VERSION}/${{release}}.tar.gz"
echo "${{checksum}}  /tmp/${{release}}.tar.gz" | sha256sum -c -
tar -xzf "/tmp/${{release}}.tar.gz" -C /tmp
install -m 0755 "/tmp/${{release}}/bin/gh" /usr/local/bin/gh
rm -rf "/tmp/${{release}}.tar.gz" "/tmp/${{release}}"
id sandbox >/dev/null 2>&1 || useradd -m -s /bin/bash sandbox
install -d -o sandbox -g sandbox -m 0700 /home/sandbox/.local /home/sandbox/.local/bin
printf '%s\n' 'kernel.yama.ptrace_scope=1' >/etc/sysctl.d/90-gc-sandbox-task.conf
sysctl -q -w kernel.yama.ptrace_scope=1
: >/etc/machine-id
rm -f /root/.bash_history /home/sandbox/.bash_history
"""


def launch_command(config: SandboxConfig, base: str, name: str) -> list[str]:
    """Return the fixed argv that starts the throwaway build guest."""
    return [_INCUS, "launch", base, name, "--project", config.project,
            "--profile", config.profile, "--vm", "--device", f"root,size={config.vm.disk_gib}GiB"]


def provision_command(config: SandboxConfig, name: str) -> list[str]:
    """Return the fixed argv that runs the provisioning script inside the guest."""
    return [_INCUS, "exec", name, "--project", config.project, "--", "/bin/sh", "-c", provision_script()]


def publish_command(config: SandboxConfig, name: str, alias: str) -> list[str]:
    """Return the fixed argv that publishes the stopped guest as a local image."""
    return [_INCUS, "publish", name, "--project", config.project, "--alias", alias]


def fingerprint_from(output: str) -> str:
    """Return the image fingerprint an Incus image result reports."""
    match = re.search(r"\b([0-9a-f]{64})\b", output)
    if match is None:
        raise BuildError("Incus did not report a published image fingerprint")
    return match.group(1)


def virtual_machine_image(rows: list[dict[str, object]], architecture: str) -> str:
    """Return the one virtual-machine image of this architecture the base names."""
    fingerprints = sorted({
        str(row["fingerprint"]) for row in rows
        if row.get("type") == "virtual-machine" and row.get("architecture") == architecture
    })
    if len(fingerprints) != 1:
        raise BuildError(f"base must name exactly one {architecture} virtual-machine image, "
                         f"not {len(fingerprints)}; name the variant or a fingerprint")
    return fingerprints[0]


def launch_reference(base: str, fingerprint: str, cached: bool = False) -> str:
    """Launch an already cached base directly, otherwise pull the resolved fingerprint."""
    if cached:
        return fingerprint
    remote = f"{base.split(':', 1)[0]}:" if ":" in base else ""
    return f"{remote}{fingerprint}"


def _query(config: SandboxConfig, argv: list[str],
           runner: Callable[..., subprocess.CompletedProcess[str]] | None = None) -> str:
    """Run one fixed Incus query under the query deadline and return its output."""
    return (runner or run_owned)(argv, deadline_seconds=config.deadlines.query, streams="capture").stdout


def cached_locally(config: SandboxConfig, fingerprint: str,
                   runner: Callable[..., subprocess.CompletedProcess[str]] | None = None) -> bool:
    """Report whether the resolved base already sits in this project's image store."""
    return bool(json.loads(_query(
        config, [_INCUS, "image", "list", fingerprint, "--project", config.project, "--format", "json"], runner)))


def resolve_base(config: SandboxConfig, base: str,
                 runner: Callable[..., subprocess.CompletedProcess[str]] | None = None) -> str:
    """Resolve the base reference to the immutable fingerprint the build starts from."""
    listed = _query(config, [_INCUS, "image", "list", base, "--project", config.project, "--format", "json"],
                    runner)
    return virtual_machine_image(json.loads(listed), platform.machine())


def _await_agent(config: SandboxConfig, name: str) -> None:
    """Wait for the guest agent before provisioning, rather than failing on a race.

    Each probe is bounded by whatever remains of the wait, so the outer deadline also
    ends a probe that hangs rather than waiting on it forever.
    """
    deadline = time.monotonic() + _AGENT_TIMEOUT_SECONDS
    probe = [_INCUS, "exec", name, "--project", config.project, "--", "true"]
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            if run_owned(probe, deadline_seconds=min(config.deadlines.query, remaining), streams="discard",
                         check=False).returncode == 0:
                return
        except subprocess.TimeoutExpired:
            pass
        time.sleep(min(_AGENT_RETRY_SECONDS, max(0.0, deadline - time.monotonic())))
    raise BuildError("build guest agent did not become available")


def _require_free_alias(config: SandboxConfig, alias: str) -> None:
    """Refuse to replace an existing template rather than deleting one in use."""
    listed = _query(config, [_INCUS, "image", "alias", "list", "--project", config.project, "--format", "csv"])
    if any(line.split(",")[0] == alias for line in listed.splitlines()):
        raise BuildError(f"image alias {alias} exists; remove it before rebuilding the template")


def build(config: SandboxConfig, base: str, alias: str) -> dict[str, str]:
    """Provision a throwaway guest, publish it as the template, and remove the guest."""
    _require_free_alias(config, alias)
    resolved = resolve_base(config, base)
    name = f"gc-template-build-{int(time.time())}"
    launched = launch_reference(base, resolved, cached_locally(config, resolved))
    # Build commands keep their output in front of the operator.
    run_owned(launch_command(config, launched, name), deadline_seconds=config.deadlines.launch)
    try:
        _await_agent(config, name)
        run_owned(provision_command(config, name), deadline_seconds=config.deadlines.launch)
        run_owned([_INCUS, "stop", name, "--project", config.project], deadline_seconds=config.deadlines.lifecycle)
        published = run_owned(publish_command(config, name, alias), deadline_seconds=config.deadlines.launch,
                              streams="capture")
    finally:
        run_owned([_INCUS, "delete", name, "--force", "--project", config.project],
                  deadline_seconds=config.deadlines.lifecycle, streams="discard", check=False)
    fingerprint = fingerprint_from(published.stdout)
    return {"schema": "gc.incus-sandbox.template/v1", "base": resolved,
            "fingerprint": fingerprint, "alias": alias, "image": f"local:{fingerprint}"}


def main(argv: list[str]) -> int:
    """Build the template as root, then report the value to pin in configuration."""
    if os.geteuid() != 0:
        raise BuildError("template builds need root; run this through sudo")
    base, alias = parse_arguments(argv)
    config = load_config(_CONFIG_PATH)
    result = build(config, base, alias)
    print(json.dumps(result, indent=2))
    print(f"\nPin this template in {_CONFIG_PATH}:\n  \"image\": \"{result['image']}\"", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BuildError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
