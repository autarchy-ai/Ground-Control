// Conditional GitHub reads for the remote-gate watchers (issue #1671).
//
// The saving is real only if an unchanged tick actually sends `If-None-Match` and actually
// reuses the previous body. These tests pin both directions, plus the two ways a naive
// implementation would be wrong: treating an unchanged FIRST page of a paginated response
// as the whole answer, and caching a response that carried no ETag to revalidate against.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ghConditionalGet, parseIncludedResponse } from "./lib/github-conditional.js";

const ETAG = 'W/"abc123"';

function response({ status = 200, etag = ETAG, body = '{"n":1}', link = null } = {}) {
  const headers = [
    `HTTP/2.0 ${status} ${status === 304 ? "Not Modified" : "OK"}`,
    "Content-Type: application/json",
    ...(etag ? [`Etag: ${etag}`] : []),
    ...(link ? [`Link: ${link}`] : []),
  ].join("\r\n");
  return status === 304 ? `${headers}\r\n\r\n` : `${headers}\r\n\r\n${body}`;
}

// A stub `gh` that records every invocation's argv.
function ghStub(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    execFile: async (_cmd, args) => {
      calls.push(args);
      return { stdout: queue.shift() ?? response({ status: 304, body: "" }) };
    },
  };
}

describe("parseIncludedResponse", () => {
  it("reads the status, headers, and body of a normal response", () => {
    const parsed = parseIncludedResponse(response());
    assert.equal(parsed.status, 200);
    assert.equal(parsed.headers.etag, ETAG);
    assert.equal(JSON.parse(parsed.body).n, 1);
  });

  it("reads a 304, which carries no body", () => {
    const parsed = parseIncludedResponse(response({ status: 304, body: "" }));
    assert.equal(parsed.status, 304);
    assert.equal(parsed.body.trim(), "");
  });

  it("takes the final response when a redirect emitted more than one header block", () => {
    const redirected = [
      "HTTP/2.0 301 Moved Permanently",
      "Location: /elsewhere",
      "",
      response({ body: '{"n":7}' }),
    ].join("\r\n");
    const parsed = parseIncludedResponse(redirected);
    assert.equal(parsed.status, 200);
    assert.equal(JSON.parse(parsed.body).n, 7);
  });
});

describe("ghConditionalGet", () => {
  it("sends no validator on the first read, then revalidates with the ETag it was given", async () => {
    const cache = new Map();
    const gh = ghStub([response({ body: '{"n":1}' }), response({ status: 304, body: "" })]);

    const first = await ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache });
    assert.equal(first.changed, true);
    assert.deepEqual(first.body, { n: 1 });
    assert.ok(!gh.calls[0].includes("-H"), "the first read has nothing to revalidate against");

    const second = await ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache });
    assert.equal(second.changed, false);
    assert.deepEqual(second.body, { n: 1 }, "an unchanged tick reuses the previous body");
    assert.ok(gh.calls[1].includes(`If-None-Match: ${ETAG}`), gh.calls[1].join(" "));
  });

  it("returns the new body, and the new validator, when the resource changed", async () => {
    const cache = new Map();
    const gh = ghStub([
      response({ body: '{"n":1}' }),
      response({ etag: 'W/"def456"', body: '{"n":2}' }),
      response({ status: 304, body: "" }),
    ]);

    await ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache });
    const changed = await ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache });
    assert.equal(changed.changed, true);
    assert.deepEqual(changed.body, { n: 2 });

    await ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache });
    assert.ok(gh.calls[2].includes('If-None-Match: W/"def456"'), "it revalidates against the LATEST etag");
  });

  it("keeps separate validators per endpoint and per checkout", async () => {
    const cache = new Map();
    const gh = ghStub([
      response({ etag: 'W/"a"', body: '{"n":1}' }),
      response({ etag: 'W/"b"', body: '{"n":2}' }),
      response({ status: 304, body: "" }),
    ]);
    await ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache });
    await ghConditionalGet("/repo", "/y", { execFile: gh.execFile, cache });
    await ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache });
    assert.ok(gh.calls[2].includes('If-None-Match: W/"a"'), "endpoint /x revalidates with its own etag");
  });

  it("reports a response that declared a next page, so one unchanged page is not the whole answer", async () => {
    const cache = new Map();
    const gh = ghStub([
      response({ body: "[]", link: '<https://api.github.com/x?page=2>; rel="next"' }),
      response({ status: 304, body: "" }),
    ]);
    const first = await ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache });
    assert.equal(first.paginated, true);
    const second = await ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache });
    assert.equal(second.changed, false);
    assert.equal(second.paginated, true, "the pagination fact survives an unchanged revalidation");
  });

  it("does not remember a response it could never revalidate", async () => {
    const cache = new Map();
    const gh = ghStub([response({ etag: null, body: '{"n":1}' }), response({ body: '{"n":1}' })]);
    await ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache });
    assert.equal(cache.size, 0);
    await ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache });
    assert.ok(!gh.calls[1].includes("-H"), "with nothing cached the next read stays unconditional");
  });

  it("refuses a body that is not JSON rather than caching nonsense", async () => {
    const gh = ghStub(["HTTP/2.0 200 OK\r\nEtag: W/\"x\"\r\n\r\n<html>nope</html>"]);
    await assert.rejects(
      () => ghConditionalGet("/repo", "/x", { execFile: gh.execFile, cache: new Map() }),
      /was not JSON/,
    );
  });

  it("bounds the cache so a long-lived server does not leak an entry per endpoint", async () => {
    const cache = new Map();
    const gh = ghStub(Array.from({ length: 300 }, (_, i) => response({ etag: `W/"${i}"`, body: `{"n":${i}}` })));
    for (let i = 0; i < 300; i += 1) {
      await ghConditionalGet("/repo", `/x/${i}`, { execFile: gh.execFile, cache });
    }
    assert.ok(cache.size <= 256, `cache grew to ${cache.size}`);
  });
});
