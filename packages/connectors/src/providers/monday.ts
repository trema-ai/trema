import type { ProviderDefInput } from "#/schema.js";

export const mondayProvider = {
  key: "monday",
  displayName: "monday.com",
  description:
    "Manage boards, items, docs, and workflows. Tools come from monday.com's official MCP server.",
  logoUrl: "/connector-logos/monday.svg",
  categories: ["project-management"],
  docsUrl: "https://developer.monday.com/api-reference/docs/build-on-monday-with-ai",
  authMode: "mcp_oauth",
  auth: { defaultScopes: [] },
  configFields: {},
  credentialFields: {},
  transport: { type: "mcp", serverUrl: "https://mcp.monday.com/mcp" },
  memberConnectable: true,
} satisfies ProviderDefInput;
