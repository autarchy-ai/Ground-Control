import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureMigration, parseMigrationSpec, transferMigration } from "./source.mjs";

const GIT = "/usr/bin/git";

function git(repository, ...args) {
  const result = spawnSync(GIT, ["-C", repository, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repositoryFixture(root) {
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch=work");
  git(repository, "config", "user.email", "sandbox@example.invalid");
  git(repository, "config", "user.name", "sandbox");
  writeFileSync(join(repository, "staged.txt"), "base\n");
  writeFileSync(join(repository, "unstaged.txt"), "base\n");
  writeFileSync(join(repository, "deleted.txt"), "base\n");
  mkdirSync(join(repository, "removed-dir"));
  writeFileSync(join(repository, "removed-dir", "file.txt"), "base\n");
  git(repository, "add", ".");
  git(repository, "commit", "--quiet", "-m", "base");
  writeFileSync(join(repository, "staged.txt"), "staged\n");
  git(repository, "add", "staged.txt");
  writeFileSync(join(repository, "staged.txt"), "working-after-stage\n");
  writeFileSync(join(repository, "unstaged.txt"), "working\n");
  rmSync(join(repository, "deleted.txt"));
  rmSync(join(repository, "removed-dir"), { recursive: true });
  writeFileSync(join(repository, "selected.txt"), "selected\n");
  symlinkSync("staged.txt", join(repository, "selected-link"));
  return repository;
}

function packetParts(packet) {
  assert.equal(packet.subarray(0, 4).toString(), "GCS1");
  const metadataLength = packet.readUInt32BE(4);
  return {
    metadata: JSON.parse(packet.subarray(8, 8 + metadataLength)),
    payload: packet.subarray(8 + metadataLength),
  };
}

const SPEC = {
  schema: "gc.incus-sandbox.migration-request/v1",
  checkpoint_acknowledged: true,
  source_agent_stopped: true,
  selected_untracked: ["selected.txt", "selected-link"],
  handoff: { task: "Continue issue 1645", unfinished: "Run the guest verification" },
};

test("migration request requires an acknowledged checkpoint, stopped agent, and closed fields", () => {
  assert.deepEqual(parseMigrationSpec(Buffer.from(JSON.stringify(SPEC))), SPEC);
  assert.throws(() => parseMigrationSpec(Buffer.from(JSON.stringify({ ...SPEC, source_agent_stopped: false }))),
    /old agent must be stopped/);
  assert.throws(() => parseMigrationSpec(Buffer.from(JSON.stringify({ ...SPEC, terminal: "scrape me" }))),
    /fields/);
  assert.throws(() => parseMigrationSpec(Buffer.alloc(65 * 1024)), /request exceeds/);
});

test("capture preserves staged, unstaged, deleted, symlink, and selected untracked state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-incus-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = repositoryFixture(root);
  const head = git(repository, "rev-parse", "HEAD");
  const refs = git(repository, "for-each-ref", "--format=%(refname) %(objectname)");
  const packet = captureMigration(repository, SPEC);
  const { metadata, payload } = packetParts(packet);

  assert.equal(metadata.schema, "gc.incus-sandbox.migration/v1");
  assert.equal(metadata.commit, head);
  assert.equal(metadata.branch, "work");
  assert.match(metadata.migration_id, /^[0-9a-f]{32}$/);
  assert.match(metadata.state_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(metadata.entries.index.map(({ path, deleted }) => [path, deleted ?? false]), [
    ["staged.txt", false],
  ]);
  assert.deepEqual(metadata.entries.worktree.map(({ path, deleted }) => [path, deleted ?? false]), [
    ["deleted.txt", true], ["removed-dir/file.txt", true], ["staged.txt", false], ["unstaged.txt", false],
  ]);
  assert.deepEqual(metadata.entries.untracked.map(({ path, mode }) => [path, mode]), [
    ["selected-link", "120000"], ["selected.txt", "100644"],
  ]);
  assert.equal(metadata.sections[0].role, "bundle");
  assert.equal(metadata.sections.at(-1).role, "handoff");
  assert.equal(payload.length, metadata.sections.reduce((total, section) => total + section.length, 0));
  assert.doesNotMatch(packet.toString("utf8"), /\/home\/|secret-canary/);
  assert.equal(git(repository, "for-each-ref", "--format=%(refname) %(objectname)"), refs);
});

test("capture rejects credential paths, ignored selections, escaping links, and submodules before transfer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-incus-migration-reject-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = repositoryFixture(root);

  writeFileSync(join(repository, ".env"), "secret-canary\n");
  assert.throws(() => captureMigration(repository, { ...SPEC, selected_untracked: [".env"] }),
    /credential or configuration path/);

  writeFileSync(join(repository, ".gitignore"), "ignored.txt\n");
  git(repository, "add", ".gitignore");
  git(repository, "commit", "--quiet", "-m", "ignore fixture");
  writeFileSync(join(repository, "ignored.txt"), "ignored\n");
  assert.throws(() => captureMigration(repository, { ...SPEC, selected_untracked: ["ignored.txt"] }),
    /selected untracked/);

  symlinkSync("../../outside", join(repository, "escape"));
  assert.throws(() => captureMigration(repository, { ...SPEC, selected_untracked: ["escape"] }),
    /escapes the checkout/);
});

test("capture rejects LFS-managed changed paths without invoking a filter", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-incus-migration-lfs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = repositoryFixture(root);
  writeFileSync(join(repository, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  writeFileSync(join(repository, "asset.bin"), "not-an-lfs-pointer\n");
  git(repository, "add", ".gitattributes", "asset.bin");
  assert.throws(() => captureMigration(repository, { ...SPEC, selected_untracked: [] }), /unsupported_lfs/);
  assert.equal(readFileSync(join(repository, "asset.bin"), "utf8"), "not-an-lfs-pointer\n");
});

test("capture refuses intent-to-add index state instead of silently flattening it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-incus-migration-intent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = repositoryFixture(root);
  writeFileSync(join(repository, "intent.txt"), "intent\n");
  git(repository, "add", "--intent-to-add", "intent.txt");
  assert.throws(() => captureMigration(repository, { ...SPEC, selected_untracked: [] }),
    /unsupported_intent_to_add/);
});

test("capture refuses a resolved but unfinished Git operation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-incus-migration-operation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch=work");
  git(repository, "config", "user.email", "sandbox@example.invalid");
  git(repository, "config", "user.name", "sandbox");
  writeFileSync(join(repository, "conflict.txt"), "base\n");
  git(repository, "add", "conflict.txt");
  git(repository, "commit", "--quiet", "-m", "base");
  git(repository, "switch", "--quiet", "-c", "topic");
  writeFileSync(join(repository, "conflict.txt"), "topic\n");
  git(repository, "commit", "--quiet", "-am", "topic");
  git(repository, "switch", "--quiet", "work");
  writeFileSync(join(repository, "conflict.txt"), "work\n");
  git(repository, "commit", "--quiet", "-am", "work");
  const merge = spawnSync(GIT, ["-C", repository, "merge", "topic"], { encoding: "utf8" });
  assert.notEqual(merge.status, 0);
  writeFileSync(join(repository, "conflict.txt"), "resolved\n");
  git(repository, "add", "conflict.txt");
  assert.throws(() => captureMigration(repository, { ...SPEC, selected_untracked: [] }),
    /unsupported_git_operation/);
});

test("capture refuses index flags that can hide tracked work", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-incus-migration-flags-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [index, flag] of ["--assume-unchanged", "--skip-worktree"].entries()) {
    const repository = join(root, `repository-${index}`);
    mkdirSync(repository);
    git(repository, "init", "--quiet", "--initial-branch=work");
    git(repository, "config", "user.email", "sandbox@example.invalid");
    git(repository, "config", "user.name", "sandbox");
    writeFileSync(join(repository, "hidden.txt"), "base\n");
    git(repository, "add", "hidden.txt");
    git(repository, "commit", "--quiet", "-m", "base");
    git(repository, "update-index", flag, "hidden.txt");
    writeFileSync(join(repository, "hidden.txt"), "unpublished\n");
    assert.throws(() => captureMigration(repository, { ...SPEC, selected_untracked: [] }),
      /unsupported_index_flag/);
  }
});

test("capture rejects clean and process filters before either can execute", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-incus-migration-filter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const canary = join(root, "filter-ran");
  mkdirSync(repository);
  git(repository, "init", "--quiet", "--initial-branch=work");
  git(repository, "config", "user.email", "sandbox@example.invalid");
  git(repository, "config", "user.name", "sandbox");
  writeFileSync(join(repository, "filtered.txt"), "base\n");
  git(repository, "add", "filtered.txt");
  git(repository, "commit", "--quiet", "-m", "base");
  git(repository, "config", "filter.canary.clean", `/usr/bin/touch ${canary}`);
  git(repository, "config", "filter.canary.process", `/usr/bin/touch ${canary}`);
  writeFileSync(join(repository, ".gitattributes"), "filtered.txt filter=canary\n");
  writeFileSync(join(repository, "filtered.txt"), "unpublished\n");
  assert.throws(() => captureMigration(repository, { ...SPEC, selected_untracked: [] }), /unsupported_filter/);
  assert.throws(() => readFileSync(canary), /ENOENT/);
});

test("capture refuses a Git submodule instead of silently omitting it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-incus-migration-submodule-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = repositoryFixture(root);
  const commit = git(repository, "rev-parse", "HEAD");
  git(repository, "update-index", "--add", "--cacheinfo", `160000,${commit},vendor/module`);
  assert.throws(() => captureMigration(repository, { ...SPEC, selected_untracked: [] }),
    /unsupported_submodule/);
});

test("capture refuses selected special files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-incus-migration-special-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = repositoryFixture(root);
  const fifo = join(repository, "task.pipe");
  const created = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  assert.throws(() => captureMigration(repository, { ...SPEC, selected_untracked: ["task.pipe"] }),
    /sockets and special files/);
});

test("migration transfer exposes only the named sandbox and packet on fixed stdin", () => {
  const calls = [];
  const packet = Buffer.from("private-packet");
  transferMigration("agent-1", packet, ({ command, args, options }) => {
    calls.push({ command, args, options });
    return { status: 0 };
  });
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [{
    command: "/usr/bin/sudo",
    args: ["--", "/usr/local/lib/gc-incus-sandbox/transfer.py", "agent-1", "migration"],
  }]);
  assert.equal(calls[0].options.input, packet);
  assert.deepEqual(calls[0].options.stdio, ["pipe", "inherit", "inherit"]);
  assert.throws(() => transferMigration("agent;host", packet, () => ({ status: 0 })), /sandbox name/);
});
