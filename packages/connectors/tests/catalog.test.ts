import { describe, expect, it } from "vitest";

import {
  githubProvider,
  loadProviderCatalog,
  ProviderCatalogValidationError,
  type ProviderDefInput,
} from "#connectors/index.js";

describe("loadProviderCatalog", () => {
  it("loads and freezes the shipped provider catalog", () => {
    const catalog = loadProviderCatalog();

    expect(catalog.map(({ key, authMode }) => ({ key, authMode }))).toEqual([
      { key: "airtable", authMode: "mcp_oauth" },
      { key: "apollo", authMode: "mcp_oauth" },
      { key: "asana", authMode: "mcp_oauth" },
      { key: "box", authMode: "oauth2_code" },
      { key: "canva", authMode: "oauth2_code" },
      { key: "clickup", authMode: "mcp_oauth" },
      { key: "docusign", authMode: "oauth2_code" },
      { key: "dropbox", authMode: "oauth2_code" },
      { key: "figma", authMode: "oauth2_code" },
      { key: "gamma", authMode: "api_key" },
      { key: "github", authMode: "oauth2_code" },
      { key: "google_workspace", authMode: "oauth2_code" },
      { key: "granola", authMode: "mcp_oauth" },
      { key: "hubspot", authMode: "oauth2_code" },
      { key: "intercom", authMode: "oauth2_code" },
      { key: "linear", authMode: "mcp_oauth" },
      { key: "lucid", authMode: "oauth2_code" },
      { key: "miro", authMode: "oauth2_code" },
      { key: "monday", authMode: "mcp_oauth" },
      { key: "n8n", authMode: "api_key" },
      { key: "netsuite", authMode: "oauth2_code" },
      { key: "notion", authMode: "mcp_oauth" },
      { key: "posthog", authMode: "api_key" },
      { key: "sentry", authMode: "mcp_oauth" },
      { key: "slack", authMode: "oauth2_code" },
      { key: "stripe", authMode: "api_key" },
      { key: "supabase", authMode: "mcp_oauth" },
      { key: "vercel", authMode: "api_key" },
      { key: "zapier", authMode: "oauth2_code" },
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
    expect(restKeys).toEqual([
      "box",
      "canva",
      "docusign",
      "dropbox",
      "figma",
      "gamma",
      "github",
      "google_workspace",
      "hubspot",
      "intercom",
      "lucid",
      "miro",
      "n8n",
      "netsuite",
      "posthog",
      "slack",
      "stripe",
      "vercel",
      "zapier",
      "zendesk",
    ]);
  });

  it("declares only documented stable token-response account identities", () => {
    const identities = Object.fromEntries(
      loadProviderCatalog().map((provider) => [
        provider.key,
        provider.auth.accountIdentityFields ?? [],
      ]),
    );

    expect(identities).toEqual({
      airtable: [],
      apollo: [],
      asana: ["data.gid"],
      box: [],
      canva: [],
      clickup: [],
      docusign: [],
      dropbox: [],
      figma: ["user_id_string"],
      gamma: [],
      github: [],
      google_workspace: ["sub"],
      granola: [],
      hubspot: ["hub_id"],
      intercom: [],
      linear: [],
      lucid: [],
      miro: [],
      monday: [],
      n8n: [],
      netsuite: [],
      notion: ["workspace_id", "user_id"],
      posthog: [],
      sentry: [],
      slack: ["team.id"],
      stripe: [],
      supabase: [],
      vercel: [],
      zapier: [],
      zendesk: [],
    });
  });

  it("declares provider-specific OAuth client authentication methods", () => {
    const catalog = loadProviderCatalog();

    expect(catalog.find(({ key }) => key === "box")?.auth.tokenRequestAuthMethod).toBe("body");
    expect(catalog.find(({ key }) => key === "miro")?.auth.tokenRequestAuthMethod).toBe("body");
  });

  it("uses Canva's JSON URL-upload endpoints", () => {
    const canva = loadProviderCatalog().find(({ key }) => key === "canva");

    expect(
      canva?.toolManifest
        .filter(({ name }) => name.includes("asset_upload"))
        .map(({ name, path }) => ({ name, path })),
    ).toEqual([
      { name: "create_asset_upload_from_url", path: "/url-asset-uploads" },
      { name: "get_asset_upload_from_url", path: "/url-asset-uploads/{jobId}" },
    ]);
  });

  it("uses Lucid's documented folder and document field names", () => {
    const lucid = loadProviderCatalog().find(({ key }) => key === "lucid");
    const createFolder = lucid?.toolManifest.find(({ name }) => name === "create_folder");
    const updateDocument = lucid?.toolManifest.find(({ name }) => name === "update_document");

    expect(createFolder?.paramsSchema.required).toEqual(["name", "type"]);
    expect(createFolder?.paramsSchema.properties).not.toHaveProperty("title");
    expect(updateDocument?.paramsSchema.properties).toHaveProperty("classificationId");
    expect(updateDocument?.paramsSchema.properties).not.toHaveProperty("classification");
  });

  it("allows DocuSign accounts to select their regional API base URI", () => {
    const docusign = loadProviderCatalog().find(({ key }) => key === "docusign");

    expect(docusign?.transport).toMatchObject({
      type: "rest",
      baseUrl: `\${config.apiBaseUrl}/restapi/v2.1`,
    });
    expect(docusign?.configFields.apiBaseUrl).toMatchObject({
      optional: true,
      default: "https://www.docusign.net",
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
