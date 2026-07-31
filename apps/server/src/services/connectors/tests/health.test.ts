import { describe, expect, it } from "vitest";
import { encryptEnvelope } from "#server/lib/crypto/index.js";
import {
  connectorConnectionCanRefresh,
  connectorConnectionHealthStatus,
  connectorConnectionValidity,
} from "#server/services/connectors/health.js";

const now = new Date("2026-07-31T12:00:00.000Z");
const masterKey = Buffer.alloc(32, 1).toString("base64");

describe("connector connection health", () => {
  it("classifies every state that affects member-visible availability", () => {
    expect(connectorConnectionHealthStatus(undefined, now)).toBe("missing");
    expect(
      connectorConnectionHealthStatus(
        { revokedAt: now, expiresAt: null, refreshExhausted: false },
        now,
      ),
    ).toBe("revoked");
    expect(
      connectorConnectionHealthStatus(
        { revokedAt: null, expiresAt: null, refreshExhausted: true },
        now,
      ),
    ).toBe("refresh_exhausted");
    expect(
      connectorConnectionHealthStatus(
        {
          revokedAt: null,
          expiresAt: new Date("2026-07-31T11:59:59.000Z"),
          refreshExhausted: false,
          canRefresh: true,
        },
        now,
      ),
    ).toBe("available");
    expect(
      connectorConnectionHealthStatus(
        {
          revokedAt: null,
          expiresAt: new Date("2026-07-31T11:59:59.000Z"),
          refreshExhausted: false,
        },
        now,
      ),
    ).toBe("expired");
    expect(
      connectorConnectionHealthStatus(
        {
          revokedAt: null,
          expiresAt: new Date("2026-07-31T12:00:01.000Z"),
          refreshExhausted: false,
        },
        now,
      ),
    ).toBe("available");
  });

  it("keeps the public validity flags aligned with health classification", () => {
    expect(
      connectorConnectionValidity(
        { revokedAt: null, expiresAt: now, refreshExhausted: false },
        now,
      ),
    ).toEqual({ isRevoked: false, isExpired: true, isValid: false });
    expect(
      connectorConnectionValidity(
        { revokedAt: null, expiresAt: now, refreshExhausted: false, canRefresh: true },
        now,
      ),
    ).toEqual({ isRevoked: false, isExpired: false, isValid: true });
  });

  it("detects refresh capability without exposing credential material", () => {
    expect(
      connectorConnectionCanRefresh(
        {
          authMode: "oauth2_code",
          ciphertext: encryptEnvelope({ refreshToken: "refresh-direct" }, masterKey),
        },
        masterKey,
      ),
    ).toBe(true);
    expect(
      connectorConnectionCanRefresh(
        {
          authMode: "mcp_oauth",
          ciphertext: encryptEnvelope({ raw: { refresh_token: "refresh-nested" } }, masterKey),
        },
        masterKey,
      ),
    ).toBe(true);
    expect(
      connectorConnectionCanRefresh(
        {
          authMode: "oauth2_code",
          ciphertext: encryptEnvelope({ accessToken: "access-only" }, masterKey),
        },
        masterKey,
      ),
    ).toBe(false);
    expect(
      connectorConnectionCanRefresh(
        { authMode: "api_key", ciphertext: "not-an-envelope" },
        masterKey,
      ),
    ).toBe(false);
  });
});
