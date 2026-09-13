// Copy the repository's workflow skills into this package before it is packed (issue #1587), so
// one published version carries the server and the skills that drive it. `--clean` removes the
// copy again after packing; the bundled directory is never committed.

import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../skills/", import.meta.url));
const target = fileURLToPath(new URL("../skills/", import.meta.url));

rmSync(target, { recursive: true, force: true });
if (!process.argv.includes("--clean")) {
  if (!existsSync(source)) {
    process.stderr.write(`bundle-skills: ${source} not found; pack from a Ground Control repository checkout\n`);
    process.exit(1);
  }
  cpSync(source, target, { recursive: true });
}
