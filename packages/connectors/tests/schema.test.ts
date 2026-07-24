import { describe, expect, it } from "vitest";

import {
  gammaProvider,
  githubProvider,
  googleIdTokenIdentity,
  loadProviderCatalog,
  ProviderCatalogValidationError,
  type ProviderDefInput,
  providerDefSchema,
} from "#/index.js";

function githubInput(): ProviderDefInput {
  return structuredClone(githubProvider) as ProviderDefInput;
}

describe("providerDefSchema", () => {
  it("parses a valid provider entry", () => {
    const provider = providerDefSchema.parse(githubInput());

    expect(provider.key).toBe("github");
    expect(provider.auth.pkce).toBe(false);
  });

  it("rejects oauth2_code without a token URL", () => {
    const provider = githubInput();
    delete provider.auth.tokenUrl;

    expect(providerDefSchema.safeParse(provider).success).toBe(false);
  });

  it("rejects OAuth URL fields on api_key providers", () => {
    const provider = githubInput();
    provider.authMode = "api_key";
    delete provider.auth.authorizationUrl;

    expect(providerDefSchema.safeParse(provider).success).toBe(false);
  });

  it("requires a non-empty manifest for REST providers", () => {
    const provider = githubInput();
    provider.toolManifest = [];

    expect(providerDefSchema.safeParse(provider).success).toBe(false);
  });

  it("accepts an availableScopes vocabulary of trimmed non-empty strings", () => {
    const provider = githubInput();
    provider.auth.availableScopes = ["read:user", "repo", "gist"];

    expect(providerDefSchema.safeParse(provider).success).toBe(true);
  });

  it("rejects availableScopes containing empty entries", () => {
    const provider = githubInput();
    provider.auth.availableScopes = ["read:user", ""];

    expect(providerDefSchema.safeParse(provider).success).toBe(false);
  });

  it("accepts a non-empty account identity field declaration", () => {
    const provider = githubInput();
    provider.auth.accountIdentityFields = ["account_id"];

    expect(providerDefSchema.safeParse(provider).success).toBe(true);
  });

  it("rejects an empty account identity field declaration", () => {
    const provider = githubInput();
    provider.auth.accountIdentityFields = [];

    expect(providerDefSchema.safeParse(provider).success).toBe(false);
  });

  it("accepts named authentication headers for REST providers", () => {
    const provider = providerDefSchema.parse(gammaProvider);

    expect(provider.transport).toMatchObject({
      type: "rest",
      authHeaders: { "x-api-key": `\${credentials.apiKey}` },
    });
  });

  it("rejects simultaneous standard and named authentication headers", () => {
    const provider = structuredClone(gammaProvider) as ProviderDefInput;
    if (provider.transport.type !== "rest") throw new Error("Expected a REST provider");
    provider.transport.authHeader = `Bearer \${credentials.apiKey}`;

    expect(providerDefSchema.safeParse(provider).success).toBe(false);
  });
});

describe("provider catalog validation", () => {
  it("rejects a hook name absent from the typed registry", () => {
    const provider = githubInput();
    provider.hooks = { postConnection: "missingHook" };

    expect(() => loadProviderCatalog([provider])).toThrowError(ProviderCatalogValidationError);
    expect(() => loadProviderCatalog([provider])).toThrowError(/unknown hook 'missingHook'/);
  });

  it("rejects duplicate provider keys", () => {
    expect(() => loadProviderCatalog([githubInput(), githubInput()])).toThrowError(
      /Duplicate provider key 'github'/,
    );
  });

  it("accepts a per-tool base URL whose placeholder is declared", () => {
    const provider = githubInput();
    const tool = provider.toolManifest?.[0];
    if (!tool) throw new Error("GitHub fixture requires a tool");
    provider.configFields = {
      apiHost: { type: "string", title: "API host", description: "Provider API host" },
    };
    provider.toolManifest = [
      {
        ...tool,
        baseUrl: `https://\${config.apiHost}`,
      },
    ];

    expect(() => loadProviderCatalog([provider])).not.toThrow();
  });

  it("rejects a per-tool base URL whose placeholder is undeclared", () => {
    const provider = githubInput();
    const tool = provider.toolManifest?.[0];
    if (!tool) throw new Error("GitHub fixture requires a tool");
    provider.toolManifest = [
      {
        ...tool,
        baseUrl: `https://\${config.missingHost}`,
      },
    ];

    expect(() => loadProviderCatalog([provider])).toThrowError(ProviderCatalogValidationError);
    expect(() => loadProviderCatalog([provider])).toThrowError(
      /toolManifest\[0\]\.baseUrl has invalid placeholder 'config\.missingHost'/,
    );
  });

  it("validates placeholders in named authentication headers", () => {
    const provider = structuredClone(gammaProvider) as ProviderDefInput;
    if (provider.transport.type !== "rest") throw new Error("Expected a REST provider");
    provider.transport.authHeaders = { "x-api-key": `\${credentials.missing}` };

    expect(() => loadProviderCatalog([provider])).toThrowError(
      /transport\.authHeaders\.x-api-key has invalid placeholder 'credentials\.missing'/,
    );
  });
});

describe("google_id_token_identity", () => {
  function idToken(claims: Record<string, unknown>) {
    return [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      "signature",
    ].join(".");
  }

  it("returns only the non-secret Google identity claims", () => {
    const token = idToken({ sub: "google-subject", email: "ada@example.com", hd: "example.com" });

    expect(
      googleIdTokenIdentity({
        tokenResponse: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          id_token: token,
        },
        config: {},
      }),
    ).toEqual({ sub: "google-subject", email: "ada@example.com", hd: "example.com" });
  });

  it("ignores missing or malformed id tokens without exposing token values", () => {
    const missing = googleIdTokenIdentity({
      tokenResponse: { access_token: "access-token" },
      config: {},
    });
    const malformed = googleIdTokenIdentity({
      tokenResponse: { id_token: "not-a-jwt", access_token: "access-token" },
      config: {},
    });

    expect(missing).toEqual({});
    expect(malformed).toEqual({});
    expect(JSON.stringify({ missing, malformed })).not.toContain("access-token");
  });
});
