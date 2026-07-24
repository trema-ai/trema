import type { ProviderDefInput } from "#connectors/schema.js";

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
    // Both values are required: one user can authorize multiple workspaces,
    // and one workspace can be authorized by multiple users.
    accountIdentityFields: ["workspace_id", "user_id"],
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "mcp",
    serverUrl: "https://mcp.notion.com/mcp",
  },
  memberConnectable: true,
} satisfies ProviderDefInput;
