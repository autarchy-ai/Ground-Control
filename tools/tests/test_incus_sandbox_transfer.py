"""Boundary tests for private-repository source transfer into an Incus guest."""

from __future__ import annotations

import io
import json
import runpy
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.incus_sandbox import guest_bootstrap
from tools.incus_sandbox import transfer as incus_transfer
from tools.incus_sandbox.guest_bootstrap import PacketError, guest_environment, main, parse_packet
from tools.incus_sandbox.transfer import TransferError, read_packet, transfer, transfer_commands


def packet(metadata: dict[str, object], payload: bytes = b"") -> bytes:
    encoded = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
    return b"GCS1" + len(encoded).to_bytes(4, "big") + encoded + payload


class PacketBoundaryTest(unittest.TestCase):
    def test_clone_packet_has_an_immutable_commit_and_safe_repository_only(self) -> None:
        source = packet({
            "schema": "gc.incus-sandbox.source/v1", "kind": "clone", "commit": "a" * 40,
            "repository": "https://github.com/example/private.git",
        })
        parsed = parse_packet(source)
        self.assertEqual(parsed["kind"], "clone")
        self.assertNotIn("path", parsed)
        self.assertNotIn("credential", parsed)

    def test_packet_rejects_a_host_path_credentials_or_an_unbounded_payload(self) -> None:
        for metadata in (
            {"schema": "gc.incus-sandbox.source/v1", "kind": "clone", "commit": "a" * 40,
             "repository": "/home/operator/private"},
            {"schema": "gc.incus-sandbox.source/v1", "kind": "clone", "commit": "a" * 40,
             "repository": "https://token@github.com/example/private.git"},
        ):
            with self.assertRaises(PacketError):
                parse_packet(packet(metadata))
        with self.assertRaises(TransferError):
            read_packet(io.BytesIO(b"x" * 17), max_bytes=16)

    def test_guest_bootstrap_removes_host_credential_and_docker_endpoints(self) -> None:
        environment = guest_environment({
            "DOCKER_HOST": "unix:///host.sock", "OPENAI_API_KEY": "secret-canary",
            "CODEX_HOME": "/host/codex", "GH_TOKEN": "secret-canary", "PATH": "/usr/bin",
        })
        self.assertEqual(environment, {"PATH": "/usr/bin", "GIT_TERMINAL_PROMPT": "0"})

    def test_guest_bootstrap_rejects_caller_controlled_paths_before_reading(self) -> None:
        with self.assertRaises(PacketError):
            main(["/tmp/source.gcs", "/tmp/workspace"])

    def test_packet_validation_rejects_malformed_identities_and_payloads(self) -> None:
        invalid_packets = (
            b"not-a-packet",
            b"GCS1" + (0).to_bytes(4, "big"),
            b"GCS1" + (2).to_bytes(4, "big"),
            b"GCS1" + (2).to_bytes(4, "big") + b"{x",
            packet({"schema": "unexpected", "kind": "clone", "commit": "a" * 40,
                    "repository": "https://github.com/example/private.git"}),
            packet({"schema": "gc.incus-sandbox.source/v1", "kind": "invalid", "commit": "a" * 40}),
            packet({"schema": "gc.incus-sandbox.source/v1", "kind": "clone", "commit": "short",
                    "repository": "https://github.com/example/private.git"}),
            packet({"schema": "gc.incus-sandbox.source/v1", "kind": "clone", "commit": "a" * 40,
                    "repository": "https://github.com/example/private.git", "extra": "field"}),
            packet({"schema": "gc.incus-sandbox.source/v1", "kind": "bundle", "commit": "a" * 40}),
        )
        for source in invalid_packets:
            with self.assertRaises(PacketError):
                parse_packet(source)


class GuestMaterializationTest(unittest.TestCase):
    def test_bundle_copy_uses_fixed_paths_and_replaces_a_stale_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            packet_path, bundle_path = root / "source.gcs", root / "source.bundle"
            packet_path.write_bytes(b"header-bundle")
            bundle_path.write_bytes(b"stale bundle from an interrupted run")
            with patch.multiple(guest_bootstrap, _PACKET_PATH=packet_path, _BUNDLE_PATH=bundle_path):
                guest_bootstrap._copy_bundle_payload(len(b"header-"))
                self.assertEqual(bundle_path.read_bytes(), b"bundle")
                bundle_path.unlink()
                packet_path.unlink()
                with self.assertRaises(FileNotFoundError):
                    guest_bootstrap._copy_bundle_payload(0)
            self.assertFalse(bundle_path.exists())

    def _materialization_paths(self, root: Path) -> dict[str, Path]:
        transfer = root / ".gc-transfer"
        transfer.mkdir()
        home = root / "home"
        home.mkdir()
        return {"_PACKET_PATH": transfer / "source.gcs", "_WORKSPACE_PATH": root / "workspace",
                "_BUNDLE_PATH": transfer / "source.bundle", "_LOG_PATH": transfer / "bootstrap.log",
                "_NPMRC_PATH": root / ".npmrc", "_REQUIRED_TOOLS": (), "home": home}

    def test_materialize_uses_fixed_guest_paths_for_clone_and_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = self._materialization_paths(root)
            home = paths.pop("home")
            sources = (
                packet({"schema": "gc.incus-sandbox.source/v1", "kind": "clone", "commit": "a" * 40,
                        "repository": "https://github.com/example/private.git"}),
                packet({"schema": "gc.incus-sandbox.source/v1", "kind": "bundle", "commit": "a" * 40}, b"bundle"),
            )
            for source in sources:
                paths["_PACKET_PATH"].write_bytes(source)
                with patch.multiple(guest_bootstrap, **paths), \
                     patch.object(guest_bootstrap.Path, "home", return_value=home), \
                     patch("tools.incus_sandbox.guest_bootstrap.subprocess.run") as run:
                    guest_bootstrap.materialize()
                commands = [call.args[0] for call in run.call_args_list]
                self.assertEqual(commands[0][0], "/usr/bin/git")
                self.assertEqual(commands[1][-1], "a" * 40)
                # A transfer materializes source; it never fetches and runs a network package.
                self.assertTrue(all(command[0] == "/usr/bin/git" for command in commands))
                self.assertFalse(paths["_BUNDLE_PATH"].exists())
                # The packet is a full copy of the private source; it does not outlive the run.
                self.assertFalse(paths["_PACKET_PATH"].exists())
                self.assertEqual(paths["_NPMRC_PATH"].read_text(encoding="utf-8"),
                                 f"prefix={home / '.local'}\n")
            # A transferred bundle is deleted after checkout, so its remote is removed with it.
            self.assertEqual(commands[2], ["/usr/bin/git", "-C", str(paths["_WORKSPACE_PATH"]),
                                           "remote", "remove", "origin"])

    def test_materialize_reuses_a_workspace_holding_the_same_commit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = self._materialization_paths(root)
            home = paths.pop("home")
            paths["_PACKET_PATH"].write_bytes(packet({
                "schema": "gc.incus-sandbox.source/v1", "kind": "clone", "commit": "a" * 40,
                "repository": "https://github.com/example/private.git",
            }))
            paths["_WORKSPACE_PATH"].mkdir()
            with patch.multiple(guest_bootstrap, **paths), \
                 patch.object(guest_bootstrap.Path, "home", return_value=home), \
                 patch("tools.incus_sandbox.guest_bootstrap.subprocess.run") as run:
                run.return_value = types.SimpleNamespace(returncode=0, stdout="a" * 40 + "\n")
                guest_bootstrap.materialize()
            commands = [call.args[0] for call in run.call_args_list]
            self.assertNotIn("clone", [command[3] for command in commands if len(command) > 3])
            self.assertEqual([command[3] for command in commands], ["rev-parse"])

    def test_materialize_routes_a_migration_packet_to_the_atomic_restorer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = self._materialization_paths(root)
            paths.pop("home")
            source = packet({"schema": "gc.incus-sandbox.migration/v1"})
            paths["_PACKET_PATH"].write_bytes(source)
            with patch.multiple(guest_bootstrap, **paths), \
                 patch("tools.incus_sandbox.guest_bootstrap.restore_migration", return_value={}) as restore:
                guest_bootstrap.materialize()
            restore.assert_called_once_with(source, paths["_WORKSPACE_PATH"],
                                            paths["_PACKET_PATH"].parent, "sandbox")
            self.assertFalse(paths["_PACKET_PATH"].exists())

    def test_materialize_rejects_a_workspace_holding_another_commit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = self._materialization_paths(root)
            home = paths.pop("home")
            paths["_PACKET_PATH"].write_bytes(packet({
                "schema": "gc.incus-sandbox.source/v1", "kind": "clone", "commit": "a" * 40,
                "repository": "https://github.com/example/private.git",
            }))
            paths["_WORKSPACE_PATH"].mkdir()
            with patch.multiple(guest_bootstrap, **paths), \
                 patch.object(guest_bootstrap.Path, "home", return_value=home), \
                 patch("tools.incus_sandbox.guest_bootstrap.subprocess.run") as run:
                run.return_value = types.SimpleNamespace(returncode=0, stdout="b" * 40 + "\n")
                with self.assertRaises(PacketError):
                    guest_bootstrap.materialize()

    def test_missing_guest_prerequisites_are_named(self) -> None:
        with patch.multiple(guest_bootstrap, _REQUIRED_TOOLS=("/usr/bin/git", "/nonexistent/npm")):
            with self.assertRaises(PacketError) as result:
                guest_bootstrap.require_guest_tools()
        self.assertIn("/nonexistent/npm", str(result.exception))

    def test_guest_command_output_stays_in_the_guest_log(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log_path = Path(directory) / "bootstrap.log"
            with patch.multiple(guest_bootstrap, _LOG_PATH=log_path):
                guest_bootstrap.run_guest_command(["/bin/echo", "guest-only-output"], {})
                with self.assertRaises(subprocess.CalledProcessError):
                    guest_bootstrap.run_guest_command(["/bin/false"], {})
            recorded = log_path.read_text(encoding="utf-8")
        self.assertIn("guest-only-output", recorded)
        self.assertIn("/bin/false", recorded)

    def test_main_uses_only_the_fixed_paths(self) -> None:
        expected = [str(guest_bootstrap._PACKET_PATH), str(guest_bootstrap._WORKSPACE_PATH), "agent-1"]
        with patch("tools.incus_sandbox.guest_bootstrap.materialize") as materialize:
            self.assertEqual(main(expected), 0)
        materialize.assert_called_once_with("agent-1")

    def test_cli_reports_invalid_arguments(self) -> None:
        with patch.object(sys, "argv", ["guest-bootstrap.py"]):
            with self.assertRaises(SystemExit) as result:
                runpy.run_module("tools.incus_sandbox.guest_bootstrap", run_name="__main__")
        self.assertEqual(result.exception.code, 64)


class TransferCommandTest(unittest.TestCase):
    def test_read_packet_rejects_empty_and_nonbinary_streams(self) -> None:
        for stream in (io.BytesIO(), io.StringIO("text")):
            with self.assertRaises(TransferError):
                read_packet(stream)

    def test_transfer_uses_only_fixed_incus_push_and_guest_bootstrap_argv(self) -> None:
        commands = transfer_commands("gc-sandbox", "agent-1", "/var/lib/gc/source.gcs")
        rendered = json.dumps(commands)
        self.assertIn("/usr/bin/incus", rendered)
        self.assertIn("guest-bootstrap.py", rendered)
        self.assertIn("migration.py", rendered)
        self.assertIn("migration_packet.py", rendered)
        self.assertIn("source.gcs", rendered)
        self.assertNotIn("/home/operator", rendered)
        self.assertTrue(all(command[0] == "/usr/bin/incus" for command in commands))
        self.assertIn("/usr/bin/install", commands[0])
        self.assertIn("sandbox", commands[-1])
        self.assertNotIn("/bin/sh", rendered)
        # A guest command takes an absolute guest path; only a file push is instance-relative.
        for command in (commands[0], commands[-1]):
            self.assertNotIn("agent-1/home", " ".join(command[5:]))
        self.assertEqual([argument for argument in commands[0] if argument.startswith("/home")],
                         ["/home/sandbox/.local", "/home/sandbox/.local/bin", "/home/sandbox/.gc-transfer"])
        self.assertTrue(all(command[4].startswith("agent-1/home/sandbox/")
                            for command in commands[1:5]))
        # The bootstrap is root-owned and run by the unprivileged guest user.
        self.assertIn("--mode=0755", commands[1])

    def test_transfer_rejects_a_name_that_could_change_the_guest_command(self) -> None:
        with self.assertRaises(TransferError):
            transfer_commands("gc-sandbox", "agent;host-command", "/var/lib/gc/source.gcs")

    def test_transfer_does_not_forward_guest_output_to_host_logs(self) -> None:
        source = packet({
            "schema": "gc.incus-sandbox.source/v1", "kind": "clone", "commit": "a" * 40,
            "repository": "https://github.com/example/private.git",
        })
        with tempfile.TemporaryDirectory() as directory, patch("tools.incus_sandbox.transfer.subprocess.run") as run:
            transfer("gc-sandbox", Path(directory), "agent-1", io.BytesIO(source))
        self.assertTrue(all(
            call.kwargs["stdout"] is not None and call.kwargs["stderr"] is not None
            for call in run.call_args_list
        ))

    def test_audited_transfer_records_success_and_failure_without_packet_contents(self) -> None:
        records: list[dict[str, str]] = []

        class EventWriter:
            def __init__(self, *_: object) -> None:
                pass

            def ensure_available(self) -> None:
                pass

            def write(self, record: dict[str, str]) -> None:
                records.append(record)

        config = types.SimpleNamespace(event_log=Path("/tmp/events"), event_max_bytes=32,
                                       project="gc-sandbox", state_dir=Path("/tmp/state"))
        events = types.SimpleNamespace(EventWriter=EventWriter)
        clone = packet({"schema": "gc.incus-sandbox.source/v1", "kind": "clone", "commit": "a" * 40,
                        "repository": "https://github.com/example/private.git"})
        bundle = packet({"schema": "gc.incus-sandbox.source/v1", "kind": "bundle", "commit": "a" * 40}, b"bundle")
        with patch.dict(sys.modules, {"events": events}):
            with patch("tools.incus_sandbox.transfer.transfer"):
                incus_transfer.audited_transfer(config, "agent-1", io.BytesIO(clone), "clone")
            with patch("tools.incus_sandbox.transfer.transfer", side_effect=RuntimeError("failed")):
                with self.assertRaises(RuntimeError):
                    incus_transfer.audited_transfer(config, "agent-1", io.BytesIO(bundle), "bundle")
        self.assertEqual([record["outcome"] for record in records], ["success", "failure"])
        with self.assertRaises(TransferError):
            incus_transfer.audited_transfer(config, "agent-1", io.BytesIO(b"packet"), "invalid")

    def test_dirty_migration_requires_v2_root_owned_limits(self) -> None:
        events = types.SimpleNamespace(EventWriter=lambda *_: types.SimpleNamespace(
            ensure_available=lambda: None, write=lambda _: None,
        ))
        config = types.SimpleNamespace(event_log=Path("/tmp/events"), event_max_bytes=32,
                                       project="gc-sandbox", state_dir=Path("/tmp/state"), migration=None)
        with patch.dict(sys.modules, {"events": events}):
            with self.assertRaises(TransferError) as result:
                incus_transfer.audited_transfer(
                    config, "agent-1", io.BytesIO(packet({"schema": "gc.incus-sandbox.migration/v1"})),
                    "migration", caller_uid=1000,
                )
        self.assertIn("v2", str(result.exception))

    def test_declared_bundle_cannot_smuggle_a_migration_packet(self) -> None:
        records: list[dict[str, str]] = []

        class EventWriter:
            def __init__(self, *_: object) -> None:
                pass

            def ensure_available(self) -> None:
                pass

            def write(self, record: dict[str, str]) -> None:
                records.append(record)

        config = types.SimpleNamespace(event_log=Path("/tmp/events"), event_max_bytes=32,
                                       project="gc-sandbox", state_dir=Path("/tmp/state"), migration=None)
        events = types.SimpleNamespace(EventWriter=EventWriter)
        source = packet({"schema": "gc.incus-sandbox.migration/v1"})
        with patch.dict(sys.modules, {"events": events}), \
             patch("tools.incus_sandbox.transfer.transfer") as transfer_call:
            with self.assertRaisesRegex(TransferError, "kind does not match"):
                incus_transfer.audited_transfer(config, "agent-1", io.BytesIO(source), "bundle")
        transfer_call.assert_not_called()
        self.assertEqual(records[-1]["outcome"], "failure")

    def test_migration_schema_requires_active_owner_before_transfer(self) -> None:
        writer = types.SimpleNamespace(ensure_available=lambda: None, write=lambda _: None)
        events = types.SimpleNamespace(EventWriter=lambda *_: writer)
        limits = types.SimpleNamespace(max_packet_bytes=1024, max_file_count=4,
                                       max_file_bytes=128, max_handoff_bytes=64)
        config = types.SimpleNamespace(event_log=Path("/tmp/events"), event_max_bytes=32,
                                       project="gc-sandbox", state_dir=Path("/tmp/state"), migration=limits)
        metadata = {
            "entries": {"index": [], "worktree": [], "untracked": []},
            "sections": [{"role": "handoff", "length": 1}], "handoff_section": 0,
        }
        source = packet({"schema": "gc.incus-sandbox.migration/v1"})
        with patch.dict(sys.modules, {"events": events}), \
             patch("tools.incus_sandbox.helper.LifecycleHelper.require_active_owner") as require_owner, \
             patch("tools.incus_sandbox.migration.parse_migration_packet", return_value=(metadata, b"")), \
             patch("tools.incus_sandbox.transfer.transfer") as transfer_call:
            incus_transfer.audited_transfer(
                config, "agent-1", io.BytesIO(source), "migration", caller_uid=1000,
            )
        require_owner.assert_called_once_with("agent-1")
        transfer_call.assert_called_once()

    def test_transfer_entrypoint_checks_operator_identity_and_dispatches(self) -> None:
        config = types.SimpleNamespace(operator_uid=1000)
        config_module = types.SimpleNamespace(load_config=lambda _: config)
        with patch("tools.incus_sandbox.transfer.os.geteuid", return_value=0), \
             patch.dict("tools.incus_sandbox.transfer.os.environ", {"SUDO_UID": "1000"}, clear=True), \
             patch.dict(sys.modules, {"config": config_module}), \
             patch("tools.incus_sandbox.transfer.audited_transfer") as audited:
            self.assertEqual(incus_transfer.main(["agent-1", "clone"]), 0)
        audited.assert_called_once()
        with patch("tools.incus_sandbox.transfer.os.geteuid", return_value=1):
            with self.assertRaises(TransferError):
                incus_transfer.main(["agent-1", "clone"])
        with patch("tools.incus_sandbox.transfer.os.geteuid", return_value=0), \
             patch.dict("tools.incus_sandbox.transfer.os.environ", {}, clear=True):
            with self.assertRaises(TransferError):
                incus_transfer.main(["agent-1", "clone"])

    def test_guest_failure_names_the_guest_log_without_host_details(self) -> None:
        config_module = types.SimpleNamespace(load_config=lambda _: types.SimpleNamespace(operator_uid=1000))
        failure = subprocess.CalledProcessError(64, ["/usr/bin/incus", "exec", "agent-1"])
        with patch("tools.incus_sandbox.transfer.os.geteuid", return_value=0), \
             patch.dict("tools.incus_sandbox.transfer.os.environ", {"SUDO_UID": "1000"}, clear=True), \
             patch.dict(sys.modules, {"config": config_module}), \
             patch("tools.incus_sandbox.transfer.audited_transfer", side_effect=failure):
            with self.assertRaises(TransferError) as result:
                incus_transfer.main(["agent-1", "bundle"])
        self.assertIn("bootstrap.log", str(result.exception))
        self.assertNotIn("/usr/bin/incus", str(result.exception))


if __name__ == "__main__":
    unittest.main()
