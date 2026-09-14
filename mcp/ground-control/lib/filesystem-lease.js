// Heartbeat-backed filesystem lease (promoted under issue #1495).
//
// A proper-lockfile-backed advisory lease Ground Control uses to serialize
// mutating work on a directory across processes. It was born in the knowledge
// base, gained an integration caller, and now has a third real caller in the
// mechanical publish base-sync. The 500-LOC gate (ADR-092) and the preflight's
// "reuse, do not duplicate lock mechanics" rule put the shared mechanics in one
// module; decision-records.js and the publish path import from here rather than
// each re-implementing acquisition, stale detection, and idempotent release.

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import properLockfile from "proper-lockfile";
import { EXECUTION_OBLIGATION_ID_RE } from "./codex-workflow.js";

// Validate that a caller-supplied path is an absolute, existing directory and
// return its canonical realpath. `label` names the acquirer so a bad path
// produces the acquirer's own diagnostic. Three real callers share this.
function canonicalLeaseDirectory(label, path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error(`${label}: path must be an absolute directory path`);
  }
  let canonical;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- absolute path validated above
    canonical = realpathSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label}: path does not exist: ${path}`);
    }
    throw error;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonical is a realpath
  const stat = statSync(canonical);
  if (!stat.isDirectory()) {
    throw new Error(`${label}: path is not a directory: ${path}`);
  }
  return canonical;
}

// Acquire the advisory lock file `<canonicalDir>/<lockfileBasename>`. Returns an
// idempotent release handle. `stale`/`update` give the lock a heartbeat so a
// crashed holder's lock is reclaimable without a manual sweep.
async function acquireFilesystemLock(canonicalDir, lockfileBasename, { retries = 0, lockedMessage } = {}) {
  let release;
  try {
    release = await properLockfile.lock(canonicalDir, {
      stale: 60_000,
      update: 10_000,
      retries,
      lockfilePath: join(canonicalDir, lockfileBasename),
      realpath: false,
    });
  } catch (error) {
    if (error.code === "ELOCKED") {
      const msg = lockedMessage ?? `directory is already held by another process: ${canonicalDir}`;
      const contended = new Error(msg);
      contended.code = "ELOCKED";
      contended.path = canonicalDir;
      throw contended;
    }
    throw error;
  }

  let released = false;
  return async function releaseHandle() {
    if (released) return;
    released = true;
    try {
      await release();
    } catch (error) {
      // "Lock is already released" is fine — observed release via another path.
      if (error.code !== "ENOTACQUIRED" && !/already released/i.test(error.message)) {
        throw error;
      }
    }
  };
}

export async function acquireKnowledgeLock(knowledgeDir, { retries = 0 } = {}) {
  const canonical = canonicalLeaseDirectory("acquireKnowledgeLock", knowledgeDir);
  return acquireFilesystemLock(canonical, ".gc-lock", {
    retries,
    lockedMessage: `knowledge base is already held by another process: ${canonical}`,
  });
}

export async function acquireIntegrationLock(repoRoot, { retries = 0 } = {}) {
  const canonical = canonicalLeaseDirectory("acquireIntegrationLock", repoRoot);
  return acquireFilesystemLock(canonical, ".gc-integration-lock", {
    retries,
    lockedMessage: `integration run is already in progress at: ${canonical}`,
  });
}

// The mechanical publish base-sync mutation lease. The directory is the
// authorized per-worktree Git metadata directory (`git rev-parse --git-dir`),
// so the lock file lives in Git metadata, never the working tree, and a linked
// worktree gets its own lease instead of serializing on the common directory.
// The issue-scope read-modify-write lease (issue #1569). gc_update_issue_requirements
// GETs the issue body, resolves requirements, transforms, and PATCHes; without
// serialization two concurrent `add` calls interleave so the slower one writes a body
// derived from a stale scope and silently drops the UID the faster one added — a
// narrowing that `add` is supposed to be incapable of. Like the publish lease, the lock
// file lives in the per-worktree Git metadata directory, never the working tree.
export async function acquireIssueScopeLock(gitDir, { retries = 5 } = {}) {
  const canonical = canonicalLeaseDirectory("acquireIssueScopeLock", gitDir);
  return acquireFilesystemLock(canonical, ".gc-issue-scope-lock", {
    retries,
    lockedMessage: `an issue-scope update is already in progress for: ${canonical}`,
  });
}

// The station-observation reconciliation lease (issue #1582). Reconciliation reads the thread,
// decides, and appends a `reobserved` resolution; two concurrent calls for the same obligation
// would each see it open and each append one. Keyed by issue and obligation so unrelated
// reconciliations do not contend; the lock file lives in per-worktree Git metadata.
export async function acquireStationObservationReconcileLock(gitDir, { issueNumber, obligationId, retries = 5 }) {
  const canonical = canonicalLeaseDirectory("acquireStationObservationReconcileLock", gitDir);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !EXECUTION_OBLIGATION_ID_RE.test(String(obligationId))) {
    throw new Error("acquireStationObservationReconcileLock: issueNumber and obligationId must be canonical");
  }
  return acquireFilesystemLock(canonical, `.gc-station-observation-${issueNumber}-${obligationId}-lock`, {
    retries,
    lockedMessage: `a reconciliation of ${obligationId} is already in progress for: ${canonical}`,
  });
}

export async function acquireImplementPublishLock(gitDir, { retries = 0 } = {}) {
  const canonical = canonicalLeaseDirectory("acquireImplementPublishLock", gitDir);
  return acquireFilesystemLock(canonical, ".gc-publish-lock", {
    retries,
    lockedMessage: `an implement publish is already in progress for: ${canonical}`,
  });
}
