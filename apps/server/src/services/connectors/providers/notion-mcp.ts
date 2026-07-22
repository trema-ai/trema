import type { ProviderDefInput } from "#/services/connectors/schema.js";

export const notionMcpProvider = {
  key: "notion",
  displayName: "Notion MCP",
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
