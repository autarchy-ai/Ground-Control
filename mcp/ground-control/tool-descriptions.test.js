// Parity regression test: verify that every action-multiplexed MCP tool's
// published description contains the required field tokens it enforces at
// runtime. Spawns the real MCP server as a subprocess and queries it via the
// SDK client so the assertion targets the live published surface, not a static
// string in source. Addresses issue #1169.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DIR = fileURLToPath(new URL(".", import.meta.url));

// Required field tokens per tool. Each token is a distinctive field name that
// the tool description must contain because the tool enforces it at runtime
// (via reqArg or equivalent). Tokens are substrings of field names; the check
// is description.includes(token).
const REQUIRED_FIELD_REGISTRY = {
  gc_prepare_implement_branch: [
    "repo_path", "invocation_root", "issue_number", "branch_name",
    "base_branch", "checkout_mode",
  ],
  gc_implement_mechanical: [
    "action", "repo_path", "issue_number", "invocation_root", "branch_name",
    "base_branch", "driver", "requested_requirement_uid", "requirements", "commit_message",
    "synchronization", "pr_number", "completion", "async", "idempotency_key",
  ],
  gc_synchronize_implement_branch: [
    "repo_path", "issue_number", "branch_name", "action", "record_id",
    "pre_sync_sha", "fetched_base_sha", "outcome", "requested_requirement_uid",
  ],
  gc_create_synchronized_implement_pr: [
    "repo_path", "issue_number", "branch_name", "record_id", "title", "body",
  ],
  gc_record_execution_obligation: [
    "obligation_id", "event", "category", "observed_state", "evidence",
    "impact", "obligation", "pause_class", "decision_request", "disposition",
    "corrective_action", "verification", "user_authorization",
  ],
  gc_mark_implement_issue_picked_up: [
    "repo_path", "issue_number", "driver", "branch_name",
  ],
  gc_authorize_execution_obligation_wontfix: [
    "repo_path", "issue_number", "obligation_id", "authorization_source_url",
  ],
  gc_reconcile_station_observation: [
    "repo_path", "issue_number", "obligation_id", "findings_record_url",
  ],
  gc_release_identity: [
    "action", "repo_path", "issue_number", "family", "idempotency_key", "reason",
  ],
};

describe("MCP tool description parity (issue #1169)", { timeout: 30000 }, () => {
  let client;
  let transport;
  let descriptionMap;
  let toolMap;

  before(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["index.js"],
      cwd: DIR,
      stderr: "ignore",
    });
    client = new Client({ name: "desc-parity-test", version: "1.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    descriptionMap = Object.fromEntries(
      tools.map((t) => [t.name, t.description ?? ""]),
    );
  });

  after(async () => {
    if (client) await client.close();
  });

  for (const [toolName, tokens] of Object.entries(REQUIRED_FIELD_REGISTRY)) {
    it(`${toolName}: description contains all required field tokens`, () => {
      const description = descriptionMap[toolName];
      assert.ok(
        description !== undefined,
        `Tool '${toolName}' not found in listTools() response`,
      );
      for (const token of tokens) {
        assert.ok(
          description.includes(token),
          `Tool '${toolName}': description missing token '${token}'`,
        );
      }
    });
  }

  it("publishes the bounded async mechanical and polling schema", () => {
    const mechanical = toolMap.gc_implement_mechanical?.inputSchema?.properties;
    assert.equal(mechanical?.async?.type, "boolean");
    assert.equal(mechanical?.idempotency_key?.type, "string");
    assert.ok(mechanical?.idempotency_key?.maxLength <= 128);
    assert.equal(typeof mechanical?.idempotency_key?.pattern, "string");

    const polling = toolMap.gc_codex_job?.inputSchema?.properties;
    assert.equal(polling?.job_id?.type, "string");
    assert.ok(polling?.job_id?.maxLength <= 80);
    assert.equal(typeof polling?.job_id?.pattern, "string");
    assert.match(descriptionMap.gc_codex_job, /gc_implement_mechanical/);
    assert.match(descriptionMap.gc_codex_job, /review-cycle.*issue thread/i);
    assert.doesNotMatch(descriptionMap.gc_codex_job, /re-run the originating tool/i);
  });

  it("directs merged PRs immediately into finalize without waiting on hosted actions", () => {
    assert.match(descriptionMap.gc_implement_mechanical, /linked PR is merged/i);
    assert.match(descriptionMap.gc_implement_mechanical, /run finalize immediately/i);
    assert.match(descriptionMap.gc_implement_mechanical, /do not wait for post-merge hosted actions/i);
  });

  it("publishes a release-identity schema with no caller-selected destination or identity (issue #1579)", () => {
    const schema = toolMap.gc_release_identity?.inputSchema;
    assert.deepEqual(Object.keys(schema?.properties ?? {}).sort(),
      ["action", "family", "idempotency_key", "issue_number", "reason", "repo_path"]);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.action.enum, ["reserve", "publish", "abandon", "status"]);
    assert.ok(schema.properties.idempotency_key.maxLength <= 128);
  });

  it("publishes async-only idempotent review-cycle schemas", () => {
    for (const name of ["gc_codex_review_cycle"]) {
      const properties = toolMap[name]?.inputSchema?.properties;
      const required = toolMap[name]?.inputSchema?.required ?? [];
      assert.equal(properties?.async?.type, "boolean");
      assert.equal(properties?.idempotency_key?.type, "string");
      assert.ok(properties?.idempotency_key?.maxLength <= 128);
      assert.equal(typeof properties?.idempotency_key?.pattern, "string");
      assert.ok(required.includes("idempotency_key"));
      assert.match(descriptionMap[name], /async-only/i);
      assert.match(descriptionMap[name], /idempotency_key/);
      assert.match(descriptionMap[name], /gc_codex_job/);
      assert.deepEqual(properties?.publication_mode?.enum, ["automatic", "deferred"]);
    }
    assert.equal(toolMap.gc_test_quality_review, undefined);
    assert.equal(toolMap.gc_test_quality_review_cycle, undefined);
  });

  it("publishes separate retained-review inspection and publication capabilities", () => {
    const inspect = toolMap.gc_get_review_result?.inputSchema?.properties;
    const publish = toolMap.gc_publish_review_result?.inputSchema?.properties;
    assert.deepEqual(Object.keys(inspect ?? {}).sort(), ["repo_path", "review_handle"]);
    assert.deepEqual(Object.keys(publish ?? {}).sort(), ["architectural_read", "findings", "notes", "publication_kind", "repo_path", "review_handle", "verdict"]);
    assert.match(descriptionMap.gc_get_review_result, /no GitHub writes/i);
    assert.match(descriptionMap.gc_publish_review_result, /sanitized/i);
    assert.match(descriptionMap.gc_publish_review_result, /stale/i);
  });
});
