// The inventory, the code, and the template say the same thing (issue #1562).
//
// `.env` is now the only source of Ground Control's variables, so `.env.example`
// stopped being a courtesy and became the operator's specification: it is what
// tells someone which variables exist and which of the leftovers in their real
// `.env` are dead. A template that drifts from the code is worse than none,
// because the failure it produces is a tool that silently does not run.
//
// Two directions, both enforced here. Every `process.env.<NAME>` read in the
// server's own source must be inventoried, or the loader would delete a name
// nothing can restore. And the inventory and the template must be the same set,
// so a new variable cannot ship undocumented and a documented variable cannot
// outlive its consumer.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUND_CONTROL_ENV_VARS } from "./lib/server-env.js";

const SERVER_ROOT = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Names read directly by a sibling process rather than by this server, so the
// loader must not own them. Their consumers and provenance are documented where
// they are actually read.
const NOT_GROUND_CONTROL_OWNED = new Set([
  // mcp/citation reads these in its own Python process; .mcp.json expands them
  // from the MCP client's environment, never from this server's `.env`.
  "CITATION_MCP_MAILTO",
  "PERSONAL_ZOTERO_ID",
  "PERSONAL_ZOTERO_KEY",
  "TRANSLATION_SERVER_URL",
]);

function sourceFiles(dir) {
  // Test fixtures execute in the test runner, not the launched server. Their
  // PATH shims must not expand the server's documented environment contract.
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "coverage" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith(".js") && !entry.endsWith(".test.js")
      && !entry.endsWith(".test-helpers.js")) {
      found.push(full);
    }
  }
  return found;
}

// Line comments carry example names (`process.env.GH_REPO` appears in one as
// something the code deliberately does NOT consult), so strip them before
// scanning for real reads.
function stripLineComments(text) {
  return text.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
}

function envReadsIn(text) {
  return [...stripLineComments(text).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
}

// A documented entry is a commented-out assignment: `# NAME=value`. Prose never
// matches, because the name must start the line after the marker.
function documentedNames(text) {
  return [...text.matchAll(/^#\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
}

describe("Ground Control environment inventory parity", () => {
  it("scans runtime source without treating test helpers as server consumers", () => {
    const files = sourceFiles(SERVER_ROOT);
    assert.ok(files.some((file) => file.endsWith("/lib/server-env.js")));
    assert.ok(files.every((file) => !file.endsWith(".test-helpers.js")));
  });

  it("inventories every variable the server's own source reads", () => {
    const unowned = new Map();
    for (const file of sourceFiles(SERVER_ROOT)) {
      for (const name of envReadsIn(readFileSync(file, "utf8"))) {
        if (GROUND_CONTROL_ENV_VARS.includes(name) || NOT_GROUND_CONTROL_OWNED.has(name)) continue;
        unowned.set(name, file.slice(REPO_ROOT.length));
      }
    }
    assert.deepEqual(
      [...unowned],
      [],
      "add each name to GROUND_CONTROL_ENV_VARS and .env.example, or the loader will delete it with nothing to restore it",
    );
  });

  it("documents every inventoried variable in .env.example", () => {
    const documented = new Set(documentedNames(readFileSync(join(REPO_ROOT, ".env.example"), "utf8")));
    const undocumented = GROUND_CONTROL_ENV_VARS.filter((name) => !documented.has(name));
    assert.deepEqual(undocumented, [], "every owned variable needs a template entry");
  });

  it("documents nothing in .env.example that the server does not read", () => {
    const owned = new Set(GROUND_CONTROL_ENV_VARS);
    const stale = documentedNames(readFileSync(join(REPO_ROOT, ".env.example"), "utf8"))
      .filter((name) => !owned.has(name));
    assert.deepEqual(stale, [], "the template must not describe a variable with no consumer");
  });
});
