# Agent Instructions

This repository is developed through its own Ground Control `/implement` workflow. Requirements and ADRs are repo-local files (issue #1500): there is no backend, database, or frontend.

## Ground Control Context

This repo's Ground Control project id, workflow commands, SonarCloud
settings, and plan rules live in `.ground-control.yaml` at repo root
(with larger rule files under `.gc/`). Agents read it via the
`gc_get_repo_ground_control_context` MCP tool, which returns the full
workflow config in a single call.

## Workflow Notes

- Pass full requirement UIDs exactly as they appear at `docs/requirements/<UID>/requirement.md`.
- Do not synthesize or rewrite requirement prefixes.
- During implementation, run the narrowest tests that exercise the changed behavior. Run `make mcp-test` and `make policy` once through the final verification boundary; reuse its exact-input evidence while the tree and bound inputs remain unchanged. Those are the shared repo-native gates for both Claude and Codex.
- Do not rely on agent-specific user-level hooks as the only enforcement layer. Keep repo-native checks and docs in sync; the tool layer is the trust boundary, so prose the MCP tools cannot enforce is not a control.
- See `docs/DEVELOPMENT_WORKFLOW.md` for the full `/implement` workflow and its sibling lanes.
