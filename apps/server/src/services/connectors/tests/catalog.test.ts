import { describe, expect, it } from "vitest";

import { loadProviderCatalog } from "#/services/connectors/index.js";

describe("loadProviderCatalog", () => {
  it("loads and freezes the three shipped providers", () => {
    const catalog = loadProviderCatalog();

    expect(catalog.map(({ key, authMode }) => ({ key, authMode }))).toEqual([
      { key: "github", authMode: "oauth2_code" },
      { key: "linear", authMode: "api_key" },
      { key: "notion", authMode: "mcp_oauth" },
    ]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[0])).toBe(true);
    expect(Object.isFrozen(catalog[0]?.auth)).toBe(true);
  });
});
