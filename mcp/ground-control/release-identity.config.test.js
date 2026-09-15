// `release_families` configuration and identity rendering (issue #1579, ADR-097).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  normalizeReleaseFamiliesConfig,
  parseGroundControlYaml,
  releaseFamilyDigest,
  renderReleaseIdentity,
} from "./lib.js";

const RAE_FAMILY = {
  base_branch: "dev",
  sequence_floor: 11,
  version_template: "{sequence+1}.0.0",
  paths: {
    bundle: "docs/research/formal-semantic-validation/bundles/retest-v{sequence}.json",
    snapshot: "docs/research/formal-semantic-validation/execution-snapshot-v{version}.json",
  },
};

function normalize(families, options) {
  return normalizeReleaseFamiliesConfig(families, options);
}

function errorsFor(family) {
  const result = normalize({ fam: family });
  assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(family)}`);
  return result.errors.join("\n");
}

describe("normalizeReleaseFamiliesConfig", () => {
  it("is disabled when absent", () => {
    assert.deepEqual(normalize(undefined), { ok: true, value: {} });
    assert.deepEqual(normalize(null), { ok: true, value: {} });
  });

  it("accepts a family with an offset version and derived paths", () => {
    const result = normalize({ "formal-semantic-validation": RAE_FAMILY });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.value["formal-semantic-validation"], RAE_FAMILY);
  });

  it("defaults base_branch to the workflow base branch", () => {
    const { base_branch: _omitted, ...family } = RAE_FAMILY;
    assert.equal(normalize({ fam: family }, { defaultBaseBranch: "main" }).value.fam.base_branch, "main");
    assert.equal(normalize({ fam: family }).value.fam.base_branch, "dev");
  });

  it("rejects a list, an unsafe family name, and unknown keys", () => {
    assert.equal(normalize([RAE_FAMILY]).ok, false);
    assert.equal(normalize({ "Bad/Name": RAE_FAMILY }).ok, false);
    assert.match(errorsFor({ ...RAE_FAMILY, counter: 3 }), /unknown key 'counter'/);
  });

  it("requires a positive integer sequence_floor", () => {
    for (const floor of [0, -1, 1.5, "11", undefined]) {
      assert.match(errorsFor({ ...RAE_FAMILY, sequence_floor: floor }), /sequence_floor/);
    }
  });

  it("requires exactly one sequence token in version_template and no unknown tokens", () => {
    assert.match(errorsFor({ ...RAE_FAMILY, version_template: "1.0.0" }), /exactly one sequence token/);
    assert.match(errorsFor({ ...RAE_FAMILY, version_template: "{sequence}.{sequence}" }), /exactly one sequence token/);
    assert.match(errorsFor({ ...RAE_FAMILY, version_template: "{sequence}-{branch}" }), /unsupported token/);
    assert.match(errorsFor({ ...RAE_FAMILY, version_template: "{version}" }), /version_template/);
    assert.match(errorsFor({ ...RAE_FAMILY, version_template: "v{sequence} beta" }), /version_template/);
  });

  it("refuses a sequence term that would render below 1 at the floor", () => {
    assert.match(errorsFor({ ...RAE_FAMILY, sequence_floor: 2, version_template: "{sequence-2}" }), /below 1/);
    assert.match(errorsFor({ ...RAE_FAMILY, sequence_floor: 1, paths: { bundle: "a/v{sequence-1}.json" } }), /below 1/);
  });

  it("refuses a family whose first identity is outside the supported sequence range", () => {
    assert.match(errorsFor({
      ...RAE_FAMILY,
      sequence_floor: 1_000_000_000,
      version_template: "{sequence+1}",
    }), /sequence_floor/);
  });

  it("refuses a path whose actual rendered version contains path-unsafe characters", () => {
    assert.match(errorsFor({
      ...RAE_FAMILY,
      version_template: "{sequence}+meta",
      paths: { bundle: "out/{version}.json" },
    }), /repo-relative path/);
  });

  it("refuses paths that coincide, nest inside one another, or enter Git metadata", () => {
    assert.match(errorsFor({ ...RAE_FAMILY, paths: { a: "out/v{sequence}", b: "out/v{sequence}" } }), /distinct paths/);
    assert.match(errorsFor({ ...RAE_FAMILY, paths: { a: "out/v{sequence}", b: "out/v{sequence}/x.json" } }), /distinct paths/);
    assert.match(errorsFor({ ...RAE_FAMILY, paths: { a: ".GIT/hooks/v{sequence}" } }), /\.git/);
  });

  it("treats a path key named like an Object prototype member as an ordinary own key", () => {
    const result = normalize({ fam: { ...RAE_FAMILY, paths: { constructor: "out/v{sequence}.json" } } });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(Object.getPrototypeOf(result.value.fam.paths), Object.prototype);
    assert.equal(result.value.fam.paths.constructor, "out/v{sequence}.json");
  });

  it("requires every path template to be a token-bearing repo-relative path", () => {
    for (const path of [
      "/etc/evidence-{sequence}.json",
      "../outside/evidence-{sequence}.json",
      "docs/./evidence-{sequence}.json",
      "docs//evidence-{sequence}.json",
      "docs/evidence-{sequence}.json/",
      "docs\\evidence-{sequence}.json",
      "docs/evidence.json",
      "docs/evidence {sequence}.json",
    ]) {
      assert.match(errorsFor({ ...RAE_FAMILY, paths: { bundle: path } }), /paths\.bundle/, path);
    }
    assert.match(errorsFor({ ...RAE_FAMILY, paths: {} }), /at least one path/);
    assert.match(errorsFor({ ...RAE_FAMILY, paths: { "Bad-Key": "a/{sequence}" } }), /path key/);
  });

  it("is wired into the canonical .ground-control.yaml parser", () => {
    const yaml = [
      "schema_version: 1",
      "project: widgets",
      "workflow:",
      "  base_branch: main",
      "release_families:",
      "  coverage:",
      "    sequence_floor: 8",
      "    version_template: \"{sequence}.0.0\"",
      "    paths:",
      "      snapshot: docs/coverage/execution-snapshot-v{sequence}.json",
    ].join("\n");
    const parsed = parseGroundControlYaml(yaml);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
    assert.equal(parsed.value.release_families.coverage.base_branch, "main");

    const invalid = parseGroundControlYaml(`${yaml}\n    extra: true`);
    assert.equal(invalid.ok, false);
  });
});

describe("renderReleaseIdentity", () => {
  it("renders the version and every path for a sequence, applying offsets", () => {
    assert.deepEqual(renderReleaseIdentity(RAE_FAMILY, 9), {
      sequence: 9,
      version: "10.0.0",
      paths: {
        bundle: "docs/research/formal-semantic-validation/bundles/retest-v9.json",
        snapshot: "docs/research/formal-semantic-validation/execution-snapshot-v10.0.0.json",
      },
    });
  });

  it("digests the normalized definition so a changed convention is detectable", () => {
    const same = releaseFamilyDigest({ ...RAE_FAMILY, paths: { snapshot: RAE_FAMILY.paths.snapshot, bundle: RAE_FAMILY.paths.bundle } });
    assert.match(releaseFamilyDigest(RAE_FAMILY), /^[0-9a-f]{64}$/);
    assert.equal(releaseFamilyDigest(RAE_FAMILY), same, "key order does not change the digest");
    assert.notEqual(releaseFamilyDigest(RAE_FAMILY), releaseFamilyDigest({ ...RAE_FAMILY, sequence_floor: 12 }));
  });

  it("canonicalizes path keys by code unit rather than the host locale", () => {
    const family = {
      base_branch: "dev",
      sequence_floor: 1,
      version_template: "{sequence}",
      paths: { a_a: "out/a-{sequence}", a0: "out/b-{sequence}" },
    };
    const canonical = JSON.stringify({
      base_branch: "dev",
      sequence_floor: 1,
      version_template: "{sequence}",
      paths: { a0: "out/b-{sequence}", a_a: "out/a-{sequence}" },
    });
    const expected = createHash("sha256").update(canonical).digest("hex");

    assert.equal(releaseFamilyDigest(family), expected);
  });
});
