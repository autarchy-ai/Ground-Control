import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const bundleScript = `${packageRoot}scripts/bundle-skills.mjs`;

function runBundle(...args) {
  return spawnSync(process.execPath, [bundleScript, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
  });
}

test("bundles runtime assets without development tests", () => {
  const bundled = runBundle();
  assert.equal(bundled.status, 0, bundled.stderr);

  try {
    assert.equal(existsSync(`${packageRoot}skills/implement/SKILL.md`), true);
    assert.equal(existsSync(`${packageRoot}templates/env.example`), true);
    assert.equal(existsSync(`${packageRoot}sandbox/client.mjs`), true);
    assert.equal(existsSync(`${packageRoot}skills/lit-review-argument/tests`), false);
    assert.equal(existsSync(`${packageRoot}sandbox/client.test.mjs`), false);
  } finally {
    const cleaned = runBundle("--clean");
    assert.equal(cleaned.status, 0, cleaned.stderr);
  }
});
