import json
import tempfile
import unittest
from pathlib import Path

from tools.policy.checks import run_optional_mcp_boundary_contract


class OptionalMcpBoundaryContractTest(unittest.TestCase):
    def test_accepts_repo_without_ground_control_registration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".mcp.json").write_text(
                json.dumps({"mcpServers": {"citation": {"command": "citation-mcp"}}}),
                encoding="utf-8",
            )

            self.assertEqual(run_optional_mcp_boundary_contract(root), [])

    def test_rejects_tracked_ground_control_registration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".mcp.json").write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "ground-control": {
                                "type": "stdio",
                                "command": "grndctl",
                                "args": ["mcp"],
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )

            violations = run_optional_mcp_boundary_contract(root)

        self.assertEqual([item.code for item in violations], ["tracked-personal-ground-control-mcp"])

    def test_live_repo_keeps_ground_control_optional(self):
        self.assertEqual(run_optional_mcp_boundary_contract(), [])


if __name__ == "__main__":
    unittest.main()
