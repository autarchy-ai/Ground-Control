"""Unit tests for the fixed guest task launcher."""

from __future__ import annotations

import base64
import json
import os
import unittest

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


if __name__ == "__main__":
    unittest.main()
