"""Unit tests for the fixed guest task launcher."""

from __future__ import annotations

import base64
import io
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from tools.incus_sandbox import task_launcher
from tools.incus_sandbox.task_launcher import FrameError, environment_from_frame, systemd_run_command


class TaskLauncherTest(unittest.TestCase):
    """Exercise the guest frame and transient-service boundary."""

    def test_constructs_a_minimal_environment_without_ambient_inheritance(self) -> None:
        frame = json.dumps({
            "schema": "gc.incus-sandbox.task-frame/v1",
            "task_id": "a" * 32,
            "variables": [{"name": "DECLARED", "value_b64": base64.b64encode(b"value").decode()}],
        }).encode()
        environ = environment_from_frame(frame, {"AMBIENT_CANARY": "must-not-pass", "TERM": "xterm-256color"})
        self.assertEqual(environ["DECLARED"], "value")
        self.assertNotIn("AMBIENT_CANARY", environ)
        self.assertEqual(environ["PATH"], "/usr/local/bin:/usr/bin:/bin")
        self.assertEqual(environ["HOME"], "/run/gc-sandbox-task")
        self.assertEqual(environ["TERM"], "xterm-256color")
        self.assertNotIn("USER", environ)

    def test_rejects_duplicate_reserved_invalid_and_oversized_frames(self) -> None:
        for variables in (
            [{"name": "PATH", "value_b64": "eA=="}],
            [{"name": "ONE", "value_b64": "eA=="}, {"name": "ONE", "value_b64": "eQ=="}],
            [{"name": "BAD-NAME", "value_b64": "eA=="}],
            [{"name": "ONE", "value_b64": "%%%"}],
        ):
            frame = json.dumps({
                "schema": "gc.incus-sandbox.task-frame/v1", "task_id": "b" * 32,
                "variables": variables,
            }).encode()
            with self.subTest(variables=variables), self.assertRaises(FrameError):
                environment_from_frame(frame, os.environ)
        with self.assertRaises(FrameError):
            environment_from_frame(b"x" * (64 * 1024 + 1), {})
        for invalid in (b"{", b"{}", json.dumps({
            "schema": "gc.incus-sandbox.task-frame/v1", "task_id": "short", "variables": [],
        }).encode()):
            with self.subTest(invalid=invalid), self.assertRaises(FrameError):
                environment_from_frame(invalid, {})

    def test_systemd_service_uses_a_dynamic_identity_private_socket_and_complete_cgroup_kill(self) -> None:
        command = systemd_run_command()
        rendered = " ".join(command)
        self.assertIn("DynamicUser=yes", rendered)
        self.assertIn("RuntimeDirectoryMode=0700", rendered)
        self.assertIn("KillMode=control-group", rendered)
        self.assertIn("ProtectProc=invisible", rendered)
        self.assertNotIn("DECLARED", rendered)
        self.assertNotIn("value", rendered)
        self.assertEqual(command[-3:], [
            "/usr/bin/python3", "/usr/local/lib/gc-incus-sandbox/task-launcher.py", "child",
        ])

    def test_root_start_delivers_the_frame_and_observes_readiness(self) -> None:
        raw = json.dumps({
            "schema": "gc.incus-sandbox.task-frame/v1", "task_id": "a" * 32, "variables": [],
        }).encode()
        with patch.object(task_launcher.os, "geteuid", return_value=0), \
             patch.object(task_launcher.subprocess, "run") as run, \
             patch.object(task_launcher, "_send_frame") as send, \
             patch.object(task_launcher.os.path, "isfile", return_value=True):
            task_launcher.start(raw)
        run.assert_called_once()
        send.assert_called_once_with(raw)

    def test_private_socket_send_and_bounded_read(self) -> None:
        client = MagicMock()
        with patch.object(task_launcher.socket, "socket", return_value=client):
            task_launcher._send_frame(b"frame")
        client.connect.assert_called_once_with("/run/gc-sandbox-task/input.sock")
        client.sendall.assert_called_once_with(b"frame")
        connection = MagicMock()
        connection.recv.side_effect = [b"one", b"two", b""]
        self.assertEqual(task_launcher._read_socket(connection), b"onetwo")

    def test_stop_controls_the_complete_systemd_unit(self) -> None:
        inactive = SimpleNamespace(returncode=1)
        with patch.object(task_launcher.os, "geteuid", return_value=0), \
             patch.object(task_launcher.subprocess, "run", side_effect=[inactive, MagicMock()]) as run:
            task_launcher.stop()
        self.assertEqual(run.call_count, 2)
        active = SimpleNamespace(returncode=0)
        with patch.object(task_launcher.subprocess, "run",
                          side_effect=[active, MagicMock(), MagicMock()]) as run:
            task_launcher._stop_unit()
        self.assertEqual(run.call_count, 3)

    def test_dynamic_child_owns_tmux_and_the_private_runtime(self) -> None:
        raw = b"frame"
        server, connection = MagicMock(), MagicMock()
        server.__enter__.return_value = server
        connection.__enter__.return_value = connection
        server.accept.return_value = (connection, None)
        with patch.object(task_launcher.os, "geteuid", return_value=1000), \
             patch.object(task_launcher.socket, "socket", return_value=server), \
             patch.object(task_launcher, "_read_socket", return_value=raw), \
             patch.object(task_launcher, "environment_from_frame", return_value={"PATH": "/usr/bin"}), \
             patch.object(task_launcher.subprocess, "run") as run, \
             patch.object(task_launcher.os, "open", return_value=3), \
             patch.object(task_launcher.os, "close"), \
             patch.object(task_launcher.os, "chmod"), \
             patch.object(task_launcher.os, "unlink"), \
             patch.object(task_launcher.os, "execve", side_effect=RuntimeError("exec")):
            with self.assertRaisesRegex(RuntimeError, "exec"):
                task_launcher.child()
        run.assert_called_once()

    def test_main_has_only_the_fixed_internal_vocabulary(self) -> None:
        stdin = SimpleNamespace(buffer=io.BytesIO(b"frame"))
        with patch.object(task_launcher.sys, "stdin", stdin), \
             patch.object(task_launcher, "start") as start:
            self.assertEqual(task_launcher.main(["start"]), 0)
        start.assert_called_once_with(b"frame")
        with patch.object(task_launcher, "child") as child:
            self.assertEqual(task_launcher.main(["child"]), 0)
        child.assert_called_once_with()
        with patch.object(task_launcher, "stop") as stop:
            self.assertEqual(task_launcher.main(["stop"]), 0)
        stop.assert_called_once_with()
        with self.assertRaises(FrameError):
            task_launcher.main(["shell"])


if __name__ == "__main__":
    unittest.main()
