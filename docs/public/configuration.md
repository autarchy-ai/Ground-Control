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
| `release_families` | Versioned artifacts, such as evidence snapshots, that need a unique release number. See below. |

Optional sections (`cross_cutting_concerns`, `architecture`, `routing`, and more) give
agents more context. The
[MCP server reference](https://github.com/autarchy-ai/Ground-Control/blob/dev/mcp/ground-control/README.md)
documents every setting.

### Versioned artifact releases

If your repository publishes numbered artifacts, two changes in progress at the
same time can both pick the same next number. Declare each series as a release
family, and the agent reserves its number before it generates the artifact:

```yaml
release_families:
  coverage:
    base_branch: dev
    sequence_floor: 8
    version_template: "{sequence}.0.0"
    paths:
      snapshot: docs/coverage/execution-snapshot-v{sequence}.json
```

| Setting | Purpose |
| --- | --- |
| `base_branch` | The branch whose definition is authoritative. Defaults to `workflow.base_branch`. |
| `sequence_floor` | The first number to hand out. Set it past any artifact that already exists. |
| `version_template` | The release name. Use `{sequence}`, or `{sequence+1}` or `{sequence-1}` when the name and the file number differ. |
| `paths` | Where each artifact of a release is written. A path can also use `{version}`. |

A family takes effect once it is merged into its base branch. Numbers are never
reused, including for a reservation that was abandoned.

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
