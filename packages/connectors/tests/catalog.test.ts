import { describe, expect, it } from "vitest";

import {
  githubProvider,
  loadProviderCatalog,
  ProviderCatalogValidationError,
  type ProviderDefInput,
} from "#/index.js";

describe("loadProviderCatalog", () => {
  it("loads and freezes the shipped provider catalog", () => {
    const catalog = loadProviderCatalog();

    expect(catalog.map(({ key, authMode }) => ({ key, authMode }))).toEqual([
      { key: "asana", authMode: "mcp_oauth" },
      { key: "figma", authMode: "oauth2_code" },
      { key: "github", authMode: "oauth2_code" },
      { key: "hubspot", authMode: "oauth2_code" },
      { key: "linear", authMode: "mcp_oauth" },
      { key: "notion", authMode: "mcp_oauth" },
      { key: "sentry", authMode: "mcp_oauth" },
      { key: "slack", authMode: "oauth2_code" },
      { key: "stripe", authMode: "api_key" },
      { key: "zendesk", authMode: "oauth2_code" },
    ]);

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[0])).toBe(true);
    expect(Object.isFrozen(catalog[0]?.auth)).toBe(true);
  });

  it("ships exactly one entry per product", () => {
    const catalog = loadProviderCatalog();
    const restKeys = catalog
      .filter((provider) => provider.transport.type === "rest")
      .map(({ key }) => key);

    // No <key>_mcp duals: where the vendor MCP server is dominated by the
    // REST integration (identity model, scopes, coverage), only REST ships.
    expect(catalog.some(({ key }) => key.endsWith("_mcp"))).toBe(false);
    expect(restKeys).toEqual(["figma", "github", "hubspot", "slack", "stripe", "zendesk"]);
  });

  it("declares only documented stable token-response account identities", () => {
    const identities = Object.fromEntries(
      loadProviderCatalog().map((provider) => [
        provider.key,
        provider.auth.accountIdentityFields ?? [],
      ]),
    );

    expect(identities).toEqual({
      asana: ["data.gid"],
      figma: ["user_id_string"],
      github: [],
      hubspot: ["hub_id"],
      linear: [],
      notion: ["workspace_id", "user_id"],
      sentry: [],
      slack: ["team.id"],
      stripe: [],
      zendesk: [],
    });
  });

  it("accepts a catalog whose defaultScopes are all within availableScopes", () => {
    const provider = structuredClone(githubProvider) as ProviderDefInput;
    provider.auth.availableScopes = ["read:user", "repo", "gist"];

    expect(() => loadProviderCatalog([provider])).not.toThrow();
  });

  it("flags a defaultScope absent from availableScopes", () => {
    const provider = structuredClone(githubProvider) as ProviderDefInput;
    provider.auth.availableScopes = ["read:user"];

    expect(() => loadProviderCatalog([provider])).toThrowError(ProviderCatalogValidationError);
    expect(() => loadProviderCatalog([provider])).toThrowError(
      /defaultScope 'repo' is absent from availableScopes/,
    );
  });

  it("ships a catalog whose declared availableScopes cover every defaultScope", () => {
    for (const provider of loadProviderCatalog()) {
      const available = provider.auth.availableScopes;
      if (!available) continue;
      const known = new Set(available);
      for (const scope of provider.auth.defaultScopes) {
        expect(known.has(scope)).toBe(true);
      }
    }
  });

  it("exposes a logo for every shipped provider", () => {
    const catalog = loadProviderCatalog();
    for (const provider of catalog) {
      expect(provider.logoUrl).toMatch(/^\/connector-logos\/.+\.svg$/);
    }
  });

  it("ships a substantial, uniquely named toolManifest for every REST provider", () => {
    const catalog = loadProviderCatalog();
    const restProviders = catalog.filter((provider) => provider.transport.type === "rest");
    expect(restProviders.length).toBeGreaterThan(0);

    for (const provider of restProviders) {
      const names = provider.toolManifest.map(({ name }) => name);
      expect(names.length).toBeGreaterThanOrEqual(8);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
