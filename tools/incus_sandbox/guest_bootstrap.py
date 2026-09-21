#!/usr/bin/python3
"""Materialize one validated source packet wholly inside an Incus guest."""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

if __package__:
    from .migration import MigrationError, restore_migration
else:
    from migration import MigrationError, restore_migration


class PacketError(RuntimeError):
    """The transferred source packet is outside the closed guest contract."""


_COMMIT = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_REPOSITORY = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$")
_HEADER_BYTES = 8
_MAX_METADATA_BYTES = 4096
_INVALID_METADATA = "source packet metadata is invalid"
_GUEST_HOME = Path("/home/sandbox")
_PACKET_PATH = _GUEST_HOME / ".gc-transfer/source.gcs"
_WORKSPACE_PATH = _GUEST_HOME / "workspace"
_BUNDLE_PATH = _GUEST_HOME / ".gc-transfer/source.bundle"
_LOG_PATH = _GUEST_HOME / ".gc-transfer/bootstrap.log"
_NPMRC_PATH = _GUEST_HOME / ".npmrc"
_GIT = "/usr/bin/git"
_REQUIRED_TOOLS = (_GIT, "/usr/bin/npm")


def _packet_metadata(packet: bytes) -> tuple[dict[str, object], int]:
    """Decode the fixed binary envelope before validating its declared source."""
    if len(packet) < _HEADER_BYTES or packet[:4] != b"GCS1":
        raise PacketError("source packet header is invalid")
    metadata_length = int.from_bytes(packet[4:8], "big")
    if not 2 <= metadata_length <= _MAX_METADATA_BYTES:
        raise PacketError(_INVALID_METADATA)
    if len(packet) < _HEADER_BYTES + metadata_length:
        raise PacketError(_INVALID_METADATA)
    try:
        metadata = json.loads(packet[8:8 + metadata_length].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PacketError(_INVALID_METADATA) from exc
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
    _BUNDLE_PATH.unlink(missing_ok=True)
    bundle = _BUNDLE_PATH.open("xb")
    try:
        with bundle, _PACKET_PATH.open("rb") as source:
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
    clone = [_GIT, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]
    clone += ["clone", "--no-checkout", "--"]
    bundle = metadata["kind"] == "bundle"
    source = str(bundle_path) if bundle else metadata["repository"]
    commands = [clone + [source, str(workspace)],
                [_GIT, "-C", str(workspace), "checkout", "--detach", metadata["commit"]]]
    if bundle:
        # The bundle is removed once its objects are in the workspace, so keeping its
        # remote would leave the guest with an origin that cannot fetch or push.
        commands.append([_GIT, "-C", str(workspace), "remote", "remove", "origin"])
    return commands


def guest_environment(base: dict[str, str] | None = None) -> dict[str, str]:
    """Reject inherited host endpoints and API credentials before guest tooling starts."""
    environment = dict(os.environ if base is None else base)
    for forbidden in ("DOCKER_HOST", "OPENAI_API_KEY", "CODEX_HOME", "GH_TOKEN", "GITHUB_TOKEN"):
        environment.pop(forbidden, None)
    environment["GIT_TERMINAL_PROMPT"] = "0"
    return environment


def log(message: str) -> None:
    """Record one bootstrap step in the guest, where the private source already lives."""
    with _LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"{message}\n")


def run_guest_command(command: list[str], environment: dict[str, str], cwd: Path | None = None) -> None:
    """Run one fixed guest command, keeping its output in the guest-local log."""
    log(f"$ {' '.join(command)}")
    with _LOG_PATH.open("a", encoding="utf-8") as handle:
        subprocess.run(command, check=True, env=environment, cwd=cwd, stdout=handle, stderr=handle)


def require_guest_tools() -> None:
    """Name a missing template prerequisite instead of failing inside a fixed command."""
    missing = [tool for tool in _REQUIRED_TOOLS if not os.access(tool, os.X_OK)]
    if missing:
        raise PacketError(f"guest image is missing {', '.join(missing)}")


def guest_tool_prefix(local_prefix: Path) -> None:
    """Point the guest session's global installs at the sandbox user's own prefix."""
    if _NPMRC_PATH.exists():
        return
    local_prefix.mkdir(mode=0o700, parents=True, exist_ok=True)
    _NPMRC_PATH.write_text(f"prefix={local_prefix}\n", encoding="utf-8")
    _NPMRC_PATH.chmod(0o600)


def prepared_workspace(commit: str) -> bool:
    """Report whether an earlier run already checked out this exact immutable source."""
    if not _WORKSPACE_PATH.exists():
        return False
    head = subprocess.run([_GIT, "-C", str(_WORKSPACE_PATH), "rev-parse", "--verify", "HEAD"],
                          check=False, capture_output=True, text=True)
    if head.stdout.strip() != commit:
        raise PacketError("guest workspace holds a different source; remove ~/workspace in the guest")
    return True


def _checkout(metadata: dict[str, str], bundle_offset: int, environment: dict[str, str]) -> None:
    """Materialize the validated source into the fixed guest workspace exactly once."""
    bundle = metadata["kind"] == "bundle"
    try:
        if bundle:
            _copy_bundle_payload(bundle_offset)
        for command in checkout_commands(metadata, _WORKSPACE_PATH, _BUNDLE_PATH):
            run_guest_command(command, environment)
    finally:
        if bundle:
            _BUNDLE_PATH.unlink(missing_ok=True)


def materialize(sandbox: str = "sandbox") -> None:
    """Create a guest checkout and prepare the sandbox user's local tool prefix."""
    packet = _PACKET_PATH.read_bytes()
    if len(packet) >= _HEADER_BYTES and packet[:4] == b"GCS1":
        metadata_length = int.from_bytes(packet[4:8], "big")
        if 2 <= metadata_length <= 8 * 1024 * 1024 and len(packet) >= _HEADER_BYTES + metadata_length:
            try:
                envelope = json.loads(packet[8:8 + metadata_length].decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                envelope = None
            if isinstance(envelope, dict) and envelope.get("schema") == "gc.incus-sandbox.migration/v1":
                require_guest_tools()
                restore_migration(packet, _WORKSPACE_PATH, _PACKET_PATH.parent, sandbox)
                guest_tool_prefix(Path.home() / ".local")
                _PACKET_PATH.unlink(missing_ok=True)
                return
    metadata, bundle_offset = _validated_packet(packet)
    require_guest_tools()
    if not prepared_workspace(metadata["commit"]):
        _checkout(metadata, bundle_offset, guest_environment())
    # Tools and credentials are installed by the operator in the guest session. A
    # transfer does not fetch and run a moving network package beside private source.
    guest_tool_prefix(Path.home() / ".local")
    _PACKET_PATH.unlink(missing_ok=True)


def main(argv: list[str]) -> int:
    """Run the fixed guest bootstrap entry point."""
    if (len(argv) != 3 or argv[0] != str(_PACKET_PATH) or argv[1] != str(_WORKSPACE_PATH)
            or not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", argv[2])):
        raise PacketError("usage: guest-bootstrap.py PACKET WORKSPACE SANDBOX")
    materialize(argv[2])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (PacketError, MigrationError, subprocess.CalledProcessError) as exc:
        # The host deliberately discards guest output, so the operator reads the reason
        # from the guest-local log after attaching.
        with contextlib.suppress(OSError):
            log(f"bootstrap failed: {exc}")
        print(str(exc), file=sys.stderr)
        raise SystemExit(64)
