// Copy the repository assets this package ships into it before it is packed: the workflow skills
// and the `.env` template (issue #1587), and the Incus sandbox programs (issue #1680) so a host
// can set up a sandbox and build its guest template without a checkout. `--clean` removes the
// copies again after packing; no bundled path is ever committed.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const skillsSource = `${repoRoot}skills/`;
const envSource = `${repoRoot}.env.example`;
const sandboxSource = `${repoRoot}tools/incus_sandbox/`;

function isRuntimeAsset(source) {
  const name = basename(source);
  return name !== "tests" && name !== "__pycache__" && !name.includes(".test.");
}

rmSync(`${packageRoot}skills`, { recursive: true, force: true });
rmSync(`${packageRoot}templates`, { recursive: true, force: true });
rmSync(`${packageRoot}sandbox`, { recursive: true, force: true });
if (!process.argv.includes("--clean")) {
  for (const source of [skillsSource, envSource, sandboxSource]) {
    if (!existsSync(source)) {
      process.stderr.write(`bundle-skills: ${source} not found; pack from a Ground Control repository checkout\n`);
      process.exit(1);
    }
  }
  cpSync(skillsSource, `${packageRoot}skills`, {
    recursive: true,
    filter: isRuntimeAsset,
  });
  mkdirSync(`${packageRoot}templates`, { recursive: true });
  cpSync(envSource, `${packageRoot}templates/env.example`);
  cpSync(sandboxSource, `${packageRoot}sandbox`, {
    recursive: true,
    filter: isRuntimeAsset,
  });
}
