import type { ProviderDefInput } from "#connectors/schema.js";

export const clickupProvider = {
  key: "clickup",
  trusted: true,
  displayName: "ClickUp",
  description:
    "Manage ClickUp tasks, docs, comments, time, and workspace workflows through its MCP server.",
  logoUrl: "/connector-logos/clickup.svg",
  categories: ["project-management"],
  docsUrl: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server-1",
  authMode: "mcp_oauth",
  oauthActor: "user",
  auth: { defaultScopes: [] },
  configFields: {},
  credentialFields: {},
  transport: { type: "mcp", serverUrl: "https://mcp.clickup.com/mcp" },
} satisfies ProviderDefInput;
