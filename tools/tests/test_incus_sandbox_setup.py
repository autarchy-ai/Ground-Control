"""Behavioral contracts for installing and upgrading the sandbox programs."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class SetupContractTest(unittest.TestCase):
    def test_root_helper_is_directly_executable_as_a_python_program(self) -> None:
        root = Path(__file__).resolve().parents[2]
        helper = (root / "tools/incus_sandbox/helper.py").read_text(encoding="utf-8")
        self.assertTrue(helper.startswith("#!/usr/bin/python3\n"))

    def test_setup_installs_the_closed_guest_transfer_programs(self) -> None:
        root = Path(__file__).resolve().parents[2]
        setup = (root / "tools/incus_sandbox/setup.sh").read_text(encoding="utf-8")
        self.assertIn("guest_bootstrap.py", setup)
        self.assertIn("migration.py", setup)
        self.assertIn("migration_packet.py", setup)
        self.assertIn("migration_guard.mjs", setup)
        self.assertIn("transfer.py", setup)
        self.assertIn("source.mjs", setup)
        self.assertIn("task_environment.py", setup)
        self.assertIn("task_launcher.py", setup)
        self.assertIn("task_client.mjs", setup)
        self.assertIn("transfer.py *", setup)
        self.assertIn("^(images:|local:)", setup)
        self.assertNotIn("^(sha256:|images:)", setup)

    def test_dry_run_is_explicit_about_owned_resources_and_never_flushes_firewalls(self) -> None:
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run(["bash", str(root / "tools/incus_sandbox/setup.sh"), "--dry-run", "install"],
                                capture_output=True, text=True, check=True)
        self.assertIn("incus project create gc-sandbox", result.stdout)
        self.assertIn("nft -f", result.stdout)
        self.assertIn("btrfs size=64GiB", result.stdout)
        self.assertIn("quota write probe", result.stdout)
        self.assertIn('profile device add gc-sandbox-default root disk path=/ pool=gc-sandbox-pool --project gc-sandbox', result.stdout)
        self.assertIn('project set gc-sandbox restricted.devices.nic allow', result.stdout)
        self.assertIn('profile device add gc-sandbox-default agent disk source=agent:config --project gc-sandbox', result.stdout)
        self.assertIn("record network-addresses.sha256", result.stdout)
        self.assertNotIn("flush ruleset", result.stdout)
        self.assertNotIn("mkfs", result.stdout)

    def test_dry_run_rollback_refuses_to_remove_running_owned_vms(self) -> None:
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run(["bash", str(root / "tools/incus_sandbox/setup.sh"), "--dry-run", "rollback"],
                                capture_output=True, text=True, check=True)
        self.assertIn("refuse rollback while owned VMs are running", result.stdout)

    def test_dry_run_upgrade_is_non_destructive_and_versions_the_policy(self) -> None:
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run(["bash", str(root / "tools/incus_sandbox/setup.sh"), "--dry-run", "upgrade"],
                                capture_output=True, text=True, check=True)
        self.assertIn("upgrade sandbox programs", result.stdout)
        self.assertIn("config to v3", result.stdout)
        self.assertNotIn("project delete", result.stdout)

    def test_upgrade_program_install_uses_its_payload_and_preserves_ownership(self) -> None:
        root = Path(__file__).resolve().parents[2]
        setup = (root / "tools/incus_sandbox/setup.sh").read_text(encoding="utf-8")
        functions = setup[setup.index("run() {"):setup.index("\ninstall_resources() {")]
        with tempfile.TemporaryDirectory(prefix="gc-incus-setup-upgrade-") as directory:
            sandbox = Path(directory)
            install_root, config_root, state_root = sandbox / "install", sandbox / "config", sandbox / "state"
            rules_path, ownership = sandbox / "rules.nft", state_root / "setup-owned"
            sudoers, client = sandbox / "sudoers", sandbox / "bin/gc-incus-sandbox"
            source, guard = sandbox / "bin/source.mjs", sandbox / "bin/migration_guard.mjs"
            task_client = sandbox / "bin/task_client.mjs"
            repository_identity = sandbox / "bin/repository_identity.mjs"
            source_binding = sandbox / "bin/source_binding.mjs"
            legacy = (client, source, guard, task_client, repository_identity, source_binding)
            config_root.mkdir()
            state_root.mkdir()
            client.parent.mkdir(parents=True)
            for path in legacy:
                path.write_text("an earlier standalone client\n", encoding="utf-8")
            (config_root / "config.json").write_text("{}\n", encoding="utf-8")
            original = "files\nsudoers\nrules\nconfig\nproject\npool\nnetwork\nprofile\ncomplete\nforwarding FORWARD\n"
            ownership.write_text(original, encoding="utf-8")
            ownership.chmod(0o600)
            functions = functions.replace('/usr/local/bin/gc-incus-sandbox', str(client))
            functions = functions.replace('/usr/local/bin/source.mjs', str(source))
            functions = functions.replace('/usr/local/bin/migration_guard.mjs', str(guard))
            functions = functions.replace('/usr/local/bin/task_client.mjs', str(task_client))
            functions = functions.replace('/usr/local/bin/repository_identity.mjs', str(repository_identity))
            functions = functions.replace('/usr/local/bin/source_binding.mjs', str(source_binding))
            functions = functions.replace('/etc/sudoers.d/gc-incus-sandbox', str(sudoers))
            functions = functions.replace('/var/log/gc-incus-sandbox', str(sandbox / "log"))
            harness = sandbox / "upgrade-harness.sh"
            harness.write_text(
                "set -euo pipefail\n"
                f"INSTALL_ROOT={install_root}\nCONFIG_ROOT={config_root}\nSTATE_ROOT={state_root}\n"
                f"RULES_PATH={rules_path}\nOWNERSHIP_RECORD={ownership}\n"
                f"PAYLOAD_ROOT={root / 'tools/incus_sandbox'}\ndry_run=false\n"
                "visudo() { return 0; }\n" + functions + "\ninstall_files true\n",
                encoding="utf-8",
            )
            environment = {**os.environ, "SUDO_UID": str(os.getuid()), "SUDO_USER": "sandbox"}
            unrelated = sandbox / "unrelated-working-directory"
            unrelated.mkdir()
            subprocess.run(["bash", str(harness)], cwd=unrelated, env=environment, check=True)
            self.assertEqual(ownership.read_text(encoding="utf-8"), original)
            # The lifecycle client runs from the grndctl package; an upgrade removes the old copy.
            self.assertEqual([path for path in legacy if path.exists()], [])

    def test_firewall_has_a_scoped_input_deny_and_rollback_requires_the_ownership_record(self) -> None:
        root = Path(__file__).resolve().parents[2]
        rules = (root / "tools/incus_sandbox/gc-incus-sandbox.nft").read_text(encoding="utf-8")
        setup = (root / "tools/incus_sandbox/setup.sh").read_text(encoding="utf-8")
        self.assertIn("chain input", rules)
        self.assertIn('iifname "gcbr0" ip daddr @host_ipv4 drop', rules)
        self.assertIn("require_complete_ownership_record", setup)
        self.assertIn("require_program_ownership_record", setup)
        self.assertIn("setup-owned", setup)


if __name__ == "__main__":
    unittest.main()
