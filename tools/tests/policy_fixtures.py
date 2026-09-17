"""Shared fixtures for the policy-check test shards.

The suite was split by concern under the repo's 500-LOC limit (issue #1355). The first cut
copied these members into every shard, so a fixture correction needed 26 synchronized edits and
copies could drift into exercising inconsistent contracts. They live here once.
"""

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
    REPO_ROOT,
    main,
)


class PolicyChecksFixture(unittest.TestCase):
    """Setup and helpers shared by every policy-check shard."""

    def _implement_contract_root(self, tmp_dir):
        """Copy the surfaces run_implement_execution_contract reads into a temp root."""
        root = Path(tmp_dir)
        for rel in (
            "AGENTS.md",
            "skills/implement/SKILL.md",
            "skills/implement/_development-principles.md",
            "skills/implement/steps",
            "skills/quickfix/SKILL.md",
            ".cursor/skills/implement/SKILL.md",
            "docs/DEVELOPMENT_WORKFLOW.md",
            "mcp/ground-control/lib.js",
            "mcp/ground-control/index.js",
        ):
            source = REPO_ROOT / rel
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copy2(source, target)
        return root

    def _render_pr_body_via_js(self, input_dict):
        """Invoke `tools/render_pr_body_fixture.mjs` against the JS renderer in
        `mcp/ground-control/lib.js::buildPrBody`. Pipes JSON in, returns the
        rendered body. Skips the test if `node` is unavailable on PATH.
        The fixture script imports the actual lib.js, so this binds the
        compose contract to the real renderer instead of a copied Python
        string."""
        import shutil
        import subprocess

        if shutil.which("node") is None:
            self.skipTest("node not available on PATH; renderer compose check needs Node")
        fixture = REPO_ROOT / "tools" / "render_pr_body_fixture.mjs"
        proc = subprocess.run(
            ["node", str(fixture)],
            input=json.dumps(input_dict),
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
        )
        self.assertEqual(
            proc.returncode,
            0,
            f"renderer fixture exited {proc.returncode}: stderr={proc.stderr}",
        )
        return proc.stdout

    def _workflow_guardrail_rule(self):
        policy_path = REPO_ROOT / "architecture/policies/adr-policy.json"
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        for pol in policy.get("policies", []):
            for r in pol.get("rules", []):
                if r.get("id") == "workflow-guardrail-sync":
                    return r
        return None

    def _module_graph_registry(self, *, edges=None):
        modules = [
            {
                "id": "mcp-tools",
                "name": "MCP tools",
                "surface": "mcp",
                "owner": "@Brad-Edwards",
                "lock_level": "guarded",
                "risk_score": 2,
                "selectors": ["mcp/ground-control/gc-*.js"],
            },
            {
                "id": "mcp-lib",
                "name": "MCP lib",
                "surface": "mcp",
                "owner": "@Brad-Edwards",
                "lock_level": "locked",
                "risk_score": 4,
                "selectors": ["mcp/ground-control/lib.js"],
            },
        ]
        return {
            "schema_version": 1,
            "risk_model": "cld-v1",
            "modules": modules,
            "allowed_edges": edges if edges is not None else [{"from": "mcp-tools", "to": "mcp-lib"}],
        }

    def _write_module_graph_fixture(self, root, *, registry=None, protect=True):
        self._write_file(
            root, "architecture/registry/module-graph.json", json.dumps(registry or self._module_graph_registry())
        )
        if protect:
            protected = {
                "schema_version": 1,
                "categories": [
                    {
                        "id": "architecture-registry",
                        "name": "Architecture registry",
                        "selectors": ["architecture/registry/**"],
                        "approval_mode": "design_authority",
                        "codeowners": ["@Brad-Edwards"],
                        "weakening_detectors": [],
                        "freeze_inputs": ["architecture/registry/**"],
                    }
                ],
            }
            self._write_file(root, "architecture/registry/protected-paths.json", json.dumps(protected))

    @staticmethod
    def _write_file(root: Path, rel: str, content: str) -> str:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return rel

    @staticmethod
    def _run_main_for_event(base_ref, head_ref, body):
        import contextlib
        import io

        with tempfile.TemporaryDirectory() as tmp_dir:
            event = Path(tmp_dir) / "event.json"
            event.write_text(
                json.dumps(
                    {"pull_request": {"body": body, "base": {"ref": base_ref}, "head": {"ref": head_ref}}}
                )
            )
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                main(["--event-path", str(event), "--files", "README.md"])
            return buf.getvalue()

    def _body_with_uid_section(self, section_body):
        return (
            "## Summary\n\nFix.\n"
            f"## Requirement UIDs\n\n{section_body}\n"
            "## ADR Impact\n\nNo ADR required.\n"
            "## Ground Control Checks\n\n"
            "- [x] Repository policy checks required in CI before merge\n"
            "- [x] Pre-push code review and test-quality review completed; all findings fixed or dispositioned\n"
            "## Traceability\n\n- IMPLEMENTS: foo\n- TESTS: bar\n"
        )
