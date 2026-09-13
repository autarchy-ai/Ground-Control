// The launch directory's .env is the only source of Ground Control's own
// configuration and credentials (issue #1562).
//
// #1560 added a machine-level `~/.config/ground-control/env` behind the launch
// root, and both loaders ranked an inherited value above both files. That let a
// global credential arrive silently in a repository that deliberately holds
// none, and made the effective configuration a property of whichever launcher
// happened to start the server. These cases pin the replacement: inherited
// values for owned names are removed before anything is installed, only owned
// names are installed, and no other environment state is touched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUND_CONTROL_ENV_VARS, launchEnvFilePath, loadServerEnv } from "./lib/server-env.js";

function makeCwd(body) {
  const cwd = mkdtempSync(join(tmpdir(), "gc-server-env-"));
  if (body !== null) writeFileSync(join(cwd, ".env"), body, { mode: 0o600 });
  return cwd;
}

function withCwd(body, run) {
  const cwd = makeCwd(body);
  try {
    return run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("loadServerEnv — the launch-directory .env is the only source", () => {
  it("installs an owned variable from the launch-directory .env", () => {
    withCwd("SONAR_TOKEN=from-launch-root\n", (cwd) => {
      const env = {};
      loadServerEnv(env, { cwd });
      assert.equal(env.SONAR_TOKEN, "from-launch-root");
    });
  });

  it("makes .env authoritative over an inherited value", () => {
    withCwd("SONAR_TOKEN=from-launch-root\n", (cwd) => {
      const env = { SONAR_TOKEN: "from-shell" };
      loadServerEnv(env, { cwd });
      assert.equal(env.SONAR_TOKEN, "from-launch-root");
    });
  });

  it("REMOVES an inherited owned variable that .env does not declare", () => {
    withCwd("GC_CODEX_TIMEOUT_MS=120000\n", (cwd) => {
      const env = { SONAR_TOKEN: "from-shell", CLAUDE_CONFIG_DIR: "/home/u/.claude" };
      loadServerEnv(env, { cwd });
      assert.equal("SONAR_TOKEN" in env, false);
      assert.equal("CLAUDE_CONFIG_DIR" in env, false);
    });
  });

  it("REMOVES every inherited owned variable when the .env is absent", () => {
    withCwd(null, (cwd) => {
      const env = { SONAR_TOKEN: "from-shell", OPENAI_API_KEY: "sk-x" };
      loadServerEnv(env, { cwd });
      assert.equal("SONAR_TOKEN" in env, false);
      assert.equal("OPENAI_API_KEY" in env, false);
    });
  });

  it("REMOVES an inherited owned variable when the .env is unreadable", () => {
    const cwd = makeCwd("SONAR_TOKEN=from-launch-root\n");
    try {
      chmodSync(join(cwd, ".env"), 0o000);
      const env = { SONAR_TOKEN: "from-shell" };
      loadServerEnv(env, { cwd });
      assert.equal("SONAR_TOKEN" in env, false);
    } finally {
      chmodSync(join(cwd, ".env"), 0o600);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ignores a .env entry that is not an owned variable", () => {
    withCwd("PATH=/attacker/bin\nHOME=/attacker\nUNRELATED=x\n", (cwd) => {
      const env = { PATH: "/usr/bin", HOME: "/home/u" };
      loadServerEnv(env, { cwd });
      assert.equal(env.PATH, "/usr/bin");
      assert.equal(env.HOME, "/home/u");
      assert.equal("UNRELATED" in env, false);
    });
  });

  it("leaves inherited state that Ground Control does not own", () => {
    withCwd(null, (cwd) => {
      const env = { PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8", CORTEX_XDR_KEY: "k" };
      loadServerEnv(env, { cwd });
      assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8", CORTEX_XDR_KEY: "k" });
    });
  });

  it("installs an empty declared value rather than falling back to the inherited one", () => {
    withCwd("SONAR_TOKEN=\n", (cwd) => {
      const env = { SONAR_TOKEN: "from-shell" };
      loadServerEnv(env, { cwd });
      assert.equal(env.SONAR_TOKEN, "");
    });
  });

  it("skips comments and blank lines and strips one matching quote pair", () => {
    withCwd("# a comment\n\nGC_CODEX_TIMEOUT_MS='120000'\nGC_CODEX_REVIEW_PARALLEL=\"2\"\nnot-a-pair\n", (cwd) => {
      const env = {};
      loadServerEnv(env, { cwd });
      assert.deepEqual(env, { GC_CODEX_TIMEOUT_MS: "120000", GC_CODEX_REVIEW_PARALLEL: "2" });
    });
  });

  it("resolves the file in the launch directory, never a home directory", () => {
    assert.equal(launchEnvFilePath("/srv/checkout"), join("/srv/checkout", ".env"));
  });

  it("declares an inventory that is frozen, unique, and carries the review-engine auth", () => {
    assert.equal(Object.isFrozen(GROUND_CONTROL_ENV_VARS), true);
    assert.equal(new Set(GROUND_CONTROL_ENV_VARS).size, GROUND_CONTROL_ENV_VARS.length);
    for (const name of ["SONAR_TOKEN", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      assert.ok(GROUND_CONTROL_ENV_VARS.includes(name), `${name} must be owned`);
    }
  });
});
