import { isAbsolute, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const NAME = /^[a-z][a-z0-9-]{0,47}$/;
const KINDS = new Set(["clone", "bundle"]);
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PACKET_MAGIC = Buffer.from("GCS1");
const GIT = "/usr/bin/git";
const SUDO = "/usr/bin/sudo";
const TRANSFER = "/usr/local/lib/gc-incus-sandbox/transfer.py";
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const BUNDLE_REF = "refs/heads/gc-incus-sandbox-source";

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
