#!/usr/bin/python3
"""Materialize one validated source packet wholly inside an Incus guest."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


class PacketError(RuntimeError):
    """The transferred source packet is outside the closed guest contract."""


_COMMIT = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_REPOSITORY = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$")
_HEADER_BYTES = 8
_MAX_METADATA_BYTES = 4096
_GUEST_HOME = Path("/home/sandbox")
_PACKET_PATH = _GUEST_HOME / ".gc-transfer/source.gcs"
_WORKSPACE_PATH = _GUEST_HOME / "workspace"
_BUNDLE_PATH = _GUEST_HOME / ".gc-transfer/source.bundle"


def _packet_metadata(packet: bytes) -> tuple[dict[str, object], int]:
    """Decode the fixed binary envelope before validating its declared source."""
    if len(packet) < _HEADER_BYTES or packet[:4] != b"GCS1":
        raise PacketError("source packet header is invalid")
    metadata_length = int.from_bytes(packet[4:8], "big")
    if not 2 <= metadata_length <= _MAX_METADATA_BYTES:
        raise PacketError("source packet metadata is invalid")
    if len(packet) < _HEADER_BYTES + metadata_length:
        raise PacketError("source packet metadata is invalid")
    try:
        metadata = json.loads(packet[8:8 + metadata_length].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PacketError("source packet metadata is invalid") from exc
    if not isinstance(metadata, dict) or metadata.get("schema") != "gc.incus-sandbox.source/v1":
        raise PacketError("source packet schema is invalid")
    return metadata, metadata_length


def _source_identity(metadata: dict[str, object]) -> tuple[str, str]:
    """Return the closed source kind and immutable commit identity."""
    kind, commit = metadata.get("kind"), metadata.get("commit")
    if kind not in {"clone", "bundle"}:
        raise PacketError("source packet kind is invalid")
    if not isinstance(commit, str) or not _COMMIT.fullmatch(commit):
        raise PacketError("source packet commit is invalid")
    return kind, commit


def _clone_repository(metadata: dict[str, object], kind: str) -> str | None:
    """Return a safe clone remote and reject repository fields for bundles."""
    if kind == "bundle":
        return None
    repository = metadata.get("repository")
    if not isinstance(repository, str) or not _REPOSITORY.fullmatch(repository):
        raise PacketError("source packet repository is invalid")
    return repository


def _validated_source(metadata: dict[str, object], payload: bytes) -> dict[str, str]:
    """Validate source identity and the closed fields allowed for each transfer kind."""
    kind, commit = _source_identity(metadata)
    expected = {"schema", "kind", "commit", "repository"}
    if kind == "bundle":
        expected = {"schema", "kind", "commit"}
    if set(metadata) != expected:
        raise PacketError("source packet fields are invalid")
    repository = _clone_repository(metadata, kind)
    if kind == "bundle" and not payload:
        raise PacketError("source packet bundle is empty")
    validated = {"schema": "gc.incus-sandbox.source/v1", "kind": kind, "commit": commit}
    if repository is not None:
        validated["repository"] = repository
    return validated


def _copy_bundle_payload(offset: int) -> None:
    """Copy bundle bytes from the fixed packet file into a fixed guest-only path."""
    try:
        with _PACKET_PATH.open("rb") as source, _BUNDLE_PATH.open("xb") as bundle:
            source.seek(offset)
            shutil.copyfileobj(source, bundle)
        _BUNDLE_PATH.chmod(0o600)
    except Exception:
        _BUNDLE_PATH.unlink(missing_ok=True)
        raise


def _validated_packet(packet: bytes) -> tuple[dict[str, str], int]:
    """Return a validated source and the byte where its bundle begins."""
    metadata, metadata_length = _packet_metadata(packet)
    bundle_offset = _HEADER_BYTES + metadata_length
    return _validated_source(metadata, packet[bundle_offset:]), bundle_offset


def parse_packet(packet: bytes) -> dict[str, str]:
    """Validate the fixed packet envelope without accepting a host path or credential."""
    return _validated_packet(packet)[0]


def checkout_commands(metadata: dict[str, str], workspace: Path, bundle_path: Path) -> list[list[str]]:
    """Construct guest-only Git argv for the validated immutable source identity."""
    clone = ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]
    clone += ["clone", "--no-checkout", "--"]
    source = metadata["repository"] if metadata["kind"] == "clone" else str(bundle_path)
    checkout = ["/usr/bin/git", "-C", str(workspace), "checkout", "--detach", metadata["commit"]]
    return [clone + [source, str(workspace)], checkout]


def guest_environment(base: dict[str, str] | None = None) -> dict[str, str]:
    """Reject inherited host endpoints and API credentials before guest tooling starts."""
    environment = dict(os.environ if base is None else base)
    for forbidden in ("DOCKER_HOST", "OPENAI_API_KEY", "CODEX_HOME", "GH_TOKEN", "GITHUB_TOKEN"):
        environment.pop(forbidden, None)
    return environment


def materialize() -> None:
    """Create a guest checkout and install guest-local CLI dependencies."""
    packet = _PACKET_PATH.read_bytes()
    metadata, bundle_offset = _validated_packet(packet)
    environment = guest_environment()
    local_prefix = Path.home() / ".local"
    environment["NPM_CONFIG_PREFIX"] = str(local_prefix)
    environment["PATH"] = f"{local_prefix / 'bin'}:{environment.get('PATH', '')}"
    _WORKSPACE_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if _WORKSPACE_PATH.exists():
        raise PacketError("guest workspace already exists")
    bundle_copied = False
    try:
        if metadata["kind"] == "bundle":
            _copy_bundle_payload(bundle_offset)
            bundle_copied = True
        for command in checkout_commands(metadata, _WORKSPACE_PATH, _BUNDLE_PATH):
            subprocess.run(command, check=True, env=environment)
        install = ["/usr/bin/npm", "install", "--global", "@openai/codex", "grndctl"]
        subprocess.run(install, check=True, env=environment)
        skills = [str(local_prefix / "bin/grndctl"), "install-skills"]
        subprocess.run(skills, check=True, cwd=_WORKSPACE_PATH, env=environment)
    finally:
        if bundle_copied:
            _BUNDLE_PATH.unlink(missing_ok=True)


def main(argv: list[str]) -> int:
    """Run the fixed guest bootstrap entry point."""
    expected = [str(_PACKET_PATH), str(_WORKSPACE_PATH)]
    if argv != expected:
        raise PacketError("usage: guest-bootstrap.py PACKET WORKSPACE")
    materialize()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except PacketError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
