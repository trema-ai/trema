import { describe, expect, it } from "vitest";

import {
  extractPlaceholders,
  githubProvider,
  interpolate,
  loadProviderCatalog,
  ProviderCatalogValidationError,
  type ProviderDefInput,
  TemplateInterpolationError,
} from "#/index.js";

describe("connector templates", () => {
  it("extracts supported placeholder references", () => {
    expect(
      extractPlaceholders(`https://\${config.tenant}/\${credentials.apiKey}/clients/\${clientId}`),
    ).toEqual(["config.tenant", "credentials.apiKey", "clientId"]);
  });

  it("throws a typed error instead of returning an unfilled placeholder", () => {
    const template = `https://\${config.tenant}/clients/\${clientId}`;

    expect(() => interpolate(template, { clientId: "client" })).toThrowError(
      TemplateInterpolationError,
    );
    expect(() => interpolate(template, { clientId: "client" })).toThrowError(/config\.tenant/);
  });

  it("returns no placeholder syntax after successful interpolation", () => {
    const result = interpolate(`https://\${config.tenant}/clients/\${clientId}`, {
      config: { tenant: "example" },
      clientId: "client",
    });

    expect(result).toBe("https://example/clients/client");
    expect(result).not.toContain("${");
  });

  it("rejects templates that reference undeclared fields", () => {
    const provider = structuredClone(githubProvider) as ProviderDefInput;
    if (provider.transport.type !== "rest") throw new Error("Expected REST provider");
    provider.transport.baseUrl = `https://\${config.tenant}.example.com`;

    expect(() => loadProviderCatalog([provider])).toThrowError(ProviderCatalogValidationError);
    expect(() => loadProviderCatalog([provider])).toThrowError(
      /Provider 'github' transport\.baseUrl has invalid placeholder 'config\.tenant'/,
    );
  });
});
