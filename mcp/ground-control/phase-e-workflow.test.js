// The installable Phase E workflow, and the setup surfaces that carry it (issue #1671).
//
// Ground Control ships as `grndctl`, so automated finalization has to arrive with it rather
// than working only in this repository. These tests pin the template's security shape — the
// same shape `tools/policy/phase_e_automation.py` pins for this repository's own copy — and
// the install and drift-report behavior of `init` and `doctor`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PHASE_E_WORKFLOW_PATH, renderPhaseEWorkflow } from "./lib/phase-e-workflow.js";
import { PHASE_E_WORKFLOW_PATH as TRUST_ANCHOR_PATH } from "./lib/automation-provenance.js";
import { planInit } from "./lib/grndctl-init.js";
import { runDoctorChecks } from "./lib/grndctl-doctor.js";

function tempRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gc-phase-e-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function doctorNamed(results, name) {
  return results.find((r) => r.name === name);
}

describe("Phase E workflow template", () => {
  it("names the same file the close gate's trust anchor verifies", () => {
    assert.equal(PHASE_E_WORKFLOW_PATH, TRUST_ANCHOR_PATH);
    assert.equal(PHASE_E_WORKFLOW_PATH, ".github/workflows/ground-control-phase-e.yml");
  });

  // Consumer repositories install this template, and their finalizer runs bind to a pull
  // request through the number it puts in the run name — the merged-pull-request trigger
  // supplies no association (issue #1683). GitHub uses the pull-request TITLE when
  // `run-name:` is absent, so a template that lost this line would quietly make
  // attacker-authored text the binding evidence in every repository that installed it.
  it("carries the run name both triggers bind through", () => {
    const runName = renderPhaseEWorkflow("2.5.1")
      .split("\n")
      .find((line) => line.startsWith("run-name:"));
    assert.ok(runName, "the template must set an explicit run name");
    assert.match(runName, /github\.event\.pull_request\.number/);
    assert.match(runName, /inputs\.pr/);
  });

  // The file is a trigger, not a configuration surface (issue #1688). Every consumer's copy
  // is byte-identical, so there is nothing in it to pin, upgrade, or drift.
  it("carries no version of its own and reads the pinned release from the repo config", () => {
    const rendered = renderPhaseEWorkflow();
    assert.equal(rendered, renderPhaseEWorkflow(), "every repository installs the same bytes");
    assert.ok(!/grndctl@\d+\.\d+\.\d+/.test(rendered), "a baked version is a second thing to upgrade");
    assert.ok(!rendered.includes("__GRNDCTL_VERSION__"));
    assert.match(rendered, /\.ground-control\.yaml/);
    assert.match(rendered, /npx --yes "grndctl\$\{?VERSION\}?"|npx --yes "grndctl@\$VERSION"/);
  });

  it("fails the job rather than resolving a moving tag when the config says nothing", () => {
    const rendered = renderPhaseEWorkflow();
    assert.ok(!rendered.includes("grndctl@latest"), "a moving tag would change what runs without review");
    assert.match(rendered, /phase_e\.version is not set/);
    assert.match(rendered, /exit 1/);
  });

  it("runs only for a merged pull request, and never checks out its head", () => {
    const rendered = renderPhaseEWorkflow();
    assert.match(rendered, /pull_request\.merged == true/);
    assert.ok(!rendered.includes("pull_request_target"), "pull_request_target would grant write to fork code");
    assert.match(rendered, /ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha/);
    assert.ok(!/pull_request\.head\.(sha|ref)/.test(rendered), "Phase E must read the merged tree, not the head");
    assert.match(rendered, /persist-credentials: false/);
  });

  it("takes only one write permission, and keeps the token out of argv", () => {
    const rendered = renderPhaseEWorkflow("1.0.0");
    const permissions = rendered.slice(rendered.indexOf("permissions:"), rendered.indexOf("jobs:"));
    assert.match(permissions, /issues: write/);
    assert.equal(permissions.match(/: write/g).length, 1);
    assert.match(rendered, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.ok(!/--pr "?\$\{\{/.test(rendered), "the pull-request number reaches argv through the environment");
  });

  it("pins every external action to an immutable revision", () => {
    for (const [, ref] of renderPhaseEWorkflow("1.0.0").matchAll(/uses:\s*(\S+)/g)) {
      assert.match(ref, /@[0-9a-f]{40}$/, ref);
    }
  });
});

describe("grndctl init installs the workflow", () => {
  it("creates the trigger and puts the pinned release in the repo config", async () => {
    const repo = tempRepo();
    try {
      const changes = await planInit(repo.dir, { project: "p", github_repo: "o/r", plan_rules: "no" }, { version: "3.1.4" });
      const workflow = changes.find((c) => c.path.endsWith(PHASE_E_WORKFLOW_PATH));
      assert.equal(workflow.action, "create");
      assert.ok(!workflow.content.includes("3.1.4"), "the version does not live in the workflow");
      // One config per repository: the version a consumer upgrades is this line (#1688).
      const yaml = changes.find((c) => c.path.endsWith(".ground-control.yaml"));
      assert.match(yaml.content, /phase_e:/);
      assert.match(yaml.content, /version: ['"]?3\.1\.4/);
    } finally {
      repo.cleanup();
    }
  });

  it("replaces a drifted copy, because the file holds nothing repo-specific any more", async () => {
    const repo = tempRepo({ [PHASE_E_WORKFLOW_PATH]: "name: mine\n" });
    try {
      const changes = await planInit(repo.dir, { project: "p", github_repo: "o/r", plan_rules: "no" }, { version: "3.1.4" });
      const planned = changes.find((c) => c.path.endsWith(PHASE_E_WORKFLOW_PATH));
      assert.equal(planned.action, "update");
      assert.equal(planned.content, renderPhaseEWorkflow());
    } finally {
      repo.cleanup();
    }
  });

  it("leaves a current copy alone", async () => {
    const repo = tempRepo({ [PHASE_E_WORKFLOW_PATH]: renderPhaseEWorkflow() });
    try {
      const changes = await planInit(repo.dir, { project: "p", github_repo: "o/r", plan_rules: "no" }, { version: "3.1.4" });
      const planned = changes.find((c) => c.path.endsWith(PHASE_E_WORKFLOW_PATH));
      assert.equal(planned.action, "keep");
      assert.equal(planned.content, undefined);
    } finally {
      repo.cleanup();
    }
  });
});

describe("grndctl doctor reports the workflow", () => {
  const works = async () => false;

  it("warns when it is missing, because Phase E would then need a human every time", async () => {
    const repo = tempRepo();
    try {
      const result = doctorNamed(await runDoctorChecks({ cwd: repo.dir, version: "1.0.0", works }), "Phase E workflow installed");
      assert.equal(result.status, "warn");
      assert.match(result.fix, /grndctl init/);
    } finally {
      repo.cleanup();
    }
  });

  it("warns when the installed copy lost its merged guard", async () => {
    const drifted = renderPhaseEWorkflow("1.0.0").replace("github.event.pull_request.merged == true", "true");
    const repo = tempRepo({ [PHASE_E_WORKFLOW_PATH]: drifted });
    try {
      const result = doctorNamed(await runDoctorChecks({ cwd: repo.dir, version: "1.0.0", works }), "Phase E workflow installed");
      assert.equal(result.status, "warn");
    } finally {
      repo.cleanup();
    }
  });

  it("passes on a freshly installed copy", async () => {
    const repo = tempRepo({ [PHASE_E_WORKFLOW_PATH]: renderPhaseEWorkflow() });
    try {
      const result = doctorNamed(await runDoctorChecks({ cwd: repo.dir, version: "1.0.0", works }), "Phase E workflow installed");
      assert.equal(result.status, "ok");
    } finally {
      repo.cleanup();
    }
  });
});
