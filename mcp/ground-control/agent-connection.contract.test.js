import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const SCHEMA_PATH = resolve(
  ROOT,
  "architecture/contracts/gc.agent-connection.v1.schema.json",
);

function readSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(readSchema());

const session = {
  machine_id: "machine-1",
  checkout_id: "checkout-1",
  harness: "codex",
  account_profile_id: "work",
  native_session_id: "session-1",
};

function envelope(message_type, payload) {
  return {
    schema: "gc.agent-connection/v1",
    message_id: `message-${message_type}`,
    message_type,
    issued_at: "2026-09-17T04:00:00Z",
    session,
    payload,
  };
}

function assertValid(document) {
  assert.equal(validate(document), true, JSON.stringify(validate.errors));
}

function assertInvalid(document) {
  assert.equal(validate(document), false, "document unexpectedly matched v1");
}

function collectPropertyNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPropertyNames(item, names);
    return names;
  }
  if (!value || typeof value !== "object") return names;
  if (value.properties && typeof value.properties === "object") {
    for (const name of Object.keys(value.properties)) names.add(name);
  }
  for (const child of Object.values(value)) collectPropertyNames(child, names);
  return names;
}

test("agent connection v1 keeps session identity dimensions distinct", () => {
  const schema = readSchema();
  assert.equal(schema.$id, "https://ground-control.dev/contracts/gc.agent-connection/v1");
  assert.equal(schema.additionalProperties, false);

  const identity = schema.$defs.sessionIdentity;
  assert.equal(identity.additionalProperties, false);
  assert.deepEqual(identity.required, [
    "machine_id",
    "checkout_id",
    "harness",
    "account_profile_id",
    "native_session_id",
  ]);
  assert.deepEqual(identity.properties.harness.enum, ["claude-code", "codex"]);
  for (const name of identity.required) {
    assert.equal(identity.properties[name].type, "string", `${name} stays independently typed`);
  }
});

test("agent connection v1 separates observations, commands, and delivery results", () => {
  const schema = readSchema();
  assert.deepEqual(schema.properties.message_type.enum, [
    "connection",
    "observation",
    "message",
    "delivery_result",
  ]);
  assert.deepEqual(schema.$defs.completeness.enum, ["complete", "partial", "unknown"]);
  assert.deepEqual(schema.$defs.deliveryOutcome.enum, [
    "accepted_by_harness",
    "rejected",
    "unsupported",
    "session_unavailable",
    "unknown_after_disconnect",
  ]);
  assert.deepEqual(schema.$defs.capabilityStatus.enum, ["available", "unavailable"]);
  assert.deepEqual(schema.$defs.capability.allOf[0].then.required, ["reason"]);
  assert.equal(schema.$defs.messagePayload.properties.text.maxLength, 8000);
});

test("agent connection v1 keys capabilities and requires unavailable reasons", () => {
  const connection = envelope("connection", {
    connector_version: "0.8.0",
    harness_version: "0.151.0",
    capabilities: {
      observe: { status: "available" },
      send_message: { status: "unavailable", reason: "unqualified_version" },
    },
    egress_mode: "metadata",
    transport: "loopback",
  });
  assertValid(connection);

  assertInvalid({
    ...connection,
    payload: {
      ...connection.payload,
      capabilities: [
        { name: "observe", status: "available" },
        { name: "observe", status: "unavailable", reason: "disconnected" },
      ],
    },
  });
  assertInvalid({
    ...connection,
    payload: {
      ...connection.payload,
      capabilities: { observe: { status: "unavailable" } },
    },
  });
});

test("agent connection v1 enforces each observation egress ceiling", () => {
  const metadataObservation = envelope("observation", {
    sequence: 1,
    captured_at: "2026-09-17T04:00:01Z",
    event_kind: "turn.updated",
    egress_mode: "metadata",
    metadata: { attention_state: "waiting_for_input" },
    source: "live_protocol",
    completeness: "complete",
  });
  assertValid(metadataObservation);
  assertInvalid({
    ...metadataObservation,
    payload: { ...metadataObservation.payload, transcript_payload: "private prompt" },
  });

  const transcriptObservation = {
    ...metadataObservation,
    payload: {
      ...metadataObservation.payload,
      egress_mode: "transcript",
      transcript_payload: "bounded provider event text",
    },
  };
  assertValid(transcriptObservation);
  assertInvalid({
    ...transcriptObservation,
    payload: {
      ...transcriptObservation.payload,
      workspace_payload: { path_label: "src/app.js", content: "source" },
    },
  });
});

test("agent connection v1 keeps messages text-only", () => {
  const message = envelope("message", {
    caller_message_id: "caller-1",
    text: "Continue with the targeted test.",
  });
  assertValid(message);
  assertInvalid({
    ...message,
    payload: {
      ...message.payload,
      attachment: { media_type: "text/plain", content: "not in v1" },
    },
  });
});

test("agent connection v1 rejects free-form delivery diagnostics", () => {
  const delivery = envelope("delivery_result", {
    caller_message_id: "caller-1",
    outcome: "rejected",
    observed_at: "2026-09-17T04:00:02Z",
  });
  assertValid(delivery);
  assertInvalid({
    ...delivery,
    payload: {
      ...delivery.payload,
      detail: "native error containing a path or transcript fragment",
    },
  });
});

test("agent connection v1 enforces closed objects, timestamps, and opaque ids", () => {
  const connection = envelope("connection", {
    connector_version: "0.8.0",
    harness_version: "0.151.0",
    capabilities: { observe: { status: "available" } },
    egress_mode: "metadata",
    transport: "loopback",
  });
  const observation = envelope("observation", {
    sequence: 1,
    captured_at: "2026-09-17T04:00:01Z",
    event_kind: "turn.updated",
    egress_mode: "workspace",
    metadata: { attention_state: "active" },
    workspace_payload: { path_label: "src/app.js", content: "source" },
    source: "live_protocol",
    completeness: "complete",
  });
  const message = envelope("message", {
    caller_message_id: "caller-1",
    text: "Continue.",
  });
  const delivery = envelope("delivery_result", {
    caller_message_id: "caller-1",
    outcome: "accepted_by_harness",
    observed_at: "2026-09-17T04:00:02Z",
  });
  for (const document of [connection, observation, message, delivery]) assertValid(document);

  assertInvalid({ ...connection, unknown_envelope_key: true });
  assertInvalid({ ...connection, session: { ...connection.session, unknown_identity_key: true } });
  assertInvalid({
    ...connection,
    payload: { ...connection.payload, unknown_connection_key: true },
  });
  assertInvalid({
    ...connection,
    payload: {
      ...connection.payload,
      capabilities: { ...connection.payload.capabilities, launch_shell: { status: "available" } },
    },
  });
  assertInvalid({
    ...connection,
    payload: {
      ...connection.payload,
      capabilities: { observe: { status: "available", unknown_capability_key: true } },
    },
  });
  assertInvalid({
    ...observation,
    payload: { ...observation.payload, unknown_observation_key: true },
  });
  assertInvalid({
    ...observation,
    payload: {
      ...observation.payload,
      metadata: { ...observation.payload.metadata, unknown_metadata_key: true },
    },
  });
  assertInvalid({
    ...observation,
    payload: {
      ...observation.payload,
      workspace_payload: {
        ...observation.payload.workspace_payload,
        unknown_workspace_key: true,
      },
    },
  });

  assertInvalid({ ...connection, issued_at: "not-a-timestamp" });
  assertInvalid({
    ...observation,
    payload: { ...observation.payload, captured_at: "not-a-timestamp" },
  });
  assertInvalid({
    ...delivery,
    payload: { ...delivery.payload, observed_at: "not-a-timestamp" },
  });
  assertInvalid({ ...message, message_id: "-invalid" });
  assertInvalid({
    ...message,
    payload: { ...message.payload, caller_message_id: "contains a space" },
  });
});

test("agent connection v1 has no credential, shell, or workflow-authority channel", () => {
  const propertyNames = collectPropertyNames(readSchema());
  const forbidden = [
    "api_key",
    "credential",
    "credential_path",
    "environment",
    "github_token",
    "merge",
    "raw_environment",
    "shell",
    "terminal_input",
    "workflow_command",
  ];
  for (const name of forbidden) {
    assert.equal(propertyNames.has(name), false, `${name} must not be in the wire contract`);
  }
});

test("dependency manifests keep the excluded product out", () => {
  const manifests = [
    resolve(ROOT, "mcp/ground-control/package.json"),
    resolve(ROOT, "mcp/ground-control/package-lock.json"),
  ];
  for (const manifest of manifests) {
    assert.doesNotMatch(readFileSync(manifest, "utf8"), /vicoa/i, manifest);
  }
});
