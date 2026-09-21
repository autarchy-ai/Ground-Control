// Bind a prepared source to one reviewed repository declaration without carrying values.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalRepositoryIdentity } from "./repository_identity.mjs";

const DECLARATION = ".gc-sandbox-env.json";
const MAX_BYTES = 64 * 1024;

function digest(declaration) {
  if (!Buffer.isBuffer(declaration) || declaration.length === 0 || declaration.length > MAX_BYTES) {
    throw new Error("repository task environment declaration is empty or oversized");
  }
  return createHash("sha256").update(declaration).digest("hex");
}

function binding(remote, declaration) {
  return {
    repositoryIdentity: canonicalRepositoryIdentity(remote),
    environmentDigest: digest(declaration),
  };
}

export function committedEnvironmentBinding(repository, commit, remote, run, environment) {
  const result = run({
    command: "/usr/bin/git", args: ["-C", repository, "show", `${commit}:${DECLARATION}`],
    options: { env: environment, encoding: null, maxBuffer: MAX_BYTES + 1 },
  });
  if (result?.status !== 0) return {};
  const declaration = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  return binding(remote, declaration);
}

export function migrationEnvironmentBinding(repository, remote, environment, git) {
  let declaration;
  try {
    declaration = readFileSync(join(repository, DECLARATION));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  const tracked = git(repository, ["ls-files", "--error-unmatch", "--", DECLARATION],
    environment, { allowStatus: [1] });
  if (tracked.status !== 0) throw new Error("task environment declaration must be tracked before migration");
  return binding(remote, declaration);
}
