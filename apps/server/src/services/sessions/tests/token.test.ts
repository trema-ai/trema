import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  hashSessionToken,
  isSessionToken,
  SESSION_TOKEN_TTL_MS,
} from "#server/services/sessions/index.js";

describe("session token helpers", () => {
  it("accepts only non-empty tokens with the session prefix", () => {
    expect(isSessionToken("trema_ses_secret")).toBe(true);
    expect(isSessionToken("trema_ses_")).toBe(false);
    expect(isSessionToken("trema_sc_secret")).toBe(false);
  });

  it("hashes tokens with SHA-256 as lowercase hex", () => {
    const token = "trema_ses_example";
    const expected = createHash("sha256").update(token, "utf8").digest("hex");

    expect(hashSessionToken(token)).toBe(expected);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lives fifteen minutes", () => {
    expect(SESSION_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
  });
});
