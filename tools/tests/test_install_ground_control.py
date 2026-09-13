"""Tests for bin/install-ground-control.sh - the general Ground Control host installer.

The installer runs against an isolated HOME and XDG data directory, so the host's
real skill and binary directories are never touched.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INSTALLER = REPO_ROOT / "bin" / "install-ground-control.sh"
DISPATCHER_SOURCE = REPO_ROOT / "bin" / "gc-test-dispatch"
PACKAGE_SOURCE = REPO_ROOT / "tools" / "gc_dispatch"

EXIT_UNKNOWN_OPTION = 2
EXIT_UNMANAGED_TARGET = 3


class InstallGroundControlTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gc-install-"))
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.bin = self.home / ".local" / "bin"
        self.data = self.home / ".local" / "share"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_installer(self, *args, check=True):
        env = dict(os.environ, HOME=str(self.home), XDG_DATA_HOME=str(self.data))
        return subprocess.run(
            ["bash", str(INSTALLER), "--no-skills", *args],
            env=env, capture_output=True, text=True, timeout=120, check=check,
        )

    @property
    def installed_binary(self):
        return self.bin / "gc-test-dispatch"

    @property
    def installed_package(self):
        return self.data / "ground-control" / "gc_dispatch"

    def test_it_installs_a_runnable_dispatcher(self):
        self.run_installer()
        self.assertTrue(self.installed_binary.is_file())
        self.assertTrue(os.access(self.installed_binary, os.X_OK))
        self.assertTrue((self.installed_package / "cli.py").is_file())

    def test_the_installed_dispatcher_runs_without_the_checkout(self):
        self.run_installer()
        relocated = self.tmp / "moved-checkout"
        relocated.mkdir()
        shutil.copy2(self.installed_binary, relocated / "gc-test-dispatch")

        # The relocated copy has no sibling checkout, so it must resolve its
        # package from the installed data directory through the normal path.
        runtime = self.tmp / "run"
        runtime.mkdir()
        env = dict(os.environ, HOME=str(self.home), XDG_DATA_HOME=str(self.data),
                   XDG_CONFIG_HOME=str(self.home / ".config"), XDG_RUNTIME_DIR=str(runtime))
        result = subprocess.run(
            [sys.executable, str(relocated / "gc-test-dispatch"),
             "--profile", "unit", "--", sys.executable, "-c", "print('ran')"],
            env=env, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ran")

    def test_the_installed_binary_is_a_copy_not_a_link_into_the_checkout(self):
        self.run_installer()
        self.assertFalse(self.installed_binary.is_symlink())
        self.assertFalse(self.installed_package.is_symlink())
        self.assertEqual(
            self.installed_binary.read_text(encoding="utf-8"),
            DISPATCHER_SOURCE.read_text(encoding="utf-8"),
        )

    def test_a_dry_run_writes_nothing(self):
        result = self.run_installer("--dry-run")
        self.assertFalse(self.installed_binary.exists())
        self.assertFalse(self.installed_package.exists())
        self.assertIn("DRY-RUN", result.stdout)

    def test_reinstalling_is_idempotent(self):
        self.run_installer()
        first = self.installed_binary.read_bytes()
        self.run_installer()
        self.assertEqual(self.installed_binary.read_bytes(), first)

    def test_a_stale_install_is_refreshed(self):
        self.run_installer()
        (self.installed_package / "cli.py").write_text("# stale\n", encoding="utf-8")
        self.run_installer("--force")
        self.assertEqual(
            (self.installed_package / "cli.py").read_text(encoding="utf-8"),
            (PACKAGE_SOURCE / "cli.py").read_text(encoding="utf-8"))

    def test_it_refuses_to_clobber_an_unmanaged_host_binary(self):
        self.bin.mkdir(parents=True)
        self.installed_binary.write_text("#!/bin/sh\necho local\n", encoding="utf-8")
        result = self.run_installer(check=False)
        self.assertEqual(result.returncode, EXIT_UNMANAGED_TARGET, result.stderr)
        self.assertIn("--force", result.stderr)
        self.assertEqual(self.installed_binary.read_text(encoding="utf-8"),
                         "#!/bin/sh\necho local\n")

    def test_force_overwrites_an_unmanaged_host_binary(self):
        self.bin.mkdir(parents=True)
        self.installed_binary.write_text("#!/bin/sh\necho local\n", encoding="utf-8")
        self.run_installer("--force")
        self.assertEqual(self.installed_binary.read_text(encoding="utf-8"),
                         DISPATCHER_SOURCE.read_text(encoding="utf-8"))

    def test_skills_are_installed_through_the_existing_skill_installer(self):
        # The general installer must delegate rather than reimplement the skill
        # install rules; --dry-run makes the delegation observable without writing.
        env = dict(os.environ, HOME=str(self.home), XDG_DATA_HOME=str(self.data))
        result = subprocess.run(
            ["bash", str(INSTALLER), "--dry-run", "--no-codex", "--no-cursor",
             "--claude-dir", str(self.tmp / "skills")],
            env=env, capture_output=True, text=True, timeout=120, check=True,
        )
        self.assertIn("implement", result.stdout)
        self.assertFalse((self.tmp / "skills").exists())

    def test_an_unknown_option_is_refused(self):
        result = self.run_installer("--nope", check=False)
        self.assertEqual(result.returncode, EXIT_UNKNOWN_OPTION, result.stderr)

    def test_the_help_text_documents_the_dispatcher(self):
        result = self.run_installer("--help")
        self.assertIn("gc-test-dispatch", result.stdout)


if __name__ == "__main__":
    unittest.main()
