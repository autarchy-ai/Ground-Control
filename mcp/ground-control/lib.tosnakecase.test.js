// Split from lib.test.js under issue #1467 for the 500-LOC limit
// (docs/CODING_STANDARDS.md). Test bodies are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatIssueBody, toCamelCase, toSnakeCase } from "./lib.js";

// ---------------------------------------------------------------------------
// toSnakeCase (backend response normalization)
// ---------------------------------------------------------------------------

describe("toSnakeCase", () => {
  it("maps sweep + status-drift response fields to snake_case, recursively", () => {
    const backend = {
      projectIdentifier: "ground-control",
      hasProblems: true,
      totalProblems: 1,
      statusDrift: [
        {
          uid: "GC-T010",
          title: "Risk Assessment Result Entity",
          confidence: "HIGH",
          strongestSignal: "IMPLEMENTS_LINK_ON_DRAFT",
          evidence: [
            {
              signal: "IMPLEMENTS_LINK_ON_DRAFT",
              confidence: "HIGH",
              artifactType: "GITHUB_ISSUE",
              artifactIdentifier: "826",
              artifactTitle: "GC-T010: ...",
              artifactUrl: "https://gh/826",
              detail: "IMPLEMENTS link on a DRAFT requirement",
            },
          ],
        },
      ],
    };
    const out = toSnakeCase(backend);
    assert.equal(out.has_problems, true);
    assert.equal(out.total_problems, 1);
    assert.ok(Array.isArray(out.status_drift));
    const finding = out.status_drift[0];
    assert.equal(finding.uid, "GC-T010");
    assert.equal(finding.confidence, "HIGH");
    assert.equal(finding.strongest_signal, "IMPLEMENTS_LINK_ON_DRAFT");
    const evidence = finding.evidence[0];
    assert.equal(evidence.signal, "IMPLEMENTS_LINK_ON_DRAFT");
    assert.equal(evidence.artifact_type, "GITHUB_ISSUE");
    assert.equal(evidence.artifact_identifier, "826");
    assert.equal(evidence.artifact_url, "https://gh/826");
    assert.equal(evidence.detail, "IMPLEMENTS link on a DRAFT requirement");
  });

  it("maps the standalone status-drift result envelope", () => {
    const out = toSnakeCase({
      draftRequirementsScanned: 14,
      minimumConfidence: "MEDIUM",
      findings: [],
    });
    assert.equal(out.draft_requirements_scanned, 14);
    assert.equal(out.minimum_confidence, "MEDIUM");
    assert.deepEqual(out.findings, []);
  });

  it("passes unknown keys through unchanged and tolerates null/scalars", () => {
    assert.equal(toSnakeCase(null), null);
    assert.equal(toSnakeCase(42), 42);
    assert.deepEqual(toSnakeCase({ alreadyPlain: 1 }), { alreadyPlain: 1 });
  });
});

// ---------------------------------------------------------------------------
// toCamelCase — request body normalization (issue #875)
//
// Pure-function shape tests for the snake_case → camelCase rewrite that runs
// on every outbound request body. Adapter-level coverage of the
// gc_threat_model handler (Zod schema, action dispatch, body allowlists) lives
// in gc-threat-model.test.js.
// ---------------------------------------------------------------------------

describe("toCamelCase", () => {
  it("renders a threat_model create body to the backend camelCase shape", () => {
    const out = toCamelCase({
      uid: "TM-1",
      title: "Title",
      threat_source: "Source",
      threat_event: "Event",
      effect: "Effect",
      stride_category: "TAMPERING",
      narrative: "Note",
    });
    assert.deepEqual(out, {
      uid: "TM-1",
      title: "Title",
      threatSource: "Source",
      threatEvent: "Event",
      effect: "Effect",
      stride: "TAMPERING",
      narrative: "Note",
    });
  });

  it("rewrites the threat-model update clearStride / clearNarrative flags", () => {
    const out = toCamelCase({ clear_stride: true, clear_narrative: false });
    assert.deepEqual(out, { clearStride: true, clearNarrative: false });
  });

  it("passes unknown keys through unchanged and tolerates null/scalars", () => {
    assert.equal(toCamelCase(null), null);
    assert.equal(toCamelCase(42), 42);
    assert.deepEqual(toCamelCase({ already_camel: 1 }), { already_camel: 1 });
  });

  it("rewrites the asset GC-M011 clear flags onto backend camelCase shape", () => {
    const out = toCamelCase({ clear_subtype: true, clear_metadata: false });
    assert.deepEqual(out, { clearSubtype: true, clearMetadata: false });
  });

  it("treats the asset metadata bag as opaque — inner keys are preserved verbatim", () => {
    // GC-M011: project-defined metadata keys must reach the backend
    // verbatim. Recursive camelization would rewrite e.g.
    // `cloud_account_id` → `cloudAccountId` and change the persisted
    // contract.
    const out = toCamelCase({
      subtype: "aws_ec2",
      metadata: { cloud_account_id: "123", asset_type: "ignored-by-rewrite" },
    });
    assert.deepEqual(out, {
      subtype: "aws_ec2",
      metadata: { cloud_account_id: "123", asset_type: "ignored-by-rewrite" },
    });
  });

  it("treats the subtype-schema body as opaque — declared field keys are preserved", () => {
    // GC-M011: declared field names inside `schemaBody.fields` are part of
    // the registered contract and must not be rewritten by the MCP
    // camelizer.
    const out = toCamelCase({
      schema_body: {
        fields: { cloud_account_id: { type: "STRING" }, asset_type: { type: "STRING" } },
        allowAdditional: false,
      },
    });
    assert.deepEqual(out, {
      schemaBody: {
        fields: { cloud_account_id: { type: "STRING" }, asset_type: { type: "STRING" } },
        allowAdditional: false,
      },
    });
  });
});

describe("toSnakeCase opaque-value-key guard (GC-M011)", () => {
  it("treats response-side asset metadata as opaque — inner camelCase keys are preserved", () => {
    // Codex over-cap finding 5: response normalization must not rewrite
    // known API keys that collide with user-defined metadata keys such
    // as `assetType`, `assetUid`, or `dueDate`. Those are part of the
    // persisted subtype contract and must round-trip verbatim.
    const out = toSnakeCase({
      metadata: { assetType: "carried-through", regionId: "us-west-2" },
    });
    assert.deepEqual(out, {
      metadata: { assetType: "carried-through", regionId: "us-west-2" },
    });
  });

  it("treats response-side subtype-schema body as opaque", () => {
    // The outer `schemaBody` key is renamed to `schema_body` by the
    // standard TO_SNAKE mapping (envelope rename); the inner contents are
    // preserved verbatim because the OPAQUE_VALUE_KEYS guard stops
    // recursive walking once the matching key is hit.
    const out = toSnakeCase({
      schemaBody: {
        fields: { assetUid: { type: "STRING" }, dueDate: { type: "STRING" } },
        allowAdditional: false,
      },
    });
    assert.deepEqual(out, {
      schema_body: {
        fields: { assetUid: { type: "STRING" }, dueDate: { type: "STRING" } },
        allowAdditional: false,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// formatIssueBody
// ---------------------------------------------------------------------------

describe("formatIssueBody", () => {
  it("formats a full requirement with all fields", () => {
    const req = {
      uid: "GC-D007",
      title: "Create GitHub issues from requirements",
      requirement_type: "FUNCTIONAL",
      priority: "SHOULD",
      wave: 1,
      status: "DRAFT",
      statement: "The system shall create GitHub issues.",
      rationale: "Reduces manual copy-paste during wave activation.",
    };
    const body = formatIssueBody(req);
    assert.ok(body.includes("> **GC-D007** | FUNCTIONAL | SHOULD | Wave 1 | DRAFT"));
    assert.ok(body.includes("## Requirements"));
    assert.ok(body.includes("- GC-D007 — Create GitHub issues from requirements"));
    assert.ok(body.includes("## Statement"));
    assert.ok(body.includes("The system shall create GitHub issues."));
    assert.ok(body.includes("## Rationale"));
    assert.ok(body.includes("Reduces manual copy-paste during wave activation."));
    assert.ok(body.includes("*Created from Ground Control requirement GC-D007*"));
  });

  it("omits rationale and wave when null", () => {
    const req = {
      uid: "GC-A001",
      title: "Constraints apply to everyone",
      requirement_type: "CONSTRAINT",
      priority: "MUST",
      wave: null,
      status: "ACTIVE",
      statement: "Constraints apply.",
      rationale: null,
    };
    const body = formatIssueBody(req);
    assert.ok(body.includes("> **GC-A001** | CONSTRAINT | MUST | ACTIVE"));
    assert.ok(!body.includes("Wave"));
    assert.ok(!body.includes("## Rationale"));
    assert.ok(body.includes("## Requirements"));
    assert.ok(body.includes("- GC-A001 — Constraints apply to everyone"));
  });

  it("appends extra body text", () => {
    const req = {
      uid: "GC-T001",
      statement: "Test requirement.",
    };
    const body = formatIssueBody(req, "## Acceptance Criteria\n- [ ] Done");
    assert.ok(body.includes("## Acceptance Criteria"));
    assert.ok(body.includes("- [ ] Done"));
  });

  it("seeds a ## Requirements section that `/implement` can parse as in_scope_requirements[]", () => {
    // /implement's issue-first path reads the ## Requirements section and
    // treats every UID bullet as an authoritative in-scope requirement.
    // An issue created from a Ground Control requirement must seed that
    // section so the round-trip works without a manual body edit.
    const req = {
      uid: "GC-X042",
      title: "Example requirement",
      statement: "The system shall do the thing.",
    };
    const body = formatIssueBody(req);
    const reqIndex = body.indexOf("## Requirements");
    const statementIndex = body.indexOf("## Statement");
    assert.notEqual(reqIndex, -1, "## Requirements must be present");
    assert.ok(
      reqIndex < statementIndex,
      "## Requirements must precede ## Statement",
    );
    assert.match(body, /## Requirements\n\n- GC-X042 — Example requirement\n/);
  });

  it("falls back to the UID alone when no title is supplied", () => {
    const req = { uid: "GC-T002", statement: "No title." };
    const body = formatIssueBody(req);
    assert.match(body, /## Requirements\n\n- GC-T002\n/);
  });

  it("collapses newlines in the title so they cannot inject extra Requirements bullets", () => {
    // Requirement titles are untrusted user input. A malicious or
    // accidentally-pasted multiline title must not produce a second
    // list item — the parser at the `/implement` side would otherwise
    // treat the second line as a second UID entry in
    // `in_scope_requirements[]` and link/transition an unrelated
    // requirement. See code comment in formatIssueBody for the rule.
    const req = {
      uid: "GC-INJ001",
      title: "Original title\n- GC-X999 — fake injected requirement",
      statement: "The system shall be resistant to title injection.",
    };
    const body = formatIssueBody(req);
    assert.ok(body.includes("## Requirements"));
    const reqSection = body.slice(body.indexOf("## Requirements"));
    const nextHeader = reqSection.indexOf("## Statement");
    const reqBody = reqSection.slice(0, nextHeader);
    // Exactly one bullet in the Requirements section.
    const bullets = reqBody.split("\n").filter((line) => line.startsWith("- "));
    assert.equal(
      bullets.length,
      1,
      `expected exactly one requirement bullet, got ${bullets.length}: ${JSON.stringify(bullets)}`,
    );
    assert.equal(
      bullets[0],
      "- GC-INJ001 — Original title - GC-X999 — fake injected requirement",
    );
    // And the injected GC-X999 UID must not appear as a standalone bullet.
    assert.ok(!reqBody.includes("\n- GC-X999"));
  });

  it("collapses tabs and runs of whitespace in the title", () => {
    const req = {
      uid: "GC-T003",
      title: "Multiple\t\twhitespace    runs",
      statement: "Ok.",
    };
    const body = formatIssueBody(req);
    assert.match(body, /## Requirements\n\n- GC-T003 — Multiple whitespace runs\n/);
  });

  it("reads the title from folder_title (the field request() returns after toSnakeCase)", () => {
    // request() runs every response through toSnakeCase, which renames
    // `title` -> `folder_title` globally. A requirement fetched via the lib
    // therefore carries its title under folder_title, not title.
    const req = {
      uid: "GC-D007",
      folder_title: "Create GitHub issues from requirements",
      statement: "The system shall create GitHub issues.",
    };
    const body = formatIssueBody(req);
    assert.match(body, /## Requirements\n\n- GC-D007 — Create GitHub issues from requirements\n/);
  });
});
