# Ground Control

Ground Control runs a gated development loop for coding agents. An agent picks up a
GitHub issue, plans, implements, and ships a pull request, while separate reviewers
check its work and every decision is recorded on the issue. You merge the pull
request; everything else is automated.

It ships as one npm package, `grndctl`, with two parts:

- **The MCP server** (`grndctl mcp`), which your agent (Claude Code, Codex, or
  Cursor) talks to. It runs the `git` and `gh` side effects, the review cycles, CI and
  SonarCloud checks, and the issue-thread records.
- **The workflow skills** (`/implement`, `/quickfix`, `/integrate`, `/review`), which
  tell the agent how to drive the server.

## Get started

1. [Install](install.md) `grndctl` on your machine.
2. [Set up a repository](repository-setup.md) with `grndctl init`.
3. In an agent session in that repository, run `/implement <issue-number>`.

```{toctree}
:hidden:
:maxdepth: 2

install
repository-setup
configuration
upgrading
```

## Further reading

- [Development workflow](https://github.com/autarchy-ai/Ground-Control/blob/dev/docs/DEVELOPMENT_WORKFLOW.md): every phase of the `/implement` loop.
- [MCP server reference](https://github.com/autarchy-ai/Ground-Control/blob/dev/mcp/ground-control/README.md): the tool surface.
- [Contributing](https://github.com/autarchy-ai/Ground-Control/blob/dev/CONTRIBUTING.md): working on Ground Control itself.
