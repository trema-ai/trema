import { describe, expect, it } from "vitest";

import {
  githubProvider,
  loadProviderCatalog,
  ProviderCatalogValidationError,
  type ProviderDefInput,
  providerDefSchema,
} from "#/services/connectors/index.js";

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
});
