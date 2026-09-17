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
- During implementation, run the narrowest tests that exercise the changed behavior. CI owns the full MCP suite and repository policy checks; do not run them as a mandatory local publish or synchronization step.
- Do not rely on agent-specific user-level hooks as the only enforcement layer. Keep repo-native checks and docs in sync; the tool layer is the trust boundary, so prose the MCP tools cannot enforce is not a control.
- See `docs/DEVELOPMENT_WORKFLOW.md` for the full `/implement` workflow and its sibling lanes.

## Starting Worktree Boundary

The canonical repository top-level where a task begins is that task's starting
worktree. Agents and delegated agents MUST NOT make repository changes outside
the starting worktree without explicit user authorization naming the other
repository or worktree. This includes creating, editing, or deleting files;
changing Git state; and invoking write-capable repository tools from another
checkout. Read-only inspection outside the starting worktree is allowed.

Invoking a workflow whose documented purpose creates an isolated worktree is
explicit authorization only for that workflow's documented target and
operations. It does not authorize unrelated changes elsewhere.
