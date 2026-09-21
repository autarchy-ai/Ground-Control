"""Behavioral tests for repository-scoped sandbox task environments."""

from __future__ import annotations

import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from tools.incus_sandbox import task_environment
from tools.incus_sandbox.config import ConfigError, load_config, upgrade_config
from tools.incus_sandbox.repository_environment import (
    DeclarationError,
    parse_repository_environment,
)
from tools.incus_sandbox.task_environment import (
    clear_source_binding,
    ProviderError,
    TaskRuntime,
    TaskEnvironmentService,
    redacted_task_observation,
    record_source_binding,
)


def declaration(repository: str, variables: list[dict[str, str]]) -> bytes:
    return json.dumps({
        "schema": "gc.incus-sandbox.task-environment/v1",
        "repository": repository,
        "variables": variables,
    }, separators=(",", ":")).encode()


class RepositoryDeclarationTest(unittest.TestCase):
    def test_accepts_exclusive_literals_and_references(self) -> None:
        parsed = parse_repository_environment(declaration("example/one", [
            {"name": "REGION", "literal": "eu-central-1"},
            {"name": "SERVICE_TOKEN", "secret_ref": "service-token"},
        ]), "example/one", max_value_bytes=1024)
        self.assertEqual([item.name for item in parsed.variables], ["REGION", "SERVICE_TOKEN"])
        self.assertEqual(parsed.variables[1].secret_ref, "service-token")

    def test_rejects_ambiguous_duplicate_and_reserved_declarations(self) -> None:
        bad = [
            [{"name": "VALUE", "literal": "x", "secret_ref": "alias"}],
            [{"name": "VALUE", "literal": "x"}, {"name": "VALUE", "literal": "y"}],
            [{"name": "ONE", "secret_ref": "same"}, {"name": "TWO", "secret_ref": "same"}],
            [{"name": "PATH", "literal": "/tmp"}],
            [{"name": "LD_PRELOAD", "literal": "evil.so"}],
            [{"name": "GITHUB_TOKEN", "secret_ref": "publication"}],
            [{"name": "SAFE", "literal": "nul\u0000value"}],
        ]
        for variables in bad:
            with self.subTest(variables=variables), self.assertRaises(DeclarationError):
                parse_repository_environment(declaration("example/one", variables), "example/one")

    def test_rejects_copied_configuration_and_unknown_fields(self) -> None:
        with self.assertRaises(DeclarationError):
            parse_repository_environment(declaration("example/other", []), "example/one")
        document = json.loads(declaration("example/one", []).decode())
        document["provider"] = "/host/secret"
        with self.assertRaises(DeclarationError):
            parse_repository_environment(json.dumps(document).encode(), "example/one")


class HostPolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="gc-task-policy-")
        self.root = Path(self.temporary.name)
        self.path = self.root / "config.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def document(self) -> dict[str, object]:
        return {
            "schema": "gc.incus-sandbox/v3",
            "project": "gc-sandbox", "profile": "gc-profile", "pool": "gc-pool",
            "bridge": "gcbr0", "image": "images:" + "a" * 64,
            "state_dir": str(self.root / "state"), "event_log": str(self.root / "events.jsonl"),
            "event_max_bytes": 1024, "observation_max_age_seconds": 60,
            "operator_uid": os.getuid(),
            "vm": {"cpu": 2, "memory_mib": 4096, "disk_gib": 16},
            "host": {"reserve_memory_mib": 2048, "reserve_disk_gib": 32, "max_cpu": 8,
                     "max_memory_mib": 32768, "max_disk_gib": 512, "overhead_disk_gib": 16},
            "migration": {"max_packet_bytes": 1024 * 1024, "max_file_count": 10,
                          "max_file_bytes": 65536, "max_handoff_bytes": 4096},
            "task_environment": {
                "max_value_bytes": 16384,
                "repositories": {
                    "example/one": {"shared": {"path": str(self.root / "one.secret"),
                                                  "state": "available"}},
                },
            },
        }

    def write(self, document: dict[str, object]) -> None:
        self.path.write_text(json.dumps(document), encoding="utf-8")
        self.path.chmod(0o600)

    def test_loads_closed_repository_scoped_provider_policy(self) -> None:
        self.write(self.document())
        policy = load_config(self.path, expected_uid=os.getuid()).task_environment
        self.assertEqual(policy.max_value_bytes, 16384)
        self.assertEqual(policy.repositories["example/one"]["shared"].state, "available")

    def test_rejects_unsafe_provider_policy(self) -> None:
        documents = []
        doc = self.document()
        doc["task_environment"]["unknown"] = True
        documents.append(doc)
        doc = self.document()
        doc["task_environment"]["repositories"]["Example/One"] = \
            doc["task_environment"]["repositories"].pop("example/one")
        documents.append(doc)
        doc = self.document()
        doc["task_environment"]["repositories"]["example/one"]["shared"]["path"] = "relative"
        documents.append(doc)
        doc = self.document()
        doc["task_environment"]["repositories"]["example/one"]["shared"]["state"] = "mystery"
        documents.append(doc)
        for doc in documents:
            self.write(doc)
            with self.assertRaises(ConfigError):
                load_config(self.path, expected_uid=os.getuid())

    def test_upgrade_adds_an_empty_v3_policy_without_configuring_any_repository(self) -> None:
        doc = self.document()
        doc["schema"] = "gc.incus-sandbox/v2"
        doc.pop("task_environment")
        self.write(doc)
        self.assertTrue(upgrade_config(self.path, expected_uid=os.getuid()))
        upgraded = json.loads(self.path.read_text())
        self.assertEqual(upgraded["schema"], "gc.incus-sandbox/v3")
        self.assertEqual(upgraded["task_environment"]["repositories"], {})


class TaskEnvironmentServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="gc-task-env-")
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.secret_one = self.root / "one.secret"
        self.secret_two = self.root / "two.secret"
        self.secret_one.write_bytes(b"first-value")
        self.secret_two.write_bytes(b"second-value")
        self.secret_one.chmod(0o600)
        self.secret_two.chmod(0o600)
        self.calls: list[tuple[list[str], bytes | None]] = []
        self.policy = {
            "example/one": {"shared": {"path": self.secret_one, "state": "available"}},
            "example/two": {"shared": {"path": self.secret_two, "state": "available"}},
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def service(self, repository: str, raw: bytes) -> TaskEnvironmentService:
        digest = record_source_binding(self.state, "agent-1", repository, raw)
        return TaskEnvironmentService(
            project="gc-sandbox",
            state_dir=self.state,
            operator_uid=os.getuid(),
            repositories=self.policy,
            runtime=TaskRuntime(
                active_owner=lambda sandbox, uid: sandbox == "agent-1" and uid == os.getuid(),
                runner=lambda argv, input_bytes=None: self.calls.append((argv, input_bytes)),
                expected_provider_uid=os.getuid(), task_id_factory=lambda: "a" * 32,
            ),
        ), digest

    @staticmethod
    def request(repository: str, raw: bytes) -> bytes:
        return json.dumps({
            "schema": "gc.incus-sandbox.task-start/v1",
            "repository": repository,
            "declaration_b64": base64.b64encode(raw).decode("ascii"),
        }).encode()

    def test_two_repositories_resolve_the_same_name_and_alias_independently(self) -> None:
        frames = []
        for repository, expected in (("example/one", b"first-value"), ("example/two", b"second-value")):
            raw = declaration(repository, [{"name": "TOKEN", "secret_ref": "shared"}])
            service, _ = self.service(repository, raw)
            service.start("agent-1", self.request(repository, raw), os.getuid())
            frame = json.loads(self.calls[-1][1])
            value = base64.b64decode(frame["variables"][0]["value_b64"])
            self.assertEqual(value, expected)
            frames.append(frame)
        self.assertNotEqual(frames[0]["variables"], frames[1]["variables"])

    def test_rejects_cross_repository_and_changed_declarations_before_resolution(self) -> None:
        raw = declaration("example/one", [{"name": "TOKEN", "secret_ref": "shared"}])
        service, _ = self.service("example/one", raw)
        copied = declaration("example/two", [{"name": "TOKEN", "secret_ref": "shared"}])
        with self.assertRaises(ProviderError):
            service.start("agent-1", self.request("example/two", copied), os.getuid())
        changed = declaration("example/one", [{"name": "TOKEN", "literal": "changed"}])
        with self.assertRaises(ProviderError):
            service.start("agent-1", self.request("example/one", changed), os.getuid())
        self.assertEqual(self.calls, [])

    def test_clearing_a_replaced_source_removes_old_binding_and_redacted_task_state(self) -> None:
        raw = declaration("example/one", [])
        self.service("example/one", raw)
        task = self.state / "tasks" / "agent-1.json"
        task.parent.mkdir(parents=True)
        task.write_text('{"redacted":true}', encoding="utf-8")
        clear_source_binding(self.state, "agent-1")
        self.assertFalse((self.state / "source-bindings" / "agent-1.json").exists())
        self.assertFalse(task.exists())

    def test_missing_expired_revoked_and_unsafe_provider_files_fail_closed(self) -> None:
        raw = declaration("example/one", [{"name": "TOKEN", "secret_ref": "shared"}])
        for state in ("expired", "revoked"):
            service, _ = self.service("example/one", raw)
            self.policy["example/one"]["shared"]["state"] = state
            with self.subTest(state=state), self.assertRaises(ProviderError):
                service.start("agent-1", self.request("example/one", raw), os.getuid())
        self.policy["example/one"]["shared"]["state"] = "available"
        self.secret_one.unlink()
        service, _ = self.service("example/one", raw)
        with self.assertRaises(ProviderError):
            service.start("agent-1", self.request("example/one", raw), os.getuid())
        self.secret_one.write_bytes(b"")
        self.secret_one.chmod(0o600)
        with self.assertRaises(ProviderError):
            service.start("agent-1", self.request("example/one", raw), os.getuid())
        self.secret_one.write_bytes(b"readable-by-others")
        self.secret_one.chmod(0o644)
        with self.assertRaises(ProviderError):
            service.start("agent-1", self.request("example/one", raw), os.getuid())

    def test_start_restart_stop_and_status_never_persist_or_render_values_or_aliases(self) -> None:
        canary = b"secret-canary-value"
        self.secret_one.write_bytes(canary)
        raw = declaration("example/one", [
            {"name": "PUBLIC", "literal": "visible-only-to-task"},
            {"name": "TOKEN", "secret_ref": "shared"},
        ])
        service, _ = self.service("example/one", raw)
        service.start("agent-1", self.request("example/one", raw), os.getuid())
        start_argv, frame = self.calls[-1]
        self.assertNotIn(canary.decode(), json.dumps(start_argv))
        delivered = json.loads(frame)
        self.assertIn(canary, [base64.b64decode(item["value_b64"]) for item in delivered["variables"]])
        persisted = (self.state / "tasks" / "agent-1.json").read_text()
        self.assertNotIn(canary.decode(), persisted)
        self.assertNotIn("shared", persisted)
        status = service.status("agent-1")
        self.assertEqual(status["variables"], [
            {"name": "PUBLIC", "source": "literal", "state": "available"},
            {"name": "TOKEN", "source": "secret", "state": "available"},
        ])
        self.secret_one.write_bytes(b"rotated-value")
        service.restart("agent-1", self.request("example/one", raw), os.getuid())
        delivered = json.loads(self.calls[-1][1])
        self.assertIn(b"rotated-value", [
            base64.b64decode(item["value_b64"]) for item in delivered["variables"]
        ])
        service.stop("agent-1", os.getuid())
        self.assertFalse((self.state / "tasks" / "agent-1.json").exists())

    def test_host_rejects_an_aggregate_frame_the_guest_cannot_accept(self) -> None:
        self.secret_one.write_bytes(b"x" * 16384)
        raw = declaration("example/one", [
            {"name": f"VALUE_{index}", "secret_ref": f"alias-{index}"}
            for index in range(4)
        ])
        self.policy["example/one"] = {
            f"alias-{index}": {"path": self.secret_one, "state": "available"}
            for index in range(4)
        }
        service, _ = self.service("example/one", raw)
        with self.assertRaises(ProviderError):
            service.start("agent-1", self.request("example/one", raw), os.getuid())
        self.assertEqual(self.calls, [])

    def test_redacted_observation_rejects_malformed_state(self) -> None:
        task = self.root / "task.json"
        self.assertEqual(redacted_task_observation(task, False),
                         {"state": "not_started", "variables": []})
        task.write_text(json.dumps({"variables": [
            {"name": "TOKEN", "source": "secret", "state": "available"},
        ]}), encoding="utf-8")
        self.assertEqual(redacted_task_observation(task, True)["state"], "running")
        task.write_text('{"variables":[{"name":"BAD-NAME"}]}', encoding="utf-8")
        self.assertEqual(redacted_task_observation(task, True)["state"], "unavailable")

    def test_root_entrypoint_dispatches_only_the_authenticated_task_lifecycle(self) -> None:
        config = SimpleNamespace(
            project="gc-sandbox", state_dir=self.state, operator_uid=os.getuid(),
            event_log=self.root / "events", event_max_bytes=1024,
            task_environment=SimpleNamespace(repositories={}, max_value_bytes=16384),
        )
        service, events, lifecycle = MagicMock(), MagicMock(), MagicMock()
        with patch.object(task_environment.os, "geteuid", return_value=0), \
             patch.dict(task_environment.os.environ, {"SUDO_UID": str(os.getuid())}, clear=True), \
             patch("tools.incus_sandbox.config.load_config", return_value=config), \
             patch("tools.incus_sandbox.events.EventWriter", return_value=events), \
             patch("tools.incus_sandbox.helper.LifecycleHelper", return_value=lifecycle), \
             patch.object(task_environment, "TaskEnvironmentService", return_value=service):
            self.assertEqual(task_environment.main(["stop", "agent-1"]), 0)
        service.stop.assert_called_once_with("agent-1", os.getuid())
        events.write.assert_called_once()


if __name__ == "__main__":
    unittest.main()
