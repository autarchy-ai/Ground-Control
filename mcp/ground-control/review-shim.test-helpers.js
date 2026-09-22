import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function makeFullShimRepo({ branch, ghHandler, codexHandler }) {
    const repoDir = mkdtempSync(join(tmpdir(), "gc-fullshim-repo-"));
    execFileSync("git", ["-C", repoDir, "init", "-q", "--initial-branch", branch]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"]);
    writeFileSync(join(repoDir, "README"), "x\n");
    execFileSync("git", ["-C", repoDir, "add", "README"]);
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "init"]);
    // Pre-push reviews diff against the integration base too (#1694).
    execFileSync("git", ["-C", repoDir, "update-ref", "refs/heads/dev", "HEAD"]);
    // Real origin so owner/repo resolves from the git remote, as production does. git ignores
    // GH_REPO; the `gh repo view` fallback honours it.
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "https://github.com/fake/repo.git"]);

    const binDir = mkdtempSync(join(tmpdir(), "gc-fullshim-bin-"));
    const ghCfgPath = join(binDir, "gh-config.json");
    const ghStatePath = join(binDir, "gh-state.json");
    writeFileSync(ghCfgPath, JSON.stringify(ghHandler));
    writeFileSync(ghStatePath, JSON.stringify({ counters: {} }));
    // The shim supports two route kinds:
    //   - simple: { argv_prefix, stdout?, exit_code?, stderr? } — same response every call.
    //   - sequenced: { argv_prefix, sequenced: true, sequence: [{stdout?, exit_code?, stderr?}, ...] }
    //     Each invocation that matches the prefix consumes the next sequence
    //     entry; once exhausted, the last entry is reused. The counter is
    //     keyed by the route's argv_prefix joined with "|" and persisted in
    //     a JSON state file so successive process invocations can advance.
    const ghShim = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(ghCfgPath)}, "utf8"));
const statePath = ${JSON.stringify(ghStatePath)};
const argv = process.argv.slice(2);
function match(prefix) { return prefix.every((p, i) => argv[i] === p); }
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return { counters: {} }; }
}
function writeState(state) { fs.writeFileSync(statePath, JSON.stringify(state)); }
for (const route of cfg.routes) {
  if (match(route.argv_prefix)) {
    let entry = route;
    if (route.sequenced === true && Array.isArray(route.sequence) && route.sequence.length > 0) {
      const key = route.argv_prefix.join("|");
      const state = readState();
      const idx = state.counters[key] || 0;
      const seqEntry = route.sequence[Math.min(idx, route.sequence.length - 1)];
      state.counters[key] = idx + 1;
      writeState(state);
      entry = seqEntry;
    }
    if (entry.exit_code != null && entry.exit_code !== 0) {
      process.stderr.write(entry.stderr || "");
      process.exit(entry.exit_code);
    }
    process.stdout.write(entry.stdout || "");
    process.exit(0);
  }
}
process.stderr.write("gh shim: unhandled argv: " + JSON.stringify(argv) + "\\n");
process.exit(2);
`;
    writeFileSync(join(binDir, "gh"), ghShim, { mode: 0o755 });

    // codex shim: parses --output-last-message <path>, writes the canned tail
    // to that path AND to stdout, drains stdin so the prompt pipe doesn't
    // SIGPIPE, then exits 0.
    const codexCfgPath = join(binDir, "codex-config.json");
    writeFileSync(codexCfgPath, JSON.stringify(codexHandler));
    const codexShim = `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(codexCfgPath)}, "utf8"));
const args = process.argv.slice(2);
let outputPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output-last-message") outputPath = args[i + 1];
}
let stdinBuf = "";
process.stdin.on("data", (chunk) => { stdinBuf += chunk.toString(); });
process.stdin.on("end", () => {
  const tail = cfg.tail || "**Findings**\\n\\nNo issues found.\\n\\n===REVIEW===\\n{\\"verdict\\":\\"ship\\",\\"architectural_read\\":\\"Reviewed.\\",\\"blocking\\":[]}\\n===END===\\n";
  if (outputPath) fs.writeFileSync(outputPath, tail);
  process.stdout.write(tail);
  process.exit(cfg.exit_code || 0);
});
`;
    writeFileSync(join(binDir, "codex"), codexShim, { mode: 0o755 });

    return {
      repoDir,
      binDir,
      cleanup() {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
      },
    };
  }

export async function withShimPathFull(binDir, fn) {
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = oldPath;
    }
  }

  // Helper: post-push reviews compute diffs against a base ref
  // (`origin/dev`, `dev`, `origin/main`, `main`); the makeFullShimRepo helper
  // only creates the feature branch. Create a `dev` ref pointing at the
  // initial commit so computeReviewDiff resolves.
export function ensureBaseRef(repoDir) {
    execFileSync("git", ["-C", repoDir, "update-ref", "refs/heads/dev", "HEAD"]);
  }
