#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputs = [
  ".pre-commit-config.yaml",
  ".vale.ini",
  "docs/public/requirements.txt",
  "mcp/ground-control/package-lock.json",
  "tools/verification-fingerprint.mjs",
];

function commandVersion(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} is unavailable for verification fingerprinting`);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

export function verificationFingerprint() {
  const hash = createHash("sha256");
  hash.update(`node\0${process.version}\0`);
  hash.update(`python3\0${commandVersion("python3", ["--version"])}\0`);
  for (const path of inputs) {
    hash.update(`${path}\0`);
    hash.update(readFileSync(resolve(repoRoot, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${verificationFingerprint()}\n`);
}
