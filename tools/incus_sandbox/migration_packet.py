"""Validate the closed dirty-work migration packet format."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import PurePosixPath
from typing import Any


class MigrationError(RuntimeError):
    """The migration packet or destination is outside the closed contract."""


_SCHEMA = "gc.incus-sandbox.migration/v1"
_COMMIT = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_MIGRATION_ID = re.compile(r"^[0-9a-f]{32}$")
_MODES = {"100644", "100755", "120000"}
_ROLES = {"bundle", "index", "worktree", "untracked", "handoff"}
_MAX_METADATA_BYTES = 8 * 1024 * 1024
_MAX_PACKET_BYTES = 1024 * 1024 * 1024
_MAX_FILE_COUNT = 2048
_MAX_FILE_BYTES = 64 * 1024 * 1024
_MAX_HANDOFF_BYTES = 64 * 1024


def canonical_json(value: object) -> bytes:
    """Encode one value with the packet's cross-language canonical JSON form."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def safe_path(value: object) -> str:
    """Return a normalized checkout-relative path or reject it."""
    if not isinstance(value, str) or not value or "\0" in value or "\\" in value:
        raise MigrationError("migration path is invalid")
    path = PurePosixPath(value)
    if path.is_absolute() or value != path.as_posix() or any(part in {"", ".", "..", ".git"} for part in path.parts):
        raise MigrationError("migration path escapes the checkout")
    return value


def _section_role(raw: object) -> tuple[dict[str, object], object]:
    """Validate a section's closed field set and return its declared role."""
    if not isinstance(raw, dict):
        raise MigrationError("migration section is invalid")
    role = raw.get("role")
    expected = {"role", "offset", "length", "sha256"}
    if role in {"index", "worktree", "untracked"}:
        expected |= {"path", "mode"}
    if set(raw) != expected or role not in _ROLES:
        raise MigrationError("migration section fields are invalid")
    return raw, role


def _section_bounds(raw: dict[str, object], role: object, cursor: int) -> tuple[int, int, str]:
    """Validate one section's contiguous, bounded byte range and digest."""
    offset, length, digest = raw.get("offset"), raw.get("length"), raw.get("sha256")
    max_length = _MAX_PACKET_BYTES if role == "bundle" else _MAX_FILE_BYTES
    if not isinstance(offset, int) or not isinstance(length, int):
        raise MigrationError("migration section bounds are invalid")
    if offset != cursor or not 0 <= length <= max_length:
        raise MigrationError("migration section bounds are invalid")
    if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
        raise MigrationError("migration section bounds are invalid")
    return offset, length, digest


def _validate_section_fields(raw: dict[str, object], role: object, length: int) -> None:
    """Validate role-specific section limits and file identity fields."""
    if role == "handoff" and length > _MAX_HANDOFF_BYTES:
        raise MigrationError("migration handoff exceeds the limit")
    if role not in {"index", "worktree", "untracked"}:
        return
    safe_path(raw.get("path"))
    if raw.get("mode") not in _MODES:
        raise MigrationError("migration file mode is invalid")


def _validated_section(raw: object, payload: bytes, cursor: int) -> tuple[dict[str, object], int]:
    """Validate one contiguous packet section and return its next offset."""
    section, role = _section_role(raw)
    offset, length, digest = _section_bounds(section, role, cursor)
    _validate_section_fields(section, role, length)
    content = payload[offset:offset + length]
    if len(content) != length or hashlib.sha256(content).hexdigest() != digest:
        raise MigrationError("migration section integrity check failed")
    return section, cursor + length


def _validate_sections(raw: object, payload: bytes) -> list[dict[str, object]]:
    """Validate the closed, contiguous section table."""
    if not isinstance(raw, list) or not 2 <= len(raw) <= _MAX_FILE_COUNT + 2:
        raise MigrationError("migration section count is invalid")
    sections: list[dict[str, object]] = []
    cursor = 0
    for candidate in raw:
        section, cursor = _validated_section(candidate, payload, cursor)
        sections.append(section)
    if cursor != len(payload):
        raise MigrationError("migration payload has unclaimed bytes")
    roles = [section["role"] for section in sections]
    if roles.count("bundle") != 1:
        raise MigrationError("migration packet requires one bundle")
    if roles.count("handoff") != 1:
        raise MigrationError("migration packet requires one handoff")
    return sections


def _entry_identity(item: object, role: str, previous: str) -> tuple[dict[str, object], str, bool]:
    """Validate one entry's closed fields, safe path, order, and deletion state."""
    if not isinstance(item, dict):
        raise MigrationError("migration entry is invalid")
    path = safe_path(item.get("path"))
    if path <= previous:
        raise MigrationError("migration entries must be unique and sorted")
    deleted = item.get("deleted") is True
    expected = {"path", "deleted"} if deleted else {"path", "mode", "section"}
    if set(item) != expected:
        raise MigrationError("migration entry fields are invalid")
    if deleted:
        if role == "untracked":
            raise MigrationError("an untracked entry cannot be deleted")
    return item, path, deleted


def _validate_entry_section(item: dict[str, object], role: str, path: str,
                            sections: list[dict[str, object]]) -> None:
    """Validate one non-deleted entry's content-section reference."""
    mode, section_index = item.get("mode"), item.get("section")
    valid_index = isinstance(section_index, int) and 0 <= section_index < len(sections)
    if mode not in _MODES or not valid_index:
        raise MigrationError("migration entry section is invalid")
    section = sections[section_index]
    if section.get("role") != role or section.get("path") != path or section.get("mode") != mode:
        raise MigrationError("migration entry does not match its section")


def _validated_entry(item: object, role: str, previous: str,
                     sections: list[dict[str, object]]) -> tuple[dict[str, object], str]:
    """Validate one sorted entry and its referenced content section."""
    entry, path, deleted = _entry_identity(item, role, previous)
    if not deleted:
        _validate_entry_section(entry, role, path, sections)
    return entry, path


def _validate_entries(raw: object, sections: list[dict[str, object]]) -> dict[str, list[dict[str, object]]]:
    """Validate every sorted index, worktree, and untracked entry."""
    if not isinstance(raw, dict) or set(raw) != {"index", "worktree", "untracked"}:
        raise MigrationError("migration entries are invalid")
    entries: dict[str, list[dict[str, object]]] = {}
    total = 0
    for role in ("index", "worktree", "untracked"):
        items = raw[role]
        if not isinstance(items, list):
            raise MigrationError("migration entries are invalid")
        validated: list[dict[str, object]] = []
        previous = ""
        for item in items:
            entry, previous = _validated_entry(item, role, previous, sections)
            validated.append(entry)
            total += 1
        entries[role] = validated
    if total > _MAX_FILE_COUNT:
        raise MigrationError("migration file count exceeds the limit")
    return entries


def _packet_parts(packet: bytes) -> tuple[dict[str, Any], bytes]:
    """Decode the bounded packet envelope into metadata and payload."""
    if not isinstance(packet, bytes) or len(packet) > _MAX_PACKET_BYTES:
        raise MigrationError("migration packet exceeds the limit")
    if len(packet) < 8 or packet[:4] != b"GCS1":
        raise MigrationError("migration packet header is invalid")
    metadata_length = int.from_bytes(packet[4:8], "big")
    if not 2 <= metadata_length <= _MAX_METADATA_BYTES or len(packet) < 8 + metadata_length:
        raise MigrationError("migration packet metadata is invalid")
    try:
        metadata = json.loads(packet[8:8 + metadata_length].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MigrationError("migration packet metadata is invalid") from exc
    if not isinstance(metadata, dict):
        raise MigrationError("migration packet schema is invalid")
    return metadata, packet[8 + metadata_length:]


def _validate_metadata_shape(metadata: dict[str, Any]) -> None:
    """Validate the packet schema and its closed top-level field set."""
    expected = {
        "schema", "migration_id", "commit", "branch", "state_digest", "bundle_section",
        "handoff_section", "entries", "sections",
    }
    if set(metadata) != expected or metadata.get("schema") != _SCHEMA:
        raise MigrationError("migration packet schema is invalid")


def _validate_metadata(metadata: dict[str, Any]) -> str | None:
    """Validate metadata identities and return the optional branch."""
    _validate_metadata_shape(metadata)
    commit = metadata.get("commit")
    if not isinstance(commit, str) or not _COMMIT.fullmatch(commit):
        raise MigrationError("migration commit is invalid")
    branch = metadata.get("branch")
    if branch is not None and (
        not isinstance(branch, str) or len(branch) > 255 or branch.startswith("-") or ".." in branch
    ):
        raise MigrationError("migration branch is invalid")
    migration_id = metadata.get("migration_id")
    if not isinstance(migration_id, str) or not _MIGRATION_ID.fullmatch(migration_id):
        raise MigrationError("migration id is invalid")
    return branch


def _validate_section_references(metadata: dict[str, Any], sections: list[dict[str, object]]) -> None:
    """Require metadata to name the unique bundle and handoff sections."""
    for key, role in (("bundle_section", "bundle"), ("handoff_section", "handoff")):
        index = metadata.get(key)
        valid = isinstance(index, int) and 0 <= index < len(sections) and sections[index]["role"] == role
        if not valid:
            raise MigrationError(f"migration {role} section is invalid")


def _identity_entry(item: dict[str, object], sections: list[dict[str, object]]) -> dict[str, object]:
    """Build the content-addressed identity for one validated entry."""
    if item.get("deleted") is True:
        return {"path": item["path"], "deleted": True}
    section_index = item["section"]
    assert isinstance(section_index, int)
    section = sections[section_index]
    return {"path": item["path"], "mode": item["mode"], "sha256": section["sha256"]}


def _state_digest(metadata: dict[str, Any], entries: dict[str, list[dict[str, object]]],
                  sections: list[dict[str, object]], branch: str | None) -> tuple[str, str]:
    """Return the canonical state digest and derived migration identity."""
    identity_entries = {
        role: [_identity_entry(item, sections) for item in items]
        for role, items in entries.items()
    }
    state = {"commit": metadata["commit"], "branch": branch, "entries": identity_entries}
    digest = hashlib.sha256(canonical_json(state)).hexdigest()
    handoff_index = metadata["handoff_section"]
    assert isinstance(handoff_index, int)
    handoff_digest = sections[handoff_index]["sha256"]
    assert isinstance(handoff_digest, str)
    migration_id = hashlib.sha256(f"{digest}:{handoff_digest}".encode("ascii")).hexdigest()[:32]
    return digest, migration_id


def parse_migration_packet(packet: bytes) -> tuple[dict[str, Any], bytes]:
    """Validate a complete migration packet before any destination write."""
    metadata, payload = _packet_parts(packet)
    branch = _validate_metadata(metadata)
    sections = _validate_sections(metadata.get("sections"), payload)
    entries = _validate_entries(metadata.get("entries"), sections)
    _validate_section_references(metadata, sections)
    digest, migration_id = _state_digest(metadata, entries, sections, branch)
    if metadata.get("state_digest") != digest or metadata["migration_id"] != migration_id:
        raise MigrationError("migration state digest is invalid")
    metadata["entries"] = entries
    metadata["sections"] = sections
    return metadata, payload
