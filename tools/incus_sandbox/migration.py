"""Validate and restore one dirty-work migration packet inside a sandbox guest."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any


class MigrationError(RuntimeError):
    """The migration packet or destination is outside the closed contract."""


_SCHEMA = "gc.incus-sandbox.migration/v1"
_RESULT_SCHEMA = "gc.incus-sandbox.migration-result/v1"
_COMMIT = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_MIGRATION_ID = re.compile(r"^[0-9a-f]{32}$")
_SANDBOX = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
_MODES = {"100644", "100755", "120000"}
_ROLES = {"bundle", "index", "worktree", "untracked", "handoff"}
_MAX_METADATA_BYTES = 8 * 1024 * 1024
_MAX_PACKET_BYTES = 1024 * 1024 * 1024
_MAX_FILE_COUNT = 2048
_MAX_FILE_BYTES = 64 * 1024 * 1024
_MAX_HANDOFF_BYTES = 64 * 1024
_GIT = "/usr/bin/git"


def _canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _safe_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\0" in value or "\\" in value:
        raise MigrationError("migration path is invalid")
    path = PurePosixPath(value)
    if path.is_absolute() or value != path.as_posix() or any(part in {"", ".", "..", ".git"} for part in path.parts):
        raise MigrationError("migration path escapes the checkout")
    return value


def _section_bytes(payload: bytes, section: dict[str, object]) -> bytes:
    offset, length = section["offset"], section["length"]
    assert isinstance(offset, int) and isinstance(length, int)
    return payload[offset:offset + length]


def _validate_sections(raw: object, payload: bytes) -> list[dict[str, object]]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= _MAX_FILE_COUNT + 2:
        raise MigrationError("migration section count is invalid")
    sections: list[dict[str, object]] = []
    cursor = 0
    for raw_section in raw:
        if not isinstance(raw_section, dict):
            raise MigrationError("migration section is invalid")
        role = raw_section.get("role")
        expected = {"role", "offset", "length", "sha256"}
        if role in {"index", "worktree", "untracked"}:
            expected |= {"path", "mode"}
        if set(raw_section) != expected or role not in _ROLES:
            raise MigrationError("migration section fields are invalid")
        offset, length, digest = raw_section.get("offset"), raw_section.get("length"), raw_section.get("sha256")
        max_length = _MAX_PACKET_BYTES if role == "bundle" else _MAX_FILE_BYTES
        if (not isinstance(offset, int) or not isinstance(length, int) or offset != cursor or length < 0
                or length > max_length or not isinstance(digest, str) or not _DIGEST.fullmatch(digest)):
            raise MigrationError("migration section bounds are invalid")
        if role == "handoff" and length > _MAX_HANDOFF_BYTES:
            raise MigrationError("migration handoff exceeds the limit")
        if role in {"index", "worktree", "untracked"}:
            _safe_path(raw_section.get("path"))
            if raw_section.get("mode") not in _MODES:
                raise MigrationError("migration file mode is invalid")
        content = payload[offset:offset + length]
        if len(content) != length or hashlib.sha256(content).hexdigest() != digest:
            raise MigrationError("migration section integrity check failed")
        cursor += length
        sections.append(raw_section)
    if cursor != len(payload):
        raise MigrationError("migration payload has unclaimed bytes")
    if [section["role"] for section in sections].count("bundle") != 1:
        raise MigrationError("migration packet requires one bundle")
    if [section["role"] for section in sections].count("handoff") != 1:
        raise MigrationError("migration packet requires one handoff")
    return sections


def _validate_entries(raw: object, sections: list[dict[str, object]]) -> dict[str, list[dict[str, object]]]:
    if not isinstance(raw, dict) or set(raw) != {"index", "worktree", "untracked"}:
        raise MigrationError("migration entries are invalid")
    entries: dict[str, list[dict[str, object]]] = {}
    seen: set[tuple[str, str]] = set()
    total = 0
    for role in ("index", "worktree", "untracked"):
        items = raw[role]
        if not isinstance(items, list):
            raise MigrationError("migration entries are invalid")
        validated: list[dict[str, object]] = []
        previous = ""
        for item in items:
            if not isinstance(item, dict):
                raise MigrationError("migration entry is invalid")
            path = _safe_path(item.get("path"))
            if path <= previous or (role, path) in seen:
                raise MigrationError("migration entries must be unique and sorted")
            previous = path
            seen.add((role, path))
            deleted = item.get("deleted") is True
            expected = {"path", "deleted"} if deleted else {"path", "mode", "section"}
            if set(item) != expected:
                raise MigrationError("migration entry fields are invalid")
            if deleted:
                if role == "untracked":
                    raise MigrationError("an untracked entry cannot be deleted")
            else:
                mode, section_index = item.get("mode"), item.get("section")
                if mode not in _MODES or not isinstance(section_index, int) or not 0 <= section_index < len(sections):
                    raise MigrationError("migration entry section is invalid")
                section = sections[section_index]
                if section.get("role") != role or section.get("path") != path or section.get("mode") != mode:
                    raise MigrationError("migration entry does not match its section")
            validated.append(item)
            total += 1
        entries[role] = validated
    if total > _MAX_FILE_COUNT:
        raise MigrationError("migration file count exceeds the limit")
    return entries


def parse_migration_packet(packet: bytes) -> tuple[dict[str, Any], bytes]:
    """Validate a complete migration packet before any destination write."""
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
    expected = {
        "schema", "migration_id", "commit", "branch", "state_digest", "bundle_section",
        "handoff_section", "entries", "sections",
    }
    if not isinstance(metadata, dict) or set(metadata) != expected or metadata.get("schema") != _SCHEMA:
        raise MigrationError("migration packet schema is invalid")
    if not isinstance(metadata.get("commit"), str) or not _COMMIT.fullmatch(metadata["commit"]):
        raise MigrationError("migration commit is invalid")
    branch = metadata.get("branch")
    if branch is not None and (not isinstance(branch, str) or len(branch) > 255 or branch.startswith("-") or ".." in branch):
        raise MigrationError("migration branch is invalid")
    if not isinstance(metadata.get("migration_id"), str) or not _MIGRATION_ID.fullmatch(metadata["migration_id"]):
        raise MigrationError("migration id is invalid")
    payload = packet[8 + metadata_length:]
    sections = _validate_sections(metadata.get("sections"), payload)
    entries = _validate_entries(metadata.get("entries"), sections)
    for key, role in (("bundle_section", "bundle"), ("handoff_section", "handoff")):
        index = metadata.get(key)
        if not isinstance(index, int) or not 0 <= index < len(sections) or sections[index]["role"] != role:
            raise MigrationError(f"migration {role} section is invalid")
    identity_entries: dict[str, list[dict[str, object]]] = {}
    for role, items in entries.items():
        identity_entries[role] = []
        for item in items:
            if item.get("deleted") is True:
                identity_entries[role].append({"path": item["path"], "deleted": True})
            else:
                section = sections[item["section"]]
                identity_entries[role].append({
                    "path": item["path"], "mode": item["mode"], "sha256": section["sha256"],
                })
    state = {"commit": metadata["commit"], "branch": branch, "entries": identity_entries}
    digest = hashlib.sha256(_canonical(state)).hexdigest()
    handoff_digest = sections[metadata["handoff_section"]]["sha256"]
    migration_id = hashlib.sha256(f"{digest}:{handoff_digest}".encode("ascii")).hexdigest()[:32]
    if metadata.get("state_digest") != digest or metadata["migration_id"] != migration_id:
        raise MigrationError("migration state digest is invalid")
    metadata["entries"] = entries
    metadata["sections"] = sections
    return metadata, payload


def _run_git(workspace: Path, *args: str, input_bytes: bytes | None = None) -> bytes:
    environment = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1",
                   "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"}
    try:
        completed = subprocess.run(
            [_GIT, "-C", str(workspace), *args], input=input_bytes, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment,
        )
    except subprocess.CalledProcessError as exc:
        raise MigrationError("guest Git reconstruction failed") from exc
    return completed.stdout


def _git_paths(output: bytes) -> set[str]:
    if output and not output.endswith(b"\0"):
        raise MigrationError("guest workspace state verification failed")
    try:
        paths = output[:-1].decode("utf-8").split("\0") if output else []
    except UnicodeDecodeError as exc:
        raise MigrationError("guest workspace state verification failed") from exc
    return {_safe_path(path) for path in paths}


def _reject_index_flags(workspace: Path) -> None:
    output = _run_git(workspace, "ls-files", "-v", "-z")
    rows = output[:-1].split(b"\0") if output else []
    for row in rows:
        if len(row) < 3 or row[1] != 0x20:
            raise MigrationError("guest workspace state verification failed")
        if row[0] == 0x53 or 0x61 <= row[0] <= 0x7A:
            raise MigrationError("guest workspace state verification failed")


def _target(workspace: Path, relative: str) -> Path:
    target = workspace.joinpath(*PurePosixPath(_safe_path(relative)).parts)
    current = workspace
    for part in PurePosixPath(relative).parts[:-1]:
        current /= part
        if current.is_symlink():
            raise MigrationError("migration path parent is a link")
    return target


def _write_entry(workspace: Path, entry: dict[str, object], content: bytes) -> None:
    target = _target(workspace, str(entry["path"]))
    if target.is_symlink() or target.exists():
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode = entry["mode"]
    if mode == "120000":
        try:
            link = content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise MigrationError("migration link target is invalid") from exc
        resolved = (target.parent / link).resolve(strict=False)
        try:
            resolved.relative_to(workspace.resolve())
        except ValueError as exc:
            raise MigrationError("migration link escapes the checkout") from exc
        target.symlink_to(link)
        return
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o755 if mode == "100755" else 0o644)
    try:
        os.write(descriptor, content)
    finally:
        os.close(descriptor)


def _remove_entry(workspace: Path, path: str) -> None:
    target = _target(workspace, path)
    if target.is_dir() and not target.is_symlink():
        raise MigrationError("migration cannot replace a directory tree")
    target.unlink(missing_ok=True)


def _apply_entries(metadata: dict[str, Any], payload: bytes, workspace: Path) -> None:
    sections = metadata["sections"]
    index_entries = metadata["entries"]["index"]
    for entry in (item for item in index_entries if item.get("deleted") is True):
        path = str(entry["path"])
        _remove_entry(workspace, path)
        _run_git(workspace, "update-index", "--force-remove", "--", path)
    for entry in (item for item in index_entries if item.get("deleted") is not True):
        path = str(entry["path"])
        content = _section_bytes(payload, sections[entry["section"]])
        _write_entry(workspace, entry, content)
        oid = _run_git(workspace, "hash-object", "-w", "--stdin", input_bytes=content).decode().strip()
        _run_git(workspace, "update-index", "--add", "--cacheinfo", f"{entry['mode']},{oid},{path}")
    for role in ("worktree", "untracked"):
        for entry in metadata["entries"][role]:
            if entry.get("deleted") is True:
                _remove_entry(workspace, str(entry["path"]))
            else:
                _write_entry(workspace, entry, _section_bytes(payload, sections[entry["section"]]))


def _verify_entries(metadata: dict[str, Any], payload: bytes, workspace: Path) -> None:
    if _run_git(workspace, "rev-parse", "HEAD").decode().strip() != metadata["commit"]:
        raise MigrationError("guest HEAD verification failed")
    branch = _run_git(workspace, "branch", "--show-current").decode().strip() or None
    if branch != metadata["branch"]:
        raise MigrationError("guest branch verification failed")
    _reject_index_flags(workspace)
    actual = {
        "index": _git_paths(_run_git(workspace, "diff", "--no-ext-diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--")),
        "worktree": _git_paths(_run_git(workspace, "diff", "--no-ext-diff", "--name-only", "-z", "--no-renames", "--")),
        "untracked": _git_paths(_run_git(workspace, "ls-files", "--others", "--exclude-standard", "-z", "--")),
    }
    expected_paths = {
        role: {str(entry["path"]) for entry in entries}
        for role, entries in metadata["entries"].items()
    }
    if actual != expected_paths:
        raise MigrationError("guest workspace state verification failed")
    sections = metadata["sections"]
    for role, entries in metadata["entries"].items():
        for entry in entries:
            path = str(entry["path"])
            if role == "index":
                output = _run_git(workspace, "ls-files", "--stage", "-z", "--", path)
                suffix = b"\t" + path.encode("utf-8")
                rows = [row for row in output.rstrip(b"\0").split(b"\0") if row.endswith(suffix)] if output else []
                if entry.get("deleted") is True:
                    if rows:
                        raise MigrationError("guest index deletion verification failed")
                    continue
                if len(rows) != 1:
                    raise MigrationError("guest index mode verification failed")
                row = rows[0]
                expected = _section_bytes(payload, sections[entry["section"]])
                prefix = f"{entry['mode']} ".encode("ascii")
                if not row.startswith(prefix):
                    raise MigrationError("guest index mode verification failed")
                if _run_git(workspace, "show", f":{path}") != expected:
                    raise MigrationError("guest index verification failed")
                continue
            target = _target(workspace, path)
            if entry.get("deleted") is True:
                if target.exists() or target.is_symlink():
                    raise MigrationError("guest deletion verification failed")
                continue
            expected = _section_bytes(payload, sections[entry["section"]])
            if entry["mode"] == "120000":
                actual = os.readlink(target).encode("utf-8") if target.is_symlink() else None
            else:
                actual = target.read_bytes() if target.is_file() and not target.is_symlink() else None
                executable = bool(target.stat().st_mode & stat.S_IXUSR) if actual is not None else False
                if executable != (entry["mode"] == "100755"):
                    raise MigrationError("guest file mode verification failed")
            if actual != expected:
                raise MigrationError("guest file content verification failed")


def _handoff(metadata: dict[str, Any], payload: bytes) -> dict[str, str]:
    content = _section_bytes(payload, metadata["sections"][metadata["handoff_section"]])
    try:
        handoff = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MigrationError("migration handoff is invalid") from exc
    if (not isinstance(handoff, dict) or set(handoff) != {"task", "unfinished"}
            or not all(isinstance(handoff[key], str) and 0 < len(handoff[key]) <= 4096 for key in handoff)):
        raise MigrationError("migration handoff is invalid")
    return handoff


def _write_private(path: Path, content: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        os.write(descriptor, content)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(path, 0o600)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _migration_result(metadata: dict[str, Any], handoff: dict[str, str], sandbox: str) -> dict[str, object]:
    counts = {role: len(metadata["entries"][role]) for role in ("index", "worktree", "untracked")}
    return {
        "schema": _RESULT_SCHEMA, "migration_id": metadata["migration_id"],
        "state_digest": metadata["state_digest"], "task_owner": sandbox,
        "source_agent_stopped": True, "verification": "verified",
        "preserved": {"unpublished_commit": True, **counts}, "unfinished": handoff["unfinished"],
    }


def _matches_identity(value: object, metadata: dict[str, Any]) -> bool:
    return (isinstance(value, dict) and value.get("migration_id") == metadata["migration_id"]
            and value.get("state_digest") == metadata["state_digest"])


def _read_json(path: Path) -> object | None:
    if path.is_symlink():
        raise MigrationError("migration publication path is unsafe")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _publish_result(transfer_dir: Path, result_path: Path, ready_path: Path,
                    handoff: dict[str, str], result: dict[str, object]) -> None:
    handoff_text = f"# Task handoff\n\n{handoff['task']}\n\n## Unfinished\n\n{handoff['unfinished']}\n"
    _write_private(transfer_dir / "handoff.md", handoff_text.encode("utf-8"))
    _write_private(result_path, _canonical(result) + b"\n")
    ready_path.unlink(missing_ok=True)
    _fsync_directory(transfer_dir)


def restore_migration(packet: bytes, workspace: Path, transfer_dir: Path, sandbox: str) -> dict[str, object]:
    """Stage, verify, and atomically expose one private guest workspace."""
    if not isinstance(sandbox, str) or not _SANDBOX.fullmatch(sandbox):
        raise MigrationError("migration sandbox identity is invalid")
    metadata, payload = parse_migration_packet(packet)
    handoff = _handoff(metadata, payload)
    if transfer_dir.is_symlink() or workspace.is_symlink():
        raise MigrationError("migration destination path is unsafe")
    transfer_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    result_path = transfer_dir / "migration-result.json"
    ready_path = transfer_dir / f"import-{metadata['migration_id']}.ready.json"
    result = _migration_result(metadata, handoff, sandbox)
    if workspace.exists():
        existing = _read_json(result_path) if result_path.exists() else None
        if _matches_identity(existing, metadata):
            _verify_entries(metadata, payload, workspace)
            if _matches_identity(_read_json(ready_path), metadata):
                ready_path.unlink(missing_ok=True)
                _fsync_directory(transfer_dir)
            assert isinstance(existing, dict)
            return existing
        if existing is not None:
            raise MigrationError("guest workspace belongs to a different migration")
        ready = _read_json(ready_path) if ready_path.exists() else None
        if not _matches_identity(ready, metadata):
            raise MigrationError("guest workspace already exists without this migration result")
        _verify_entries(metadata, payload, workspace)
        _publish_result(transfer_dir, result_path, ready_path, handoff, result)
        return result
    for candidate in transfer_dir.glob("import-*"):
        if candidate.is_dir() and not candidate.is_symlink():
            shutil.rmtree(candidate)
    staging = transfer_dir / f"import-{metadata['migration_id']}"
    staging.mkdir(mode=0o700)
    bundle = staging.with_suffix(".bundle")
    _write_private(bundle, _section_bytes(payload, metadata["sections"][metadata["bundle_section"]]))
    try:
        _run_git(transfer_dir, "clone", "--quiet", "--no-checkout", "--", str(bundle), str(staging))
        _run_git(staging, "checkout", "--quiet", "--detach", metadata["commit"])
        _run_git(staging, "remote", "remove", "origin")
        if metadata["branch"] is not None:
            _run_git(staging, "switch", "--quiet", "-c", metadata["branch"])
        _apply_entries(metadata, payload, staging)
        _verify_entries(metadata, payload, staging)
        ready = {"migration_id": metadata["migration_id"], "state_digest": metadata["state_digest"]}
        _write_private(ready_path, _canonical(ready) + b"\n")
        _fsync_directory(transfer_dir)
        staging.rename(workspace)
        _fsync_directory(workspace.parent)
    finally:
        bundle.unlink(missing_ok=True)
    _publish_result(transfer_dir, result_path, ready_path, handoff, result)
    return result
