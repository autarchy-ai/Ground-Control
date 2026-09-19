"""Harmless reachability canaries for an already-created sandbox VM."""

from __future__ import annotations

import ipaddress
import re
import subprocess
import sys


_NAME = re.compile(r"^[a-z][a-z0-9-]{0,47}$")


def _name(value: str) -> str:
    if not _NAME.fullmatch(value):
        raise ValueError("sandbox names must use the closed lifecycle name grammar")
    return value


def _ipv4(value: str) -> str:
    parsed = ipaddress.ip_address(value)
    if parsed.version != 4:
        raise ValueError("host canary must be IPv4")
    return value


def boundary_probe_commands(sandbox: str, host_address: str, sibling: str) -> list[list[str]]:
    """Return fixed guest probes; there is no caller-controlled guest command."""
    sandbox, sibling, host_address = _name(sandbox), _name(sibling), _ipv4(host_address)
    targets = ["169.254.169.254", host_address, "10.74.0.2", "::1"]
    command = "reachable=0; for target in " + " ".join(targets) + "; do if timeout 3 ping -c 1 -W 1 \"$target\"; then reachable=1; fi; done; exit \"$reachable\""
    return [["incus", "exec", sandbox, "--project", "gc-sandbox", "--", "/bin/sh", "-c", command],
            ["incus", "exec", sibling, "--project", "gc-sandbox", "--", "true"]]


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        raise ValueError("usage: probe.py SANDBOX HOST_IPV4 SIBLING")
    commands = boundary_probe_commands(*argv)
    result = subprocess.run(commands[0], check=False)
    # The second command only proves the sibling exists; the fixed 10.74.0.2
    # canary in the first command must remain unreachable for a passing probe.
    subprocess.run(commands[1], check=True)
    return 0 if result.returncode != 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
