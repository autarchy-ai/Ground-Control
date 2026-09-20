#!/usr/bin/python3
"""Materialize one validated source packet wholly inside an Incus guest."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


class PacketError(RuntimeError):
    """The transferred source packet is outside the closed guest contract."""


_COMMIT = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_REPOSITORY = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$")
_HEADER_BYTES = 8
_MAX_METADATA_BYTES = 4096


def parse_packet(packet: bytes) -> dict[str, str]:
    """Validate the fixed packet envelope without accepting a host path or credential."""
    if len(packet) < _HEADER_BYTES or packet[:4] != b"GCS1":
        raise PacketError("source packet header is invalid")
    metadata_length = int.from_bytes(packet[4:8], "big")
    if not 2 <= metadata_length <= _MAX_METADATA_BYTES or len(packet) < _HEADER_BYTES + metadata_length:
        raise PacketError("source packet metadata is invalid")
    try:
        metadata = json.loads(packet[8:8 + metadata_length].decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise PacketError("source packet metadata is invalid") from exc
    if not isinstance(metadata, dict) or metadata.get("schema") != "gc.incus-sandbox.source/v1":
        raise PacketError("source packet schema is invalid")
    kind, commit = metadata.get("kind"), metadata.get("commit")
    if kind not in {"clone", "bundle"} or not isinstance(commit, str) or not _COMMIT.fullmatch(commit):
        raise PacketError("source packet source identity is invalid")
    expected = {"schema", "kind", "commit", "repository"} if kind == "clone" else {"schema", "kind", "commit"}
    if set(metadata) != expected:
        raise PacketError("source packet fields are invalid")
    if kind == "clone" and (not isinstance(metadata["repository"], str) or not _REPOSITORY.fullmatch(metadata["repository"])):
        raise PacketError("source packet repository is invalid")
    if kind == "bundle" and not packet[_HEADER_BYTES + metadata_length:]:
        raise PacketError("source packet bundle is empty")
    return metadata


def packet_payload(packet: bytes) -> bytes:
    """Return bundle objects after packet validation has established their offset."""
    metadata_length = int.from_bytes(packet[4:8], "big")
    return packet[_HEADER_BYTES + metadata_length:]


def checkout_commands(metadata: dict[str, str], workspace: Path, bundle_path: Path) -> list[list[str]]:
    """Construct guest-only Git argv for the validated immutable source identity."""
    clone = ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "clone", "--no-checkout", "--"]
    source = metadata["repository"] if metadata["kind"] == "clone" else str(bundle_path)
    return [clone + [source, str(workspace)], ["/usr/bin/git", "-C", str(workspace), "checkout", "--detach", metadata["commit"]]]


def guest_environment(base: dict[str, str] | None = None) -> dict[str, str]:
    """Reject inherited host endpoints and API credentials before guest tooling starts."""
    environment = dict(os.environ if base is None else base)
    for forbidden in ("DOCKER_HOST", "OPENAI_API_KEY", "CODEX_HOME", "GH_TOKEN", "GITHUB_TOKEN"):
        environment.pop(forbidden, None)
    return environment


def materialize(packet_path: Path, workspace: Path) -> None:
    """Create a guest checkout and install guest-local CLI dependencies."""
    packet = packet_path.read_bytes()
    metadata = parse_packet(packet)
    environment = guest_environment()
    local_prefix = Path.home() / ".local"
    environment["NPM_CONFIG_PREFIX"] = str(local_prefix)
    environment["PATH"] = f"{local_prefix / 'bin'}:{environment.get('PATH', '')}"
    workspace.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if workspace.exists():
        raise PacketError("guest workspace already exists")
    bundle_path = workspace.parent / ".source.bundle"
    try:
        if metadata["kind"] == "bundle":
            bundle_path.write_bytes(packet_payload(packet))
            bundle_path.chmod(0o600)
        for command in checkout_commands(metadata, workspace, bundle_path):
            subprocess.run(command, check=True, env=environment)
        subprocess.run(["/usr/bin/npm", "install", "--global", "@openai/codex", "grndctl"], check=True, env=environment)
        subprocess.run([str(local_prefix / "bin/grndctl"), "install-skills"], check=True, cwd=workspace, env=environment)
    finally:
        bundle_path.unlink(missing_ok=True)


def main(argv: list[str]) -> int:
    """Run the fixed guest bootstrap entry point."""
    if len(argv) != 2:
        raise PacketError("usage: guest-bootstrap.py PACKET WORKSPACE")
    materialize(Path(argv[0]), Path(argv[1]))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except PacketError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
