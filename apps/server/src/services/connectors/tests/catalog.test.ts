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
    expect(catalog.map(({ key, description, logoUrl }) => ({ key, description, logoUrl }))).toEqual(
      [
        {
          key: "github",
          description: "Access repositories, issues, pull requests, and their comments.",
          logoUrl: "/connector-logos/github.svg",
        },
        {
          key: "linear",
          description: "Access issues, projects, and comments in Linear workspaces.",
          logoUrl: "/connector-logos/linear.svg",
        },
        {
          key: "notion",
          description: "Access pages, databases, and workspace content through Notion MCP.",
          logoUrl: "/connector-logos/notion.svg",
        },
      ],
    );
  });
});
