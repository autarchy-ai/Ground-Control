# Agent Instructions

Ground Control is optional maintainer tooling for this repository, not a
prerequisite for contributing. Contributors may use ordinary Git, GitHub, and
the repo-native build and test commands. Requirements and ADRs are repo-local
files (issue #1500): there is no backend, database, or frontend.

## Ground Control Context

Maintainers who opt into Ground Control use the project id, workflow commands,
SonarCloud settings, and plan rules in `.ground-control.yaml` at repo root
(with larger rule files under `.gc/`). Ground Control agents read it via the
`gc_get_repo_ground_control_context` MCP tool, which returns the full workflow
config in a single call. `.mcp.json` is per-developer and git-ignored; copy
`.mcp.json.example` to register the Ground Control, citation, and SonarQube
servers.

## Workflow Notes

- Pass full requirement UIDs exactly as they appear at `docs/requirements/<UID>/requirement.md`.
- Do not synthesize or rewrite requirement prefixes.
- During implementation, run the narrowest tests that exercise the changed behavior. CI owns the full MCP suite and repository policy checks; do not run them as a mandatory local publish or synchronization step.
- Do not rely on agent-specific user-level hooks as the only enforcement layer. Keep repo-native checks and docs in sync; the tool layer is the trust boundary, so prose the MCP tools cannot enforce is not a control.
- See `docs/DEVELOPMENT_WORKFLOW.md` for the full `/implement` workflow and its sibling lanes.

## GitGuardian findings are user-owned

Agents must never investigate, remediate, dismiss, suppress, bypass, or work
around a GitGuardian finding. Do not open the GitGuardian dashboard, request or
handle suspected secret values, rotate credentials, rewrite history, or change
code, configuration, and allowlists in response to the finding.

An agent may report only the GitHub check name, status, and check URL. If the
check blocks progress, state that the user owns every GitGuardian investigation
and resolution, then stop and wait. After the user reports that the finding is
resolved, the agent may read the GitHub check status again; it must not perform
the remediation itself.

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
