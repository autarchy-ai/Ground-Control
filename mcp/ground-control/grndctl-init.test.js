// `grndctl init` and `grndctl doctor` (issue #1587).
//
// The property under test: init proposes and the operator decides. Detected values are only
// defaults, nothing is written without a confirmed preview, a non-interactive run cannot fall back
// to detection, and only this repository's own files change.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { detectRepoFacts } from "./lib/grndctl-detect.js";
import { runDoctorChecks } from "./lib/grndctl-doctor.js";
import { INIT_FIELDS, confirmValues, planInit, runInit, valuesFromFlags } from "./lib/grndctl-init.js";

function repo({ origin = "https://github.com/acme/widgets.git", files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "grndctl-init-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function scriptedAsk(answers) {
  const asked = [];
  return {
    asked,
    ask: async (question) => {
      asked.push(question);
      if (answers.length === 0) throw new Error(`unexpected prompt: ${question}`);
      return answers.shift();
    },
  };
}

const ALL_FLAGS = [
  "--non-interactive", "--project", "widgets", "--github-repo", "acme/widgets", "--base-branch", "dev",
  "--test-command", "make test", "--completion-command", "make check", "--lint-command=", "--format-command=",
  "--sonar-project-key=", "--sonar-organization=", "--adr-dir", "docs/adrs/", "--plan-rules", "no",
];

describe("detectRepoFacts", () => {
  it("proposes values with the evidence each came from", async () => {
    const dir = repo({
      files: {
        Makefile: "test:\n\tpytest\ncheck: test\nlint:\n\truff .\n",
        "sonar-project.properties": "sonar.projectKey=acme_widgets\nsonar.organization=acme\n",
        "docs/adrs/001.md": "# ADR\n",
      },
    });
    try {
      const facts = await detectRepoFacts(dir);
      assert.deepEqual(facts.github_repo, { value: "acme/widgets", source: "git remote origin" });
      assert.deepEqual(facts.test_command, { value: "make test", source: "Makefile target 'test'" });
      assert.equal(facts.completion_command.value, "make check");
      assert.equal(facts.lint_command.value, "make lint");
      assert.equal(facts.format_command.value, null);
      assert.equal(facts.sonar_project_key.value, "acme_widgets");
      assert.equal(facts.adr_dir.value, "docs/adrs/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("confirmValues", () => {
  it("offers each detected value as a default the operator can accept or replace", async () => {
    const facts = {
      project: { value: "widgets", source: "directory name" },
      github_repo: { value: "acme/widgets", source: "git remote origin" },
      test_command: { value: "make test", source: "Makefile target 'test'" },
    };
    // Accept project, accept repo, override base branch, accept test, blanks for the rest, no plan rules.
    const answers = ["", "", "main", "", "", "", "", "", "", "", ""];
    const { ask, asked } = scriptedAsk(answers);
    const values = await confirmValues(ask, facts, () => {});
    assert.equal(asked.length, INIT_FIELDS.length);
    assert.match(asked[0], /\[widgets\] \(directory name\)/);
    assert.equal(values.project, "widgets");
    assert.equal(values.base_branch, "main");
    assert.equal(values.test_command, "make test");
    assert.equal(values.plan_rules, "no");
  });

  it("re-asks for a required value that was neither detected nor entered", async () => {
    const messages = [];
    const { ask } = scriptedAsk(["", "widgets", "acme/widgets", "", "", "", "", "", "", "", "", ""]);
    const values = await confirmValues(ask, {}, (line) => messages.push(line));
    assert.equal(values.project, "widgets");
    assert.ok(messages.some((m) => /is required/.test(m)));
  });
});

describe("planInit", () => {
  it("creates a valid config, merges only the ground-control MCP entry, and never rewrites existing files", async () => {
    const dir = repo({
      files: {
        ".mcp.json": JSON.stringify({ mcpServers: { sonarqube: { command: "docker" }, "ground-control": { command: "node", args: ["/old/checkout/index.js"] } } }),
        ".env": "SONAR_TOKEN=keep-me\n",
      },
    });
    try {
      const { values } = valuesFromFlags(ALL_FLAGS);
      const changes = await planInit(dir, values);
      const byName = Object.fromEntries(changes.map((c) => [c.path.slice(dir.length + 1), c]));
      const config = parseYaml(byName[".ground-control.yaml"].content);
      assert.equal(config.project, "widgets");
      assert.deepEqual(config.workflow, { test_command: "make test", completion_command: "make check", base_branch: "dev" });
      assert.equal(config.sonarcloud, undefined);
      const mcp = JSON.parse(byName[".mcp.json"].content);
      assert.deepEqual(mcp.mcpServers.sonarqube, { command: "docker" });
      assert.deepEqual(mcp.mcpServers["ground-control"], { type: "stdio", command: "grndctl", args: ["mcp"] });
      assert.equal(byName[".env"].action, "keep");
      assert.equal(byName[".env"].content, undefined);
      assert.equal(byName[".gitignore"].content, ".env\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an existing .ground-control.yaml untouched", async () => {
    const dir = repo({ files: { ".ground-control.yaml": "schema_version: 1\nproject: hand-written\n" } });
    try {
      const { values } = valuesFromFlags(ALL_FLAGS);
      const yaml = (await planInit(dir, values)).find((c) => c.path.endsWith(".ground-control.yaml"));
      assert.equal(yaml.action, "keep");
      assert.equal(yaml.content, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runInit", () => {
  it("writes nothing when the operator declines the preview", async () => {
    const dir = repo();
    try {
      const answers = ["widgets", "acme/widgets", "", "", "", "", "", "", "", "", "no", "n"];
      const code = await runInit([], { cwd: dir, ask: scriptedAsk(answers).ask, print: () => {}, interactive: true });
      assert.equal(code, 1);
      assert.equal(existsSync(join(dir, ".ground-control.yaml")), false);
      assert.equal(existsSync(join(dir, ".mcp.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the previewed changes once the operator confirms", async () => {
    const dir = repo();
    try {
      const answers = ["widgets", "acme/widgets", "", "", "", "", "", "", "", "", "yes", "y"];
      const code = await runInit([], { cwd: dir, ask: scriptedAsk(answers).ask, print: () => {}, interactive: true });
      assert.equal(code, 0);
      assert.equal(parseYaml(readFileSync(join(dir, ".ground-control.yaml"), "utf8")).github_repo, "acme/widgets");
      assert.ok(existsSync(join(dir, ".gc", "plan-rules.md")));
      assert.match(readFileSync(join(dir, ".env"), "utf8"), /Ground Control environment template/);
      execFileSync("git", ["-C", dir, "check-ignore", "-q", ".env"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-interactive run that leaves any value to detection", async () => {
    const dir = repo();
    try {
      const messages = [];
      const code = await runInit(["--non-interactive", "--project", "widgets"], { cwd: dir, print: (m) => messages.push(m), interactive: false });
      assert.equal(code, 2);
      assert.match(messages[0], /missing: --github-repo/);
      assert.equal(existsSync(join(dir, ".mcp.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run without a terminal unless every value is a flag", async () => {
    const dir = repo();
    try {
      const code = await runInit([], { cwd: dir, print: () => {}, interactive: false });
      assert.equal(code, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints every non-interactive flag for --help without prompting or writing", async () => {
    const dir = repo();
    try {
      const messages = [];
      const code = await runInit(["--help"], { cwd: dir, print: (m) => messages.push(m), interactive: true });
      assert.equal(code, 0);
      for (const field of INIT_FIELDS) assert.match(messages[0], new RegExp(field.flag));
      assert.equal(existsSync(join(dir, ".mcp.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing on a dry run", async () => {
    const dir = repo();
    try {
      const code = await runInit([...ALL_FLAGS, "--dry-run"], { cwd: dir, print: () => {}, interactive: false });
      assert.equal(code, 0);
      assert.equal(existsSync(join(dir, ".ground-control.yaml")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDoctorChecks", () => {
  it("fails a repository whose MCP entry still runs a checkout, and passes once init has run", async () => {
    const dir = repo({ files: { ".mcp.json": JSON.stringify({ mcpServers: { "ground-control": { command: "node", args: ["/src/Ground-Control/mcp/ground-control/index.js"] } } }) } });
    const works = async () => true;
    try {
      const before = await runDoctorChecks({ cwd: dir, version: "1.1.0", works });
      assert.equal(before.find((c) => c.name === ".mcp.json runs grndctl mcp").status, "fail");
      assert.equal(before.find((c) => c.name === ".ground-control.yaml present").status, "fail");
      rmSync(join(dir, ".mcp.json"));
      await runInit(ALL_FLAGS, { cwd: dir, print: () => {}, interactive: false });
      const after = await runDoctorChecks({ cwd: dir, version: "1.1.0", works });
      assert.deepEqual(after.filter((c) => c.status === "fail"), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
