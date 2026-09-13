# Configuration

## `.ground-control.yaml`

The repository's Ground Control settings, committed with the repository.
`grndctl init` writes the essentials:

```yaml
schema_version: 1
project: widgets
github_repo: acme/widgets
workflow:
  base_branch: dev
  test_command: make test
  completion_command: make check
  lint_command: make lint
sonarcloud:
  project_key: acme_widgets
  organization: acme
```

| Setting | Purpose |
| --- | --- |
| `project` | Lowercase identifier for the repository. Required. |
| `github_repo` | `owner/name`. It must match the `origin` remote. |
| `workflow.base_branch` | The branch pull requests target. |
| `workflow.test_command` | Fast tests the agent runs while implementing. |
| `workflow.completion_command` | The full gate every change must pass before it is published. |
| `sonarcloud` | Enables the SonarCloud gate. Omit it if the repository doesn't use SonarCloud. |
| `rules.plan_rules` | A Markdown file of repository-specific rules every plan must follow. |
| `docs.adr_dir` | Where the repository's architecture decision records live. |

Optional sections (`cross_cutting_concerns`, `architecture`, `routing`, and more) give
agents more context. The
[MCP server reference](https://github.com/autarchy-ai/Ground-Control/blob/dev/mcp/ground-control/README.md)
documents every setting.

## `.env`

Credentials and tuning for this repository, read from the directory the server
starts in and nowhere else. It is never committed. See
[Set up a repository](repository-setup.md#add-credentials).

## `.mcp.json`

Tells your agent how to start the server:

```json
{
  "mcpServers": {
    "ground-control": { "type": "stdio", "command": "grndctl", "args": ["mcp"] }
  }
}
```
