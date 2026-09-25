"""Harmless reachability canaries for an already-created sandbox VM."""

from __future__ import annotations

import ipaddress
import re
import subprocess
import sys

from pathlib import Path

if __package__:
    from .config import load_config
    from .owned_process import run_owned
else:
    from config import load_config
    from owned_process import run_owned


_NAME = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
METADATA_CANARY = str(ipaddress.IPv4Address(0xA9FEA9FE))
PRIVATE_CANARY = str(ipaddress.IPv4Address(0x0A4A0002))
# A public resolver address, outside the host, so the verdict reflects the sandbox
# firewall rather than the guest's own loopback stack.
IPV6_CANARY = str(ipaddress.IPv6Address(0x26064700470000000000000000001111))
_PROJECT = "gc-sandbox"
_CONFIG_PATH = Path("/etc/gc-incus-sandbox/config.json")


def _name(value: str) -> str:
    """Validate a sandbox name before embedding it in fixed Incus argv."""
    if not _NAME.fullmatch(value):
        raise ValueError("sandbox names must use the closed lifecycle name grammar")
    return value


def _ipv4(value: str) -> str:
    """Validate the setup-provided host address used by the probe."""
    parsed = ipaddress.ip_address(value)
    if parsed.version != 4:
        raise ValueError("host canary must be IPv4")
    return value


def sibling_address_command(sibling: str) -> list[str]:
    """Return the fixed Incus argv that reports a sibling guest's bridge address."""
    return ["incus", "list", _name(sibling), "--project", _PROJECT, "--format", "csv", "-c", "4"]


def sibling_address(output: str) -> str:
    """Return the sibling's IPv4 address, refusing a guest that reports none."""
    address = output.strip().split(" ")[0].strip('"')
    if not address:
        raise ValueError("sibling sandbox reports no address to probe")
    return _ipv4(address)


def boundary_probe_commands(sandbox: str, host_address: str, sibling: str) -> list[list[str]]:
    """Return fixed guest probes; there is no caller-controlled guest command."""
    sandbox, host_address, sibling = _name(sandbox), _ipv4(host_address), _ipv4(sibling)
    targets = [METADATA_CANARY, host_address, PRIVATE_CANARY, sibling, IPV6_CANARY]
    shell = "reachable=0; for target in " + " ".join(targets)
    command = shell + "; do if timeout 3 ping -c 1 -W 1 \"$target\"; then reachable=1; fi; done; exit \"$reachable\""
    return [["incus", "exec", sandbox, "--project", _PROJECT, "--", "/bin/sh", "-c", command]]


def main(argv: list[str]) -> int:
    """Run the closed guest network-boundary probe and return its verdict."""
    if len(argv) != 3:
        raise ValueError("usage: probe.py SANDBOX HOST_IPV4 SIBLING")
    sandbox, host_address, sibling = argv
    # The sibling's own address is the meaningful guest-to-guest canary, and reading it
    # also proves the sibling exists.
    # The probe runs as root; its deadline is the root-owned query policy, never an argument.
    deadline = load_config(_CONFIG_PATH).deadlines.query
    listed = run_owned(sibling_address_command(sibling), deadline_seconds=deadline, streams="capture")
    commands = boundary_probe_commands(sandbox, host_address, sibling_address(listed.stdout))
    # The guest exits non-zero when any prohibited target answered, and a probe that
    # could not run at all, or did not finish, is a failed boundary check rather than a pass.
    try:
        result = run_owned(commands[0], deadline_seconds=deadline, check=False)
    except subprocess.TimeoutExpired:
        return 1
    return 0 if result.returncode == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
