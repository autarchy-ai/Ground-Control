"""Boundary tests for private-repository source transfer into an Incus guest."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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
        self.assertEqual(environment, {"PATH": "/usr/bin"})

    def test_guest_bootstrap_rejects_caller_controlled_paths_before_reading(self) -> None:
        with self.assertRaises(PacketError):
            main(["/tmp/source.gcs", "/tmp/workspace"])


class TransferCommandTest(unittest.TestCase):
    def test_transfer_uses_only_fixed_incus_push_and_guest_bootstrap_argv(self) -> None:
        commands = transfer_commands("gc-sandbox", "agent-1", "/var/lib/gc/source.gcs")
        rendered = json.dumps(commands)
        self.assertIn("/usr/bin/incus", rendered)
        self.assertIn("guest-bootstrap.py", rendered)
        self.assertIn("source.gcs", rendered)
        self.assertNotIn("/home/operator", rendered)
        self.assertTrue(all(command[0] == "/usr/bin/incus" for command in commands))
        self.assertIn("/usr/bin/install", commands[0])
        self.assertIn("sandbox", commands[-1])
        self.assertNotIn("/bin/sh", rendered)

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


if __name__ == "__main__":
    unittest.main()
