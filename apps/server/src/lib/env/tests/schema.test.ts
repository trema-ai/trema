import { describe, expect, it } from "vitest";

import { parseEnv } from "#server/lib/env/schema.js";

describe("parseEnv", () => {
  const authSecret = "a-development-auth-secret-with-32-characters";
  const credentialMasterKey = Buffer.alloc(32, 1).toString("base64");

  it("parses values and applies defaults", () => {
    const result = parseEnv({
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/trema",
      TREMA_AUTH_SECRET: authSecret,
      TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey,
    });

    expect(result).toEqual({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/trema",
      HOST: "127.0.0.1",
      PORT: 3000,
      TREMA_MODE: "dedicated",
      TREMA_LOG_FORMAT: "logfmt",
      TREMA_LOG_LEVEL: "info",
      TREMA_AUTH_SECRET: authSecret,
      TREMA_AUTH_BASE_URL: "http://127.0.0.1:3000",
      TREMA_WEB_ORIGINS: ["http://127.0.0.1:5173"],
      TREMA_PASSWORD_AUTH_ENABLED: true,
      TREMA_SESSION_STANDING_BUDGET_TOKENS: 4000,
      TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("coerces a valid port", () => {
    const result = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://localhost/trema",
      HOST: "0.0.0.0",
      PORT: "8080",
      TREMA_AUTH_SECRET: authSecret,
      TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey,
    });

    expect(result).toEqual({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://localhost/trema",
      HOST: "0.0.0.0",
      PORT: 8080,
      TREMA_MODE: "dedicated",
      TREMA_LOG_FORMAT: "logfmt",
      TREMA_LOG_LEVEL: "info",
      TREMA_AUTH_SECRET: authSecret,
      TREMA_AUTH_BASE_URL: "http://127.0.0.1:3000",
      TREMA_WEB_ORIGINS: ["http://127.0.0.1:5173"],
      TREMA_PASSWORD_AUTH_ENABLED: true,
      TREMA_SESSION_STANDING_BUDGET_TOKENS: 4000,
      TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey,
    });
  });

  it("parses all auth and deployment settings", () => {
    const result = parseEnv({
      DATABASE_URL: "postgresql://localhost/trema",
      TREMA_MODE: "hosted",
      TREMA_LOG_FORMAT: "json",
      TREMA_LOG_LEVEL: "debug",
      TREMA_AUTH_SECRET: authSecret,
      TREMA_AUTH_BASE_URL: "https://api.example.com",
      TREMA_WEB_ORIGINS: "https://app.example.com, https://admin.example.com",
      TREMA_WEB_DIST: "/srv/trema/web",
      TREMA_GOOGLE_CLIENT_ID: "google-client",
      TREMA_GOOGLE_CLIENT_SECRET: "google-secret",
      TREMA_PASSWORD_AUTH_ENABLED: "false",
      TREMA_BOOTSTRAP_TOKEN: "bootstrap-token",
      TREMA_SESSION_STANDING_BUDGET_TOKENS: "2000",
      TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey,
      TREMA_OIDC_ISSUER: "https://idp.example.com",
      TREMA_OIDC_CLIENT_ID: "oidc-client",
      TREMA_OIDC_CLIENT_SECRET: "oidc-secret",
    });

    expect(result).toMatchObject({
      TREMA_MODE: "hosted",
      TREMA_LOG_FORMAT: "json",
      TREMA_LOG_LEVEL: "debug",
      TREMA_AUTH_BASE_URL: "https://api.example.com",
      TREMA_WEB_ORIGINS: ["https://app.example.com", "https://admin.example.com"],
      TREMA_WEB_DIST: "/srv/trema/web",
      TREMA_GOOGLE_CLIENT_ID: "google-client",
      TREMA_GOOGLE_CLIENT_SECRET: "google-secret",
      TREMA_PASSWORD_AUTH_ENABLED: false,
      TREMA_BOOTSTRAP_TOKEN: "bootstrap-token",
      TREMA_SESSION_STANDING_BUDGET_TOKENS: 2000,
      TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey,
      TREMA_OIDC_ISSUER: "https://idp.example.com",
      TREMA_OIDC_CLIENT_ID: "oidc-client",
      TREMA_OIDC_CLIENT_SECRET: "oidc-secret",
    });
  });

  it("treats empty optional settings as unset", () => {
    const result = parseEnv({
      DATABASE_URL: "postgresql://localhost/trema",
      TREMA_MODE: "hosted",
      TREMA_AUTH_SECRET: authSecret,
      TREMA_GOOGLE_CLIENT_ID: "",
      TREMA_GOOGLE_CLIENT_SECRET: "",
      TREMA_BOOTSTRAP_TOKEN: "",
      TREMA_CREDENTIAL_MASTER_KEY: "",
      TREMA_WEB_DIST: "",
      TREMA_OIDC_ISSUER: "",
      TREMA_OIDC_CLIENT_ID: "",
      TREMA_OIDC_CLIENT_SECRET: "",
    });

    expect(result.TREMA_GOOGLE_CLIENT_ID).toBeUndefined();
    expect(result.TREMA_BOOTSTRAP_TOKEN).toBeUndefined();
    expect(result.TREMA_CREDENTIAL_MASTER_KEY).toBeUndefined();
    expect(result.TREMA_WEB_DIST).toBeUndefined();
    expect(result.TREMA_OIDC_ISSUER).toBeUndefined();
  });

  it.each([undefined, ""])(
    "requires a credential master key in dedicated mode when the value is %s",
    (credentialMasterKey) => {
      expect(() =>
        parseEnv({
          DATABASE_URL: "postgresql://localhost/trema",
          TREMA_MODE: "dedicated",
          TREMA_AUTH_SECRET: authSecret,
          TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey,
        }),
      ).toThrow("TREMA_CREDENTIAL_MASTER_KEY is required when TREMA_MODE is dedicated");
    },
  );

  it("allows a hosted deployment without a credential master key", () => {
    const result = parseEnv({
      DATABASE_URL: "postgresql://localhost/trema",
      TREMA_MODE: "hosted",
      TREMA_AUTH_SECRET: authSecret,
    });

    expect(result.TREMA_CREDENTIAL_MASTER_KEY).toBeUndefined();
  });

  it.each([
    ["TREMA_GOOGLE_CLIENT_ID", "google-client"],
    ["TREMA_GOOGLE_CLIENT_SECRET", "google-secret"],
  ])("requires the Google pair when %s is set", (key, value) => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgresql://localhost/trema",
        TREMA_MODE: "hosted",
        TREMA_AUTH_SECRET: authSecret,
        [key]: value,
      }),
    ).toThrow("must be configured together");
  });

  it.each([
    ["TREMA_OIDC_ISSUER", "https://idp.example.com"],
    ["TREMA_OIDC_CLIENT_ID", "oidc-client"],
    ["TREMA_OIDC_CLIENT_SECRET", "oidc-secret"],
  ])("requires the OIDC group when %s is set", (key, value) => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgresql://localhost/trema",
        TREMA_MODE: "hosted",
        TREMA_AUTH_SECRET: authSecret,
        [key]: value,
      }),
    ).toThrow("must be configured together");
  });

  it.each([
    [{}, "DATABASE_URL"],
    [
      { DATABASE_URL: "https://example.com/trema", TREMA_AUTH_SECRET: authSecret },
      "PostgreSQL URL",
    ],
    [
      {
        DATABASE_URL: "postgresql://localhost/trema",
        PORT: "70000",
        TREMA_AUTH_SECRET: authSecret,
      },
      "PORT",
    ],
    [
      {
        DATABASE_URL: "postgresql://localhost/trema",
        TREMA_AUTH_SECRET: "short",
      },
      "TREMA_AUTH_SECRET",
    ],
    [
      {
        DATABASE_URL: "postgresql://localhost/trema",
        TREMA_AUTH_SECRET: authSecret,
        TREMA_MODE: "unknown",
      },
      "TREMA_MODE",
    ],
    [
      {
        DATABASE_URL: "postgresql://localhost/trema",
        TREMA_AUTH_SECRET: authSecret,
        TREMA_AUTH_BASE_URL: "not-a-url",
      },
      "TREMA_AUTH_BASE_URL",
    ],
    [
      {
        DATABASE_URL: "postgresql://localhost/trema",
        TREMA_AUTH_SECRET: authSecret,
        TREMA_WEB_ORIGINS: "not-a-url",
      },
      "TREMA_WEB_ORIGINS",
    ],
    [
      {
        DATABASE_URL: "postgresql://localhost/trema",
        TREMA_AUTH_SECRET: authSecret,
        TREMA_PASSWORD_AUTH_ENABLED: "yes",
      },
      "TREMA_PASSWORD_AUTH_ENABLED",
    ],
    [
      {
        DATABASE_URL: "postgresql://localhost/trema",
        TREMA_AUTH_SECRET: authSecret,
        TREMA_LOG_FORMAT: "pretty",
      },
      "TREMA_LOG_FORMAT",
    ],
    [
      {
        DATABASE_URL: "postgresql://localhost/trema",
        TREMA_AUTH_SECRET: authSecret,
        TREMA_LOG_LEVEL: "trace",
      },
      "TREMA_LOG_LEVEL",
    ],
  ])("rejects invalid input", (input, message) => {
    expect(() => parseEnv({ TREMA_CREDENTIAL_MASTER_KEY: credentialMasterKey, ...input })).toThrow(
      message,
    );
  });
});
