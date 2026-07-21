import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  hashServiceCredentialToken,
  isServiceCredentialToken,
} from "#/services/credentials/index.js";

describe("service credential token helpers", () => {
  it("accepts only non-empty tokens with the service credential prefix", () => {
    expect(isServiceCredentialToken("trema_sc_secret")).toBe(true);
    expect(isServiceCredentialToken("trema_sc_")).toBe(false);
    expect(isServiceCredentialToken("secret")).toBe(false);
  });

  it("hashes tokens with SHA-256 as lowercase hex", () => {
    const token = "trema_sc_example";
    const expected = createHash("sha256").update(token, "utf8").digest("hex");

    expect(hashServiceCredentialToken(token)).toBe(expected);
    expect(hashServiceCredentialToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
