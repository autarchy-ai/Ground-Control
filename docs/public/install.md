# Install

Install once per machine.

## Requirements

- Node.js 22 or newer
- `git`, and the GitHub CLI (`gh`) signed in with `gh auth login`
- The Codex CLI (`codex`) for code review, and Claude Code (`claude`) for test-quality review

## Install the package

```bash
npm install -g grndctl
grndctl --version
```

## Install the skills

```bash
grndctl install-skills
```

This copies the workflow skills into `~/.claude/skills`, `~/.codex/skills`, and
`~/.cursor/skills`. It replaces older symlinked installs, and leaves any skill you have
edited locally untouched unless you pass `--force`. Use `--no-codex` or `--no-cursor`
to skip an agent you don't use, and `--dry-run` to preview.

Next: [set up a repository](repository-setup.md).
