import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSourcePacket, prepareSource, parsePrepareArguments, safeGitEnvironment } from "./source.mjs";

const GIT = "/usr/bin/git";

function git(...args) {
  const result = spawnSync(GIT, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function committedRepository(root) {
  const repository = join(root, "repository");
  mkdirSync(repository);
  git("-C", repository, "init", "--quiet", "--initial-branch=work");
  git("-C", repository, "config", "user.email", "sandbox@example.invalid");
  git("-C", repository, "config", "user.name", "sandbox");
  writeFileSync(join(repository, "source.txt"), "unpublished\n");
  git("-C", repository, "add", "source.txt");
  git("-C", repository, "commit", "--quiet", "-m", "unpublished change");
  return repository;
}

function packetParts(packet) {
  const metadataLength = packet.readUInt32BE(4);
  return {
    metadata: JSON.parse(packet.subarray(8, 8 + metadataLength)),
    payload: packet.subarray(8 + metadataLength),
  };
}

test("prepare accepts only a closed source kind, sandbox name, repository path, and revision", () => {
  assert.deepEqual(parsePrepareArguments(["agent-1", "clone", "/work/repository", "HEAD"]), {
    sandbox: "agent-1", kind: "clone", repository: "/work/repository", revision: "HEAD",
  });
  assert.throws(() => parsePrepareArguments(["agent-1", "exec", "/work/repository", "HEAD"]), /source kind/);
  assert.throws(() => parsePrepareArguments(["agent-1", "bundle", "/work/repository", "HEAD", "extra"]), /usage/);
  assert.throws(() => parsePrepareArguments(["agent;1", "clone", "/work/repository", "HEAD"]), /sandbox name/);
});

test("host source discovery removes ambient credentials and disables repository hooks", () => {
  const environment = safeGitEnvironment({
    GH_TOKEN: "secret-canary", GITHUB_TOKEN: "secret-canary", HOME: "/home/operator", PATH: "/usr/bin",
  });
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.HOME, "/nonexistent");
  assert.equal(environment.TMPDIR, "/tmp");
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  assert.equal(environment.GIT_CONFIG_VALUE_0, "/dev/null");
  assert.equal(environment.GIT_CONFIG_VALUE_1, "false");
  assert.equal(environment.GIT_CONFIG_KEY_2, "core.attributesFile");
  assert.equal(environment.GIT_CONFIG_VALUE_2, "/dev/null");
  assert.equal(environment.GIT_CONFIG_VALUE_3, "");
});

test("source packets carry an immutable commit without a host path or credential", () => {
  const packet = buildSourcePacket({
    kind: "clone", commit: "a".repeat(40), repository: "https://github.com/example/private.git",
    repositoryIdentity: "example/private", environmentDigest: "b".repeat(64),
  });
  const metadataLength = packet.readUInt32BE(4);
  const metadata = JSON.parse(packet.subarray(8, 8 + metadataLength));
  assert.deepEqual(metadata, {
    schema: "gc.incus-sandbox.source/v1",
    kind: "clone",
    commit: "a".repeat(40),
    repository: "https://github.com/example/private.git",
    repository_identity: "example/private",
    environment_digest: "b".repeat(64),
  });
  assert.doesNotMatch(packet.toString("utf8"), /secret-canary|\/work\/repository/);
});

test("unpublished packets carry only the repository binding beside Git objects", () => {
  const packet = buildSourcePacket({ kind: "bundle", commit: "d".repeat(40), bundle: Buffer.from("git bundle"),
    repositoryIdentity: "example/private", environmentDigest: "e".repeat(64) });
  const metadataLength = packet.readUInt32BE(4);
  const metadata = JSON.parse(packet.subarray(8, 8 + metadataLength));
  assert.deepEqual(metadata, {
    schema: "gc.incus-sandbox.source/v1", kind: "bundle", commit: "d".repeat(40),
    repository_identity: "example/private", environment_digest: "e".repeat(64),
  });
});

test("preparing a published revision uses fixed Git and transfer commands", () => {
  const calls = [];
  prepareSource(["agent-1", "clone", "/work/repository", "HEAD"], ({ command, args, options }) => {
    calls.push({ command, args, options });
    if (args.includes("rev-parse")) return { status: 0, stdout: `${"b".repeat(40)}\n` };
    if (args.includes("remote")) return { status: 0, stdout: "https://github.com/example/private.git\n" };
    if (args.includes("show")) return { status: 128, stdout: Buffer.alloc(0) };
    return { status: 0 };
  }, { GH_TOKEN: "secret-canary" });
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: "/usr/bin/git", args: ["-C", "/work/repository", "rev-parse", "--verify", "HEAD^{commit}"] },
    { command: "/usr/bin/git", args: ["-C", "/work/repository", "remote", "get-url", "origin"] },
    { command: "/usr/bin/git", args: ["-C", "/work/repository", "show",
      `${"b".repeat(40)}:.gc-sandbox-env.json`] },
    { command: "/usr/bin/sudo", args: ["--", "/usr/local/lib/gc-incus-sandbox/transfer.py", "agent-1", "clone"] },
  ]);
  assert.equal(calls[0].options.env.GH_TOKEN, undefined);
  assert.equal(calls[3].options.input.includes(Buffer.from("secret-canary")), false);
  // An inherited stdin discards the packet and leaves the transfer endpoint reading a terminal.
  assert.deepEqual(calls[3].options.stdio, ["pipe", "inherit", "inherit"]);
});

test("an unpublished revision transfers objects the guest can clone and check out", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-incus-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = committedRepository(root);
  const commit = git("-C", repository, "rev-parse", "HEAD");
  const refs = git("-C", repository, "for-each-ref", "--format=%(refname)");

  let packet = null;
  prepareSource(["agent-1", "bundle", repository, "work"], ({ command, args, options }) => {
    if (command !== GIT) {
      packet = options.input;
      return { status: 0 };
    }
    return spawnSync(command, args, options);
  }, { GH_TOKEN: "secret-canary" });

  const { metadata, payload } = packetParts(packet);
  assert.deepEqual(metadata, { schema: "gc.incus-sandbox.source/v1", kind: "bundle", commit });
  const bundle = join(root, "source.bundle");
  writeFileSync(bundle, payload);
  const workspace = join(root, "workspace");
  git("clone", "--quiet", "--no-checkout", "--", bundle, workspace);
  git("-C", workspace, "checkout", "--detach", commit);
  assert.equal(git("-C", workspace, "rev-parse", "HEAD"), commit);
  assert.equal(git("-C", workspace, "show", `${commit}:source.txt`), "unpublished");
  // The host transfers objects only: the source repository keeps exactly its own refs.
  assert.equal(git("-C", repository, "for-each-ref", "--format=%(refname)"), refs);
});

test("preparation binds a committed repository declaration without carrying resolved values", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-incus-source-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = committedRepository(root);
  const declaration = Buffer.from(JSON.stringify({
    schema: "gc.incus-sandbox.task-environment/v1", repository: "example/private",
    variables: [{ name: "TOKEN", secret_ref: "service-token" }],
  }));
  writeFileSync(join(repository, ".gc-sandbox-env.json"), declaration);
  git("-C", repository, "add", ".gc-sandbox-env.json");
  git("-C", repository, "commit", "--quiet", "-m", "declare task environment");
  git("-C", repository, "remote", "add", "origin", "git@github.com:example/private.git");
  let packet;
  prepareSource(["agent-1", "bundle", repository, "HEAD"], ({ command, args, options }) => {
    if (command !== GIT) {
      packet = options.input;
      return { status: 0 };
    }
    return spawnSync(command, args, options);
  }, {});
  const { metadata } = packetParts(packet);
  assert.equal(metadata.repository_identity, "example/private");
  assert.equal(metadata.environment_digest, createHash("sha256").update(declaration).digest("hex"));
  assert.doesNotMatch(JSON.stringify(metadata), /service-token|TOKEN/);
});
