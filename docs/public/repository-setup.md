# Set up a repository

Run these from the root of each repository you want agents to work in. They only
touch that repository.

## `grndctl init`

```bash
grndctl init
```

`init` detects a value for each setting and shows where it came from, such as
`github_repo [acme/widgets] (git remote origin)`. Press Enter to accept a value or
type a replacement. It then shows every file change and writes nothing until you
confirm. If the repository already has a `.ground-control.yaml`, `init` keeps it and
asks for no settings; it only updates `.mcp.json` and `.env`.

| File | What `init` does |
| --- | --- |
| `.ground-control.yaml` | Creates it. An existing file is never rewritten. |
| `.mcp.json` | Adds or updates the `ground-control` entry only. Other servers are kept. |
| `.env` | Creates it from the template if it is missing. Existing values are never changed. |
| `.gitignore` | Adds `.env` if it isn't already ignored. |
| `.gc/plan-rules.md` | Creates an empty file only if you ask for one. |

For scripts, `--non-interactive` requires every setting as a flag and never uses a
detected value. Run `grndctl init --help` for the flag names. `--dry-run` previews
without writing.

## Add credentials

Open `.env` and set what this repository needs. It holds this repository's
credentials and is never committed. The common ones:

- A review-engine credential for Claude, such as `CLAUDE_CONFIG_DIR`,
  `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_USE_VERTEX`
- `SONAR_TOKEN`, if the repository uses SonarCloud

Ground Control reads only this file, so each repository gets exactly the credentials
you give it. The template lists every supported variable.

## `grndctl doctor`

```bash
grndctl doctor
```

`doctor` checks the machine and the repository and names the fix for anything wrong.
It changes nothing. Once it passes, restart your agent session so it starts
`grndctl mcp` for this repository.
