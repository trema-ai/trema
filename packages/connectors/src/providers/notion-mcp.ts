import type { ProviderDefInput } from "#/schema.js";

export const notionMcpProvider = {
  key: "notion",
  displayName: "Notion",
  description:
    "Access pages, databases, and workspace content. Tools come from Notion's official MCP server.",
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
