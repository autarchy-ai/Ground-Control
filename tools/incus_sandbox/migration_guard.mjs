import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";

const GIT = "/usr/bin/git";
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD",
  "rebase-apply", "rebase-merge", "sequencer", "BISECT_LOG"];

function output(result) {
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

function records(value, label) {
  if (value.length === 0) return [];
  if (value.at(-1) !== 0) throw new Error(`${label} output is invalid`);
  return value.subarray(0, -1).toString("binary").split("\0").map((item) => Buffer.from(item, "binary"));
}

export function migrationGit(repository, args, environment, { allowStatus = [], input = null } = {}) {
  const result = spawnSync(GIT, ["-C", repository, ...args], {
    env: environment, encoding: null, input, maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error || (result.status !== 0 && !allowStatus.includes(result.status))) {
    throw new Error("migration source inspection failed");
  }
  return result;
}

function gitPathExists(repository, marker, environment) {
  const path = output(migrationGit(repository,
    ["rev-parse", "--path-format=absolute", "--git-path", marker], environment)).toString("utf8").trim();
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function rejectIndexFlags(repository, environment) {
  for (const row of records(output(migrationGit(repository, ["ls-files", "-v", "-z"], environment)), "index")) {
    if (row.length < 3 || row[1] !== 0x20) throw new Error("source index entry is invalid");
    const tag = row[0];
    if (tag === 0x53 || (tag >= 0x61 && tag <= 0x7a)) {
      throw new Error("unsupported_index_flag: clear assume-unchanged and skip-worktree before migration");
    }
  }
}

function rejectFilters(repository, environment) {
  const paths = output(migrationGit(repository, ["ls-files", "-z"], environment));
  if (paths.length === 0) return;
  const attributes = records(output(migrationGit(
    repository, ["check-attr", "-z", "--stdin", "filter"], environment, { input: paths },
  )), "attribute");
  if (attributes.length % 3 !== 0) throw new Error("migration attribute output is invalid");
  for (let index = 2; index < attributes.length; index += 3) {
    if (attributes[index].equals(Buffer.from("lfs"))) {
      throw new Error("unsupported_lfs: restore LFS objects inside the guest");
    }
    if (!attributes[index].equals(Buffer.from("unspecified"))) {
      throw new Error("unsupported_filter: remove filter attributes before migration");
    }
  }
}

export function guardMigrationRepository(repository, environment) {
  if (OPERATION_MARKERS.some((marker) => gitPathExists(repository, marker, environment))) {
    throw new Error("unsupported_git_operation: finish or abort the Git operation before migration");
  }
  if (output(migrationGit(repository, ["ls-files", "--unmerged", "-z"], environment)).length) {
    throw new Error("unsupported_unmerged_index: resolve the index before migration");
  }
  rejectIndexFlags(repository, environment);
  rejectFilters(repository, environment);
  const status = output(migrationGit(
    repository, ["status", "--porcelain=v2", "-z", "--untracked-files=no"], environment,
  ));
  for (const row of records(status, "status")) {
    if (row.toString("utf8").startsWith("1 .A ")) {
      throw new Error("unsupported_intent_to_add: stage or remove intent-to-add entries before migration");
    }
  }
  for (const option of ["core.sparseCheckout", "core.splitIndex"]) {
    const configured = migrationGit(repository, ["config", "--bool", "--get", option], environment, {
      allowStatus: [1],
    });
    if (configured.status === 0 && output(configured).toString("utf8").trim() === "true") {
      throw new Error(`unsupported_index_extension: disable ${option} before migration`);
    }
  }
  for (const row of records(output(migrationGit(repository, ["ls-files", "--stage", "-z"], environment)), "index")) {
    const match = /^(\d{6}) [0-9a-f]{40,64} ([0-3])\t[\s\S]*$/.exec(row.toString("utf8"));
    if (!match) throw new Error("source index entry is invalid");
    if (match[1] === "160000") throw new Error("unsupported_submodule: restore the submodule inside the guest");
    if (match[2] !== "0") throw new Error("unsupported_unmerged_index: resolve the index before migration");
  }
}
