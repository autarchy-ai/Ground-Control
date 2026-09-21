"""Validate and restore one dirty-work migration packet inside a sandbox guest."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any

if __package__:
    from .migration_packet import MigrationError, canonical_json, parse_migration_packet, safe_path
else:
    from migration_packet import MigrationError, canonical_json, parse_migration_packet, safe_path


_RESULT_SCHEMA = "gc.incus-sandbox.migration-result/v1"
_SANDBOX = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
_GIT = "/usr/bin/git"
_WORKSPACE_STATE_ERROR = "guest workspace state verification failed"


def _safe_path(value: object) -> str:
    """Return a normalized checkout-relative path or reject it."""
    return safe_path(value)


def _section_bytes(payload: bytes, section: dict[str, object]) -> bytes:
    """Return the bytes named by one already-validated section."""
    offset, length = section["offset"], section["length"]
    assert isinstance(offset, int) and isinstance(length, int)
    return payload[offset:offset + length]


def _run_git(workspace: Path, *args: str, input_bytes: bytes | None = None) -> bytes:
    """Run fixed Git argv with no ambient configuration, prompts, or output leakage."""
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
    """Decode one NUL-delimited set of safe Git paths."""
    if output and not output.endswith(b"\0"):
        raise MigrationError(_WORKSPACE_STATE_ERROR)
    try:
        paths = output[:-1].decode("utf-8").split("\0") if output else []
    except UnicodeDecodeError as exc:
        raise MigrationError(_WORKSPACE_STATE_ERROR) from exc
    return {_safe_path(path) for path in paths}


def _reject_index_flags(workspace: Path) -> None:
    """Reject index flags that can suppress worktree changes from Git diff."""
    output = _run_git(workspace, "ls-files", "-v", "-z")
    rows = output[:-1].split(b"\0") if output else []
    for row in rows:
        if len(row) < 3 or row[1] != 0x20:
            raise MigrationError(_WORKSPACE_STATE_ERROR)
        if row[0] == 0x53 or 0x61 <= row[0] <= 0x7A:
            raise MigrationError(_WORKSPACE_STATE_ERROR)


def _target(workspace: Path, relative: str) -> Path:
    """Resolve a safe target whose existing parents are not links."""
    target = workspace.joinpath(*PurePosixPath(_safe_path(relative)).parts)
    current = workspace
    for part in PurePosixPath(relative).parts[:-1]:
        current /= part
        if current.is_symlink():
            raise MigrationError("migration path parent is a link")
    return target


def _write_entry(workspace: Path, entry: dict[str, object], content: bytes) -> None:
    """Write one regular file or contained symlink without following a target link."""
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
    """Remove one file-like entry without recursively deleting an unexpected tree."""
    target = _target(workspace, path)
    if target.is_dir() and not target.is_symlink():
        raise MigrationError("migration cannot replace a directory tree")
    target.unlink(missing_ok=True)


def _apply_entries(metadata: dict[str, Any], payload: bytes, workspace: Path) -> None:
    """Reconstruct the captured index before applying worktree and untracked state."""
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


def _verify_workspace_identity(metadata: dict[str, Any], workspace: Path) -> None:
    """Verify immutable HEAD, branch, and the exact changed-path inventory."""
    if _run_git(workspace, "rev-parse", "HEAD").decode().strip() != metadata["commit"]:
        raise MigrationError("guest HEAD verification failed")
    branch = _run_git(workspace, "branch", "--show-current").decode().strip() or None
    if branch != metadata["branch"]:
        raise MigrationError("guest branch verification failed")
    _reject_index_flags(workspace)
    actual = {
        "index": _git_paths(_run_git(
            workspace, "diff", "--no-ext-diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--",
        )),
        "worktree": _git_paths(_run_git(workspace, "diff", "--no-ext-diff", "--name-only", "-z", "--no-renames", "--")),
        "untracked": _git_paths(_run_git(workspace, "ls-files", "--others", "--exclude-standard", "-z", "--")),
    }
    expected_paths = {
        role: {str(entry["path"]) for entry in entries}
        for role, entries in metadata["entries"].items()
    }
    if actual != expected_paths:
        raise MigrationError(_WORKSPACE_STATE_ERROR)


def _index_rows(workspace: Path, path: str) -> list[bytes]:
    """Return exact stage-zero rows without accepting path-prefix matches."""
    output = _run_git(workspace, "ls-files", "--stage", "-z", "--", path)
    suffix = b"\t" + path.encode("utf-8")
    return [row for row in output.rstrip(b"\0").split(b"\0") if row.endswith(suffix)] if output else []


def _verify_index_entry(metadata: dict[str, Any], payload: bytes, workspace: Path,
                        entry: dict[str, object]) -> None:
    """Verify one captured index addition, modification, or deletion."""
    path = str(entry["path"])
    rows = _index_rows(workspace, path)
    if entry.get("deleted") is True:
        if rows:
            raise MigrationError("guest index deletion verification failed")
        return
    if len(rows) != 1:
        raise MigrationError("guest index mode verification failed")
    prefix = f"{entry['mode']} ".encode("ascii")
    if not rows[0].startswith(prefix):
        raise MigrationError("guest index mode verification failed")
    expected = _section_bytes(payload, metadata["sections"][entry["section"]])
    if _run_git(workspace, "show", f":{path}") != expected:
        raise MigrationError("guest index verification failed")


def _worktree_content(target: Path, mode: object) -> bytes | None:
    """Read one file-like target and verify its executable-mode class."""
    if mode == "120000":
        return os.readlink(target).encode("utf-8") if target.is_symlink() else None
    if not target.is_file() or target.is_symlink():
        return None
    content = target.read_bytes()
    executable = bool(target.stat().st_mode & stat.S_IXUSR)
    if executable != (mode == "100755"):
        raise MigrationError("guest file mode verification failed")
    return content


def _verify_worktree_entry(metadata: dict[str, Any], payload: bytes, workspace: Path,
                           entry: dict[str, object]) -> None:
    """Verify one captured worktree or selected-untracked entry."""
    target = _target(workspace, str(entry["path"]))
    if entry.get("deleted") is True:
        if target.exists() or target.is_symlink():
            raise MigrationError("guest deletion verification failed")
        return
    expected = _section_bytes(payload, metadata["sections"][entry["section"]])
    if _worktree_content(target, entry["mode"]) != expected:
        raise MigrationError("guest file content verification failed")


def _verify_entries(metadata: dict[str, Any], payload: bytes, workspace: Path) -> None:
    """Verify exact Git identity, changed paths, content, modes, and deletions."""
    _verify_workspace_identity(metadata, workspace)
    for role, entries in metadata["entries"].items():
        for entry in entries:
            if role == "index":
                _verify_index_entry(metadata, payload, workspace, entry)
            else:
                _verify_worktree_entry(metadata, payload, workspace, entry)


def _handoff(metadata: dict[str, Any], payload: bytes) -> dict[str, str]:
    """Decode the bounded operator-reviewed task handoff."""
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
    """Write and sync one owner-private publication file."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        os.write(descriptor, content)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(path, 0o600)


def _fsync_directory(path: Path) -> None:
    """Persist directory-entry changes across interruption."""
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _migration_result(metadata: dict[str, Any], handoff: dict[str, str], sandbox: str) -> dict[str, object]:
    """Build the private verified result returned to the guest operator."""
    counts = {role: len(metadata["entries"][role]) for role in ("index", "worktree", "untracked")}
    return {
        "schema": _RESULT_SCHEMA, "migration_id": metadata["migration_id"],
        "state_digest": metadata["state_digest"], "task_owner": sandbox,
        "source_agent_stopped": True, "verification": "verified",
        "preserved": {"unpublished_commit": True, **counts}, "unfinished": handoff["unfinished"],
    }


def _matches_identity(value: object, metadata: dict[str, Any]) -> bool:
    """Whether a publication marker belongs to this exact captured state."""
    return (isinstance(value, dict) and value.get("migration_id") == metadata["migration_id"]
            and value.get("state_digest") == metadata["state_digest"])


def _read_json(path: Path) -> object | None:
    """Read a private publication record, treating invalid content as absent."""
    if path.is_symlink():
        raise MigrationError("migration publication path is unsafe")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _publish_result(transfer_dir: Path, result_path: Path, ready_path: Path,
                    handoff: dict[str, str], result: dict[str, object]) -> None:
    """Durably publish handoff and result, then retire the recovery marker."""
    handoff_text = f"# Task handoff\n\n{handoff['task']}\n\n## Unfinished\n\n{handoff['unfinished']}\n"
    _write_private(transfer_dir / "handoff.md", handoff_text.encode("utf-8"))
    _write_private(result_path, canonical_json(result) + b"\n")
    ready_path.unlink(missing_ok=True)
    _fsync_directory(transfer_dir)


def _recover_workspace(metadata: dict[str, Any], payload: bytes, workspace: Path,
                       result_path: Path, ready_path: Path, handoff: dict[str, str],
                       result: dict[str, object]) -> dict[str, object]:
    """Verify and finish publication for an already-exposed workspace."""
    transfer_dir = result_path.parent
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


def _stage_workspace(metadata: dict[str, Any], payload: bytes, workspace: Path,
                     transfer_dir: Path, ready_path: Path) -> None:
    """Reconstruct, verify, mark, and atomically expose a new workspace."""
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
        _write_private(ready_path, canonical_json(ready) + b"\n")
        _fsync_directory(transfer_dir)
        staging.rename(workspace)
        _fsync_directory(workspace.parent)
    finally:
        bundle.unlink(missing_ok=True)


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
        return _recover_workspace(
            metadata, payload, workspace, result_path, ready_path, handoff, result,
        )
    _stage_workspace(metadata, payload, workspace, transfer_dir, ready_path)
    _publish_result(transfer_dir, result_path, ready_path, handoff, result)
    return result
