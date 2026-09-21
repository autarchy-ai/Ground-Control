import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { guardMigrationRepository, migrationGit } from "./migration_guard.mjs";

const NAME = /^[a-z][a-z0-9-]{0,47}$/;
const KINDS = new Set(["clone", "bundle"]);
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PACKET_MAGIC = Buffer.from("GCS1");
const GIT = "/usr/bin/git";
const SUDO = "/usr/bin/sudo";
const TRANSFER = "/usr/local/lib/gc-incus-sandbox/transfer.py";
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const MAX_MIGRATION_REQUEST_BYTES = 64 * 1024;
const MAX_MIGRATION_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_MIGRATION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MIGRATION_FILE_COUNT = 2048;
const BUNDLE_REF = "refs/heads/gc-incus-sandbox-source";
const MIGRATION_SCHEMA = "gc.incus-sandbox.migration/v1";
const REQUEST_SCHEMA = "gc.incus-sandbox.migration-request/v1";
const MODES = new Set(["100644", "100755", "120000"]);
const DENIED_COMPONENTS = new Set([
  ".ssh", ".aws", ".gnupg", ".config", ".codex", ".claude", ".cache", "node_modules",
  ".venv", "coverage", "dist", "build", "target",
]);
const DENIED_FILES = new Set([
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials.json", "auth.json",
]);
export function parsePrepareArguments(argv) {
  if (argv.length !== 4) throw new Error("usage: prepare SANDBOX {clone|bundle} REPOSITORY REVISION");
  const [sandbox, kind, repository, revision] = argv;
  if (!NAME.test(sandbox)) throw new Error("sandbox name is invalid");
  if (!KINDS.has(kind)) throw new Error("source kind is invalid");
  if (typeof repository !== "string" || !isAbsolute(repository) || repository.includes("\0")) {
    throw new Error("repository path must be absolute");
  }
  if (typeof revision !== "string" || !revision || revision.length > 255 || revision.includes("\0")) {
    throw new Error("revision is invalid");
  }
  return { sandbox, kind, repository, revision };
}
export function safeGitEnvironment(base = process.env) {
  if (base === null || typeof base !== "object") throw new Error("source environment is invalid");
  const environment = {
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    TMPDIR: "/tmp",
  };
  const overrides = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["core.attributesFile", "/dev/null"],
    ["credential.helper", ""],
    ["credential.interactive", "false"],
  ];
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_SYSTEM = "/dev/null";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_CONFIG_COUNT = String(overrides.length);
  overrides.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}
export function buildSourcePacket({ kind, commit, repository, bundle = null }) {
  if (!KINDS.has(kind) || !COMMIT.test(commit)) throw new Error("source packet is invalid");
  if (kind === "clone" && (
    typeof repository !== "string" || !repository.startsWith("https://github.com/") || repository.includes("@")
  )) {
    throw new Error("repository URL is invalid");
  }
  if (kind === "clone" && bundle !== null) throw new Error("clone packet must not contain a bundle");
  if (kind === "bundle" && !Buffer.isBuffer(bundle)) throw new Error("bundle packet requires Git objects");
  const metadata = Buffer.from(JSON.stringify({
    schema: "gc.incus-sandbox.source/v1", kind, commit, ...(kind === "clone" ? { repository } : {}),
  }));
  const header = Buffer.alloc(8);
  PACKET_MAGIC.copy(header);
  header.writeUInt32BE(metadata.length, 4);
  return Buffer.concat([header, metadata, bundle ?? Buffer.alloc(0)]);
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).toSorted((left, right) => left.localeCompare(right));
    const fields = keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}
function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new Error("migration path is invalid");
  }
  const components = value.split("/");
  if (components.some((part) => !part || part === "." || part === ".." || part === ".git")) {
    throw new Error("migration path escapes the checkout");
  }
  return value;
}
function rejectSensitivePath(path) {
  const components = safeRelativePath(path).toLowerCase().split("/");
  const filename = components.at(-1);
  if (components.some((part) => DENIED_COMPONENTS.has(part)) || DENIED_FILES.has(filename)
      || filename === ".env" || filename.startsWith(".env.")) {
    throw new Error("migration rejects a credential or configuration path");
  }
}
function boundedText(value, field) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 4096 || value.includes("\0")) {
    throw new Error(`migration ${field} is invalid`);
  }
  return value;
}
export function parseMigrationSpec(input) {
  if (!Buffer.isBuffer(input) || input.length > MAX_MIGRATION_REQUEST_BYTES) {
    throw new Error("migration request exceeds the limit");
  }
  let spec;
  try {
    spec = JSON.parse(input.toString("utf8"));
  } catch {
    throw new Error("migration request is invalid JSON");
  }
  const fields = ["schema", "checkpoint_acknowledged", "source_agent_stopped", "selected_untracked", "handoff"];
  const actualFields = spec === null || typeof spec !== "object" ? []
    : Object.keys(spec).toSorted((left, right) => left.localeCompare(right));
  const expectedFields = fields.toSorted((left, right) => left.localeCompare(right));
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)
      || actualFields.join("\0") !== expectedFields.join("\0")) {
    throw new Error("migration request fields are invalid");
  }
  if (spec.schema !== REQUEST_SCHEMA || spec.checkpoint_acknowledged !== true) {
    throw new Error("migration checkpoint must be acknowledged");
  }
  if (spec.source_agent_stopped !== true) throw new Error("old agent must be stopped before capture");
  if (!Array.isArray(spec.selected_untracked) || spec.selected_untracked.length > MAX_MIGRATION_FILE_COUNT) {
    throw new Error("selected untracked paths are invalid");
  }
  const selected = spec.selected_untracked.map((path) => {
    rejectSensitivePath(path);
    return safeRelativePath(path);
  });
  if (new Set(selected).size !== selected.length) throw new Error("selected untracked paths must be unique");
  if (spec.handoff === null || typeof spec.handoff !== "object" || Array.isArray(spec.handoff)
      || Object.keys(spec.handoff).toSorted((left, right) => left.localeCompare(right)).join("\0")
        !== "task\0unfinished") {
    throw new Error("migration handoff fields are invalid");
  }
  boundedText(spec.handoff.task, "task");
  boundedText(spec.handoff.unfinished, "unfinished work");
  return spec;
}
function bufferOutput(result) {
  if (Buffer.isBuffer(result.stdout)) return result.stdout;
  return Buffer.from(result.stdout ?? "");
}

function utf8Path(value) {
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded).equals(value)) throw new Error("migration path is not valid UTF-8");
  return safeRelativePath(decoded);
}

function nulPaths(buffer) {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) throw new Error("migration Git path output is invalid");
  return buffer.subarray(0, -1).toString("binary").split("\0").map((item) => utf8Path(Buffer.from(item, "binary")));
}

function validateCheckout(repository, environment) {
  const source = realpathSync(repository);
  const top = bufferOutput(migrationGit(source, ["rev-parse", "--show-toplevel"], environment)).toString("utf8").trim();
  if (realpathSync(top) !== source) throw new Error("source must name the checkout root exactly");
  return source;
}

function branchName(repository, environment) {
  const result = migrationGit(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"], environment, {
    allowStatus: [1],
  });
  if (result.status === 1) return null;
  const branch = bufferOutput(result).toString("utf8").trim();
  const checked = migrationGit(repository, ["check-ref-format", "--branch", branch], environment);
  if (bufferOutput(checked).toString("utf8").trim() !== branch) throw new Error("source branch is invalid");
  return branch;
}
function indexEntry(repository, path, environment) {
  const rows = nulPaths(bufferOutput(migrationGit(repository, ["ls-files", "--stage", "-z", "--", path], environment)));
  const exact = rows.filter((row) => row.endsWith(`\t${path}`));
  if (exact.length === 0) return { path, deleted: true };
  if (exact.length !== 1) throw new Error("unsupported_unmerged_index: resolve the index before migration");
  const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]*)$/.exec(exact[0]);
  if (match?.[3] !== "0" || match[4] !== path || !MODES.has(match[1])) {
    throw new Error("source index entry is unsupported");
  }
  const content = bufferOutput(migrationGit(repository, ["cat-file", "blob", match[2]], environment));
  return { path, mode: match[1], content };
}
function containedTarget(repository, path) {
  rejectSensitivePath(path);
  let current = repository;
  const components = path.split("/");
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("migration path parent is a link");
    } catch (error) {
      if (error?.code === "ENOENT") return join(repository, ...components);
      throw error;
    }
  }
  return join(repository, ...components);
}

function worktreeEntry(repository, path) {
  const target = containedTarget(repository, path);
  let details;
  try {
    details = lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return { path, deleted: true };
    throw error;
  }
  let content;
  let mode;
  if (details.isSymbolicLink()) {
    let resolved;
    try {
      resolved = realpathSync(target);
    } catch {
      throw new Error("migration link escapes the checkout");
    }
    const outside = relative(repository, resolved);
    if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
      throw new Error("migration link escapes the checkout");
    }
    content = Buffer.from(readlinkSync(target));
    mode = "120000";
  } else if (details.isFile()) {
    if (details.size > MAX_MIGRATION_FILE_BYTES) throw new Error("migration file exceeds the limit");
    content = readFileSync(target);
    mode = details.mode & 0o111 ? "100755" : "100644";
  } else {
    throw new Error("migration rejects sockets and special files");
  }
  return { path, mode, content };
}

function rejectLfs(repository, paths, environment) {
  if (paths.length === 0) return;
  const result = migrationGit(repository, ["check-attr", "-z", "filter", "--", ...paths], environment);
  const values = nulPaths(bufferOutput(result));
  for (let index = 0; index < values.length; index += 3) {
    if (values[index + 2] === "lfs") throw new Error("unsupported_lfs: restore LFS objects inside the guest");
  }
}

function selectedUntracked(repository, selected, environment) {
  if (selected.length === 0) return [];
  for (const path of selected) {
    try {
      const details = lstatSync(resolve(repository, path));
      if (!details.isFile() && !details.isSymbolicLink()) {
        throw new Error("migration rejects sockets and special files");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const actual = nulPaths(bufferOutput(migrationGit(
    repository, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...selected], environment,
  ))).toSorted((left, right) => left.localeCompare(right));
  const expected = selected.toSorted((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error("selected untracked paths must name exact non-ignored files");
  }
  return actual;
}
function snapshot(repository, spec, environment) {
  const commit = bufferOutput(migrationGit(repository, ["rev-parse", "--verify", "HEAD^{commit}"], environment))
    .toString("utf8").trim();
  if (!COMMIT.test(commit)) throw new Error("source HEAD is invalid");
  guardMigrationRepository(repository, environment);
  const indexPaths = nulPaths(bufferOutput(migrationGit(
    repository, ["diff", "--no-ext-diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"], environment,
  ))).toSorted((left, right) => left.localeCompare(right));
  const worktreePaths = nulPaths(bufferOutput(migrationGit(
    repository, ["diff", "--no-ext-diff", "--name-only", "-z", "--no-renames", "--"], environment,
  ))).toSorted((left, right) => left.localeCompare(right));
  const untrackedPaths = selectedUntracked(repository, spec.selected_untracked, environment);
  const allPaths = [...new Set([...indexPaths, ...worktreePaths, ...untrackedPaths])];
  allPaths.forEach(rejectSensitivePath);
  rejectLfs(repository, allPaths, environment);
  const entries = {
    index: indexPaths.map((path) => indexEntry(repository, path, environment)),
    worktree: worktreePaths.map((path) => worktreeEntry(repository, path)),
    untracked: untrackedPaths.map((path) => worktreeEntry(repository, path)),
  };
  if (Object.values(entries).reduce((sum, list) => sum + list.length, 0) > MAX_MIGRATION_FILE_COUNT) {
    throw new Error("migration file count exceeds the limit");
  }
  return { commit, branch: branchName(repository, environment), entries };
}

function snapshotIdentity(snapshotValue) {
  const entries = {};
  for (const role of ["index", "worktree", "untracked"]) {
    entries[role] = snapshotValue.entries[role].map((entry) => entry.deleted
      ? { path: entry.path, deleted: true }
      : { path: entry.path, mode: entry.mode, sha256: sha256(entry.content) });
  }
  return { commit: snapshotValue.commit, branch: snapshotValue.branch, entries };
}

function appendSection(sections, payloads, role, content, fields = {}) {
  if (!Buffer.isBuffer(content)) throw new Error("migration section content is invalid");
  const offset = payloads.reduce((total, payload) => total + payload.length, 0);
  const section = { role, offset, length: content.length, sha256: sha256(content), ...fields };
  const index = sections.length;
  sections.push(section);
  payloads.push(content);
  return index;
}

function packetEntries(snapshotValue, sections, payloads) {
  const entries = {};
  for (const role of ["index", "worktree", "untracked"]) {
    entries[role] = snapshotValue.entries[role].map((entry) => {
      if (entry.deleted) return { path: entry.path, deleted: true };
      const section = appendSection(sections, payloads, role, entry.content, {
        path: entry.path, mode: entry.mode,
      });
      return { path: entry.path, mode: entry.mode, section };
    });
  }
  return entries;
}

export function captureMigration(repository, rawSpec) {
  if (typeof repository !== "string" || !isAbsolute(repository) || repository.includes("\0")) {
    throw new Error("source checkout path must be absolute");
  }
  const spec = parseMigrationSpec(Buffer.from(JSON.stringify(rawSpec)));
  const environment = safeGitEnvironment();
  const source = validateCheckout(repository, environment);
  const before = snapshot(source, spec, environment);
  const temporary = mkdtempSync(join(tmpdir(), "gc-incus-migration-"));
  const bundlePath = join(temporary, "source.bundle");
  try {
    const objects = bufferOutput(migrationGit(
      source, ["rev-parse", "--path-format=absolute", "--git-path", "objects"], environment,
    )).toString("utf8").trim();
    createSourceBundle({ objects, commit: before.commit, scratch: join(temporary, "objects"), bundlePath },
      ({ command, args, options }) => spawnSync(command, args, options), environment);
    if (statSync(bundlePath).size > MAX_BUNDLE_BYTES) throw new Error("migration bundle exceeds the limit");
    const sections = [];
    const payloads = [];
    const bundleSection = appendSection(sections, payloads, "bundle", readFileSync(bundlePath));
    const entries = packetEntries(before, sections, payloads);
    const handoff = Buffer.from(stableJson(spec.handoff));
    const handoffSection = appendSection(sections, payloads, "handoff", handoff);
    const identity = snapshotIdentity(before);
    const stateDigest = sha256(Buffer.from(stableJson(identity)));
    const migrationId = sha256(Buffer.from(`${stateDigest}:${sha256(handoff)}`)).slice(0, 32);
    const metadata = {
      schema: MIGRATION_SCHEMA, migration_id: migrationId, commit: before.commit,
      branch: before.branch, state_digest: stateDigest, bundle_section: bundleSection,
      handoff_section: handoffSection, entries, sections,
    };
    const metadataBuffer = Buffer.from(stableJson(metadata));
    if (metadataBuffer.length > MAX_MIGRATION_METADATA_BYTES) throw new Error("migration metadata exceeds the limit");
    const after = snapshot(source, spec, environment);
    if (stableJson(snapshotIdentity(after)) !== stableJson(identity)) {
      throw new Error("source changed after the operator checkpoint; stop and capture again");
    }
    const header = Buffer.alloc(8);
    PACKET_MAGIC.copy(header);
    header.writeUInt32BE(metadataBuffer.length, 4);
    return Buffer.concat([header, metadataBuffer, ...payloads]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function transferMigration(
  sandbox, packet, run = ({ command, args, options }) => spawnSync(command, args, options),
) {
  if (!NAME.test(sandbox)) throw new Error("sandbox name is invalid");
  if (!Buffer.isBuffer(packet) || packet.length === 0 || packet.length > MAX_BUNDLE_BYTES) {
    throw new Error("migration packet is invalid");
  }
  runChecked(run, SUDO, ["--", TRANSFER, sandbox, "migration"], {
    input: packet, stdio: ["pipe", "inherit", "inherit"],
  });
}

function runChecked(run, command, args, options) {
  const result = run({ command, args, options });
  if (result?.status !== 0) throw new Error("source preparation failed");
  return result;
}

function output(result) {
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function resolveCommit({ repository, revision }, run, environment) {
  return output(runChecked(run, GIT, ["-C", repository, "rev-parse", "--verify", `${revision}^{commit}`], {
    env: environment, encoding: "utf8",
  }));
}

function publishedSource(source, run, environment) {
  const commit = resolveCommit(source, run, environment);
  const remote = output(runChecked(run, GIT, ["-C", source.repository, "remote", "get-url", "origin"], {
    env: environment, encoding: "utf8",
  }));
  return buildSourcePacket({ kind: "clone", commit, repository: remote });
}

export function createSourceBundle({ objects, commit, scratch, bundlePath }, run, environment) {
  // Git bundles only carry refs they can name and guest clones only fetch refs/heads,
  // so the commit is named as a branch in a throwaway repository that borrows the source
  // objects. Nothing runs inside the source repository and no ref there is changed.
  runChecked(run, GIT, ["init", "--bare", "--quiet", scratch], { env: environment });
  writeFileSync(join(scratch, "objects/info/alternates"), `${objects}\n`, { mode: 0o600 });
  runChecked(run, GIT, ["-C", scratch, "update-ref", BUNDLE_REF, commit], { env: environment });
  runChecked(run, GIT, ["-C", scratch, "bundle", "create", bundlePath, BUNDLE_REF], { env: environment });
}

function unpublishedSource(source, run, environment) {
  const commit = resolveCommit(source, run, environment);
  const objects = output(runChecked(run, GIT,
    ["-C", source.repository, "rev-parse", "--path-format=absolute", "--git-path", "objects"],
    { env: environment, encoding: "utf8" }));
  const temporary = mkdtempSync(join(tmpdir(), "gc-incus-source-"));
  const bundlePath = join(temporary, "source.bundle");
  try {
    createSourceBundle({ objects, commit, scratch: join(temporary, "objects"), bundlePath }, run, environment);
    if (statSync(bundlePath).size > MAX_BUNDLE_BYTES) throw new Error("source bundle exceeds the transfer limit");
    return buildSourcePacket({ kind: "bundle", commit, bundle: readFileSync(bundlePath) });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function prepareSource(argv, run, baseEnvironment = process.env) {
  const source = parsePrepareArguments(argv);
  const environment = safeGitEnvironment(baseEnvironment);
  const packet = source.kind === "clone"
    ? publishedSource(source, run, environment)
    : unpublishedSource(source, run, environment);
  // The packet is the transfer endpoint's only input, so stdin must be a pipe; an
  // inherited stdin silently discards it and leaves the endpoint reading the terminal.
  runChecked(run, SUDO, ["--", TRANSFER, source.sandbox, source.kind], {
    input: packet, stdio: ["pipe", "inherit", "inherit"],
  });
}
