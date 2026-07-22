import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { loadProviderCatalog } from "#/services/connectors/catalog.js";
import { buildOAuthAuthorizationUrl } from "#/services/connectors/connect.js";
import { githubProvider } from "#/services/connectors/providers/github.js";
import { TemplateInterpolationError } from "#/services/connectors/templates.js";

const baseProvider = {
  ...githubProvider,
  auth: { ...githubProvider.auth, pkce: true },
};

describe("OAuth authorization URL construction", () => {
  it("uses the deployment callback, scopes, state, and an S256 PKCE challenge", () => {
    const provider = loadProviderCatalog([baseProvider])[0]!;
    const codeVerifier = "fixed-verifier";
    const result = new URL(
      buildOAuthAuthorizationUrl({
        provider,
        clientId: "client-id",
        authBaseUrl: "https://auth.trema.example/base",
        state: "opaque-state",
        codeVerifier,
      }),
    );

    expect(result.searchParams.get("client_id")).toBe("client-id");
    expect(result.searchParams.get("redirect_uri")).toBe(
      "https://auth.trema.example/connect/callback",
    );
    expect(result.searchParams.get("scope")).toBe("read:user repo");
    expect(result.searchParams.get("state")).toBe("opaque-state");
    expect(result.searchParams.get("code_challenge_method")).toBe("S256");
    expect(result.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(codeVerifier).digest("base64url"),
    );
  });

  it("omits PKCE parameters for providers that explicitly opt out", () => {
    const provider = loadProviderCatalog([githubProvider])[0]!;
    const result = new URL(
      buildOAuthAuthorizationUrl({
        provider,
        clientId: "client-id",
        authBaseUrl: "https://auth.trema.example",
        state: "opaque-state",
        codeVerifier: "unused-verifier",
      }),
    );

    expect(result.searchParams.has("code_challenge")).toBe(false);
    expect(result.searchParams.has("code_challenge_method")).toBe(false);
  });

  it("rejects an unfilled URL placeholder before returning a redirect", () => {
    const provider = loadProviderCatalog([
      {
        ...baseProvider,
        configFields: {
          tenant: { type: "string", title: "Tenant", description: "Provider tenant" },
        },
        auth: {
          ...baseProvider.auth,
          authorizationUrl: `https://\${config.tenant}.example.test/oauth/authorize`,
        },
      },
    ])[0]!;

    expect(() =>
      buildOAuthAuthorizationUrl({
        provider,
        clientId: "client-id",
        authBaseUrl: "https://auth.trema.example",
        state: "opaque-state",
        codeVerifier: "verifier",
      }),
    ).toThrow(TemplateInterpolationError);
  });
});
