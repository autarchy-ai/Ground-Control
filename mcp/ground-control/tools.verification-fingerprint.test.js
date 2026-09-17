import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verificationFingerprint } from "../../tools/verification-fingerprint.mjs";

describe("repository verification fingerprint", () => {
  it("emits one deterministic lowercase SHA-256", () => {
    const first = verificationFingerprint();
    const second = verificationFingerprint();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(second, first);
  });
});
