"""Harmless reachability canaries for an already-created sandbox VM."""

from __future__ import annotations

import ipaddress
import re
import subprocess
import sys


_NAME = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
METADATA_CANARY = "169.254.169.254"
PRIVATE_CANARY = "10.74.0.2"


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


def boundary_probe_commands(sandbox: str, host_address: str, sibling: str) -> list[list[str]]:
    """Return fixed guest probes; there is no caller-controlled guest command."""
    sandbox, sibling, host_address = _name(sandbox), _name(sibling), _ipv4(host_address)
    targets = [METADATA_CANARY, host_address, PRIVATE_CANARY, "::1"]
    shell = "reachable=0; for target in " + " ".join(targets)
    command = shell + "; do if timeout 3 ping -c 1 -W 1 \"$target\"; then reachable=1; fi; done; exit \"$reachable\""
    return [["incus", "exec", sandbox, "--project", "gc-sandbox", "--", "/bin/sh", "-c", command],
            ["incus", "exec", sibling, "--project", "gc-sandbox", "--", "true"]]


def main(argv: list[str]) -> int:
    """Run the closed guest network-boundary probe and return its verdict."""
    if len(argv) != 3:
        raise ValueError("usage: probe.py SANDBOX HOST_IPV4 SIBLING")
    commands = boundary_probe_commands(*argv)
    result = subprocess.run(commands[0], check=False)
    # The sibling check proves the VM exists while the private canary must fail.
    subprocess.run(commands[1], check=True)
    return 0 if result.returncode != 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
