// GitHub REST reads and writes for the release-identity log (issue #1579, ADR-097).
//
// Bound to the authorized repository and pinned to github.com, the only host repository
// authorization accepts. Nothing here writes a branch, a tag, or a file: event commits are created
// detached and are reachable only from ledger references. File existence is decided by walking Git
// trees at an immutable commit, never through the Contents API, which follows symlinks.

import { ghRestJson } from "./github-rest.js";

const GITHUB_HOST = "github.com";
const CALL_TIMEOUT_MS = 30_000;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);
const TREE_CACHE_MAX = 1024;

function encodeRefPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function requireObjectId(value, what) {
  if (typeof value !== "string" || !OBJECT_ID_RE.test(value)) throw new Error(`GitHub returned an invalid ${what}`);
  return value;
}

export function githubReleaseLedgerApi({ repoRoot, owner, name, restJson = ghRestJson }) {
  const repo = `/repos/${owner}/${name}`;
  const call = (path, options = {}) =>
    restJson(repoRoot, path, { hostname: GITHUB_HOST, timeout: CALL_TIMEOUT_MS, ...options });
  const trees = new Map();

  async function listRefs(namespace) {
    const refs = await call(`${repo}/git/matching-refs/${encodeRefPath(namespace)}`, { paginate: true });
    if (!Array.isArray(refs)) throw new Error("GitHub returned an invalid reference listing");
    return refs.map((ref) => ({ ref: ref?.ref, sha: ref?.object?.sha }));
  }

  async function readCommit(sha) {
    const payload = await call(`${repo}/git/commits/${requireObjectId(sha, "commit id")}`);
    if (payload?.sha !== sha || typeof payload.message !== "string" || !Array.isArray(payload.parents)) {
      throw new Error("GitHub returned a commit that does not describe the requested object");
    }
    return {
      sha,
      message: payload.message,
      treeSha: requireObjectId(payload.tree?.sha, "tree id"),
      parents: payload.parents.map((parent) => requireObjectId(parent?.sha, "parent id")),
    };
  }

  async function readTree(sha) {
    if (trees.has(sha)) return trees.get(sha);
    const payload = await call(`${repo}/git/trees/${requireObjectId(sha, "tree id")}`);
    if (payload?.truncated !== false || !Array.isArray(payload.tree)) {
      throw new Error("GitHub returned an incomplete tree");
    }
    if (trees.size >= TREE_CACHE_MAX) trees.delete(trees.keys().next().value);
    trees.set(sha, payload.tree);
    return payload.tree;
  }

  return {
    repository: `${owner}/${name}`,
    listRefs,
    readCommit,

    async readIssue(issueNumber) {
      return call(`${repo}/issues/${issueNumber}`);
    },

    /** The exact reference's target, or null when it does not exist. */
    async readRef(ref) {
      const match = (await listRefs(ref.replace(/^refs\//, ""))).find((entry) => entry.ref === ref);
      return match == null ? null : requireObjectId(match.sha, "reference target");
    },

    /** The head commit and root tree of `refs/heads/<branch>`, or null when the branch is absent. */
    async branchHead(branch) {
      const ref = `refs/heads/${branch}`;
      const match = (await listRefs(`heads/${branch}`)).find((entry) => entry.ref === ref);
      if (match == null) return null;
      const commit = await readCommit(requireObjectId(match.sha, "branch head"));
      return { sha: commit.sha, treeSha: commit.treeSha };
    },

    /**
     * Classify `path` in the tree of a commit: `absent`, `file` (a regular blob, with its sha),
     * `other` (a symlink, submodule, or directory), or `blocked` (an ancestor is not a directory).
     */
    async lookupPath(rootTreeSha, path) {
      const segments = path.split("/");
      let treeSha = rootTreeSha;
      for (const [index, segment] of segments.entries()) {
        const entry = (await readTree(treeSha)).find((candidate) => candidate?.path === segment);
        if (entry == null) return { kind: "absent" };
        if (index === segments.length - 1) {
          return entry.type === "blob" && REGULAR_FILE_MODES.has(entry.mode)
            ? { kind: "file", sha: requireObjectId(entry.sha, "blob id") }
            : { kind: "other" };
        }
        if (entry.type !== "tree") return { kind: "blocked" };
        treeSha = requireObjectId(entry.sha, "tree id");
      }
      return { kind: "absent" };
    },

    async readBlobText(sha, maxBytes) {
      const payload = await call(`${repo}/git/blobs/${requireObjectId(sha, "blob id")}`);
      if (!Number.isInteger(payload?.size) || payload.size > maxBytes || payload.encoding !== "base64") return null;
      return Buffer.from(payload.content ?? "", "base64").toString("utf8");
    },

    async createCommit({ message, treeSha, parentSha }) {
      const payload = await call(`${repo}/git/commits`, {
        method: "POST",
        fields: { message, tree: treeSha, "parents[]": parentSha },
      });
      return requireObjectId(payload?.sha, "created commit id");
    },

    async createRef(ref, sha) {
      await call(`${repo}/git/refs`, { method: "POST", fields: { ref, sha } });
    },

    async listIssueComments(issueNumber) {
      const comments = await call(`${repo}/issues/${issueNumber}/comments?per_page=100`, { paginate: true });
      if (!Array.isArray(comments)) throw new Error("GitHub returned an invalid comment listing");
      return comments;
    },

    async postIssueComment(issueNumber, body) {
      const payload = await call(`${repo}/issues/${issueNumber}/comments`, { method: "POST", fields: { body } });
      return typeof payload?.html_url === "string" ? payload.html_url : null;
    },

    async authenticatedLogin() {
      const payload = await call("/user");
      return typeof payload?.login === "string" && payload.login !== "" ? payload.login : null;
    },
  };
}
