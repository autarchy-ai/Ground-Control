// Shared fixture for the gc_release_identity suites (issue #1579).
//
// An in-memory GitHub that answers the exact REST paths the ledger adapter builds, including
// branch references, Git trees, and blobs. It enforces the one guarantee the design relies on —
// creating an existing reference fails with 422 — atomically, and yields to the event loop at the
// start of every call so concurrent operations genuinely interleave their reads and writes. Named
// `.test.js` for the same reason as the gc_update_issue_requirements fixture, and carries a
// self-check for the same reason.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { githubReleaseLedgerApi, resetReleaseLedgerCacheForTest, runReleaseIdentity } from "./lib.js";
import { launchAuthorizationFor, makeGitRepoWithOrigin } from "./gc-update-issue-requirements.fixture.test.js";

export const MCP_LOGIN = "gc-bot";

const sha = (text) => createHash("sha1").update(text).digest("hex");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function ghError(status, message) {
  return Object.assign(new Error("Command failed: gh api"), { stderr: `gh: ${message} (HTTP ${status})` });
}

export function familyYaml(families, { baseBranch = "dev", githubRepo = null } = {}) {
  const lines = ["schema_version: 1", "project: widgets"];
  if (githubRepo) lines.push(`github_repo: ${githubRepo}`);
  lines.push("workflow:", `  base_branch: ${baseBranch}`, "release_families:");
  for (const [family, def] of Object.entries(families)) {
    lines.push(`  ${family}:`, `    sequence_floor: ${def.sequence_floor}`, `    version_template: "${def.version_template}"`, "    paths:");
    for (const [key, path] of Object.entries(def.paths)) lines.push(`      ${key}: "${path}"`);
  }
  return `${lines.join("\n")}\n`;
}

export const COVERAGE = {
  sequence_floor: 8,
  version_template: "{sequence}.0.0",
  paths: { snapshot: "docs/coverage/execution-snapshot-v{sequence}.json" },
};
export const FORMAL = {
  sequence_floor: 10,
  version_template: "{sequence+1}.0.0",
  paths: { bundle: "docs/formal/bundles/retest-v{sequence}.json" },
};

export const blobSha = (text) => sha(`blob:${text}`);

export function makeFakeGitHub({ issues = { 7: "open" } } = {}) {
  const commits = new Map();
  const trees = new Map();
  const blobs = new Map();
  const refs = new Map();
  const comments = new Map();
  const pickupComments = new Map(Object.keys(issues).map((issue) => [issue, [{
    body: `🛠️ Picked up by /implement - driver test, branch \`${issue}-capture\`, 2026-01-01T00:00:00.000Z.`,
    user: { login: MCP_LOGIN },
    html_url: `https://github.com/o/r/issues/${issue}#issuecomment-pickup`,
  }]]));
  const calls = [];
  const faults = [];
  let counter = 0;

  // `files` maps a path to its text, or to `{ symlink: target }`.
  function buildTree(files) {
    const children = new Map();
    for (const [path, value] of Object.entries(files)) {
      const [head, ...rest] = path.split("/");
      if (rest.length === 0) children.set(head, value);
      else children.set(head, { ...(children.get(head) ?? {}), [rest.join("/")]: value });
    }
    const entries = [...children].map(([name, value]) => {
      if (typeof value === "string") {
        blobs.set(blobSha(value), value);
        return { path: name, mode: "100644", type: "blob", sha: blobSha(value) };
      }
      if (value.symlink != null) return { path: name, mode: "120000", type: "blob", sha: blobSha(`link:${value.symlink}`) };
      return { path: name, mode: "040000", type: "tree", sha: buildTree(value) };
    });
    const id = sha(`tree:${JSON.stringify(entries)}`);
    trees.set(id, entries);
    return id;
  }

  function commitBase(branch, files) {
    const head = sha(`base:${branch}:${counter++}`);
    commits.set(head, { message: "base", tree: buildTree(files), parents: [] });
    refs.set(`refs/heads/${branch}`, head);
    return head;
  }

  const notFound = () => { throw ghError(404, "Not Found"); };
  const routes = [
    ["GET", /^\/user$/, () => ({ login: MCP_LOGIN })],
    ["GET", /^\/repos\/o\/r\/issues\/(\d+)$/, ([n]) => {
      if (!issues[n]) notFound();
      return issues[n] === "pr"
        ? { number: Number(n), state: "open", pull_request: {} }
        : { number: Number(n), state: issues[n] };
    }],
    ["GET", /^\/repos\/o\/r\/issues\/(\d+)\/comments\?per_page=100$/, ([n]) => [
      ...(pickupComments.get(n) ?? []),
      ...(comments.get(n) ?? []),
    ]],
    ["POST", /^\/repos\/o\/r\/issues\/(\d+)\/comments$/, ([n], fields) => {
      const url = `https://github.com/o/r/issues/${n}#issuecomment-${1000 + counter++}`;
      comments.set(n, [...(comments.get(n) ?? []), { body: fields.body, user: { login: MCP_LOGIN }, html_url: url }]);
      return { html_url: url };
    }],
    ["GET", /^\/repos\/o\/r\/git\/matching-refs\/(.+)$/, ([namespace]) =>
      [...refs].filter(([ref]) => ref.startsWith(`refs/${decodeURIComponent(namespace)}`)).map(([ref, target]) => ({ ref, object: { sha: target } }))],
    ["GET", /^\/repos\/o\/r\/git\/commits\/([0-9a-f]+)$/, ([id]) => {
      const commit = commits.get(id) ?? notFound();
      return { sha: id, message: commit.message, tree: { sha: commit.tree }, parents: commit.parents.map((p) => ({ sha: p })) };
    }],
    ["GET", /^\/repos\/o\/r\/git\/trees\/([0-9a-f]+)$/, ([id]) => ({ sha: id, tree: trees.get(id) ?? notFound(), truncated: false })],
    ["GET", /^\/repos\/o\/r\/git\/blobs\/([0-9a-f]+)$/, ([id]) => {
      const text = blobs.get(id) ?? notFound();
      return { sha: id, size: Buffer.byteLength(text), encoding: "base64", content: Buffer.from(text).toString("base64") };
    }],
    ["POST", /^\/repos\/o\/r\/git\/commits$/, (_, fields) => {
      const id = sha(`commit:${fields.message}:${fields.tree}:${fields["parents[]"]}:${counter++}`);
      commits.set(id, { message: fields.message, tree: fields.tree, parents: [fields["parents[]"]] });
      return { sha: id };
    }],
    ["POST", /^\/repos\/o\/r\/git\/refs$/, (_, fields) => {
      if (refs.has(fields.ref)) throw ghError(422, "Reference already exists");
      refs.set(fields.ref, fields.sha);
      return { ref: fields.ref };
    }],
  ];

  async function restJson(_repoRoot, path, { method = "GET", fields = {}, hostname = null } = {}) {
    await tick();
    calls.push({ method, path, fields, hostname });
    const fault = faults.find((f) => f.remaining > 0 && f.method === method && f.match.test(path));
    if (fault) {
      fault.remaining -= 1;
      if (!fault.applyFirst) throw ghError(fault.status, fault.message);
    }
    for (const [routeMethod, pattern, handler] of routes) {
      const match = routeMethod === method ? pattern.exec(path) : null;
      if (!match) continue;
      const result = structuredClone(handler(match.slice(1), fields));
      if (fault) throw ghError(fault.status, fault.message);
      return result;
    }
    return notFound();
  }

  return {
    restJson,
    calls,
    refs,
    commits,
    comments: (issue = 7) => comments.get(String(issue)) ?? [],
    ledgerRefs: (family = "coverage", kind = "claims") =>
      [...refs.keys()].filter((ref) => ref.startsWith(`refs/gc/release-identities/${family}/${kind}/`)).sort(),
    commitBase,
    /** Fail the next `times` matching calls; `applyFirst` performs the write before failing (a lost response). */
    fail({ method, match, status = 502, message = "Bad Gateway", times = 1, applyFirst = false }) {
      faults.push({ method, match, status, message, remaining: times, applyFirst });
    },
    readEvent(ref) {
      const message = commits.get(refs.get(ref))?.message ?? "";
      return JSON.parse(message.slice(message.indexOf("\n\n") + 2));
    },
  };
}

/** A throwaway checkout with a local `.ground-control.yaml`, authorized as the launch workspace. */
export async function withReleaseFixture({
  localFamilies = { coverage: COVERAGE }, baseFamilies = localFamilies, baseFiles = {}, baseYaml = null, issues,
} = {}, run) {
  const repoDir = makeGitRepoWithOrigin("o/r");
  writeFileSync(join(repoDir, ".ground-control.yaml"), familyYaml(localFamilies));
  const github = makeFakeGitHub({ issues });
  github.commitBase("dev", { ".ground-control.yaml": baseYaml ?? familyYaml(baseFamilies), ...baseFiles });
  resetReleaseLedgerCacheForTest();
  try {
    const resolver = await launchAuthorizationFor(repoDir);
    // Each call runs as the run for its issue (branch `<issue>-capture`) unless a test names another
    // branch, or asks for the real checkout HEAD with `{ branch: "checkout" }`.
    const call = (input, { branch } = {}) => {
      const merged = { repoPath: repoDir, issueNumber: 7, family: "coverage", idempotencyKey: "capture-1", ...input };
      const deps = { workspaceAuthorizationResolver: resolver, restJson: github.restJson };
      if (branch !== "checkout") deps.readActiveBranch = async () => branch ?? `${merged.issueNumber}-capture`;
      return runReleaseIdentity(merged, deps);
    };
    return await run({ repoDir, github, resolver, call });
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

describe("gc_release_identity fixture", () => {
  it("serves branch heads, trees, and blobs, and enforces create-only references", async () => {
    const github = makeFakeGitHub();
    const head = github.commitBase("dev", { "docs/a.txt": "x", "docs/link": { symlink: "a.txt" } });
    const api = githubReleaseLedgerApi({ repoRoot: null, owner: "o", name: "r", restJson: github.restJson });
    const branch = await api.branchHead("dev");
    assert.equal(branch.sha, head);
    assert.deepEqual(await api.lookupPath(branch.treeSha, "docs/a.txt"), { kind: "file", sha: blobSha("x") });
    assert.deepEqual(await api.lookupPath(branch.treeSha, "docs/link"), { kind: "other" });
    assert.deepEqual(await api.lookupPath(branch.treeSha, "docs/a.txt/nested"), { kind: "blocked" });
    assert.deepEqual(await api.lookupPath(branch.treeSha, "docs/missing"), { kind: "absent" });
    assert.equal(await api.readBlobText(blobSha("x"), 10), "x");
    assert.equal(await api.branchHead("de"), null, "a branch-name prefix is not the branch");
    await api.createRef("refs/gc/x", head);
    await assert.rejects(api.createRef("refs/gc/x", head), (error) => /Reference already exists \(HTTP 422\)/.test(error.stderr));
    assert.ok(github.calls.every((c) => c.hostname === "github.com"), "every call pins the API host");
  });
});
