"""Behavioral tests for dirty-work migration into a private guest checkout."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.incus_sandbox.config import ConfigError, load_config, upgrade_config
from tools.incus_sandbox import migration
from tools.incus_sandbox.migration import MigrationError, restore_migration


def git(repository: Path, *args: str, input_bytes: bytes | None = None) -> str:
    result = subprocess.run(
        ["/usr/bin/git", "-C", str(repository), *args], input=input_bytes,
        capture_output=True, check=True,
    )
    return result.stdout.decode("utf-8").strip()


def append_section(payload: bytearray, sections: list[dict[str, object]], role: str,
                   content: bytes, **fields: object) -> int:
    index = len(sections)
    sections.append({
        "role": role, "offset": len(payload), "length": len(content),
        "sha256": hashlib.sha256(content).hexdigest(), **fields,
    })
    payload.extend(content)
    return index


def migration_packet(root: Path) -> tuple[bytes, str]:
    source = root / "source"
    source.mkdir()
    git(source, "init", "--quiet", "--initial-branch=work")
    git(source, "config", "user.email", "sandbox@example.invalid")
    git(source, "config", "user.name", "sandbox")
    (source / "staged.txt").write_text("base\n", encoding="utf-8")
    (source / "unstaged.txt").write_text("base\n", encoding="utf-8")
    (source / "deleted.txt").write_text("base\n", encoding="utf-8")
    (source / "clean.txt").write_text("base\n", encoding="utf-8")
    (source / "staged-only.txt").write_text("base\n", encoding="utf-8")
    git(source, "add", ".")
    git(source, "commit", "--quiet", "-m", "base")
    commit = git(source, "rev-parse", "HEAD")
    bundle = root / "source.bundle"
    git(source, "bundle", "create", str(bundle), "HEAD")

    payload = bytearray()
    sections: list[dict[str, object]] = []
    bundle_section = append_section(payload, sections, "bundle", bundle.read_bytes())
    staged_section = append_section(payload, sections, "index", b"staged\n",
                                    path="staged.txt", mode="100644")
    staged_only_section = append_section(payload, sections, "index", b"staged-only\n",
                                         path="staged-only.txt", mode="100644")
    staged_worktree_section = append_section(payload, sections, "worktree", b"working-after-stage\n",
                                             path="staged.txt", mode="100644")
    worktree_section = append_section(payload, sections, "worktree", b"working\n",
                                      path="unstaged.txt", mode="100644")
    untracked_section = append_section(payload, sections, "untracked", b"selected\n",
                                       path="selected.txt", mode="100644")
    handoff_section = append_section(payload, sections, "handoff", json.dumps({
        "task": "Continue issue 1645", "unfinished": "Run verification",
    }, separators=(",", ":")).encode())
    entries = {
        "index": [
            {"path": "staged-only.txt", "mode": "100644", "section": staged_only_section},
            {"path": "staged.txt", "mode": "100644", "section": staged_section},
        ],
        "worktree": [
            {"path": "deleted.txt", "deleted": True},
            {"path": "staged.txt", "mode": "100644", "section": staged_worktree_section},
            {"path": "unstaged.txt", "mode": "100644", "section": worktree_section},
        ],
        "untracked": [{"path": "selected.txt", "mode": "100644", "section": untracked_section}],
    }
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
    state = {"commit": commit, "branch": "work", "entries": identity_entries}
    state_digest = hashlib.sha256(json.dumps(
        state, separators=(",", ":"), sort_keys=True,
    ).encode()).hexdigest()
    migration_id = hashlib.sha256(
        f"{state_digest}:{sections[handoff_section]['sha256']}".encode("ascii")
    ).hexdigest()[:32]
    metadata = {
        "schema": "gc.incus-sandbox.migration/v1", "migration_id": migration_id,
        "commit": commit, "branch": "work", "state_digest": state_digest,
        "bundle_section": bundle_section, "handoff_section": handoff_section,
        "entries": entries, "sections": sections,
    }
    encoded = json.dumps(metadata, separators=(",", ":"), sort_keys=True).encode()
    return b"GCS1" + len(encoded).to_bytes(4, "big") + encoded + payload, state_digest


class MigrationRestoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="gc-incus-migration-")
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_restore_reconstructs_git_state_and_writes_a_private_result(self) -> None:
        packet, digest = migration_packet(self.root)
        workspace = self.root / "workspace"
        transfer = self.root / "transfer"
        result = restore_migration(packet, workspace, transfer, "agent-1")

        self.assertEqual(git(workspace, "branch", "--show-current"), "work")
        self.assertEqual((workspace / "staged.txt").read_text(encoding="utf-8"), "working-after-stage\n")
        self.assertEqual(git(workspace, "show", ":staged.txt"), "staged")
        self.assertEqual((workspace / "unstaged.txt").read_text(encoding="utf-8"), "working\n")
        self.assertFalse((workspace / "deleted.txt").exists())
        self.assertEqual((workspace / "selected.txt").read_text(encoding="utf-8"), "selected\n")
        self.assertIn("MM staged.txt", git(workspace, "status", "--short"))
        self.assertIn(" M unstaged.txt", git(workspace, "status", "--short"))
        self.assertIn("D deleted.txt", git(workspace, "status", "--short"))
        self.assertIn("?? selected.txt", git(workspace, "status", "--short"))
        self.assertEqual(result["schema"], "gc.incus-sandbox.migration-result/v1")
        self.assertEqual(result["state_digest"], digest)
        self.assertEqual(result["task_owner"], "agent-1")
        self.assertEqual(result["verification"], "verified")
        self.assertEqual((transfer / "handoff.md").stat().st_mode & 0o777, 0o600)

    def test_retry_replaces_only_incomplete_staging_and_is_idempotent_after_completion(self) -> None:
        packet, _ = migration_packet(self.root)
        workspace = self.root / "workspace"
        transfer = self.root / "transfer"
        transfer.mkdir()
        stale = transfer / "import-stale"
        stale.mkdir()
        (stale / "partial").write_text("partial", encoding="utf-8")
        first = restore_migration(packet, workspace, transfer, "agent-1")
        second = restore_migration(packet, workspace, transfer, "agent-1")
        self.assertEqual(first, second)
        self.assertTrue(workspace.exists())
        self.assertFalse(any(path.name.startswith("import-") for path in transfer.iterdir()))

    def test_retry_finishes_publication_interrupted_after_workspace_rename(self) -> None:
        for failed_name in ("handoff.md", "migration-result.json"):
            with self.subTest(failed_name=failed_name):
                case = self.root / failed_name
                case.mkdir()
                packet, _ = migration_packet(case)
                workspace = case / "workspace"
                transfer = case / "transfer"
                original_write = migration._write_private
                failed = False

                def interrupt_once(path: Path, content: bytes) -> None:
                    nonlocal failed
                    if path.name == failed_name and not failed:
                        failed = True
                        raise OSError("simulated publication interruption")
                    original_write(path, content)

                with patch("tools.incus_sandbox.migration._write_private", side_effect=interrupt_once):
                    with self.assertRaises(OSError):
                        restore_migration(packet, workspace, transfer, "agent-1")
                result = restore_migration(packet, workspace, transfer, "agent-1")
                self.assertEqual(result["verification"], "verified")
                self.assertFalse(any(path.name.endswith(".ready.json") for path in transfer.iterdir()))

    def test_replay_rejects_an_unexpected_change_to_a_clean_tracked_file(self) -> None:
        packet, _ = migration_packet(self.root)
        workspace = self.root / "workspace"
        transfer = self.root / "transfer"
        restore_migration(packet, workspace, transfer, "agent-1")
        (workspace / "clean.txt").write_text("changed after import\n", encoding="utf-8")
        with self.assertRaisesRegex(MigrationError, "workspace state"):
            restore_migration(packet, workspace, transfer, "agent-1")

    def test_replay_rejects_a_worktree_change_to_a_staged_only_entry(self) -> None:
        packet, _ = migration_packet(self.root)
        workspace = self.root / "workspace"
        transfer = self.root / "transfer"
        restore_migration(packet, workspace, transfer, "agent-1")
        (workspace / "staged-only.txt").write_text("changed after import\n", encoding="utf-8")
        with self.assertRaisesRegex(MigrationError, "workspace state"):
            restore_migration(packet, workspace, transfer, "agent-1")

    def test_replay_rejects_index_flags_that_hide_a_tracked_edit(self) -> None:
        for flag in ("--assume-unchanged", "--skip-worktree"):
            with self.subTest(flag=flag):
                case = self.root / flag.removeprefix("--")
                case.mkdir()
                packet, _ = migration_packet(case)
                workspace = case / "workspace"
                transfer = case / "transfer"
                restore_migration(packet, workspace, transfer, "agent-1")
                git(workspace, "update-index", flag, "clean.txt")
                (workspace / "clean.txt").write_text("hidden after import\n", encoding="utf-8")
                with self.assertRaisesRegex(MigrationError, "workspace state"):
                    restore_migration(packet, workspace, transfer, "agent-1")

    def test_restore_rejects_escape_paths_and_preserves_an_existing_workspace(self) -> None:
        packet, _ = migration_packet(self.root)
        metadata_length = int.from_bytes(packet[4:8], "big")
        metadata = json.loads(packet[8:8 + metadata_length])
        payload = packet[8 + metadata_length:]
        metadata["entries"]["untracked"][0]["path"] = "../escape"
        encoded = json.dumps(metadata, separators=(",", ":"), sort_keys=True).encode()
        poisoned = b"GCS1" + len(encoded).to_bytes(4, "big") + encoded + payload
        workspace = self.root / "workspace"
        workspace.mkdir()
        marker = workspace / "original"
        marker.write_text("keep", encoding="utf-8")
        with self.assertRaises(MigrationError):
            restore_migration(poisoned, workspace, self.root / "transfer", "agent-1")
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_node_capture_round_trips_through_the_guest_restorer(self) -> None:
        source = self.root / "node-source"
        source.mkdir()
        git(source, "init", "--quiet", "--initial-branch=travail-é")
        git(source, "config", "user.email", "sandbox@example.invalid")
        git(source, "config", "user.name", "sandbox")
        (source / "tracked.txt").write_text("base\n", encoding="utf-8")
        (source / "directory-to-file").mkdir()
        (source / "directory-to-file" / "child.txt").write_text("child\n", encoding="utf-8")
        (source / "file-to-directory").write_text("file\n", encoding="utf-8")
        git(source, "add", ".")
        git(source, "commit", "--quiet", "-m", "base")
        (source / "tracked.txt").write_text("staged\n", encoding="utf-8")
        git(source, "add", "tracked.txt")
        (source / "tracked.txt").write_text("working\n", encoding="utf-8")
        (source / "directory-to-file" / "child.txt").unlink()
        (source / "directory-to-file").rmdir()
        (source / "directory-to-file").write_text("replacement file\n", encoding="utf-8")
        (source / "file-to-directory").unlink()
        (source / "file-to-directory").mkdir()
        (source / "file-to-directory" / "child.txt").write_text("replacement child\n", encoding="utf-8")
        git(source, "add", "-A", "directory-to-file", "file-to-directory")
        (source / "sélection.txt").write_text("selected\n", encoding="utf-8")
        spec = json.dumps({
            "schema": "gc.incus-sandbox.migration-request/v1",
            "checkpoint_acknowledged": True, "source_agent_stopped": True,
            "selected_untracked": ["sélection.txt"],
            "handoff": {"task": "Continue the task", "unfinished": "Run focused tests"},
        }).encode()
        module = (Path(__file__).resolve().parents[2] / "tools/incus_sandbox/source.mjs").as_uri()
        script = (
            f'import {{captureMigration,parseMigrationSpec}} from "{module}";'
            'import {readFileSync} from "node:fs";'
            'process.stdout.write(captureMigration(process.argv[1],parseMigrationSpec(readFileSync(0))));'
        )
        capture = subprocess.run(
            ["node", "--input-type=module", "-e", script, str(source)], input=spec,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(capture.returncode, 0, capture.stderr.decode("utf-8"))
        captured = capture.stdout
        workspace = self.root / "node-workspace"
        result = restore_migration(captured, workspace, self.root / "node-transfer", "agent-node")
        self.assertEqual((workspace / "tracked.txt").read_text(encoding="utf-8"), "working\n")
        self.assertEqual(git(workspace, "show", ":tracked.txt"), "staged")
        self.assertEqual((workspace / "sélection.txt").read_text(encoding="utf-8"), "selected\n")
        self.assertEqual((workspace / "directory-to-file").read_text(encoding="utf-8"), "replacement file\n")
        self.assertEqual((workspace / "file-to-directory" / "child.txt").read_text(encoding="utf-8"),
                         "replacement child\n")
        self.assertEqual(git(workspace, "branch", "--show-current"), "travail-é")
        self.assertEqual(result["task_owner"], "agent-node")


class MigrationConfigTest(unittest.TestCase):
    def test_v2_config_carries_root_owned_migration_limits(self) -> None:
        root = Path(self.tmpdir.name) if hasattr(self, "tmpdir") else None
        with tempfile.TemporaryDirectory(prefix="gc-incus-config-") as directory:
            root = Path(directory)
            document = {
                "schema": "gc.incus-sandbox/v2", "project": "gc-sandbox",
                "profile": "gc-sandbox-default", "pool": "gc-sandbox-pool", "bridge": "gcbr0",
                "image": "images:" + "a" * 64, "state_dir": str(root / "state"),
                "event_log": str(root / "events.jsonl"), "event_max_bytes": 4096,
                "observation_max_age_seconds": 60, "operator_uid": os.getuid(),
                "vm": {"cpu": 2, "memory_mib": 4096, "disk_gib": 16},
                "host": {"reserve_memory_mib": 2048, "reserve_disk_gib": 32, "max_cpu": 8,
                         "max_memory_mib": 32768, "max_disk_gib": 512, "overhead_disk_gib": 16},
                "migration": {"max_packet_bytes": 1073741824, "max_file_count": 2048,
                              "max_file_bytes": 67108864, "max_handoff_bytes": 65536},
            }
            path = root / "config.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            path.chmod(0o600)
            config = load_config(path, expected_uid=os.getuid())
            self.assertEqual(config.migration.max_file_count, 2048)
            document["migration"]["unknown"] = 1
            path.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_config(path, expected_uid=os.getuid())

    def test_upgrade_adds_only_the_closed_v2_migration_policy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="gc-incus-config-upgrade-") as directory:
            root = Path(directory)
            document = {
                "schema": "gc.incus-sandbox/v1", "project": "gc-sandbox",
                "profile": "gc-sandbox-default", "pool": "gc-sandbox-pool", "bridge": "gcbr0",
                "image": "images:" + "a" * 64, "state_dir": str(root / "state"),
                "event_log": str(root / "events.jsonl"), "event_max_bytes": 4096,
                "observation_max_age_seconds": 60, "operator_uid": os.getuid(),
                "vm": {"cpu": 2, "memory_mib": 4096, "disk_gib": 16},
                "host": {"reserve_memory_mib": 2048, "reserve_disk_gib": 32, "max_cpu": 8,
                         "max_memory_mib": 32768, "max_disk_gib": 512, "overhead_disk_gib": 16},
            }
            path = root / "config.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            path.chmod(0o600)
            self.assertTrue(upgrade_config(path, expected_uid=os.getuid()))
            upgraded = load_config(path, expected_uid=os.getuid())
            self.assertEqual(upgraded.migration.max_packet_bytes, 1073741824)
            self.assertFalse(upgrade_config(path, expected_uid=os.getuid()))


if __name__ == "__main__":
    unittest.main()
