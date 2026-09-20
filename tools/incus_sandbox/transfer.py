#!/usr/bin/python3
"""Fixed root-side packet transfer for the private-repository guest workflow."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


class TransferError(RuntimeError):
    """The caller requested a transfer outside the closed boundary."""


_NAME = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
_INCUS = "/usr/bin/incus"
_BOOTSTRAP = "/usr/local/lib/gc-incus-sandbox/guest-bootstrap.py"
_GUEST_HOME = "/home/sandbox"
_MAX_PACKET_BYTES = 1024 * 1024 * 1024


def read_packet(stream: object, *, max_bytes: int = _MAX_PACKET_BYTES) -> bytes:
    """Read one bounded binary packet without accepting a host-side source path."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = stream.read(min(1024 * 1024, max_bytes - total + 1))
        if not chunk:
            break
        if not isinstance(chunk, bytes):
            raise TransferError("transfer packet is not binary")
        total += len(chunk)
        if total > max_bytes:
            raise TransferError("transfer packet exceeds the limit")
        chunks.append(chunk)
    if total == 0:
        raise TransferError("transfer packet is empty")
    return b"".join(chunks)


def transfer_commands(project: str, sandbox: str, packet_path: str) -> list[list[str]]:
    """Build only the fixed file-push and host-owned guest-bootstrap commands."""
    if not _NAME.fullmatch(sandbox):
        raise TransferError("sandbox name is invalid")
    bootstrap = f"{_GUEST_HOME}/.local/bin/gc-guest-bootstrap.py"
    packet = f"{_GUEST_HOME}/.gc-transfer/source.gcs"
    return [
        # Guest commands take an absolute guest path; a file push takes the instance-relative
        # form. Each created directory needs the owner named, which install applies per operand.
        [_INCUS, "exec", sandbox, "--project", project, "--", "/usr/bin/install", "-d",
         "-o", "sandbox", "-g", "sandbox", "-m", "0700", f"{_GUEST_HOME}/.local",
         f"{_GUEST_HOME}/.local/bin", f"{_GUEST_HOME}/.gc-transfer"],
        # The guest runs the bootstrap as the unprivileged sandbox user, so this root-owned
        # script stays readable and is never writable inside the guest.
        [_INCUS, "file", "push", _BOOTSTRAP, f"{sandbox}{bootstrap}", "--project", project,
         "--mode=0755"],
        [_INCUS, "file", "push", packet_path, f"{sandbox}{packet}", "--project", project,
         "--mode=0644"],
        [_INCUS, "exec", sandbox, "--project", project, "--", "su", "-", "sandbox", "-c",
         f"exec /usr/bin/python3 {bootstrap} {packet} {_GUEST_HOME}/workspace"],
    ]


def transfer(project: str, state_dir: Path, sandbox: str, stream: object) -> None:
    """Persist the bounded packet in root-owned state only while Incus copies it to the guest."""
    packet = read_packet(stream)
    state_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=state_dir, prefix="transfer-", suffix=".gcs", delete=False) as handle:
        handle.write(packet)
        packet_path = handle.name
    try:
        for command in transfer_commands(project, sandbox, packet_path):
            subprocess.run(command, check=True, stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        Path(packet_path).unlink(missing_ok=True)


def audited_transfer(config: object, sandbox: str, stream: object, kind: str) -> None:
    """Write a bounded lifecycle result without retaining source-packet contents."""
    if kind not in {"clone", "bundle"}:
        raise TransferError("source kind is invalid")
    from events import EventWriter
    events = EventWriter(config.event_log, config.event_max_bytes)
    events.ensure_available()
    try:
        transfer(config.project, config.state_dir, sandbox, stream)
        events.write({"action": "transfer", "outcome": "success", "sandbox_id": sandbox})
    except Exception:
        events.write({"action": "transfer", "outcome": "failure", "sandbox_id": sandbox,
                      "error_code": "command_failed"})
        raise


def main(argv: list[str]) -> int:
    """Authenticate the operator then perform the only supported packet transfer."""
    if os.geteuid() != 0 or len(argv) != 2:
        raise TransferError("usage: transfer.py SANDBOX {clone|bundle}")
    sudo_uid = os.environ.get("SUDO_UID")
    if sudo_uid is None or not sudo_uid.isdecimal():
        raise TransferError("transfer requires the calling operator identity")
    from config import load_config
    config = load_config(Path("/etc/gc-incus-sandbox/config.json"))
    if int(sudo_uid) != config.operator_uid:
        raise TransferError("caller is not the configured sandbox operator")
    try:
        audited_transfer(config, argv[0], sys.stdin.buffer, argv[1])
    except subprocess.CalledProcessError as exc:
        # Guest output never reaches the host, so name the guest-local log instead of
        # reporting a host command the operator cannot act on.
        raise TransferError("guest preparation failed; read ~/.gc-transfer/bootstrap.log in the guest") from exc
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except TransferError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
