"""Boundary tests for building the sandbox guest template image."""

from __future__ import annotations

import unittest
from types import SimpleNamespace

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
                           vm=SimpleNamespace(disk_gib=16))


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
                         "sha256sum -c -", "gh_2.101.0_linux_"):
            self.assertIn(expected, script)
        # The template carries tooling, never a credential, a host path, or a repository.
        for forbidden in ("GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "/home/atomik", "git clone"):
            self.assertNotIn(forbidden, script)
        self.assertIn(": >/etc/machine-id", script)


if __name__ == "__main__":
    unittest.main()
