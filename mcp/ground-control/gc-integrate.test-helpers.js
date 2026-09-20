// Shared dep factories for the /integrate lane's tests.
//
// Extracted under issue #1559: splitting the Sonar-watcher-mapping suite into
// its own file for the 500-LOC limit (docs/CODING_STANDARDS.md, ADR-092) would
// otherwise have copied these four factories into a second file. Bodies are
// unchanged from gc-integrate.gc-integration-manager-sonar-watcher-mapping.test.js.

/** A ground-control.yaml that passes the parser (schema_version + project are the minimum). */
export function validYaml(integrationManagerBlock = "") {
  return `schema_version: 1
project: test-project
${integrationManagerBlock}`;
}

/** A fake PR entry in the shape the GitHub API returns. */
export function makePr(n, labels = ["approved-for-integration"]) {
  return {
    number: n,
    head: { ref: `feature/pr-${n}`, sha: `sha${n}` },
    base: { ref: "dev" },
    created_at: `2026-05-0${n}T00:00:00Z`,
    updated_at: `2026-05-0${n}T01:00:00Z`,
    labels: labels.map((name) => ({ name })),
  };
}

/**
 * An execFile fake returning one page with the given PRs and empty pages after.
 * Records every argv array it receives.
 */
export function makeExecFileFake(pages) {
  const calls = [];
  return {
    calls,
    execFile: async (file, argv) => {
      calls.push([file, ...argv]);
      // Detect the page number from the --field page=N argument.
      const pageIdx = argv.findIndex((a) => a.startsWith("page="));
      const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
      const pageData = pages[pageNum - 1] ?? [];
      return { stdout: JSON.stringify(pageData), stderr: "" };
    },
  };
}

/** Deps that make the plan action succeed with the given PRs. */
export function happyDeps({ prs = [], yaml = validYaml(), owner = "acme", repo = "myrepo" } = {}) {
  const execFileFake = makeExecFileFake([prs]);
  return {
    execFile: execFileFake.execFile,
    execFileCalls: execFileFake.calls,
    resolveWorkspaceRoot: () => "/some/repo",
    ensureGitRepo: async (p) => p,
    getOwnerRepo: async () => ({ owner, name: repo }),
    readYaml: () => yaml,
  };
}

// --- prepare-action factories ---

// Build a lock that tracks acquire/release counts, and can be forced to ELOCKED.
export function makeLockFake({ locked = false } = {}) {
  let acquireCount = 0;
  let releaseCount = 0;

  return {
    getAcquireCount: () => acquireCount,
    getReleaseCount: () => releaseCount,
    acquireIntegrationLock: async (_repoRoot) => {
      if (locked) {
        const e = new Error("integration run is already in progress");
        e.code = "ELOCKED";
        throw e;
      }
      acquireCount++;
      return async () => {
        releaseCount++;
      };
    },
  };
}

// Build a worktree-capable execFile fake for prepare tests.
// `stepHandlers` is an array of functions `(file, argv) => result|throws`.
// Falls back to the default (gh API page 1) if no handler matches.
export function makePrepareExecFileFake(prs, stepHandlers = []) {
  const calls = [];
  let handlerIdx = 0;

  return {
    calls,
    execFile: async (file, argv, _options) => {
      calls.push([file, ...argv]);

      // The pushed-head read (issue #1365) is answered ahead of the step
      // handlers so adding it did not shift every existing handler index.
      if (file === "git" && argv.includes("rev-parse")) {
        return { stdout: `${"0".repeat(32)}pushedhead\n`, stderr: "" };
      }

      // First check step handlers in order.
      if (handlerIdx < stepHandlers.length) {
        const handler = stepHandlers[handlerIdx];
        handlerIdx++;
        return handler(file, argv);
      }

      // Default: gh api calls return the prs list on page 1, empty after.
      if (file === "gh" && argv.includes("api")) {
        const pageIdx = argv.findIndex((a) => a.startsWith("page="));
        const pageNum = pageIdx >= 0 ? Number(argv[pageIdx].split("=")[1]) : 1;
        const pageData = pageNum === 1 ? prs : [];
        return { stdout: JSON.stringify(pageData), stderr: "" };
      }

      // Default: all git calls succeed.
      return { stdout: "", stderr: "" };
    },
  };
}

// Build the deps object for a prepare test.
// `overrides` let individual tests replace specific deps.
export function prepareDeps(overrides = {}) {
  const prs = overrides.prs ?? [makePr(1)];
  const yaml = overrides.yaml ?? validYaml();
  const lockFake = overrides.lockFake ?? makeLockFake();
  const execFileFake = overrides.execFileFake ?? makePrepareExecFileFake(prs, overrides.stepHandlers ?? []);

  return {
    execFile: execFileFake.execFile,
    execFileCalls: execFileFake.calls,
    resolveWorkspaceRoot: overrides.resolveWorkspaceRoot ?? (() => "/some/repo"),
    ensureGitRepo: overrides.ensureGitRepo ?? (async (p) => p),
    getOwnerRepo: overrides.getOwnerRepo ?? (async () => ({ owner: "acme", name: "myrepo" })),
    readYaml: overrides.readYaml ?? (() => yaml),
    acquireIntegrationLock: lockFake.acquireIntegrationLock,
    lockFake,
    writeHaltLedger: overrides.writeHaltLedger ?? (() => {}),
    runCiWatcher: overrides.runCiWatcher ?? (async () => ({ conclusion: "skipped" })),
    runSonarWatcher: overrides.runSonarWatcher ?? (async () => ({ conclusion: "skipped" })),
    // Deterministic run ID.
    now: overrides.now ?? (() => 1748000000000),
    randomId: overrides.randomId ?? (() => "abc123"),
  };
}
