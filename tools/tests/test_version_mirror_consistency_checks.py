import copy
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import patch

from tools.policy.checks import (
    DEFERRAL_CASES_PATH,
    MCP_LIB_PATH,
    REPO_ROOT,
    Violation,
    _is_release_pr,
    _jsonpath_keys,
    _resolve_pr_refs,
    check_pr_body,
    classify_deferral_language,
    extract_step_section,
    main,
    parse_args,
    read_changed_files,
    run_adr_guard,
    _trigger_is_in_scope,
    run_documentation_coverage_check,
    run_repo_identity_drift,
    run_no_deferral_disposition_check,
    run_pr_body_check,
    run_version_mirror_consistency_check,
    run_workflow_routing_contract,
    run_implement_execution_contract,
)

if __name__ == "__main__":
    unittest.main()

class VersionMirrorConsistencyChecksTest(unittest.TestCase):
    def _write(self, root: Path, rel: str, text: str) -> Path:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p
    def _canonical_repo(self, root: Path, version: str = "1.0.1") -> None:
        self._write(root, ".release-please-manifest.json", json.dumps({".": version}) + "\n")
        self._write(
            root,
            "release-please-config.json",
            json.dumps(
                {
                    "include-component-in-tag": False,
                    "packages": {
                        ".": {
                            "release-type": "simple",
                            "extra-files": [
                                {"type": "json", "path": "frontend/package.json", "jsonpath": "$.version"},
                                {"type": "json", "path": "frontend/package-lock.json", "jsonpath": "$.version"},
                                {
                                    "type": "json",
                                    "path": "frontend/package-lock.json",
                                    "jsonpath": "$.packages[''].version",
                                },
                                "backend/build.gradle.kts",
                            ],
                        }
                    },
                }
            )
            + "\n",
        )
        self._write(root, "frontend/package.json", json.dumps({"name": "x", "version": version}) + "\n")
        self._write(
            root,
            "frontend/package-lock.json",
            json.dumps(
                {"name": "x", "version": version, "packages": {"": {"name": "x", "version": version}}}
            )
            + "\n",
        )
        self._write(
            root,
            "backend/build.gradle.kts",
            f'group = "com.keplerops"\nversion = "{version}" // x-release-please-version\n',
        )
    def test_noop_when_no_release_please(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(run_version_mirror_consistency_check(root=Path(tmp)), [])
    def test_passes_when_all_mirrors_match_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root, "1.0.1")
            self.assertEqual([v.code for v in run_version_mirror_consistency_check(root=root)], [])
    def test_drift_when_json_mirror_diverges(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root, "1.0.1")
            self._write(root, "frontend/package.json", json.dumps({"name": "x", "version": "0.76.0"}) + "\n")
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-drift", codes)
    def test_drift_when_lockfile_root_package_key_diverges(self):
        # Exercises the empty-root-package-key jsonpath $.packages[''].version.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root, "1.0.1")
            self._write(
                root,
                "frontend/package-lock.json",
                json.dumps(
                    {"name": "x", "version": "1.0.1", "packages": {"": {"name": "x", "version": "0.76.0"}}}
                )
                + "\n",
            )
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-drift", codes)
    def test_drift_when_generic_gradle_mirror_diverges(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root, "1.0.1")
            self._write(root, "backend/build.gradle.kts", 'version = "0.20.1" // x-release-please-version\n')
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-drift", codes)
    def test_drift_when_generic_mirror_has_trailing_non_semver_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root, "1.0.1")
            self._write(
                root,
                "backend/build.gradle.kts",
                'version = "1.0.1!" // x-release-please-version\n',
            )
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-drift", codes)
    def test_drift_when_mirror_file_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root, "1.0.1")
            (root / "backend" / "build.gradle.kts").unlink()
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-drift", codes)
    def test_config_missing_when_only_manifest_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write(root, ".release-please-manifest.json", json.dumps({".": "1.0.1"}) + "\n")
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-config-missing", codes)
    def test_config_invalid_when_manifest_has_no_root_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root, "1.0.1")
            self._write(root, ".release-please-manifest.json", json.dumps({"other": "1.0.1"}) + "\n")
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-config-invalid", codes)
    def test_config_invalid_when_manifest_version_is_not_semver(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root, "not-a-version")
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-config-invalid", codes)
    def test_config_invalid_when_numeric_prerelease_has_a_leading_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root, "1.2.3-01")
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-config-invalid", codes)
    def test_config_invalid_when_an_extra_file_entry_is_malformed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root)
            config_path = root / "release-please-config.json"
            config = json.loads(config_path.read_text(encoding="utf-8"))
            config["packages"]["."]["extra-files"].append({"type": "json"})
            config_path.write_text(json.dumps(config), encoding="utf-8")
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-config-invalid", codes)
    def test_config_invalid_when_an_extra_file_type_is_unsupported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root)
            config_path = root / "release-please-config.json"
            config = json.loads(config_path.read_text(encoding="utf-8"))
            config["packages"]["."]["extra-files"].append(
                {"type": "xml", "path": "pom.xml"}
            )
            config_path.write_text(json.dumps(config), encoding="utf-8")
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-config-invalid", codes)
    def test_config_invalid_when_a_mirror_path_escapes_the_repository(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._canonical_repo(root)
            config_path = root / "release-please-config.json"
            config = json.loads(config_path.read_text(encoding="utf-8"))
            config["packages"]["."]["extra-files"].append("../outside.txt")
            config_path.write_text(json.dumps(config), encoding="utf-8")
            codes = {v.code for v in run_version_mirror_consistency_check(root=root)}
            self.assertIn("version-mirror-config-invalid", codes)
    def test_jsonpath_keys_supports_empty_root_package_key(self):
        self.assertEqual(_jsonpath_keys("$.version"), ["version"])
        self.assertEqual(_jsonpath_keys("$.packages[''].version"), ["packages", "", "version"])
        self.assertEqual(_jsonpath_keys('$.packages[""].version'), ["packages", "", "version"])
    def test_repo_release_please_mirrors_are_consistent(self):
        # The real repo must be self-consistent: manifest version == every mirror.
        violations = run_version_mirror_consistency_check(root=REPO_ROOT)
        self.assertEqual(
            [v.code for v in violations],
            [],
            msg=f"real-repo version mirrors drifted: {[v.message for v in violations]}",
        )

    def test_repo_release_pr_title_preserves_release_identity(self):
        config = json.loads(
            (REPO_ROOT / "release-please-config.json").read_text(encoding="utf-8")
        )
        pattern = config.get("group-pull-request-title-pattern", "")
        self.assertIn("${scope}", pattern)
        self.assertIn("${component}", pattern)
        self.assertIn("${version}", pattern)

    def test_repo_grouped_root_release_does_not_require_a_branch_component(self):
        config = json.loads(
            (REPO_ROOT / "release-please-config.json").read_text(encoding="utf-8")
        )
        self.assertFalse(config["include-component-in-tag"])
        self.assertFalse(config["separate-pull-requests"])
        self.assertNotIn("package-name", config["packages"]["."])
