"""Boundary tests for building the sandbox guest template image."""

from __future__ import annotations

import io
import platform
import runpy
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tools.incus_sandbox.config import DEFAULT_DEADLINES
from tools.incus_sandbox import build_image
from tools.incus_sandbox.build_image import (
    BuildError,
    cached_locally,
    fingerprint_from,
    launch_command,
    launch_reference,
    parse_arguments,
    provision_command,
    provision_script,
    publish_command,
    resolve_base,
    virtual_machine_image,
)


def config() -> SimpleNamespace:
    return SimpleNamespace(project="gc-sandbox", profile="gc-sandbox-default",
                           vm=SimpleNamespace(disk_gib=16), deadlines=DEFAULT_DEADLINES)


class TemplateArgumentTest(unittest.TestCase):
    def test_accepts_only_a_pinned_base_and_a_name_grammar_alias(self) -> None:
        self.assertEqual(parse_arguments(["images:almalinux/10/cloud"]),
                         ("images:almalinux/10/cloud", "gc-sandbox-template"))
        self.assertEqual(parse_arguments(["a" * 64, "other-template"]), ("a" * 64, "other-template"))
        for argv in ([], ["images:almalinux/10", "a", "b"], ["docker:alpine"], ["../escape"],
                     ["images:almalinux/10", "Template;rm"], ["a" * 63]):
            with self.assertRaises(BuildError):
                parse_arguments(argv)

    def test_base_resolves_to_one_virtual_machine_image_of_this_architecture(self) -> None:
        rows = [
            {"fingerprint": "a" * 64, "type": "virtual-machine", "architecture": "x86_64"},
            {"fingerprint": "b" * 64, "type": "container", "architecture": "x86_64"},
            {"fingerprint": "c" * 64, "type": "virtual-machine", "architecture": "aarch64"},
        ]
        self.assertEqual(virtual_machine_image(rows, "x86_64"), "a" * 64)
        with self.assertRaises(BuildError):
            virtual_machine_image(rows, "riscv64")
        ambiguous = rows + [{"fingerprint": "d" * 64, "type": "virtual-machine", "architecture": "x86_64"}]
        with self.assertRaises(BuildError):
            virtual_machine_image(ambiguous, "x86_64")

    def test_a_remote_base_launches_its_resolved_fingerprint_on_that_remote(self) -> None:
        self.assertEqual(launch_reference("images:almalinux/10/cloud", "a" * 64), f"images:{'a' * 64}")
        self.assertEqual(launch_reference("b" * 64, "a" * 64), "a" * 64)
        # A base already in the image store is launched locally rather than re-fetched.
        self.assertEqual(launch_reference("images:almalinux/10/cloud", "a" * 64, True), "a" * 64)

    def test_a_cached_base_is_recognised_from_the_project_image_store(self) -> None:
        calls: list[list[str]] = []

        def runner(argv: list[str], **_: object) -> SimpleNamespace:
            calls.append(argv)
            return SimpleNamespace(stdout="[]" if "b" * 64 in argv else '[{"fingerprint": "' + "a" * 64 + '"}]')

        self.assertTrue(cached_locally(config(), "a" * 64, runner))
        self.assertFalse(cached_locally(config(), "b" * 64, runner))
        self.assertIn("--project", calls[0])

    def test_resolution_reads_the_image_list_rather_than_trusting_the_reference(self) -> None:
        calls: list[list[str]] = []

        def runner(argv: list[str], **_: object) -> SimpleNamespace:
            calls.append(argv)
            return SimpleNamespace(stdout='[{"fingerprint": "' + "a" * 64
                                   + '", "type": "virtual-machine", "architecture": "'
                                   + __import__("platform").machine() + '"}]')

        self.assertEqual(resolve_base(config(), "images:almalinux/10/cloud", runner), "a" * 64)
        self.assertEqual(calls[0][:4], ["/usr/bin/incus", "image", "list", "images:almalinux/10/cloud"])

    def test_fingerprint_is_read_from_the_incus_result_or_refused(self) -> None:
        self.assertEqual(fingerprint_from(f"Instance published with fingerprint: {'e' * 64}"), "e" * 64)
        with self.assertRaises(BuildError):
            fingerprint_from("Instance published with fingerprint: short")


class TemplateCommandTest(unittest.TestCase):
    def test_build_commands_stay_inside_the_sandbox_project_and_profile(self) -> None:
        settings = config()
        launch = launch_command(settings, f"images:{'a' * 64}", "gc-template-build-1")
        self.assertEqual(launch[:4], ["/usr/bin/incus", "launch", f"images:{'a' * 64}", "gc-template-build-1"])
        self.assertIn("--vm", launch)
        self.assertIn("gc-sandbox-default", launch)
        self.assertIn("root,size=16GiB", launch)
        publish = publish_command(settings, "gc-template-build-1", "gc-sandbox-template")
        self.assertEqual(publish[-2:], ["--alias", "gc-sandbox-template"])
        self.assertTrue(all(command[0] == "/usr/bin/incus"
                            for command in (launch, publish, provision_command(settings, "name"))))

    def test_provisioning_installs_the_documented_prerequisites_from_pinned_sources(self) -> None:
        script = provision_script()
        for expected in ("git-core", "nodejs", "npm", "python3", "tmux", "useradd -m -s /bin/bash sandbox",
                         "sha256sum -c -", "gh_2.101.0_linux_", "kernel.yama.ptrace_scope=1"):
            self.assertIn(expected, script)
        # The template carries tooling, never a credential, a host path, or a repository.
        for forbidden in ("GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "/home/atomik", "git clone"):
            self.assertNotIn(forbidden, script)
        self.assertIn(": >/etc/machine-id", script)


class TemplateBuildTest(unittest.TestCase):
    def _results(self, publish_fails: bool = False) -> list[object]:
        """One result per fixed build command, in the order the build runs them."""
        listed = SimpleNamespace(returncode=0, stdout='[{"fingerprint": "' + "a" * 64
                                 + '", "type": "virtual-machine", "architecture": "'
                                 + platform.machine() + '"}]')
        published = SimpleNamespace(returncode=0,
                                    stdout=f"Instance published with fingerprint: {'d' * 64}")
        return [
            SimpleNamespace(returncode=0, stdout="\n"),  # alias list
            listed,                                      # resolve base
            listed,                                      # cached locally
            None,                                        # launch
            None,                                        # agent probe
            None,                                        # provision
            None,                                        # stop
            BuildError("publish failed") if publish_fails else published,
            None,                                        # delete
        ]

    def _patched_build(self, results: list[object], **kwargs: object) -> tuple[dict[str, str], list[list[str]]]:
        commands: list[list[str]] = []
        remaining = list(results)

        def runner(argv: list[str], **_: object) -> object:
            commands.append(argv)
            result = remaining.pop(0) if remaining else None
            if isinstance(result, BaseException):
                raise result
            return result if result is not None else SimpleNamespace(returncode=0, stdout="")

        with patch("tools.incus_sandbox.build_image.run_owned", side_effect=runner):
            return build_image.build(config(), "images:almalinux/10/cloud", "gc-sandbox-template", **kwargs), commands

    def test_a_build_runs_the_fixed_sequence_and_reports_the_published_template(self) -> None:
        result, commands = self._patched_build(self._results())
        verbs = [command[1] for command in commands]
        self.assertEqual(verbs, ["image", "image", "image", "launch", "exec", "exec", "stop", "publish", "delete"][:len(verbs)])
        self.assertEqual(result["fingerprint"], "d" * 64)
        self.assertEqual(result["base"], "a" * 64)
        self.assertEqual(result["image"], f"local:{'d' * 64}")

    def test_a_failed_publish_still_removes_the_build_guest(self) -> None:
        commands: list[list[str]] = []
        remaining = self._results(publish_fails=True)

        def runner(argv: list[str], **_: object) -> object:
            commands.append(argv)
            result = remaining.pop(0) if remaining else None
            if isinstance(result, BaseException):
                raise result
            return result if result is not None else SimpleNamespace(returncode=0, stdout="")

        with patch("tools.incus_sandbox.build_image.run_owned", side_effect=runner):
            with self.assertRaises(BuildError):
                build_image.build(config(), "images:almalinux/10/cloud", "gc-sandbox-template")
        # The throwaway guest is removed on every exit path.
        self.assertEqual(commands[-1][1:4], ["delete", "gc-template-build", "--force"][:1] + commands[-1][2:4])
        self.assertIn("--force", commands[-1])

    def test_an_existing_template_alias_is_refused_before_anything_launches(self) -> None:
        alias_rows = SimpleNamespace(returncode=0, stdout="gc-sandbox-template,abc123\n")
        with patch("tools.incus_sandbox.build_image.run_owned", return_value=alias_rows):
            with self.assertRaises(BuildError):
                build_image.build(config(), "images:almalinux/10/cloud", "gc-sandbox-template")

    def test_the_agent_wait_gives_up_instead_of_provisioning_a_dead_guest(self) -> None:
        with patch("tools.incus_sandbox.build_image.run_owned",
                   return_value=SimpleNamespace(returncode=1)), \
             patch("tools.incus_sandbox.build_image.time.monotonic", side_effect=[0.0, 0.0, 0.0, 10_000.0]), \
             patch("tools.incus_sandbox.build_image.time.sleep"):
            with self.assertRaises(BuildError):
                build_image._await_agent(config(), "gc-template-build-1")

    def test_the_entry_point_needs_root_and_reports_the_value_to_pin(self) -> None:
        with patch("tools.incus_sandbox.build_image.os.geteuid", return_value=1000):
            with self.assertRaises(BuildError):
                build_image.main(["images:almalinux/10/cloud"])
        built = {"schema": "gc.incus-sandbox.template/v1", "base": "a" * 64,
                 "fingerprint": "d" * 64, "alias": "gc-sandbox-template", "image": f"local:{'d' * 64}"}
        with patch("tools.incus_sandbox.build_image.os.geteuid", return_value=0), \
             patch("tools.incus_sandbox.build_image.load_config", return_value=config()), \
             patch("tools.incus_sandbox.build_image.build", return_value=built), \
             patch("sys.stdout", new_callable=io.StringIO) as reported:
            self.assertEqual(build_image.main(["images:almalinux/10/cloud"]), 0)
        self.assertIn(f"local:{'d' * 64}", reported.getvalue())

    def test_cli_reports_invalid_arguments(self) -> None:
        with patch.object(sys, "argv", ["build-image.py"]):
            with self.assertRaises(SystemExit) as result:
                runpy.run_module("tools.incus_sandbox.build_image", run_name="__main__")
        self.assertEqual(result.exception.code, 64)


if __name__ == "__main__":
    unittest.main()
