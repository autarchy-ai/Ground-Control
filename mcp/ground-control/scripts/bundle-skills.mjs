// Copy the repository's workflow skills and the `.env` template into this package before it is
// packed (issue #1587), so one published version carries the server, the skills that drive it, and
// the template `grndctl init` seeds. `--clean` removes the copies again after packing; neither
// bundled path is ever committed.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const skillsSource = `${repoRoot}skills/`;
const envSource = `${repoRoot}.env.example`;

rmSync(`${packageRoot}skills`, { recursive: true, force: true });
rmSync(`${packageRoot}templates`, { recursive: true, force: true });
if (!process.argv.includes("--clean")) {
  for (const source of [skillsSource, envSource]) {
    if (!existsSync(source)) {
      process.stderr.write(`bundle-skills: ${source} not found; pack from a Ground Control repository checkout\n`);
      process.exit(1);
    }
  }
  cpSync(skillsSource, `${packageRoot}skills`, { recursive: true });
  mkdirSync(`${packageRoot}templates`, { recursive: true });
  cpSync(envSource, `${packageRoot}templates/env.example`);
}
