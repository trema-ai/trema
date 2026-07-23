import type { ProviderDefInput } from "#/services/connectors/schema.js";

export const notionMcpProvider = {
  key: "notion",
  displayName: "Notion MCP",
  description: "Access pages, databases, and workspace content through Notion MCP.",
  logoUrl: "/connector-logos/notion.svg",
  categories: ["knowledge-management"],
  docsUrl: "https://developers.notion.com/docs/mcp",
  authMode: "mcp_oauth",
  auth: {
    defaultScopes: [],
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "mcp",
    serverUrl: "https://mcp.notion.com/mcp",
  },
  memberConnectable: true,
} satisfies ProviderDefInput;
