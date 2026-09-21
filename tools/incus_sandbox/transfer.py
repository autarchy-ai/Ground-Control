#!/usr/bin/python3
"""Fixed root-side packet transfer for the private-repository guest workflow."""

from __future__ import annotations

import io
import json
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
_MIGRATION = "/usr/local/lib/gc-incus-sandbox/migration.py"
_MIGRATION_PACKET = "/usr/local/lib/gc-incus-sandbox/migration_packet.py"
_GUEST_HOME = "/home/sandbox"
_PRIVATE_FILE_MODE = "--mode=0644"
_MAX_PACKET_BYTES = 1024 * 1024 * 1024
_MAX_METADATA_BYTES = 8 * 1024 * 1024


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


def _packet_kind(packet: bytes) -> str:
    """Return the transfer kind bound to the packet's validated outer schema."""
    if len(packet) < 8 or packet[:4] != b"GCS1":
        raise TransferError("transfer packet header is invalid")
    length = int.from_bytes(packet[4:8], "big")
    if not 2 <= length <= _MAX_METADATA_BYTES or len(packet) < 8 + length:
        raise TransferError("transfer packet metadata is invalid")
    try:
        metadata = json.loads(packet[8:8 + length].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TransferError("transfer packet metadata is invalid") from exc
    if not isinstance(metadata, dict):
        raise TransferError("transfer packet schema is invalid")
    if metadata.get("schema") == "gc.incus-sandbox.migration/v1":
        return "migration"
    if metadata.get("schema") == "gc.incus-sandbox.source/v1" and metadata.get("kind") in {"clone", "bundle"}:
        return str(metadata["kind"])
    raise TransferError("transfer packet schema is invalid")


def _migration_dependencies() -> tuple[type, object, object]:
    """Load migration-only helpers in package and installed-script modes."""
    if __package__:
        from .helper import LifecycleHelper
        from .migration import MigrationError, parse_migration_packet
    else:
        from helper import LifecycleHelper
        from migration import MigrationError, parse_migration_packet
    return LifecycleHelper, MigrationError, parse_migration_packet


def _within_migration_limits(metadata: dict[str, object], migration: object) -> bool:
    """Whether validated packet content fits the stricter root-owned limits."""
    entries = metadata["entries"]
    sections = metadata["sections"]
    assert isinstance(entries, dict) and isinstance(sections, list)
    count = sum(len(entries[role]) for role in ("index", "worktree", "untracked"))
    file_lengths = [
        section["length"] for section in sections
        if section["role"] in {"index", "worktree", "untracked"}
    ]
    handoff_index = metadata["handoff_section"]
    assert isinstance(handoff_index, int)
    handoff_length = sections[handoff_index]["length"]
    return (
        count <= migration.max_file_count
        and all(length <= migration.max_file_bytes for length in file_lengths)
        and handoff_length <= migration.max_handoff_bytes
    )


def _migration_limit(config: object, sandbox: str, packet: bytes,
                     events: object, caller_uid: int | None) -> int:
    """Authorize and validate a migration packet, returning its root-owned byte limit."""
    migration = getattr(config, "migration", None)
    if migration is None:
        raise TransferError("dirty migration requires gc.incus-sandbox/v2 root-owned limits")
    if caller_uid is None:
        raise TransferError("migration transfer requires the calling operator identity")
    lifecycle_helper, migration_error, parse_packet = _migration_dependencies()
    try:
        lifecycle_helper(config, event_writer=events, caller_uid=caller_uid).require_active_owner(sandbox)
    except Exception as exc:
        raise TransferError("migration target is not an active isolated sandbox") from exc
    try:
        metadata, _ = parse_packet(packet)
    except migration_error as exc:
        raise TransferError("migration packet validation failed") from exc
    if not _within_migration_limits(metadata, migration):
        raise TransferError("migration packet exceeds root-owned limits")
    return migration.max_packet_bytes


def transfer_commands(project: str, sandbox: str, packet_path: str) -> list[list[str]]:
    """Build only the fixed file-push and host-owned guest-bootstrap commands."""
    if not _NAME.fullmatch(sandbox):
        raise TransferError("sandbox name is invalid")
    bootstrap = f"{_GUEST_HOME}/.local/bin/gc-guest-bootstrap.py"
    migration = f"{_GUEST_HOME}/.local/bin/migration.py"
    migration_packet = f"{_GUEST_HOME}/.local/bin/migration_packet.py"
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
        [_INCUS, "file", "push", _MIGRATION, f"{sandbox}{migration}", "--project", project,
         _PRIVATE_FILE_MODE],
        [_INCUS, "file", "push", _MIGRATION_PACKET, f"{sandbox}{migration_packet}", "--project", project,
         _PRIVATE_FILE_MODE],
        [_INCUS, "file", "push", packet_path, f"{sandbox}{packet}", "--project", project,
         _PRIVATE_FILE_MODE],
        [_INCUS, "exec", sandbox, "--project", project, "--", "su", "-", "sandbox", "-c",
         f"exec /usr/bin/python3 {bootstrap} {packet} {_GUEST_HOME}/workspace {sandbox}"],
    ]


def transfer(project: str, state_dir: Path, sandbox: str, stream: object,
             *, max_bytes: int = _MAX_PACKET_BYTES) -> None:
    """Persist the bounded packet in root-owned state only while Incus copies it to the guest."""
    packet = read_packet(stream, max_bytes=max_bytes)
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


def audited_transfer(config: object, sandbox: str, stream: object, kind: str,
                     *, caller_uid: int | None = None) -> None:
    """Write a bounded lifecycle result without retaining source-packet contents."""
    if kind not in {"clone", "bundle", "migration"}:
        raise TransferError("source kind is invalid")
    from events import EventWriter
    events = EventWriter(config.event_log, config.event_max_bytes)
    events.ensure_available()
    try:
        packet = read_packet(stream)
        actual_kind = _packet_kind(packet)
        if actual_kind != kind:
            raise TransferError("transfer kind does not match packet schema")
        max_bytes = (_migration_limit(config, sandbox, packet, events, caller_uid)
                     if actual_kind == "migration" else _MAX_PACKET_BYTES)
        transfer(config.project, config.state_dir, sandbox, io.BytesIO(packet),
                 max_bytes=max_bytes)
        events.write({"action": "transfer", "outcome": "success", "sandbox_id": sandbox})
    except Exception:
        events.write({"action": "transfer", "outcome": "failure", "sandbox_id": sandbox,
                      "error_code": "command_failed"})
        raise


def main(argv: list[str]) -> int:
    """Authenticate the operator then perform the only supported packet transfer."""
    if os.geteuid() != 0 or len(argv) != 2:
        raise TransferError("usage: transfer.py SANDBOX {clone|bundle|migration}")
    sudo_uid = os.environ.get("SUDO_UID")
    if sudo_uid is None or not sudo_uid.isdecimal():
        raise TransferError("transfer requires the calling operator identity")
    from config import load_config
    config = load_config(Path("/etc/gc-incus-sandbox/config.json"))
    if int(sudo_uid) != config.operator_uid:
        raise TransferError("caller is not the configured sandbox operator")
    try:
        audited_transfer(config, argv[0], sys.stdin.buffer, argv[1], caller_uid=int(sudo_uid))
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
