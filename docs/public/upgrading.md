# Upgrading

```bash
npm update -g grndctl
grndctl install-skills
```

Then restart your agent sessions. A running server keeps the version it started
with.

To pin or roll back to a specific version:

```bash
npm install -g grndctl@1.2.0
```

## Moving from a checkout install

Older setups ran the server from a Ground Control clone
(`node /path/to/Ground-Control/mcp/ground-control/index.js`) and symlinked the skills
into that clone. With that setup, agents ran whatever branch the clone had checked
out. To move to the released package:

1. [Install](install.md) `grndctl` and run `grndctl install-skills`. It replaces the
   skill symlinks with copies.
2. In each repository, run `grndctl init`. It replaces the old `ground-control` entry
   in `.mcp.json` and keeps your existing `.ground-control.yaml` and `.env`.
3. Run `grndctl doctor`, then restart your agent sessions.
